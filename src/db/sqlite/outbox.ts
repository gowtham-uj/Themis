/**
 * WP-5 outbox + judge-queue helpers for the Themis async sqlite slice.
 */

import type Database from "better-sqlite3";

import { JUDGE_JOB_STATE } from "../contracts.js";

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export interface JudgeQueueRow {
  id: string;
  projectId: string;
  name: string;
  status: string;
  revision: number;
  linkedEvalQueueId: string | null;
  autoJudge: boolean;
  trackId: string;
  parallelism: number;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEventRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payloadVersion: number;
  payloadJson: string;
  availableAt: string;
  attempts: number;
  deliveredAt: string | null;
  createdAt: string;
}

/** Create a judge queue row. */
export function createJudgeQueue(
  db: Database.Database,
  input: {
    projectId: string;
    name: string;
    linkedEvalQueueId?: string | null;
    autoJudge?: boolean;
    trackId?: string;
    parallelism?: number;
  },
): JudgeQueueRow {
  const now = new Date().toISOString();
  const id = newId("jq");
  const trackId = input.trackId ?? id;
  db.prepare(
    `INSERT INTO judge_queues (
       id, project_id, name, status, revision, linked_eval_queue_id, auto_judge,
       track_id, parallelism, created_at, updated_at
     ) VALUES (?,?,?,?,1,?,?,?,?,?,?)`,
  ).run(
    id,
    input.projectId,
    input.name,
    "active",
    input.linkedEvalQueueId ?? null,
    input.autoJudge ? 1 : 0,
    trackId,
    input.parallelism ?? 1,
    now,
    now,
  );
  return getJudgeQueue(db, id)!;
}

/** Fetch a judge queue by id. */
export function getJudgeQueue(db: Database.Database, id: string): JudgeQueueRow | null {
  const r = db.prepare(`SELECT * FROM judge_queues WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    status: String(r.status),
    revision: Number(r.revision),
    linkedEvalQueueId: (r.linked_eval_queue_id as string | null) ?? null,
    autoJudge: Boolean(r.auto_judge),
    trackId: String(r.track_id),
    parallelism: Number(r.parallelism),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Insert an outbox event. Unique on (aggregate_type, aggregate_id, event_type, payload_version)
 * so redelivery is a no-op insert.
 */
export function enqueueOutboxEvent(
  db: Database.Database,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
    payloadVersion?: number;
    availableAt?: string;
  },
): { event: OutboxEventRow; created: boolean } {
  const now = new Date().toISOString();
  const id = newId("out");
  const version = input.payloadVersion ?? 1;
  const availableAt = input.availableAt ?? now;
  const result = db
    .prepare(
      `INSERT INTO outbox_events (
         id, aggregate_type, aggregate_id, event_type, payload_version, payload_json,
         available_at, attempts, created_at
       ) VALUES (?,?,?,?,?,?,?,0,?)
       ON CONFLICT (aggregate_type, aggregate_id, event_type, payload_version) DO NOTHING`,
    )
    .run(
      id,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      version,
      JSON.stringify(input.payload),
      availableAt,
      now,
    );
  const row = db
    .prepare(
      `SELECT * FROM outbox_events
         WHERE aggregate_type = ? AND aggregate_id = ? AND event_type = ? AND payload_version = ?`,
    )
    .get(input.aggregateType, input.aggregateId, input.eventType, version) as Record<
    string,
    unknown
  >;
  return {
    created: result.changes === 1,
    event: {
      id: String(row.id),
      aggregateType: String(row.aggregate_type),
      aggregateId: String(row.aggregate_id),
      eventType: String(row.event_type),
      payloadVersion: Number(row.payload_version),
      payloadJson: String(row.payload_json),
      availableAt: String(row.available_at),
      attempts: Number(row.attempts),
      deliveredAt: (row.delivered_at as string | null) ?? null,
      createdAt: String(row.created_at),
    },
  };
}

/** Claim the next undelivered outbox event (IMMEDIATE txn). */
export function claimOutboxEvent(
  db: Database.Database,
  opts: { now: string; leaseMs: number; workerId: string },
): OutboxEventRow | null {
  const claim = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM outbox_events
           WHERE delivered_at IS NULL AND available_at <= ?
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1`,
      )
      .get(opts.now) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expires = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();
    const token = Number(row.attempts ?? 0) + 1;
    const updated = db
      .prepare(
        `UPDATE outbox_events
           SET lease_owner = ?, lease_token = ?, lease_expires_at = ?, attempts = ?
           WHERE id = ? AND delivered_at IS NULL`,
      )
      .run(opts.workerId, token, expires, token, row.id);
    if (updated.changes !== 1) return null;
    const next = db.prepare(`SELECT * FROM outbox_events WHERE id = ?`).get(row.id) as Record<
      string,
      unknown
    >;
    return {
      id: String(next.id),
      aggregateType: String(next.aggregate_type),
      aggregateId: String(next.aggregate_id),
      eventType: String(next.event_type),
      payloadVersion: Number(next.payload_version),
      payloadJson: String(next.payload_json),
      availableAt: String(next.available_at),
      attempts: Number(next.attempts),
      deliveredAt: (next.delivered_at as string | null) ?? null,
      createdAt: String(next.created_at),
    } satisfies OutboxEventRow;
  });
  return claim.immediate();
}

/** Mark outbox event delivered (after job upsert succeeds). */
export function markOutboxDelivered(db: Database.Database, id: string, now: string): boolean {
  const result = db
    .prepare(
      `UPDATE outbox_events
         SET delivered_at = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE id = ? AND delivered_at IS NULL`,
    )
    .run(now, id);
  return result.changes === 1;
}

/** Reference for tests — queued is a claimable job state. */
export const CLAIMABLE_JOB_HINT = JUDGE_JOB_STATE.queued;

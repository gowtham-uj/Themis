/**
 * Judge-queue ingestion store — the two locked ways work gets onto a judge queue
 * (rosy-petting-boot.md "What is locked"):
 *
 *   eval-queue-linked:  a named eval queue Q → exactly one judge queue linked to
 *     Q. When `autoJudge` is ON, each archive seal enqueues one Phase-1 item
 *     immediately (streaming). When OFF, sealed archives accumulate in a pending
 *     buffer and are batch-flushed once (operator or eval-generation close).
 *
 *   standalone:         create a named judge queue and submit a list of archive
 *     run ids onto it.
 *
 * Both flows ultimately produce `archive.sealed` outbox events, which the
 * OutboxRelay turns into durable judge jobs (idempotent on the trigger key).
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { JUDGE_JOB_TRIGGER_KIND } from "../../db/contracts.js";
import {
  createJudgeQueue,
  enqueueOutboxEvent,
  getJudgeQueue,
  type JudgeQueueRow,
} from "../../db/sqlite/outbox.js";

/** Deterministic config-snapshot identity for a linked judge queue. */
export function linkedConfigSha256(judgeQueueId: string, runId: string): string {
  return createHash("sha256").update(`${judgeQueueId}\n${runId}`).digest("hex");
}

/** A sealed archive handed to the ingestion store. */
export interface SealedArchiveRef {
  runId: string;
  projectId: string;
  /** Eval queue id (linked flow) or null (standalone flow). */
  evalQueueId: string | null;
  baseManifestSha256: string;
}

export interface IngestResult {
  action: "streamed" | "buffered" | "no_linked_queue" | "submitted";
  judgeQueueId: string | null;
  runId: string;
}

function toPayload(
  queue: JudgeQueueRow,
  ref: SealedArchiveRef,
  now: string,
): {
  judgeQueueId: string;
  judgeQueueGenerationId: string;
  sourceTriggerId: string;
  sourceTriggerKind: (typeof JUDGE_JOB_TRIGGER_KIND)[keyof typeof JUDGE_JOB_TRIGGER_KIND];
  configSnapshotId: string;
  configSnapshotSha256: string;
  runId: string;
  projectId: string;
  baseArchiveGenerationId: string;
  baseManifestSha256: string;
  trackId: string;
  availableAt: string;
} {
  return {
    judgeQueueId: queue.id,
    judgeQueueGenerationId: queue.id,
    sourceTriggerId: ref.runId,
    sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.archive_sealed,
    configSnapshotId: `cfg_${queue.id}`,
    configSnapshotSha256: linkedConfigSha256(queue.id, ref.runId),
    runId: ref.runId,
    projectId: ref.projectId,
    baseArchiveGenerationId: ref.runId,
    baseManifestSha256: ref.baseManifestSha256,
    trackId: queue.trackId,
    availableAt: now,
  };
}

/** Emit the outbox event that turns a sealed archive into a durable judge job. */
function streamArchive(db: Database.Database, queue: JudgeQueueRow, ref: SealedArchiveRef, now: string): void {
  enqueueOutboxEvent(db, {
    aggregateType: "archive",
    // Queue-scoped identity: the same archive may legitimately be judged by
    // multiple standalone/linked judge queues. A run-only aggregate id made a
    // second queue's event collide with the first and silently omitted the job
    // (observed in the durable 2-eval E2E).
    aggregateId: `${queue.id}:${ref.runId}`,
    eventType: "archive.sealed",
    payload: toPayload(queue, ref, now),
    availableAt: now,
  });
}

/**
 * Called when an archive is sealed. Streaming when the linked judge queue has
 * autoJudge on; buffered (pending) when off. No linked queue → no-op.
 */
export function onArchiveSealed(
  db: Database.Database,
  ref: SealedArchiveRef,
  now: string = new Date().toISOString(),
): IngestResult {
  if (!ref.evalQueueId) {
    return { action: "no_linked_queue", judgeQueueId: null, runId: ref.runId };
  }
  const queue = getLinkedJudgeQueue(db, ref.evalQueueId);
  if (!queue) {
    return { action: "no_linked_queue", judgeQueueId: null, runId: ref.runId };
  }
  if (queue.autoJudge) {
    streamArchive(db, queue, ref, now);
    return { action: "streamed", judgeQueueId: queue.id, runId: ref.runId };
  }
  bufferPending(db, queue.id, ref);
  return { action: "buffered", judgeQueueId: queue.id, runId: ref.runId };
}

/** Create a judge queue linked to an eval queue (one per eval queue). */
export function linkJudgeQueue(
  db: Database.Database,
  input: { name: string; projectId: string; linkedEvalQueueId: string; autoJudge: boolean },
): JudgeQueueRow {
  return createJudgeQueue(db, {
    projectId: input.projectId,
    name: input.name,
    linkedEvalQueueId: input.linkedEvalQueueId,
    autoJudge: input.autoJudge,
    trackId: input.linkedEvalQueueId,
  });
}

/** Standalone submit: enqueue a list of archive run ids as standalone items. */
export function submitStandaloneArchives(
  db: Database.Database,
  judgeQueueId: string,
  archives: SealedArchiveRef[],
  now: string = new Date().toISOString(),
): IngestResult[] {
  const queue = getJudgeQueue(db, judgeQueueId);
  if (!queue) throw new Error(`judge queue not found: ${judgeQueueId}`);
  const results: IngestResult[] = [];
  for (const ref of archives) {
    const payload = toPayload(queue, { ...ref, evalQueueId: null }, now);
    payload.sourceTriggerKind = JUDGE_JOB_TRIGGER_KIND.standalone_item;
    enqueueOutboxEvent(db, {
      aggregateType: "archive",
      // Queue-scoped standalone trigger: same run on another judge queue is a
      // distinct valid judgement, while replay on this queue still dedupes.
      aggregateId: `${queue.id}:${ref.runId}`,
      eventType: "archive.sealed",
      payload,
      availableAt: now,
    });
    results.push({ action: "submitted", judgeQueueId, runId: ref.runId });
  }
  return results;
}

function bufferPending(db: Database.Database, judgeQueueId: string, ref: SealedArchiveRef): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO judge_pending_archives
       (judge_queue_id, run_id, project_id, base_manifest_sha256, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT (judge_queue_id, run_id) DO NOTHING`,
  ).run(judgeQueueId, ref.runId, ref.projectId, ref.baseManifestSha256, now);
}

/** Batch-flush a linked queue's buffered archives into outbox events. */
export function flushPending(
  db: Database.Database,
  judgeQueueId: string,
  now: string = new Date().toISOString(),
): IngestResult[] {
  const queue = getJudgeQueue(db, judgeQueueId);
  if (!queue) throw new Error(`judge queue not found: ${judgeQueueId}`);
  const rows = db
    .prepare(`SELECT * FROM judge_pending_archives WHERE judge_queue_id = ? ORDER BY created_at ASC, run_id ASC`)
    .all(judgeQueueId) as Record<string, unknown>[];
  const results: IngestResult[] = [];
  for (const r of rows) {
    const ref: SealedArchiveRef = {
      runId: String(r.run_id),
      projectId: String(r.project_id),
      evalQueueId: queue.linkedEvalQueueId,
      baseManifestSha256: String(r.base_manifest_sha256),
    };
    streamArchive(db, queue, ref, now);
    db.prepare(`DELETE FROM judge_pending_archives WHERE judge_queue_id = ? AND run_id = ?`).run(
      judgeQueueId,
      ref.runId,
    );
    results.push({ action: "streamed", judgeQueueId, runId: ref.runId });
  }
  return results;
}

/** Count buffered archives for a judge queue. */
export function countPending(db: Database.Database, judgeQueueId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM judge_pending_archives WHERE judge_queue_id = ?`)
    .get(judgeQueueId) as { n: number };
  return row.n;
}

/** Find the judge queue linked to an eval queue, if any. */
export function getLinkedJudgeQueue(db: Database.Database, evalQueueId: string): JudgeQueueRow | null {
  const r = db
    .prepare(`SELECT id FROM judge_queues WHERE linked_eval_queue_id = ? LIMIT 1`)
    .get(evalQueueId) as { id: string } | undefined;
  if (!r) return null;
  return getJudgeQueue(db, r.id);
}

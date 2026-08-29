/**
 * WP-5 outbox relay: claim undelivered events, upsert judge jobs, mark delivered.
 * Delivery is at-least-once; job upsert is idempotent on the trigger key.
 */

import type Database from "better-sqlite3";

import {
  JUDGE_JOB_TRIGGER_KIND,
  type JudgeJobTriggerKind,
  type NewJudgeJob,
  type ThemisDb,
} from "../../db/contracts.js";
import {
  claimOutboxEvent,
  markOutboxDelivered,
  type OutboxEventRow,
} from "../../db/sqlite/outbox.js";
import { SqliteJudgeJobRepository } from "../../db/sqlite/store.js";

export interface ArchiveSealedPayload {
  judgeQueueId: string;
  judgeQueueGenerationId: string;
  sourceTriggerId: string;
  sourceTriggerKind?: JudgeJobTriggerKind;
  configSnapshotId: string;
  configSnapshotSha256: string;
  runId: string;
  projectId: string;
  batchId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  baseArchiveGenerationId: string;
  baseManifestSha256: string;
  trackId: string;
  makeCurrent?: boolean;
  priority?: number;
  availableAt?: string;
}

export interface OutboxRelayTickResult {
  claimed: number;
  delivered: number;
  errors: string[];
}

function isArchiveSealedPayload(v: unknown): v is ArchiveSealedPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  for (const k of [
    "judgeQueueId",
    "judgeQueueGenerationId",
    "sourceTriggerId",
    "configSnapshotId",
    "configSnapshotSha256",
    "runId",
    "projectId",
    "baseArchiveGenerationId",
    "baseManifestSha256",
    "trackId",
  ]) {
    if (typeof o[k] !== "string" || !(o[k] as string).length) return false;
  }
  return true;
}

/**
 * A permanent, structurally-invalid event: no redelivery can fix it, so the
 * relay must poison-pill it rather than re-claim it and wedge the queue. A
 * transient failure (database hiccup) instead releases the lease for a later
 * redelivery.
 */
class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEventError";
  }
}

function toNewJudgeJob(p: ArchiveSealedPayload, now: string): NewJudgeJob {
  return {
    judgeQueueId: p.judgeQueueId,
    judgeQueueGenerationId: p.judgeQueueGenerationId,
    sourceTriggerId: p.sourceTriggerId,
    sourceTriggerKind: p.sourceTriggerKind ?? JUDGE_JOB_TRIGGER_KIND.archive_sealed,
    configSnapshotId: p.configSnapshotId,
    configSnapshotSha256: p.configSnapshotSha256,
    runId: p.runId,
    projectId: p.projectId,
    batchId: p.batchId ?? null,
    taskId: p.taskId ?? null,
    agentId: p.agentId ?? null,
    baseArchiveGenerationId: p.baseArchiveGenerationId,
    baseManifestSha256: p.baseManifestSha256,
    publicationPolicy: {
      makeCurrent: p.makeCurrent ?? true,
      trackId: p.trackId,
      expectedCurrentResultVersionId: null,
      expectedCurrentArchiveViewGenerationId: null,
    },
    priority: p.priority ?? 0,
    availableAt: p.availableAt ?? now,
  };
}

/** Relay undelivered outbox events into durable judge jobs. */
export class OutboxRelay {
  private readonly jobs: SqliteJudgeJobRepository | null;
  private readonly themis: ThemisDb | null;

  /**
   * Two construction modes:
   *  - SQLite dev/test: `new OutboxRelay(sqliteDb)`.
   *  - PostgreSQL production: `new OutboxRelay(null, themisDb)` — the relay
   *    claims and delivers entirely through ThemisDb; no SQLite file exists.
   */
  constructor(
    private readonly db: Database.Database | null,
    themis?: ThemisDb,
  ) {
    if (db === null && themis === undefined) {
      throw new Error("OutboxRelay requires a SQLite database or a ThemisDb");
    }
    this.jobs = db !== null ? new SqliteJudgeJobRepository(db) : null;
    this.themis = themis ?? null;
  }

  /** Process up to `limit` undelivered events. */
  async tick(opts: {
    now: string;
    workerId: string;
    leaseMs: number;
    limit?: number;
  }): Promise<OutboxRelayTickResult> {
    const limit = opts.limit ?? 10;
    let claimed = 0;
    let delivered = 0;
    const errors: string[] = [];

    if (this.themis !== null) {
      // PostgreSQL production path: claim and deliver both in PG, so the
      // delivered_time update and the judge-job upsert are ONE transaction
      // (design §3). The SQLite handle is not consulted for outbox work here —
      // no dual-write.
      const claimedIds = new Set<string>();
      for (let i = 0; i < limit; i += 1) {
        const event = await this.themis.outboxEvents.claimNext({
          now: opts.now,
          leaseMs: opts.leaseMs,
          workerId: opts.workerId,
        });
        if (event === null) break;
        if (claimedIds.has(event.id)) break; // defensive: never hot-loop one event
        claimedIds.add(event.id);
        claimed += 1;
        try {
          await this.deliverPg(event, opts.now);
          delivered += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${event.id}: ${msg}`);
          if (err instanceof PermanentEventError) {
            // Poison pill: a structurally invalid event can never succeed, so
            // mark it delivered (terminal) instead of re-claiming it forever
            // and wedging the queue behind one bad row. The error stays visible
            // in the tick's `errors` result.
            await this.themis.outboxEvents.markDelivered(event.id, {
              leaseToken: event.leaseToken ?? 0,
              leaseOwner: event.leaseOwner ?? "",
            });
            delivered += 1;
          } else {
            await this.themis.outboxEvents.releaseLease(
              event.id,
              { leaseToken: event.leaseToken ?? 0 },
              msg.slice(0, 2000),
            );
          }
        }
      }
      return { claimed, delivered, errors };
    }

    const db = this.db!;
    const jobs = this.jobs!;
    for (let i = 0; i < limit; i += 1) {
      const event = claimOutboxEvent(db, {
        now: opts.now,
        leaseMs: opts.leaseMs,
        workerId: opts.workerId,
      });
      if (!event) break;
      claimed += 1;
      try {
        await this.deliver(db, jobs, event, opts.now);
        delivered += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${event.id}: ${msg}`);
        // Poison pill: a structurally invalid event can never succeed, so
        // deliver it (with last_error) instead of re-claiming it forever and
        // wedging the queue behind one bad row.
        const poisoned = db
          .prepare(
            `UPDATE outbox_events
               SET last_error = ?, delivered_at = ?, lease_owner = NULL,
                   lease_token = NULL, lease_expires_at = NULL
               WHERE id = ?`,
          )
          .run(msg.slice(0, 2000), opts.now, event.id);
        if (poisoned.changes === 1) {
          delivered += 1;
        }
      }
    }
    return { claimed, delivered, errors };
  }

  private async deliver(
    db: Database.Database,
    jobs: SqliteJudgeJobRepository,
    event: OutboxEventRow,
    now: string,
  ): Promise<void> {
    if (event.eventType !== "archive.sealed") {
      // Unknown types are marked delivered after no-op so the queue cannot wedge.
      markOutboxDelivered(db, event.id, now);
      return;
    }
    const payload = JSON.parse(event.payloadJson) as unknown;
    if (!isArchiveSealedPayload(payload)) {
      throw new Error("archive.sealed payload missing required NewJudgeJob fields");
    }
    const job = toNewJudgeJob(payload, now);
    await jobs.upsertByTrigger(job);
    const ok = markOutboxDelivered(db, event.id, now);
    if (!ok) throw new Error(`failed to mark outbox ${event.id} delivered`);
  }

  /** PG delivery: job upsert + delivered_time in one transaction. */
  private async deliverPg(
    event: import("../../db/contracts.js").OutboxEventRow,
    now: string,
  ): Promise<void> {
    if (event.eventType !== "archive.sealed") {
      await this.themis!.outboxEvents.markDelivered(event.id, {
        leaseToken: event.leaseToken ?? 0,
        leaseOwner: event.leaseOwner ?? "",
      });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.payloadBody) as unknown;
    } catch {
      throw new PermanentEventError("archive.sealed payload is not valid JSON");
    }
    if (!isArchiveSealedPayload(payload)) {
      throw new PermanentEventError("archive.sealed payload missing required NewJudgeJob fields");
    }
    const job = toNewJudgeJob(payload, now);
    await this.themis!.transaction(async (tx) => {
      await tx.judgeJobs.upsertByTrigger(job);
      const ok = await tx.outboxEvents.markDelivered(event.id, {
        leaseToken: event.leaseToken ?? 0,
        leaseOwner: event.leaseOwner ?? "",
      });
      if (!ok) throw new Error(`failed to mark outbox ${event.id} delivered`);
    });
  }
}

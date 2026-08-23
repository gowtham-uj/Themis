/**
 * WP-5 outbox relay: claim undelivered events, upsert judge jobs, mark delivered.
 * Delivery is at-least-once; job upsert is idempotent on the trigger key.
 */

import type Database from "better-sqlite3";

import {
  JUDGE_JOB_TRIGGER_KIND,
  type JudgeJobTriggerKind,
  type NewJudgeJob,
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
  private readonly jobs: SqliteJudgeJobRepository;

  constructor(private readonly db: Database.Database) {
    this.jobs = new SqliteJudgeJobRepository(db);
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

    for (let i = 0; i < limit; i += 1) {
      const event = claimOutboxEvent(this.db, {
        now: opts.now,
        leaseMs: opts.leaseMs,
        workerId: opts.workerId,
      });
      if (!event) break;
      claimed += 1;
      try {
        await this.deliver(event, opts.now);
        delivered += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${event.id}: ${msg}`);
        this.db
          .prepare(`UPDATE outbox_events SET last_error = ? WHERE id = ?`)
          .run(msg.slice(0, 2000), event.id);
      }
    }
    return { claimed, delivered, errors };
  }

  private async deliver(event: OutboxEventRow, now: string): Promise<void> {
    if (event.eventType !== "archive.sealed") {
      // Unknown types are marked delivered after no-op so the queue cannot wedge.
      markOutboxDelivered(this.db, event.id, now);
      return;
    }
    const payload = JSON.parse(event.payloadJson) as unknown;
    if (!isArchiveSealedPayload(payload)) {
      throw new Error("archive.sealed payload missing required NewJudgeJob fields");
    }
    // Job upsert is idempotent on (queue, kind, trigger). Mark delivered only
    // after upsert returns — crash before this line redelivers and dedupes.
    await this.jobs.upsertByTrigger(toNewJudgeJob(payload, now));
    const ok = markOutboxDelivered(this.db, event.id, now);
    if (!ok) throw new Error(`failed to mark outbox ${event.id} delivered`);
  }
}

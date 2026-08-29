/**
 * PostgreSQL implementation of the Themis judge-job and judge-attempt repositories.
 *
 * Production backend. `claimNext` uses `SELECT ... FOR UPDATE SKIP LOCKED` so
 * concurrent claimers lock DIFFERENT eligible rows and proceed in parallel —
 * the property the SQLite backend structurally cannot provide, and the reason
 * the M1 claim-predicate mutant is only killable here.
 *
 * Fencing is checked in SQL (`state` + `fencing_token` in every mutable WHERE),
 * never in TypeScript after a read.
 */

import type { Pool, PoolClient } from "pg";

import {
  CursorDecodeError,
  CURSOR_VERSION,
  IDEMPOTENCY_KEY_STATE,
  JUDGE_ATTEMPT_STATE,
  JUDGE_ERROR_CLASSIFICATION,
  JUDGE_JOB_STATE,
  JUDGE_PROVIDER_OPERATION_STATE,
  JUDGE_PROVIDER_OPERATION_KIND,
  JUDGE_QUEUE_GENERATION_STATE,
  JUDGE_QUEUE_STATUS,
  opaqueCursorCodec,
  type AttemptNumber,
  type DbTimestamp,
  type FencingToken,
  type IdempotencyKeyRef,
  type IdempotencyKeyRepository,
  type IdempotencyKeyRow,
  type IdempotencyKeyState,
  type JudgeAttemptRepository,
  type JudgeAttemptRow,
  type JudgeAttemptState,
  type JudgeBudgetLimits,
  type JudgeCheckpoint,
  type JudgeClaimResult,
  type JudgeClerkSettings,
  type JudgeConfigSnapshotRepository,
  type JudgeConfigSnapshotRow,
  type JudgeCurrentPointerCas,
  type JudgeCurrentPointerRepository,
  type JudgeCurrentPointerRow,
  type JudgeErrorClassification,
  type JudgeEvalProvenance,
  type JudgeFencing,
  type JudgeGenerationTriggerKind,
  type JudgeJobPatch,
  type JudgeJobRepository,
  type JudgeJobRow,
  type JudgeJobState,
  type JudgeModelSettings,
  type JudgeNode,
  type JudgeNode4Settings,
  type JudgePauseKind,
  type JudgeProviderOperationKind,
  type JudgeProviderOperationLogicalKey,
  type JudgeProviderOperationRepository,
  type JudgeProviderOperationRow,
  type JudgeProviderOperationState,
  type JudgeProviderFailure,
  type JudgeProviderSuccess,
  type JudgePublicationPolicy,
  type JudgePublicationState,
  type JudgeQueueGenerationRepository,
  type JudgeQueueGenerationRow,
  type JudgeQueueGenerationState,
  type JudgeQueuePatch,
  type JudgeQueueRepository,
  type JudgeQueueRow,
  type JudgeQueueStatus,
  type JudgeResultVersionRepository,
  type JudgeResultVersionRow,
  type JudgeRetryPolicy,
  type JudgeRole,
  type JudgeRound,
  type JudgeUsageSummary,
  type KeysetPage,
  type KeysetPageRequest,
  type LeaseClaimOptions,
  type NewJudgeAttempt,
  type NewJudgeConfigSnapshot,
  type NewJudgeJob,
  type NewJudgeProviderOperation,
  type NewJudgeQueue,
  type NewJudgeQueueGeneration,
  type NewJudgeResultVersion,
  type NewIdempotencyKey,
  type NewOutboxEvent,
  type OutboxEventRepository,
  type OutboxEventRow,
  type RequeueOptions,
} from "../contracts.js";

type Queryable = Pool | PoolClient;

/**
 * Run `work` inside a transaction. When `db` is a Pool, check out a client and
 * own BEGIN/COMMIT/ROLLBACK. When it is a PoolClient, the caller already owns
 * the transaction (a `ThemisDb.transaction()` scope) — run the work in-place and
 * touch nothing, so a claim/lease can commit atomically with sibling writes.
 */
async function inTransaction<T>(db: Queryable, work: (q: Queryable) => Promise<T>): Promise<T> {
  if (typeof (db as Partial<Pool>).connect === "function") {
    const client = await (db as Pool).connect();
    try {
      await client.query("BEGIN");
      const out = await work(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the original error is the actionable one */
      }
      throw err;
    } finally {
      client.release();
    }
  }
  return work(db);
}

/** Coerce a PG timestamptz (Date or string) to UTC ISO. */
function ts(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
function tsNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return ts(value);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** States a job may be claimed from (design §3: queued or waiting_retry). */
const CLAIMABLE_STATES: readonly JudgeJobState[] = [
  JUDGE_JOB_STATE.queued,
  JUDGE_JOB_STATE.waiting_retry,
];

/** States that hold a live lease and can therefore expire into waiting_retry. */
const LEASED_STATES: readonly JudgeJobState[] = [
  JUDGE_JOB_STATE.leased,
  JUDGE_JOB_STATE.running,
  JUDGE_JOB_STATE.sealing,
];

/** Largest page a caller may request; keyset only, never an offset. */
const MAX_PAGE_LIMIT = 1000;

const ZERO_USAGE: JudgeUsageSummary = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  modelCalls: 0,
  webCalls: 0,
});

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  return JSON.parse(raw) as T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** Map a `judge_jobs` row to the contract shape. */
function toJobRow(r: Row): JudgeJobRow {
  return {
    id: r.id,
    judgeQueueId: r.judge_queue_id,
    judgeQueueGenerationId: r.judge_queue_generation_id,
    sourceTriggerId: r.source_trigger_id,
    sourceTriggerKind: r.source_trigger_kind,
    configSnapshotId: r.config_snapshot_id,
    configSnapshotSha256: r.config_snapshot_sha256,
    runId: r.run_id,
    projectId: r.project_id,
    batchId: r.batch_id,
    taskId: r.task_id,
    agentId: r.agent_id,
    baseArchiveGenerationId: r.base_archive_generation_id,
    baseManifestSha256: r.base_manifest_sha256,
    publicationPolicy: JSON.parse(r.publication_policy_json) as JudgePublicationPolicy,
    state: r.state as JudgeJobState,
    priority: r.priority,
    availableAt: ts(r.available_at),
    attemptCount: r.attempt_count,
    activeAttemptId: r.active_attempt_id,
    activeAttemptNumber: r.active_attempt_number as AttemptNumber | null,
    fencingToken: r.fencing_token as FencingToken,
    lease:
      r.lease_owner === null || r.lease_token === null || r.lease_expires_at === null
        ? null
        : { owner: r.lease_owner, token: r.lease_token as number, expiresAt: ts(r.lease_expires_at) },
    heartbeatAt: tsNull(r.heartbeat_at),
    currentNode: r.current_node as JudgeNode | null,
    currentRound: r.current_round as JudgeRound | null,
    pauseKind: r.pause_kind as JudgePauseKind | null,
    pauseReason: r.pause_reason,
    terminalErrorKind: r.terminal_error_kind as JudgeErrorClassification | null,
    terminalErrorDetail: r.terminal_error_detail,
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

/** Map a `judge_attempts` row to the contract shape. */
function toAttemptRow(r: Row): JudgeAttemptRow {
  return {
    id: r.id,
    jobId: r.job_id,
    attemptNumber: r.attempt_number as AttemptNumber,
    workerId: r.worker_id,
    fencingToken: r.fencing_token as FencingToken,
    workingStorePrefix: r.working_store_prefix,
    stagingPrefix: r.staging_prefix,
    state: r.state as JudgeAttemptState,
    errorClassification: r.error_classification as JudgeErrorClassification | null,
    aggregateModelUsage: parseJson(r.aggregate_model_usage_json, ZERO_USAGE),
    aggregateWebUsage: parseJson(r.aggregate_web_usage_json, ZERO_USAGE),
    evidenceBytes: r.evidence_bytes,
    estimatedCost: r.estimated_cost,
    checkpointReached: parseJson<JudgeCheckpoint | null>(r.checkpoint_reached_json, null),
    startedAt: tsNull(r.started_at),
    endedAt: tsNull(r.ended_at),
  };
}

/** Decode a keyset cursor into its `(created_at, id)` order values. */
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = opaqueCursorCodec.decode(cursor);
  if (decoded.version !== CURSOR_VERSION || decoded.orderValues.length !== 2) {
    throw new CursorDecodeError("cursor does not carry (created_at, id) order values");
  }
  const [createdAt, id] = decoded.orderValues;
  if (typeof createdAt !== "string" || typeof id !== "string") {
    throw new CursorDecodeError("cursor order values must both be strings");
  }
  return { createdAt, id };
}

/** Encode the `(created_at, id)` position of the last item on a page. */
function encodeCursor(row: JudgeJobRow): string {
  return opaqueCursorCodec.encode({
    orderValues: [row.createdAt, row.id],
    direction: "asc",
    version: CURSOR_VERSION,
  });
}

function clampLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`page limit must be a positive integer, got ${String(limit)}`);
  }
  return Math.min(limit, MAX_PAGE_LIMIT);
}

/**
 * A keyset page over one indexed `(column, created_at, id)` order. Fetches
 * `limit + 1` rows to decide `hasMore` without a COUNT, and never uses OFFSET,
 * so cursor depth costs the same as the first page.
 */
async function jobPage(
  db: Queryable,
  column: "run_id" | "judge_queue_id" | "project_id",
  value: string,
  req: KeysetPageRequest,
): Promise<KeysetPage<JudgeJobRow>> {
  const limit = clampLimit(req.limit);
  const after = req.cursor === null ? null : decodeCursor(req.cursor);
  const sql =
    after === null
      ? `SELECT * FROM judge_jobs WHERE ${column} = $1
           ORDER BY created_at ASC, id ASC LIMIT $2`
      : `SELECT * FROM judge_jobs WHERE ${column} = $1
           AND (created_at > $2 OR (created_at = $3 AND id > $4))
           ORDER BY created_at ASC, id ASC LIMIT $5`;
  const params =
    after === null
      ? [value, limit + 1]
      : [value, after.createdAt, after.createdAt, after.id, limit + 1];
  const rows = (await db.query(sql, params)).rows as Row[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toJobRow);
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
  };
}

/** `judge_jobs` repository over node-postgres. */

export class PostgresJudgeJobRepository implements JudgeJobRepository {
  constructor(private readonly db: Queryable) {}

  async upsertByTrigger(input: NewJudgeJob): Promise<{ job: JudgeJobRow; created: boolean }> {
    const now = new Date().toISOString();
    const id = newId("jjob");
    const result = await this.db.query(
      `INSERT INTO judge_jobs (
         id, judge_queue_id, judge_queue_generation_id, source_trigger_id,
         source_trigger_kind, config_snapshot_id, config_snapshot_sha256, run_id,
         project_id, batch_id, task_id, agent_id, base_archive_generation_id,
         base_manifest_sha256, publication_policy_json, state, priority,
         available_at, attempt_count, fencing_token, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,0,$19,$20)
       ON CONFLICT (judge_queue_id, source_trigger_kind, source_trigger_id) DO NOTHING`,
      [
        id, input.judgeQueueId, input.judgeQueueGenerationId, input.sourceTriggerId,
        input.sourceTriggerKind, input.configSnapshotId, input.configSnapshotSha256, input.runId,
        input.projectId, input.batchId, input.taskId, input.agentId,
        input.baseArchiveGenerationId, input.baseManifestSha256,
        JSON.stringify(input.publicationPolicy), JUDGE_JOB_STATE.queued, input.priority,
        input.availableAt, now, now,
      ],
    );
    const row = (await this.db.query(
      `SELECT * FROM judge_jobs
         WHERE judge_queue_id = $1 AND source_trigger_kind = $2 AND source_trigger_id = $3`,
      [input.judgeQueueId, input.sourceTriggerKind, input.sourceTriggerId],
    )).rows[0] as Row;
    return { job: toJobRow(row), created: (result.rowCount ?? 0) === 1 };
  }

  async get(id: string): Promise<JudgeJobRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_jobs WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toJobRow(row);
  }

  async getByRunCursor(runId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>> {
    return jobPage(this.db, "run_id", runId, req);
  }
  async listByQueueCursor(judgeQueueId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>> {
    return jobPage(this.db, "judge_queue_id", judgeQueueId, req);
  }
  async listByProjectCursor(projectId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>> {
    return jobPage(this.db, "project_id", projectId, req);
  }

  /**
   * Claim the next eligible job with FOR UPDATE SKIP LOCKED.
   * The UPDATE WHERE re-checks state AND fencing_token (M1 load-bearing predicate).
   */
  async claimNext(judgeQueueId: string, opts: LeaseClaimOptions): Promise<JudgeClaimResult | null> {
    return inTransaction(this.db, async (q) => {
      const candidateRes = await q.query(
        `SELECT * FROM judge_jobs
           WHERE judge_queue_id = $1 AND state = ANY($2::text[]) AND available_at <= $3::timestamptz
           ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        [judgeQueueId, [...CLAIMABLE_STATES], opts.now],
      );
      const candidate = candidateRes.rows[0] as Row | undefined;
      if (candidate === undefined) return null;
      const nextToken = (candidate.fencing_token as number) + 1;
      const attemptNumber = (candidate.attempt_count as number) + 1;
      const attemptId = newId("jatt");
      const expiresAt = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();

      const updated = await q.query(
        `UPDATE judge_jobs
           SET state = $1, fencing_token = $2, attempt_count = $3, active_attempt_id = $4,
               active_attempt_number = $5, lease_owner = $6, lease_token = $7,
               lease_expires_at = $8, heartbeat_at = $9, updated_at = $10
           WHERE id = $11 AND state = $12 AND fencing_token = $13`,
        [
          JUDGE_JOB_STATE.leased, nextToken, attemptNumber, attemptId, attemptNumber,
          opts.workerId, nextToken, expiresAt, opts.now, opts.now,
          candidate.id, candidate.state, candidate.fencing_token,
        ],
      );
      if (updated.rowCount !== 1) return null;
      await q.query(
        `INSERT INTO judge_attempts (
           id, job_id, attempt_number, worker_id, fencing_token,
           working_store_prefix, staging_prefix, state, evidence_bytes,
           estimated_cost, started_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)`,
        [
          attemptId, candidate.id, attemptNumber, opts.workerId, nextToken,
          `work/${candidate.id}/${attemptId}`, `staging/${candidate.id}/${attemptId}`,
          JUDGE_ATTEMPT_STATE.running, opts.now,
        ],
      );
      const job = toJobRow((await q.query("SELECT * FROM judge_jobs WHERE id = $1", [candidate.id])).rows[0]);
      const attempt = toAttemptRow((await q.query("SELECT * FROM judge_attempts WHERE id = $1", [attemptId])).rows[0]);
      return { job, attempt, fencingToken: nextToken };
    });
  }

  async heartbeat(id: string, expected: JudgeFencing, leaseExpiresAt: DbTimestamp): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE judge_jobs
         SET lease_expires_at = $1, heartbeat_at = $2, updated_at = $3
         WHERE id = $4 AND active_attempt_id = $5 AND state = $6 AND fencing_token = $7`,
      [leaseExpiresAt, now, now, id, expected.activeAttemptId, expected.activeState, expected.fencingToken],
    );
    return result.rowCount === 1;
  }

  async updateFenced(id: string, expected: JudgeFencing, patch: JudgeJobPatch): Promise<JudgeJobRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.currentNode !== undefined) put("current_node", patch.currentNode);
    if (patch.currentRound !== undefined) put("current_round", patch.currentRound);
    if (patch.pauseKind !== undefined) put("pause_kind", patch.pauseKind);
    if (patch.pauseReason !== undefined) put("pause_reason", patch.pauseReason);
    if (patch.terminalErrorKind !== undefined) put("terminal_error_kind", patch.terminalErrorKind);
    if (patch.terminalErrorDetail !== undefined) put("terminal_error_detail", patch.terminalErrorDetail);
    if (patch.heartbeatAt !== undefined) put("heartbeat_at", patch.heartbeatAt);
    if (patch.availableAt !== undefined) put("available_at", patch.availableAt);
    if (patch.activeAttemptId !== undefined) put("active_attempt_id", patch.activeAttemptId);
    if (patch.activeAttemptNumber !== undefined) put("active_attempt_number", patch.activeAttemptNumber);
    if (patch.attemptCount !== undefined) put("attempt_count", patch.attemptCount);
    if (patch.fencingToken !== undefined) put("fencing_token", patch.fencingToken);
    if (patch.lease !== undefined) {
      put("lease_owner", patch.lease === null ? null : patch.lease.owner);
      put("lease_token", patch.lease === null ? null : patch.lease.token);
      put("lease_expires_at", patch.lease === null ? null : patch.lease.expiresAt);
    }
    put("updated_at", new Date().toISOString());
    const whereBase = params.length;
    params.push(id, expected.activeAttemptId, expected.activeState, expected.fencingToken);
    const result = await this.db.query(
      `UPDATE judge_jobs SET ${sets.join(", ")}
         WHERE id = $${whereBase + 1} AND active_attempt_id = $${whereBase + 2}
           AND state = $${whereBase + 3} AND fencing_token = $${whereBase + 4}`,
      params,
    );
    if (result.rowCount !== 1) return null;
    return this.get(id);
  }

  async releaseClaimNoRetryCharge(
    id: string,
    attemptId: string,
    expected: JudgeFencing,
  ): Promise<boolean> {
    return inTransaction(this.db, async (q) => {
      const moved = await q.query(
        `UPDATE judge_jobs
            SET attempt_count = GREATEST(attempt_count - 1, 0),
                active_attempt_id = NULL, active_attempt_number = NULL,
                updated_at = now()
          WHERE id = $1 AND state = $2 AND fencing_token = $3 AND active_attempt_id = $4`,
        [id, expected.activeState, expected.fencingToken, attemptId],
      );
      if (moved.rowCount !== 1) return false;
      await q.query(`DELETE FROM judge_attempts WHERE id = $1`, [attemptId]);
      return true;
    });
  }

  async requeueExpiredLeases(opts: RequeueOptions): Promise<number> {
    const limit = clampLimit(opts.limit);
    const cutoff = new Date(Date.parse(opts.now) - opts.maxLeaseAgeMs).toISOString();
    return inTransaction(this.db, async (q) => {
      const expired = (await q.query(
        `SELECT * FROM judge_jobs
           WHERE state = ANY($1::text[])
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= $2::timestamptz
           ORDER BY lease_expires_at ASC, id ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED`,
        [[...LEASED_STATES], cutoff, limit],
      )).rows as Row[];
      let requeued = 0;
      for (const job of expired) {
        const moved = await q.query(
          `UPDATE judge_jobs
             SET state = $1, lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL, active_attempt_id = NULL,
                 active_attempt_number = NULL, available_at = $2, updated_at = $3
             WHERE id = $4 AND state = $5 AND fencing_token = $6`,
          [JUDGE_JOB_STATE.waiting_retry, opts.now, opts.now, job.id, job.state, job.fencing_token],
        );
        if (moved.rowCount !== 1) continue;
        if (job.active_attempt_id !== null) {
          await q.query(
            `UPDATE judge_attempts SET state = $1, error_classification = $2, ended_at = $3
               WHERE id = $4 AND state = $5`,
            [JUDGE_ATTEMPT_STATE.lost, JUDGE_ERROR_CLASSIFICATION.worker_loss, opts.now,
             job.active_attempt_id, JUDGE_ATTEMPT_STATE.running],
          );
          await q.query(
            `UPDATE judge_provider_operations
               SET state = $1, error_classification = $2, ended_at = $3
               WHERE attempt_id = $4 AND state = $5`,
            [JUDGE_PROVIDER_OPERATION_STATE.unknown, JUDGE_ERROR_CLASSIFICATION.worker_loss,
             opts.now, job.active_attempt_id, JUDGE_PROVIDER_OPERATION_STATE.in_flight],
          );
        }
        requeued += 1;
      }
      return requeued;
    });
  }
}

export class PostgresJudgeAttemptRepository implements JudgeAttemptRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: NewJudgeAttempt): Promise<JudgeAttemptRow> {
    const id = newId("jatt");
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO judge_attempts (
         id, job_id, attempt_number, worker_id, fencing_token,
         working_store_prefix, staging_prefix, state, evidence_bytes,
         estimated_cost, started_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)`,
      [id, input.jobId, input.attemptNumber, input.workerId, input.fencingToken,
       input.workingStorePrefix, input.stagingPrefix, JUDGE_ATTEMPT_STATE.running, now],
    );
    return toAttemptRow((await this.db.query("SELECT * FROM judge_attempts WHERE id = $1", [id])).rows[0]);
  }

  async get(id: string): Promise<JudgeAttemptRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_attempts WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toAttemptRow(row);
  }

  async getByJob(jobId: string): Promise<readonly JudgeAttemptRow[]> {
    const rows = (await this.db.query(
      "SELECT * FROM judge_attempts WHERE job_id = $1 ORDER BY attempt_number ASC",
      [jobId],
    )).rows as Row[];
    return rows.map(toAttemptRow);
  }

  async transition(
    id: string,
    expected: JudgeAttemptState,
    next: JudgeAttemptState,
    opts?: {
      errorClassification?: JudgeErrorClassification | null;
      endedAt?: DbTimestamp | null;
      checkpoint?: JudgeCheckpoint | null;
    },
  ): Promise<JudgeAttemptRow | null> {
    const sets = ["state = $1"];
    const params: unknown[] = [next];
    if (opts?.errorClassification !== undefined) {
      params.push(opts.errorClassification);
      sets.push(`error_classification = $${params.length}`);
    }
    if (opts?.endedAt !== undefined) {
      params.push(opts.endedAt);
      sets.push(`ended_at = $${params.length}`);
    }
    if (opts?.checkpoint !== undefined) {
      params.push(opts.checkpoint === null ? null : JSON.stringify(opts.checkpoint));
      sets.push(`checkpoint_reached_json = $${params.length}`);
    }
    const whereBase = params.length;
    params.push(id, expected);
    const result = await this.db.query(
      `UPDATE judge_attempts SET ${sets.join(", ")}
         WHERE id = $${whereBase + 1} AND state = $${whereBase + 2}`,
      params,
    );
    if (result.rowCount !== 1) return null;
    return this.get(id);
  }
}

// ---------------------------------------------------------------------------
// The remaining eight repositories (design §3 / §8 / §10). All methods are
// async; every mutable write re-checks its predicate in SQL, never in memory.
// ---------------------------------------------------------------------------

function toQueueRow(r: Row): JudgeQueueRow {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    status: r.status as JudgeQueueStatus,
    revision: r.revision,
    linkedEvalQueueId: r.linked_eval_queue_id,
    autoJudge: r.auto_judge,
    trackKey: r.track_key ?? r.track_id ?? r.id,
    parallelism: r.parallelism,
    priority: r.priority,
    retryPolicy: parseJson(r.retry_policy_json, {} as JudgeRetryPolicy),
    modelSettings: parseJson(r.model_settings_json, {} as JudgeModelSettings),
    node0ChunkSize: r.node0_chunk_size,
    node2MetricSelection: parseJson(r.node2_metric_selection_json, [] as readonly string[]),
    clerkSettings: parseJson(r.clerk_settings_json, {} as JudgeClerkSettings),
    node4Settings: parseJson(r.node4_settings_json, {} as JudgeNode4Settings),
    budgetLimits: parseJson(r.budget_limits_json, {} as JudgeBudgetLimits),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
  };
}

function toQueueGenerationRow(r: Row): JudgeQueueGenerationRow {
  return {
    id: r.id,
    judgeQueueId: r.judge_queue_id,
    queueRevision: r.queue_revision,
    configSnapshotId: r.config_snapshot_id,
    ordinal: r.ordinal,
    state: r.state as JudgeQueueGenerationState,
    sourceTrigger: r.source_trigger as JudgeGenerationTriggerKind,
    createdAt: ts(r.created_at),
    closedAt: tsNull(r.closed_at),
  };
}

function toConfigSnapshotRow(r: Row): JudgeConfigSnapshotRow {
  return {
    id: r.id,
    judgeQueueId: r.judge_queue_id,
    projectId: r.project_id,
    jobId: r.job_id,
    queueRevision: r.queue_revision,
    configSha256: r.config_sha256,
    promptBodiesEncrypted: r.prompt_bodies_encrypted ?? "",
    promptSha256ByRole: parseJson(r.prompt_sha256_by_role_json, {} as Readonly<Record<JudgeRole, string>>),
    modelSettings: parseJson(r.model_settings_json, {} as JudgeModelSettings),
    retryPolicy: parseJson(r.retry_policy_json, {} as JudgeRetryPolicy),
    budgetLimits: parseJson(r.budget_limits_json, {} as JudgeBudgetLimits),
    subAgentCap: r.sub_agent_cap,
    maxRounds: r.max_rounds,
    toolRegistryVersion: r.tool_registry_version,
    templateSchemaVersion: r.template_schema_version,
    graphVersion: r.graph_version,
    extractorVersion: r.extractor_version,
    runtimeVersions: parseJson(r.runtime_versions_json, {} as Readonly<Record<string, string>>),
    inputArchiveGenerationId: r.input_archive_generation_id,
    inputManifestSha256: r.input_manifest_sha256,
    provenance: parseJson(r.provenance_json, {} as JudgeEvalProvenance),
    createdAt: ts(r.created_at),
  };
}

function toProviderOperationRow(r: Row): JudgeProviderOperationRow {
  return {
    id: r.id,
    caseId: r.case_id,
    attemptId: r.attempt_id,
    node: r.node as JudgeNode,
    metricOrRole: r.metric_or_role,
    round: r.round as JudgeRound | null,
    roundExecutionId: r.round_execution_id,
    assignmentId: r.assignment_id,
    operationKind: r.operation_kind as JudgeProviderOperationKind,
    canonicalRequestDigest: r.canonical_request_digest,
    provider: r.provider,
    model: r.model,
    canonicalUrl: r.canonical_url,
    providerIdempotencyKey: r.provider_idempotency_key,
    providerRequestId: r.provider_request_id,
    state: r.state as JudgeProviderOperationState,
    authoritative: r.authoritative === true,
    responseBlobKey: r.response_blob_key,
    responseBlobHash: r.response_blob_hash,
    usage: parseJson<JudgeUsageSummary | null>(r.usage_json, null),
    cost: r.cost,
    startedAt: tsNull(r.started_at),
    endedAt: tsNull(r.ended_at),
    errorClassification: r.error_classification as JudgeErrorClassification | null,
    createdAt: ts(r.created_at),
  };
}

function toResultVersionRow(r: Row): JudgeResultVersionRow {
  return {
    id: r.id,
    runId: r.run_id,
    caseId: r.case_id,
    judgeQueueId: r.judge_queue_id,
    trackId: r.track_id,
    projectId: r.project_id,
    pipelineVersion: r.pipeline_version,
    templateVersion: r.template_version,
    schemaVersion: r.schema_version,
    configSnapshotId: r.config_snapshot_id,
    configSha256: r.config_sha256,
    rejudgeTriggerId: r.rejudge_trigger_id,
    baseArchiveGenerationId: r.base_archive_generation_id,
    archiveGenerationId: r.archive_generation_id,
    reportBlobKey: r.report_blob_key,
    reportSha256: r.report_sha256,
    reportByteLength: r.report_byte_length,
    publicationState: r.publication_state as JudgePublicationState,
    resultSequence: r.result_sequence as number | null,
    officialReward: r.official_reward as number | null,
    completedAt: tsNull(r.completed_at),
    createdAt: ts(r.created_at),
  };
}

function toCurrentPointerRow(r: Row): JudgeCurrentPointerRow {
  return {
    runId: r.run_id,
    trackId: r.track_id,
    resultVersionId: r.result_version_id,
    archiveViewGenerationId: r.archive_view_generation_id,
    updatedAt: ts(r.updated_at),
  };
}

function toOutboxRow(r: Row): OutboxEventRow {
  return {
    id: r.id,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    eventType: r.event_type,
    payloadVersion: r.payload_version,
    payloadBody: r.payload_body,
    availableAt: ts(r.available_at),
    leaseOwner: r.lease_owner,
    leaseToken: r.lease_token as number | null,
    leaseExpiresAt: tsNull(r.lease_expires_at),
    attempts: r.attempts,
    deliveredAt: tsNull(r.delivered_at),
    lastError: r.last_error,
    createdAt: ts(r.created_at),
  };
}

function toIdempotencyRow(r: Row): IdempotencyKeyRow {
  return {
    key: r.key,
    projectId: r.project_id,
    route: r.route,
    callerIdentity: r.caller_identity,
    requestDigest: r.request_digest,
    state: r.state as IdempotencyKeyState,
    responseStatus: r.response_status,
    responseBodyRef: r.response_body_ref,
    expiresAt: ts(r.expires_at),
    completedAt: tsNull(r.completed_at),
    createdAt: ts(r.created_at),
  };
}

export class PostgresJudgeQueueRepository implements JudgeQueueRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: NewJudgeQueue): Promise<JudgeQueueRow> {
    const id = newId("jq");
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO judge_queues (
         id, project_id, name, status, revision, linked_eval_queue_id, auto_judge,
         track_key, parallelism, priority, retry_policy_json, model_settings_json,
         node0_chunk_size, node2_metric_selection_json, clerk_settings_json,
         node4_settings_json, budget_limits_json, pause_kind, pause_reason,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id, input.projectId, input.name, input.status, input.linkedEvalQueueId,
        input.autoJudge, input.trackKey, input.parallelism, input.priority,
        JSON.stringify(input.retryPolicy), JSON.stringify(input.modelSettings),
        input.node0ChunkSize, JSON.stringify(input.node2MetricSelection),
        JSON.stringify(input.clerkSettings), JSON.stringify(input.node4Settings),
        JSON.stringify(input.budgetLimits), null, null, now, now,
      ],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<JudgeQueueRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_queues WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toQueueRow(row);
  }

  async getByLinkedEvalQueue(evalQueueId: string): Promise<JudgeQueueRow | null> {
    const row = (await this.db.query(
      "SELECT * FROM judge_queues WHERE linked_eval_queue_id = $1",
      [evalQueueId],
    )).rows[0] as Row | undefined;
    return row === undefined ? null : toQueueRow(row);
  }

  async listByProjectCursor(projectId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeQueueRow>> {
    const limit = clampLimit(req.limit);
    const after = req.cursor === null ? null : decodeCursor(req.cursor);
    const rows = (after === null
      ? await this.db.query(
          `SELECT * FROM judge_queues WHERE project_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
          [projectId, limit + 1],
        )
      : await this.db.query(
          `SELECT * FROM judge_queues WHERE project_id = $1
             AND (created_at > $2 OR (created_at = $3 AND id > $4))
             ORDER BY created_at ASC, id ASC LIMIT $5`,
          [projectId, after.createdAt, after.createdAt, after.id, limit + 1],
        )).rows as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toQueueRow);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last as unknown as JudgeJobRow) : null,
    };
  }

  async update(
    id: string,
    expected: { revision: number; status: JudgeQueueStatus },
    patch: JudgeQueuePatch,
  ): Promise<JudgeQueueRow | null> {
    const sets = ["revision = revision + 1", "updated_at = now()"];
    const params: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.status !== undefined) put("status", patch.status);
    if (patch.pauseKind !== undefined) put("pause_kind", patch.pauseKind);
    if (patch.pauseReason !== undefined) put("pause_reason", patch.pauseReason);
    if (patch.name !== undefined) put("name", patch.name);
    if (patch.linkedEvalQueueId !== undefined) put("linked_eval_queue_id", patch.linkedEvalQueueId);
    if (patch.autoJudge !== undefined) put("auto_judge", patch.autoJudge);
    if (patch.parallelism !== undefined) put("parallelism", patch.parallelism);
    if (patch.priority !== undefined) put("priority", patch.priority);
    if (patch.retryPolicy !== undefined) put("retry_policy_json", JSON.stringify(patch.retryPolicy));
    if (patch.modelSettings !== undefined) put("model_settings_json", JSON.stringify(patch.modelSettings));
    if (patch.node0ChunkSize !== undefined) put("node0_chunk_size", patch.node0ChunkSize);
    if (patch.node2MetricSelection !== undefined) put("node2_metric_selection_json", JSON.stringify(patch.node2MetricSelection));
    if (patch.clerkSettings !== undefined) put("clerk_settings_json", JSON.stringify(patch.clerkSettings));
    if (patch.node4Settings !== undefined) put("node4_settings_json", JSON.stringify(patch.node4Settings));
    if (patch.budgetLimits !== undefined) put("budget_limits_json", JSON.stringify(patch.budgetLimits));
    const whereBase = params.length;
    params.push(id, expected.revision, expected.status);
    const result = await this.db.query(
      `UPDATE judge_queues SET ${sets.join(", ")}
         WHERE id = $${whereBase + 1} AND revision = $${whereBase + 2} AND status = $${whereBase + 3}`,
      params,
    );
    if (result.rowCount !== 1) return null;
    return this.get(id);
  }
}

export class PostgresJudgeQueueGenerationRepository implements JudgeQueueGenerationRepository {
  constructor(private readonly db: Queryable) {}

  async get(id: string): Promise<JudgeQueueGenerationRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_queue_generations WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toQueueGenerationRow(row);
  }

  async getCurrentAccepting(judgeQueueId: string): Promise<JudgeQueueGenerationRow | null> {
    const row = (await this.db.query(
      `SELECT * FROM judge_queue_generations WHERE judge_queue_id = $1 AND state = 'accepting'`,
      [judgeQueueId],
    )).rows[0] as Row | undefined;
    return row === undefined ? null : toQueueGenerationRow(row);
  }

  async createNext(input: NewJudgeQueueGeneration): Promise<JudgeQueueGenerationRow> {
    const id = newId("jqg");
    const now = new Date().toISOString();
    const row = (await this.db.query(
      `INSERT INTO judge_queue_generations (
         id, judge_queue_id, queue_revision, config_snapshot_id, ordinal,
         state, source_trigger, created_at
       ) VALUES (
         $1, $2, $3, $4,
         (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM judge_queue_generations WHERE judge_queue_id = $2),
         'accepting', $5, $6
       )
       RETURNING *`,
      [id, input.judgeQueueId, input.queueRevision, input.configSnapshotId, input.sourceTrigger, now],
    )).rows[0] as Row;
    return toQueueGenerationRow(row);
  }

  async close(id: string): Promise<JudgeQueueGenerationRow | null> {
    const result = await this.db.query(
      `UPDATE judge_queue_generations SET state = 'closed', closed_at = now()
         WHERE id = $1 AND state = 'accepting'`,
      [id],
    );
    if (result.rowCount !== 1) return null;
    return this.get(id);
  }

  async listByQueueCursor(judgeQueueId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeQueueGenerationRow>> {
    const limit = clampLimit(req.limit);
    const after = req.cursor === null ? null : decodeCursor(req.cursor);
    const rows = (after === null
      ? await this.db.query(
          `SELECT * FROM judge_queue_generations WHERE judge_queue_id = $1 ORDER BY ordinal ASC, id ASC LIMIT $2`,
          [judgeQueueId, limit + 1],
        )
      : await this.db.query(
          `SELECT * FROM judge_queue_generations WHERE judge_queue_id = $1 AND ordinal > $2
             ORDER BY ordinal ASC, id ASC LIMIT $3`,
          [judgeQueueId, Number(after.createdAt) || 0, limit + 1],
        )).rows as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toQueueGenerationRow);
    return { items, hasMore, nextCursor: hasMore ? this.encodeGeneration(items.at(-1)!) : null };
  }

  private encodeGeneration(row: JudgeQueueGenerationRow): string {
    return opaqueCursorCodec.encode({
      orderValues: [row.ordinal, row.id],
      direction: "asc",
      version: CURSOR_VERSION,
    });
  }
}

export class PostgresJudgeConfigSnapshotRepository implements JudgeConfigSnapshotRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: NewJudgeConfigSnapshot): Promise<JudgeConfigSnapshotRow> {
    const id = newId("jcfg");
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO judge_config_snapshots (
         id, judge_queue_id, project_id, job_id, queue_revision, config_sha256,
         prompt_bodies_encrypted, prompt_sha256_by_role_json, model_settings_json,
         retry_policy_json, budget_limits_json, sub_agent_cap, max_rounds,
         tool_registry_version, template_schema_version, graph_version,
         extractor_version, runtime_versions_json, input_archive_generation_id,
         input_manifest_sha256, provenance_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        id, input.judgeQueueId, input.projectId, input.jobId, input.queueRevision,
        input.configSha256, input.promptBodiesEncrypted,
        JSON.stringify(input.promptSha256ByRole), JSON.stringify(input.modelSettings),
        JSON.stringify(input.retryPolicy), JSON.stringify(input.budgetLimits),
        input.subAgentCap, input.maxRounds, input.toolRegistryVersion,
        input.templateSchemaVersion, input.graphVersion, input.extractorVersion,
        JSON.stringify(input.runtimeVersions), input.inputArchiveGenerationId,
        input.inputManifestSha256, JSON.stringify(input.provenance), now,
      ],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<JudgeConfigSnapshotRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_config_snapshots WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toConfigSnapshotRow(row);
  }

  async getByJob(jobId: string): Promise<JudgeConfigSnapshotRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_config_snapshots WHERE job_id = $1", [jobId])).rows[0] as Row | undefined;
    return row === undefined ? null : toConfigSnapshotRow(row);
  }

  async deleteEncryptedPromptBodies(id: string): Promise<void> {
    await this.db.query(
      `UPDATE judge_config_snapshots SET prompt_bodies_encrypted = NULL WHERE id = $1`,
      [id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM judge_config_snapshots WHERE id = $1`, [id]);
  }
}

export class PostgresJudgeProviderOperationRepository implements JudgeProviderOperationRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: NewJudgeProviderOperation): Promise<JudgeProviderOperationRow> {
    const id = newId("jpo");
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO judge_provider_operations (
         id, case_id, attempt_id, node, metric_or_role, round, round_execution_id,
         assignment_id, operation_kind, canonical_request_digest, provider, model,
         canonical_url, provider_idempotency_key, state, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'not_started',$15)`,
      [
        id, input.caseId, input.attemptId, input.node, input.metricOrRole, input.round,
        input.roundExecutionId, input.assignmentId, input.operationKind,
        input.canonicalRequestDigest, input.provider, input.model, input.canonicalUrl,
        input.providerIdempotencyKey, now,
      ],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<JudgeProviderOperationRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_provider_operations WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toProviderOperationRow(row);
  }

  async getByLogicalKey(attemptId: string, key: JudgeProviderOperationLogicalKey): Promise<JudgeProviderOperationRow | null> {
    const row = (await this.db.query(
      `SELECT * FROM judge_provider_operations
         WHERE attempt_id = $1 AND node = $2 AND metric_or_role = $3
           AND COALESCE(round, -1) = COALESCE($4, -1)
           AND COALESCE(round_execution_id, '') = COALESCE($5, '')
           AND COALESCE(assignment_id, '') = COALESCE($6, '')
           AND canonical_request_digest = $7 AND provider = $8
           AND COALESCE(model, '') = COALESCE($9, '')`,
      [
        attemptId, key.node, key.metricOrRole, key.round, key.roundExecutionId,
        key.assignmentId, key.canonicalRequestDigest, key.provider, key.model,
      ],
    )).rows[0] as Row | undefined;
    return row === undefined ? null : toProviderOperationRow(row);
  }

  async begin(id: string, expected: { attemptId: string; fencingToken: FencingToken }): Promise<JudgeProviderOperationRow | null> {
    const result = await this.db.query(
      `UPDATE judge_provider_operations SET state = 'in_flight', started_at = now()
         WHERE id = $1 AND attempt_id = $2 AND state = 'not_started'`,
      [id, expected.attemptId],
    );
    if (result.rowCount !== 1) return null;
    return this.get(id);
  }

  async succeed(
    id: string,
    expected: { attemptId: string; fencingToken: FencingToken },
    result: JudgeProviderSuccess,
  ): Promise<JudgeProviderOperationRow | null> {
    const r = await this.db.query(
      `UPDATE judge_provider_operations
         SET state = 'succeeded', provider_request_id = $1, response_blob_key = $2,
             response_blob_hash = $3, usage_json = $4, cost = $5, ended_at = $6
         WHERE id = $7 AND attempt_id = $8 AND state = 'in_flight'`,
      [
        result.providerRequestId, result.responseBlobKey, result.responseBlobHash,
        JSON.stringify(result.usage), result.cost, result.endedAt, id, expected.attemptId,
      ],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async fail(
    id: string,
    expected: { attemptId: string; fencingToken: FencingToken },
    failure: JudgeProviderFailure,
  ): Promise<JudgeProviderOperationRow | null> {
    const r = await this.db.query(
      `UPDATE judge_provider_operations
         SET state = 'failed', error_classification = $1, ended_at = $2
         WHERE id = $3 AND attempt_id = $4 AND state = 'in_flight'`,
      [failure.classification, failure.endedAt, id, expected.attemptId],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async markUnknown(id: string, expected: { attemptId: string }): Promise<JudgeProviderOperationRow | null> {
    const r = await this.db.query(
      `UPDATE judge_provider_operations
         SET state = 'unknown', error_classification = $1, ended_at = now()
         WHERE id = $2 AND attempt_id = $3 AND state = 'in_flight'`,
      [JUDGE_ERROR_CLASSIFICATION.worker_loss, id, expected.attemptId],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async markInFlightUnknownByAttempt(attemptId: string): Promise<number> {
    const r = await this.db.query(
      `UPDATE judge_provider_operations
         SET state = 'unknown', error_classification = $1, ended_at = now()
         WHERE attempt_id = $2 AND state = 'in_flight'`,
      [JUDGE_ERROR_CLASSIFICATION.worker_loss, attemptId],
    );
    return r.rowCount ?? 0;
  }

  async setAuthoritative(
    id: string,
    expected: { attemptId: string; fencingToken: FencingToken },
  ): Promise<JudgeProviderOperationRow | null> {
    const r = await this.db.query(
      `UPDATE judge_provider_operations SET authoritative = TRUE
         WHERE id = $1 AND attempt_id = $2 AND state = 'succeeded'`,
      [id, expected.attemptId],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async listByAttemptCursor(attemptId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeProviderOperationRow>> {
    const limit = clampLimit(req.limit);
    const after = req.cursor === null ? null : decodeCursor(req.cursor);
    const rows = (after === null
      ? await this.db.query(
          `SELECT * FROM judge_provider_operations WHERE attempt_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
          [attemptId, limit + 1],
        )
      : await this.db.query(
          `SELECT * FROM judge_provider_operations WHERE attempt_id = $1
             AND (created_at > $2 OR (created_at = $3 AND id > $4))
             ORDER BY created_at ASC, id ASC LIMIT $5`,
          [attemptId, after.createdAt, after.createdAt, after.id, limit + 1],
        )).rows as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toProviderOperationRow);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last as unknown as JudgeJobRow) : null,
    };
  }
}

export class PostgresJudgeResultVersionRepository implements JudgeResultVersionRepository {
  constructor(private readonly db: Queryable) {}

  async createStaging(input: NewJudgeResultVersion): Promise<JudgeResultVersionRow> {
    const id = newId("jrv");
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO judge_result_versions (
         id, run_id, case_id, judge_queue_id, track_id, project_id, pipeline_version,
         template_version, schema_version, config_snapshot_id, config_sha256,
         rejudge_trigger_id, base_archive_generation_id, archive_generation_id,
         report_blob_key, report_sha256, report_byte_length, publication_state,
         official_reward, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'preparing',$18,$19)`,
      [
        id, input.runId, input.caseId, input.judgeQueueId, input.trackId, input.projectId,
        input.pipelineVersion, input.templateVersion, input.schemaVersion,
        input.configSnapshotId, input.configSha256, input.rejudgeTriggerId,
        input.baseArchiveGenerationId, input.archiveGenerationId, input.reportBlobKey,
        input.reportSha256, input.reportByteLength, input.officialReward, now,
      ],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<JudgeResultVersionRow | null> {
    const row = (await this.db.query("SELECT * FROM judge_result_versions WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toResultVersionRow(row);
  }

  async listByRunCursor(runId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>> {
    return this.page("run_id", runId, req);
  }
  async listByProjectCursor(projectId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>> {
    return this.page("project_id", projectId, req);
  }
  async listByQueueCursor(judgeQueueId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>> {
    return this.page("judge_queue_id", judgeQueueId, req);
  }

  private async page(
    column: "run_id" | "project_id" | "judge_queue_id",
    value: string,
    req: KeysetPageRequest,
  ): Promise<KeysetPage<JudgeResultVersionRow>> {
    const limit = clampLimit(req.limit);
    const after = req.cursor === null ? null : decodeCursor(req.cursor);
    const rows = (after === null
      ? await this.db.query(
          `SELECT * FROM judge_result_versions WHERE ${column} = $1
             ORDER BY completed_at ASC NULLS LAST, id ASC LIMIT $2`,
          [value, limit + 1],
        )
      : await this.db.query(
          `SELECT * FROM judge_result_versions WHERE ${column} = $1
             AND (completed_at > $2 OR (completed_at IS NULL AND $2 IS NOT NULL)
                  OR (completed_at = $2 AND id > $3))
             ORDER BY completed_at ASC NULLS LAST, id ASC LIMIT $4`,
          [value, after.createdAt, after.id, limit + 1],
        )).rows as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toResultVersionRow);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last !== undefined
        ? opaqueCursorCodec.encode({
            orderValues: [last.completedAt ?? "", last.id],
            direction: "asc",
            version: CURSOR_VERSION,
          })
        : null,
    };
  }

  async transitionPublication(
    id: string,
    expected: JudgePublicationState,
    next: JudgePublicationState,
  ): Promise<JudgeResultVersionRow | null> {
    const r = await this.db.query(
      `UPDATE judge_result_versions SET publication_state = $1
         WHERE id = $2 AND publication_state = $3`,
      [next, id, expected],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async publish(id: string, expected: { publicationState: "verified" }): Promise<JudgeResultVersionRow | null> {
    const r = await this.db.query(
      `UPDATE judge_result_versions
         SET publication_state = 'published',
             result_sequence = nextval('seq_jrv_result_sequence'),
             completed_at = now()
         WHERE id = $1 AND publication_state = $2`,
      [id, expected.publicationState],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async markInvalid(id: string, reason: string): Promise<JudgeResultVersionRow | null> {
    const r = await this.db.query(
      `UPDATE judge_result_versions SET publication_state = 'invalid'
         WHERE id = $1 AND publication_state != 'published'`,
      [id],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async markSuperseded(id: string): Promise<JudgeResultVersionRow | null> {
    const r = await this.db.query(
      `UPDATE judge_result_versions SET publication_state = 'superseded'
         WHERE id = $1 AND publication_state = 'published'`,
      [id],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async listForExport(
    projectId: string,
    asOfSequence: number,
    req: KeysetPageRequest,
  ): Promise<KeysetPage<JudgeResultVersionRow>> {
    const limit = clampLimit(req.limit);
    const after = req.cursor === null ? null : decodeCursor(req.cursor);
    const rows = (after === null
      ? await this.db.query(
          `SELECT * FROM judge_result_versions
             WHERE project_id = $1 AND publication_state = 'published'
               AND result_sequence <= $2
             ORDER BY result_sequence ASC, id ASC LIMIT $3`,
          [projectId, asOfSequence, limit + 1],
        )
      : await this.db.query(
          `SELECT * FROM judge_result_versions
             WHERE project_id = $1 AND publication_state = 'published'
               AND result_sequence <= $2 AND result_sequence > $3
             ORDER BY result_sequence ASC, id ASC LIMIT $4`,
          [projectId, asOfSequence, Number(after.createdAt) || 0, limit + 1],
        )).rows as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toResultVersionRow);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last !== undefined
        ? opaqueCursorCodec.encode({
            orderValues: [last.resultSequence ?? 0, last.id],
            direction: "asc",
            version: CURSOR_VERSION,
          })
        : null,
    };
  }
}

export class PostgresJudgeCurrentPointerRepository implements JudgeCurrentPointerRepository {
  constructor(private readonly db: Queryable) {}

  async get(runId: string, trackId: string): Promise<JudgeCurrentPointerRow | null> {
    const row = (await this.db.query(
      "SELECT * FROM judge_current_pointers WHERE run_id = $1 AND track_id = $2",
      [runId, trackId],
    )).rows[0] as Row | undefined;
    return row === undefined ? null : toCurrentPointerRow(row);
  }

  async advance(
    runId: string,
    trackId: string,
    expected: JudgeCurrentPointerCas,
    next: JudgeCurrentPointerRow,
  ): Promise<JudgeCurrentPointerRow | null> {
    const existing = await this.get(runId, trackId);
    const expectedResult = expected.expectedCurrent.resultVersionId;
    const expectedView = expected.expectedCurrent.archiveViewGenerationId;
    const matches = existing === null
      ? expectedResult === null && expectedView === null
      : existing.resultVersionId === expectedResult && existing.archiveViewGenerationId === expectedView;
    if (!matches) return null;
    const r = await this.db.query(
      `INSERT INTO judge_current_pointers (run_id, track_id, result_version_id, archive_view_generation_id, updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (run_id, track_id)
         DO UPDATE SET result_version_id = EXCLUDED.result_version_id,
                       archive_view_generation_id = EXCLUDED.archive_view_generation_id,
                       updated_at = EXCLUDED.updated_at
         WHERE judge_current_pointers.result_version_id = $6
           AND judge_current_pointers.archive_view_generation_id = $7`,
      [runId, trackId, next.resultVersionId, next.archiveViewGenerationId, new Date().toISOString(),
       expectedResult ?? "", expectedView ?? ""],
    );
    if (r.rowCount !== 1) return null;
    return this.get(runId, trackId);
  }

  async listByRun(runId: string): Promise<readonly JudgeCurrentPointerRow[]> {
    const rows = (await this.db.query(
      "SELECT * FROM judge_current_pointers WHERE run_id = $1 ORDER BY track_id ASC",
      [runId],
    )).rows as Row[];
    return rows.map(toCurrentPointerRow);
  }
}

export class PostgresOutboxEventRepository implements OutboxEventRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(input: NewOutboxEvent): Promise<OutboxEventRow> {
    const id = newId("outbox");
    const now = new Date().toISOString();
    // At-least-once seal: re-enqueueing the same aggregate event is a no-op
    // that returns the already-inserted row (the frozen identity includes
    // aggregate_version), never a duplicate and never a throw.
    await this.db.query(
      `INSERT INTO outbox_events (
         id, aggregate_type, aggregate_id, aggregate_version, event_type,
         payload_version, payload_body, available_at, attempts, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9)
       ON CONFLICT (aggregate_type, event_type, aggregate_version, aggregate_id) DO NOTHING`,
      [
        id, input.aggregateType, input.aggregateId, input.aggregateVersion,
        input.eventType, input.payloadVersion, input.payloadBody, input.availableAt, now,
      ],
    );
    const row = (await this.db.query(
      `SELECT * FROM outbox_events
         WHERE aggregate_type = $1 AND event_type = $2
           AND aggregate_version = $3 AND aggregate_id = $4`,
      [input.aggregateType, input.eventType, input.aggregateVersion, input.aggregateId],
    )).rows[0] as Row;
    return toOutboxRow(row);
  }

  async get(id: string): Promise<OutboxEventRow | null> {
    const row = (await this.db.query("SELECT * FROM outbox_events WHERE id = $1", [id])).rows[0] as Row | undefined;
    return row === undefined ? null : toOutboxRow(row);
  }

  async claimNext(opts: LeaseClaimOptions): Promise<OutboxEventRow | null> {
    return inTransaction(this.db, async (q) => {
      const candidate = (await q.query(
        `SELECT * FROM outbox_events
           WHERE delivered_at IS NULL AND available_at <= $1::timestamptz
             AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        [opts.now],
      )).rows[0] as Row | undefined;
      if (candidate === undefined) return null;
      const token = ((candidate.lease_token as number | null) ?? 0) + 1;
      const expiresAt = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();
      const updated = await q.query(
        `UPDATE outbox_events
           SET lease_owner = $1, lease_token = $2, lease_expires_at = $3, attempts = attempts + 1
           WHERE id = $4 AND (lease_expires_at IS NULL OR lease_expires_at <= $5::timestamptz)`,
        [opts.workerId, token, expiresAt, candidate.id, opts.now],
      );
      if (updated.rowCount !== 1) return null;
      return toOutboxRow((await q.query("SELECT * FROM outbox_events WHERE id = $1", [candidate.id])).rows[0]);
    });
  }

  async markDelivered(id: string, expected: { leaseToken: number; leaseOwner: string }): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE outbox_events SET delivered_at = now()
         WHERE id = $1 AND lease_token = $2 AND lease_owner = $3 AND delivered_at IS NULL`,
      [id, expected.leaseToken, expected.leaseOwner],
    );
    return r.rowCount === 1;
  }

  async releaseLease(id: string, expected: { leaseToken: number }, error: string): Promise<OutboxEventRow | null> {
    const r = await this.db.query(
      `UPDATE outbox_events
         SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             attempts = attempts + 1, last_error = $1
         WHERE id = $2 AND lease_token = $3 AND delivered_at IS NULL`,
      [error, id, expected.leaseToken],
    );
    if (r.rowCount !== 1) return null;
    return this.get(id);
  }

  async requeueExpiredLeases(opts: RequeueOptions): Promise<number> {
    const limit = clampLimit(opts.limit);
    const cutoff = new Date(Date.parse(opts.now) - opts.maxLeaseAgeMs).toISOString();
    return inTransaction(this.db, async (q) => {
      const expired = (await q.query(
        `SELECT * FROM outbox_events
           WHERE delivered_at IS NULL AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= $1::timestamptz
           ORDER BY lease_expires_at ASC, id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
        [cutoff, limit],
      )).rows as Row[];
      let requeued = 0;
      for (const ev of expired) {
        const moved = await q.query(
          `UPDATE outbox_events
             SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
             WHERE id = $1 AND lease_expires_at <= $2::timestamptz AND delivered_at IS NULL`,
          [ev.id, cutoff],
        );
        if (moved.rowCount === 1) requeued += 1;
      }
      return requeued;
    });
  }

  async listPendingCursor(now: DbTimestamp, req: KeysetPageRequest): Promise<KeysetPage<OutboxEventRow>> {
    const limit = clampLimit(req.limit);
    const after = req.cursor === null ? null : decodeCursor(req.cursor);
    const rows = (after === null
      ? await this.db.query(
          `SELECT * FROM outbox_events
             WHERE delivered_at IS NULL AND available_at <= $1::timestamptz
             ORDER BY available_at ASC, created_at ASC, id ASC LIMIT $2`,
          [now, limit + 1],
        )
      : await this.db.query(
          `SELECT * FROM outbox_events
             WHERE delivered_at IS NULL AND available_at <= $1::timestamptz
               AND (available_at > $2 OR (available_at = $3 AND id > $4))
             ORDER BY available_at ASC, created_at ASC, id ASC LIMIT $5`,
          [now, after.createdAt, after.createdAt, after.id, limit + 1],
        )).rows as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toOutboxRow);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last as unknown as JudgeJobRow) : null,
    };
  }
}

export class PostgresIdempotencyKeyRepository implements IdempotencyKeyRepository {
  constructor(private readonly db: Queryable) {}

  async createIfAbsent(input: NewIdempotencyKey): Promise<{ key: IdempotencyKeyRow; created: boolean }> {
    const now = new Date().toISOString();
    const result = await this.db.query(
      `INSERT INTO idempotency_keys (
         key, project_id, route, caller_identity, request_digest, state, expires_at, created_at
       ) VALUES ($1,$2,$3,$4,$5,'in_progress',$6,$7)
         ON CONFLICT (project_id, route, caller_identity, key) DO NOTHING`,
      [
        input.key, input.projectId, input.route, input.callerIdentity,
        input.requestDigest, input.expiresAt, now,
      ],
    );
    const row = (await this.db.query(
      `SELECT * FROM idempotency_keys
         WHERE project_id = $1 AND route = $2 AND caller_identity = $3 AND key = $4`,
      [input.projectId, input.route, input.callerIdentity, input.key],
    )).rows[0] as Row;
    return { key: toIdempotencyRow(row), created: (result.rowCount ?? 0) === 1 };
  }

  async get(ref: IdempotencyKeyRef): Promise<IdempotencyKeyRow | null> {
    const row = (await this.db.query(
      `SELECT * FROM idempotency_keys WHERE project_id = $1 AND key = $2`,
      [ref.projectId, ref.key],
    )).rows[0] as Row | undefined;
    return row === undefined ? null : toIdempotencyRow(row);
  }

  async getReplay(ref: IdempotencyKeyRef, gracePeriodMs: number, now: DbTimestamp): Promise<IdempotencyKeyRow | null> {
    const floor = new Date(Date.parse(now) - gracePeriodMs).toISOString();
    const row = (await this.db.query(
      `SELECT * FROM idempotency_keys
         WHERE project_id = $1 AND key = $2 AND state = 'completed' AND expires_at >= $3::timestamptz`,
      [ref.projectId, ref.key, floor],
    )).rows[0] as Row | undefined;
    return row === undefined ? null : toIdempotencyRow(row);
  }

  async complete(
    ref: IdempotencyKeyRef,
    expected: { state: "in_progress" },
    result: { responseStatus: number; responseBodyRef: string | null; completedAt: DbTimestamp },
  ): Promise<IdempotencyKeyRow | null> {
    const r = await this.db.query(
      `UPDATE idempotency_keys
         SET state = 'completed', response_status = $1, response_body_ref = $2, completed_at = $3
         WHERE project_id = $4 AND key = $5 AND state = 'in_progress'`,
      [result.responseStatus, result.responseBodyRef, result.completedAt, ref.projectId, ref.key],
    );
    if (r.rowCount !== 1) return null;
    return this.get(ref);
  }

  async deleteExpired(now: DbTimestamp): Promise<number> {
    const r = await this.db.query(`DELETE FROM idempotency_keys WHERE expires_at < $1::timestamptz`, [now]);
    return r.rowCount ?? 0;
  }
}

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
  JUDGE_ATTEMPT_STATE,
  JUDGE_ERROR_CLASSIFICATION,
  JUDGE_JOB_STATE,
  JUDGE_PROVIDER_OPERATION_STATE,
  opaqueCursorCodec,
  type AttemptNumber,
  type DbTimestamp,
  type FencingToken,
  type JudgeAttemptRepository,
  type JudgeAttemptRow,
  type JudgeAttemptState,
  type JudgeCheckpoint,
  type JudgeClaimResult,
  type JudgeErrorClassification,
  type JudgeFencing,
  type JudgeJobPatch,
  type JudgeJobRepository,
  type JudgeJobRow,
  type JudgeJobState,
  type JudgeNode,
  type JudgePauseKind,
  type JudgePublicationPolicy,
  type JudgeRound,
  type JudgeUsageSummary,
  type KeysetPage,
  type KeysetPageRequest,
  type LeaseClaimOptions,
  type NewJudgeAttempt,
  type NewJudgeJob,
  type RequeueOptions,
} from "../contracts.js";

type Queryable = Pool | PoolClient;

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
  /** Requires a Pool so claimNext can check out a transaction client. */
  constructor(private readonly db: Pool) {}

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
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const candidateRes = await client.query(
        `SELECT * FROM judge_jobs
           WHERE judge_queue_id = $1 AND state = ANY($2::text[]) AND available_at <= $3::timestamptz
           ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        [judgeQueueId, [...CLAIMABLE_STATES], opts.now],
      );
      const candidate = candidateRes.rows[0] as Row | undefined;
      if (candidate === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      const nextToken = (candidate.fencing_token as number) + 1;
      const attemptNumber = (candidate.attempt_count as number) + 1;
      const attemptId = newId("jatt");
      const expiresAt = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();

      const updated = await client.query(
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
      if (updated.rowCount !== 1) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
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
      const job = toJobRow((await client.query("SELECT * FROM judge_jobs WHERE id = $1", [candidate.id])).rows[0]);
      const attempt = toAttemptRow((await client.query("SELECT * FROM judge_attempts WHERE id = $1", [attemptId])).rows[0]);
      await client.query("COMMIT");
      return { job, attempt, fencingToken: nextToken };
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
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

  async requeueExpiredLeases(opts: RequeueOptions): Promise<number> {
    const limit = clampLimit(opts.limit);
    const cutoff = new Date(Date.parse(opts.now) - opts.maxLeaseAgeMs).toISOString();
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const expired = (await client.query(
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
        const moved = await client.query(
          `UPDATE judge_jobs
             SET state = $1, lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL, active_attempt_id = NULL,
                 active_attempt_number = NULL, available_at = $2, updated_at = $3
             WHERE id = $4 AND state = $5 AND fencing_token = $6`,
          [JUDGE_JOB_STATE.waiting_retry, opts.now, opts.now, job.id, job.state, job.fencing_token],
        );
        if (moved.rowCount !== 1) continue;
        if (job.active_attempt_id !== null) {
          await client.query(
            `UPDATE judge_attempts SET state = $1, error_classification = $2, ended_at = $3
               WHERE id = $4 AND state = $5`,
            [JUDGE_ATTEMPT_STATE.lost, JUDGE_ERROR_CLASSIFICATION.worker_loss, opts.now,
             job.active_attempt_id, JUDGE_ATTEMPT_STATE.running],
          );
          await client.query(
            `UPDATE judge_provider_operations
               SET state = $1, error_classification = $2, ended_at = $3
               WHERE attempt_id = $4 AND state = $5`,
            [JUDGE_PROVIDER_OPERATION_STATE.unknown, JUDGE_ERROR_CLASSIFICATION.worker_loss,
             opts.now, job.active_attempt_id, JUDGE_PROVIDER_OPERATION_STATE.in_flight],
          );
        }
        requeued += 1;
      }
      await client.query("COMMIT");
      return requeued;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
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

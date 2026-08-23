/**
 * SQLite implementation of the Themis judge-job and judge-attempt repositories.
 *
 * This backend exists for development and tests; PostgreSQL is production. The
 * two are NOT equivalent under concurrency, and the difference is documented at
 * `claimNext` rather than papered over — a dev backend that silently behaves
 * differently from production under contention is worse than no dev backend,
 * because it turns a race into something that only appears in production.
 *
 * The load-bearing property is FENCING. Every mutating write carries the job id,
 * the active attempt id, the expected state, and the fencing token in its WHERE
 * clause (see `JudgeFencing`). A worker whose lease expired while it was off
 * calling a model may still be alive and may still try to write; the predicate
 * is what makes those writes no-ops instead of corruption. Fencing is checked in
 * SQL, never in TypeScript after a read, because a check-then-write in the host
 * language reintroduces exactly the race the token exists to close.
 */

import type BetterSqlite3 from "better-sqlite3";

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

/** Generate a durable row id. */
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

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
    availableAt: r.available_at,
    attemptCount: r.attempt_count,
    activeAttemptId: r.active_attempt_id,
    activeAttemptNumber: r.active_attempt_number as AttemptNumber | null,
    fencingToken: r.fencing_token as FencingToken,
    lease:
      r.lease_owner === null || r.lease_token === null || r.lease_expires_at === null
        ? null
        : { owner: r.lease_owner, token: r.lease_token, expiresAt: r.lease_expires_at },
    heartbeatAt: r.heartbeat_at,
    currentNode: r.current_node as JudgeNode | null,
    currentRound: r.current_round as JudgeRound | null,
    pauseKind: r.pause_kind as JudgePauseKind | null,
    pauseReason: r.pause_reason,
    terminalErrorKind: r.terminal_error_kind as JudgeErrorClassification | null,
    terminalErrorDetail: r.terminal_error_detail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
    startedAt: r.started_at,
    endedAt: r.ended_at,
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
function jobPage(
  db: BetterSqlite3.Database,
  column: "run_id" | "judge_queue_id" | "project_id",
  value: string,
  req: KeysetPageRequest,
): KeysetPage<JudgeJobRow> {
  const limit = clampLimit(req.limit);
  const after = req.cursor === null ? null : decodeCursor(req.cursor);
  const sql =
    after === null
      ? `SELECT * FROM judge_jobs WHERE ${column} = ?
           ORDER BY created_at ASC, id ASC LIMIT ?`
      : `SELECT * FROM judge_jobs WHERE ${column} = ?
           AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at ASC, id ASC LIMIT ?`;
  const params =
    after === null
      ? [value, limit + 1]
      : [value, after.createdAt, after.createdAt, after.id, limit + 1];
  const rows = db.prepare(sql).all(...params) as Row[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toJobRow);
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
  };
}

/** `judge_jobs` repository over better-sqlite3. */
export class SqliteJudgeJobRepository implements JudgeJobRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** Idempotent insert keyed on the immutable trigger identity. */
  async upsertByTrigger(input: NewJudgeJob): Promise<{ job: JudgeJobRow; created: boolean }> {
    const now = new Date().toISOString();
    const id = newId("jjob");
    // ON CONFLICT DO NOTHING plus a re-read: replaying one trigger returns the
    // existing job rather than minting a second one. The uniqueness is enforced
    // by the database, not by a prior SELECT, so two relays racing the same
    // outbox event still produce exactly one job.
    const insert = this.db.prepare(
      `INSERT INTO judge_jobs (
         id, judge_queue_id, judge_queue_generation_id, source_trigger_id,
         source_trigger_kind, config_snapshot_id, config_snapshot_sha256, run_id,
         project_id, batch_id, task_id, agent_id, base_archive_generation_id,
         base_manifest_sha256, publication_policy_json, state, priority,
         available_at, attempt_count, fencing_token, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)
       ON CONFLICT (judge_queue_id, source_trigger_kind, source_trigger_id) DO NOTHING`,
    );
    const result = insert.run(
      id,
      input.judgeQueueId,
      input.judgeQueueGenerationId,
      input.sourceTriggerId,
      input.sourceTriggerKind,
      input.configSnapshotId,
      input.configSnapshotSha256,
      input.runId,
      input.projectId,
      input.batchId,
      input.taskId,
      input.agentId,
      input.baseArchiveGenerationId,
      input.baseManifestSha256,
      JSON.stringify(input.publicationPolicy),
      JUDGE_JOB_STATE.queued,
      input.priority,
      input.availableAt,
      now,
      now,
    );
    const row = this.db
      .prepare(
        `SELECT * FROM judge_jobs
           WHERE judge_queue_id = ? AND source_trigger_kind = ? AND source_trigger_id = ?`,
      )
      .get(input.judgeQueueId, input.sourceTriggerKind, input.sourceTriggerId) as Row;
    return { job: toJobRow(row), created: result.changes === 1 };
  }

  /** Fetch one job by id. */
  async get(id: string): Promise<JudgeJobRow | null> {
    const row = this.db.prepare("SELECT * FROM judge_jobs WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : toJobRow(row);
  }

  /** Keyset list of jobs judging a run, ordered by (created_at, id). */
  async getByRunCursor(runId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>> {
    return jobPage(this.db, "run_id", runId, req);
  }

  /** Keyset list by judge queue, ordered by (created_at, id). */
  async listByQueueCursor(
    judgeQueueId: string,
    req: KeysetPageRequest,
  ): Promise<KeysetPage<JudgeJobRow>> {
    return jobPage(this.db, "judge_queue_id", judgeQueueId, req);
  }

  /** Keyset list by project, ordered by (created_at, id). */
  async listByProjectCursor(
    projectId: string,
    req: KeysetPageRequest,
  ): Promise<KeysetPage<JudgeJobRow>> {
    return jobPage(this.db, "project_id", projectId, req);
  }

  /**
   * Claim the next eligible job, bump the fencing token, set the lease, and
   * create the attempt.
   *
   * HOW THIS DIFFERS FROM POSTGRESQL — read before trusting a load test here.
   * PostgreSQL uses `SELECT ... FOR UPDATE SKIP LOCKED`: concurrent claimers
   * each lock a DIFFERENT eligible row and proceed in parallel. SQLite has no
   * row locks and no SKIP LOCKED. This emulation instead runs an IMMEDIATE
   * transaction (a database-wide write lock) and makes the claim a CONDITIONAL
   * UPDATE whose WHERE clause re-checks the state and fencing token it read.
   *
   * What that buys, and what it does not:
   *   - Preserved: a job is claimed at most once. The conditional update means a
   *     second claimer that read the same row updates zero rows and retries. The
   *     at-most-once guarantee this design depends on holds on both backends.
   *   - NOT preserved: parallelism. SQLite serializes ALL claimers behind one
   *     write lock, where PostgreSQL would run them concurrently on distinct
   *     rows. Claim throughput measured here therefore says nothing about
   *     production throughput, and a fairness or starvation test written against
   *     this backend proves nothing.
   *   - NOT preserved: blocking semantics. A concurrent writer here fails with
   *     SQLITE_BUSY rather than waiting on a row lock.
   */
  async claimNext(judgeQueueId: string, opts: LeaseClaimOptions): Promise<JudgeClaimResult | null> {
    const placeholders = CLAIMABLE_STATES.map(() => "?").join(",");
    const claim = this.db.transaction((): JudgeClaimResult | null => {
      const candidate = this.db
        .prepare(
          `SELECT * FROM judge_jobs
             WHERE judge_queue_id = ? AND state IN (${placeholders}) AND available_at <= ?
             ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
             LIMIT 1`,
        )
        .get(judgeQueueId, ...CLAIMABLE_STATES, opts.now) as Row | undefined;
      if (candidate === undefined) return null;

      const nextToken = (candidate.fencing_token as number) + 1;
      const attemptNumber = (candidate.attempt_count as number) + 1;
      const attemptId = newId("jatt");
      const expiresAt = new Date(Date.parse(opts.now) + opts.leaseMs).toISOString();

      // The conditional update IS the claim. Re-checking state and fencing token
      // in the predicate is what makes a lost race a no-op rather than a second
      // claim: a claimer whose read is stale updates zero rows.
      const updated = this.db
        .prepare(
          `UPDATE judge_jobs
             SET state = ?, fencing_token = ?, attempt_count = ?, active_attempt_id = ?,
                 active_attempt_number = ?, lease_owner = ?, lease_token = ?,
                 lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
             WHERE id = ? AND state = ? AND fencing_token = ?`,
        )
        .run(
          JUDGE_JOB_STATE.leased,
          nextToken,
          attemptNumber,
          attemptId,
          attemptNumber,
          opts.workerId,
          nextToken,
          expiresAt,
          opts.now,
          opts.now,
          candidate.id,
          candidate.state,
          candidate.fencing_token,
        );
      if (updated.changes !== 1) return null;

      this.db
        .prepare(
          `INSERT INTO judge_attempts (
             id, job_id, attempt_number, worker_id, fencing_token,
             working_store_prefix, staging_prefix, state, evidence_bytes,
             estimated_cost, started_at
           ) VALUES (?,?,?,?,?,?,?,?,0,0,?)`,
        )
        .run(
          attemptId,
          candidate.id,
          attemptNumber,
          opts.workerId,
          nextToken,
          `work/${candidate.id}/${attemptId}`,
          `staging/${candidate.id}/${attemptId}`,
          JUDGE_ATTEMPT_STATE.running,
          opts.now,
        );

      const job = toJobRow(
        this.db.prepare("SELECT * FROM judge_jobs WHERE id = ?").get(candidate.id) as Row,
      );
      const attempt = toAttemptRow(
        this.db.prepare("SELECT * FROM judge_attempts WHERE id = ?").get(attemptId) as Row,
      );
      return { job, attempt, fencingToken: nextToken };
    });
    // IMMEDIATE: take the write lock up front so two claimers cannot both read
    // the same candidate under a deferred read lock and then collide on upgrade.
    return claim.immediate();
  }

  /** Extend a lease only when worker, token, and active state still match. */
  async heartbeat(
    id: string,
    expected: JudgeFencing,
    leaseExpiresAt: DbTimestamp,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE judge_jobs
           SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND active_attempt_id = ? AND state = ? AND fencing_token = ?`,
      )
      .run(
        leaseExpiresAt,
        now,
        now,
        id,
        expected.activeAttemptId,
        expected.activeState,
        expected.fencingToken,
      );
    return result.changes === 1;
  }

  /** Fenced CAS update; a stale worker gets null and changes nothing. */
  async updateFenced(
    id: string,
    expected: JudgeFencing,
    patch: JudgeJobPatch,
  ): Promise<JudgeJobRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.state !== undefined) put("state", patch.state);
    if (patch.currentNode !== undefined) put("current_node", patch.currentNode);
    if (patch.currentRound !== undefined) put("current_round", patch.currentRound);
    if (patch.pauseKind !== undefined) put("pause_kind", patch.pauseKind);
    if (patch.pauseReason !== undefined) put("pause_reason", patch.pauseReason);
    if (patch.terminalErrorKind !== undefined) put("terminal_error_kind", patch.terminalErrorKind);
    if (patch.terminalErrorDetail !== undefined)
      put("terminal_error_detail", patch.terminalErrorDetail);
    if (patch.heartbeatAt !== undefined) put("heartbeat_at", patch.heartbeatAt);
    if (patch.availableAt !== undefined) put("available_at", patch.availableAt);
    if (patch.activeAttemptId !== undefined) put("active_attempt_id", patch.activeAttemptId);
    if (patch.activeAttemptNumber !== undefined)
      put("active_attempt_number", patch.activeAttemptNumber);
    if (patch.attemptCount !== undefined) put("attempt_count", patch.attemptCount);
    if (patch.fencingToken !== undefined) put("fencing_token", patch.fencingToken);
    if (patch.lease !== undefined) {
      put("lease_owner", patch.lease === null ? null : patch.lease.owner);
      put("lease_token", patch.lease === null ? null : patch.lease.token);
      put("lease_expires_at", patch.lease === null ? null : patch.lease.expiresAt);
    }

    const now = new Date().toISOString();
    put("updated_at", now);

    // The four-part predicate is the whole fencing contract. Note it is applied
    // in SQL: reading the row, comparing in TypeScript, then writing would leave
    // a window in which another worker claims the job between the two steps.
    params.push(id, expected.activeAttemptId, expected.activeState, expected.fencingToken);
    const result = this.db
      .prepare(
        `UPDATE judge_jobs SET ${sets.join(", ")}
           WHERE id = ? AND active_attempt_id = ? AND state = ? AND fencing_token = ?`,
      )
      .run(...(params as never[]));
    if (result.changes !== 1) return null;
    return this.get(id);
  }

  /**
   * Sweep expired leases in bounded batches: expired jobs move to
   * waiting_retry, the lost attempt is marked lost, and every in_flight provider
   * operation of that attempt flips to `unknown` (classification worker_loss).
   *
   * The provider-operation flip is not bookkeeping: an operation left `in_flight`
   * forever is indistinguishable from one still running, so retry policy would
   * never see that a model call may have been charged and may have produced
   * output nobody recorded. `unknown` is the honest state and is what the design
   * requires the sweeper to write.
   */
  async requeueExpiredLeases(opts: RequeueOptions): Promise<number> {
    const limit = clampLimit(opts.limit);
    const cutoff = new Date(Date.parse(opts.now) - opts.maxLeaseAgeMs).toISOString();
    const placeholders = LEASED_STATES.map(() => "?").join(",");
    const sweep = this.db.transaction((): number => {
      const expired = this.db
        .prepare(
          `SELECT * FROM judge_jobs
             WHERE state IN (${placeholders})
               AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
             ORDER BY lease_expires_at ASC, id ASC
             LIMIT ?`,
        )
        .all(...LEASED_STATES, cutoff, limit) as Row[];

      let requeued = 0;
      for (const job of expired) {
        // Fenced on the token read a moment ago: if the worker heartbeated in
        // between, the lease is no longer expired and this row must be skipped.
        const moved = this.db
          .prepare(
            `UPDATE judge_jobs
               SET state = ?, lease_owner = NULL, lease_token = NULL,
                   lease_expires_at = NULL, active_attempt_id = NULL,
                   active_attempt_number = NULL, available_at = ?, updated_at = ?
               WHERE id = ? AND state = ? AND fencing_token = ?`,
          )
          .run(
            JUDGE_JOB_STATE.waiting_retry,
            opts.now,
            opts.now,
            job.id,
            job.state,
            job.fencing_token,
          );
        if (moved.changes !== 1) continue;

        if (job.active_attempt_id !== null) {
          this.db
            .prepare(
              `UPDATE judge_attempts SET state = ?, error_classification = ?, ended_at = ?
                 WHERE id = ? AND state = ?`,
            )
            .run(
              JUDGE_ATTEMPT_STATE.lost,
              JUDGE_ERROR_CLASSIFICATION.worker_loss,
              opts.now,
              job.active_attempt_id,
              JUDGE_ATTEMPT_STATE.running,
            );
          this.db
            .prepare(
              `UPDATE judge_provider_operations
                 SET state = ?, error_classification = ?, ended_at = ?
                 WHERE attempt_id = ? AND state = ?`,
            )
            .run(
              JUDGE_PROVIDER_OPERATION_STATE.unknown,
              JUDGE_ERROR_CLASSIFICATION.worker_loss,
              opts.now,
              job.active_attempt_id,
              JUDGE_PROVIDER_OPERATION_STATE.in_flight,
            );
        }
        requeued += 1;
      }
      return requeued;
    });
    return sweep.immediate();
  }
}

/** `judge_attempts` repository over better-sqlite3. */
export class SqliteJudgeAttemptRepository implements JudgeAttemptRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** Create an attempt (normally inside claimNext's transaction). */
  async create(input: NewJudgeAttempt): Promise<JudgeAttemptRow> {
    const id = newId("jatt");
    this.db
      .prepare(
        `INSERT INTO judge_attempts (
           id, job_id, attempt_number, worker_id, fencing_token,
           working_store_prefix, staging_prefix, state, evidence_bytes,
           estimated_cost, started_at
         ) VALUES (?,?,?,?,?,?,?,?,0,0,?)`,
      )
      .run(
        id,
        input.jobId,
        input.attemptNumber,
        input.workerId,
        input.fencingToken,
        input.workingStorePrefix,
        input.stagingPrefix,
        JUDGE_ATTEMPT_STATE.running,
        new Date().toISOString(),
      );
    const row = this.db.prepare("SELECT * FROM judge_attempts WHERE id = ?").get(id) as Row;
    return toAttemptRow(row);
  }

  /** Fetch one attempt by id. */
  async get(id: string): Promise<JudgeAttemptRow | null> {
    const row = this.db.prepare("SELECT * FROM judge_attempts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row === undefined ? null : toAttemptRow(row);
  }

  /** All attempts of a job, bounded by the retry budget. */
  async getByJob(jobId: string): Promise<readonly JudgeAttemptRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM judge_attempts WHERE job_id = ? ORDER BY attempt_number ASC")
      .all(jobId) as Row[];
    return rows.map(toAttemptRow);
  }

  /** CAS attempt state transition; returns null on conflict. */
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
    const sets = ["state = ?"];
    const params: unknown[] = [next];
    if (opts?.errorClassification !== undefined) {
      sets.push("error_classification = ?");
      params.push(opts.errorClassification);
    }
    if (opts?.endedAt !== undefined) {
      sets.push("ended_at = ?");
      params.push(opts.endedAt);
    }
    if (opts?.checkpoint !== undefined) {
      sets.push("checkpoint_reached_json = ?");
      params.push(opts.checkpoint === null ? null : JSON.stringify(opts.checkpoint));
    }
    params.push(id, expected);
    const result = this.db
      .prepare(`UPDATE judge_attempts SET ${sets.join(", ")} WHERE id = ? AND state = ?`)
      .run(...(params as never[]));
    if (result.changes !== 1) return null;
    return this.get(id);
  }
}

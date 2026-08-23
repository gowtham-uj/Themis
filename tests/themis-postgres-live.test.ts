/**
 * Live PostgreSQL Themis store — real concurrency matrix (WP-15).
 * Requires AGENTEVAL_DATABASE_URL (or AGENTEVAL_PG=1) pointing at a reachable PG.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import pg from "pg";

import {
  JUDGE_ATTEMPT_STATE,
  JUDGE_ERROR_CLASSIFICATION,
  JUDGE_JOB_STATE,
  JUDGE_PROVIDER_OPERATION_STATE,
  JUDGE_JOB_TRIGGER_KIND,
  type NewJudgeJob,
} from "../src/db/contracts.ts";
import { migrate } from "../src/db/postgres/migrate.ts";
import {
  PostgresJudgeAttemptRepository,
  PostgresJudgeJobRepository,
} from "../src/db/postgres/store.ts";

const LIVE = Boolean(process.env.AGENTEVAL_DATABASE_URL) || process.env.AGENTEVAL_PG === "1";

function newJob(over: Partial<NewJudgeJob> = {}): NewJudgeJob {
  const n = Math.random().toString(36).slice(2, 10);
  return {
    judgeQueueId: `q_${n}`,
    judgeQueueGenerationId: `g_${n}`,
    sourceTriggerId: `trig_${n}`,
    sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.archive_sealed,
    configSnapshotId: `cfg_${n}`,
    configSnapshotSha256: "ab".repeat(32),
    runId: `run_${n}`,
    projectId: `proj_${n}`,
    batchId: null,
    taskId: null,
    agentId: null,
    baseArchiveGenerationId: `gen_${n}`,
    baseManifestSha256: "cd".repeat(32),
    publicationPolicy: {
      makeCurrent: false,
      trackId: `track_${n}`,
      expectedCurrentResultVersionId: null,
      expectedCurrentArchiveViewGenerationId: null,
    },
    priority: 0,
    availableAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe.skipIf(!LIVE)("postgres store — live concurrency matrix", () => {
  let pool: pg.Pool;
  let jobs: PostgresJudgeJobRepository;
  const queue = `q_live_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.AGENTEVAL_DATABASE_URL });
    await migrate(pool);
    jobs = new PostgresJudgeJobRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("two concurrent claimers: exactly one wins, tokens strictly increase", async () => {
    await jobs.upsertByTrigger(newJob({ judgeQueueId: queue }));
    const claimOpts = { now: "2026-01-01T00:00:00.000Z", leaseMs: 60_000, workerId: "w" };
    const [a, b] = await Promise.all([
      jobs.claimNext(queue, { ...claimOpts, workerId: "wA" }),
      jobs.claimNext(queue, { ...claimOpts, workerId: "wB" }),
    ]);
    const winners = [a, b].filter((x) => x !== null);
    expect(winners).toHaveLength(1);
    // A second sequential claim finds nothing.
    expect(await jobs.claimNext(queue, claimOpts)).toBeNull();
  });

  it("a stale fencing token cannot update the job (updateFenced + heartbeat)", async () => {
    const q = `${queue}_fence`;
    await jobs.upsertByTrigger(newJob({ judgeQueueId: q }));
    const claim = (await jobs.claimNext(q, {
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 60_000,
      workerId: "w1",
    }))!;
    const fencing = {
      caseId: claim.job.id,
      activeAttemptId: claim.attempt.id,
      activeState: JUDGE_JOB_STATE.leased as const,
      fencingToken: claim.fencingToken,
    };
    // Correct token → works.
    expect(
      await jobs.updateFenced(claim.job.id, fencing, { state: JUDGE_JOB_STATE.completed }),
    ).not.toBeNull();
    // Replaying the same (now-stale) token must fail — the predicate is SQL-fenced.
    expect(
      await jobs.updateFenced(claim.job.id, fencing, { state: JUDGE_JOB_STATE.failed }),
    ).toBeNull();
    expect(
      await jobs.heartbeat(claim.job.id, fencing, "2026-01-01T01:00:00.000Z"),
    ).toBe(false);
  });

  it("requeueExpiredLeases flips the lost attempt's in_flight provider ops to unknown", async () => {
    const q = `${queue}_requeue`;
    await jobs.upsertByTrigger(newJob({ judgeQueueId: q }));
    const claim = (await jobs.claimNext(q, {
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 60_000,
      workerId: "w1",
    }))!;
    // Seed an in_flight provider operation on this attempt.
    await pool.query(
      `INSERT INTO judge_provider_operations
         (id, case_id, attempt_id, node, metric_or_role, operation_kind,
          canonical_request_digest, provider, state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        `jpo_${Math.random().toString(36).slice(2)}`,
        claim.job.id,
        claim.attempt.id,
        "node4",
        "minos",
        "model_call",
        "ab".repeat(32),
        "openai-compatible",
        JUDGE_PROVIDER_OPERATION_STATE.in_flight,
        new Date().toISOString(),
      ],
    );
    // Sweep with maxLeaseAgeMs 0 → anything leased is expired.
    const count = await jobs.requeueExpiredLeases({
      now: "2026-01-01T01:00:00.000Z",
      maxLeaseAgeMs: 0,
      limit: 100,
    });
    expect(count).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      `SELECT state, error_classification FROM judge_provider_operations WHERE attempt_id = $1`,
      [claim.attempt.id],
    );
    expect(rows[0].state).toBe(JUDGE_PROVIDER_OPERATION_STATE.unknown);
    expect(rows[0].error_classification).toBe(JUDGE_ERROR_CLASSIFICATION.worker_loss);
  });

  it("idempotent upsertByTrigger does not create a second job", async () => {
    const q = `${queue}_idem`;
    const job = newJob({ judgeQueueId: q });
    const a = await jobs.upsertByTrigger(job);
    const b = await jobs.upsertByTrigger(job);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });

  it("attempt transitions are CAS on state", async () => {
    const q = `${queue}_attempt`;
    await jobs.upsertByTrigger(newJob({ judgeQueueId: q }));
    const claim = (await jobs.claimNext(q, {
      now: "2026-01-01T00:00:00.000Z",
      leaseMs: 60_000,
      workerId: "w1",
    }))!;
    const attempts = new PostgresJudgeAttemptRepository(pool);
    const a = await attempts.transition(
      claim.attempt.id,
      JUDGE_ATTEMPT_STATE.running,
      JUDGE_ATTEMPT_STATE.succeeded,
      { endedAt: new Date().toISOString() },
    );
    expect(a?.state).toBe(JUDGE_ATTEMPT_STATE.succeeded);
    // Wrong expected state → null.
    expect(
      await attempts.transition(claim.attempt.id, JUDGE_ATTEMPT_STATE.running, JUDGE_ATTEMPT_STATE.succeeded),
    ).toBeNull();
  });
});

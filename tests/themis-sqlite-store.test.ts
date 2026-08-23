/**
 * Behavioral tests for the SQLite Themis store against a real on-disk database.
 *
 * The load-bearing property under test is FENCING, and these tests are written
 * to fail against a store that omits it. A test suite for a lease/fencing layer
 * that only exercises the happy path is worse than none: it certifies exactly
 * the code path that was never in doubt. Each fencing test below therefore
 * constructs a stale worker — one holding a token another worker has since
 * superseded — and asserts both that its write is rejected AND that the row is
 * byte-identical afterward. Rejection alone is not enough; a store that returns
 * null after having already written is still corrupt.
 *
 * Mutation-verified. Deleting `AND fencing_token = ?` from `updateFenced` or
 * `heartbeat` turns this file red; so does a deferred (non-IMMEDIATE) claim
 * transaction, dropping the keyset cursor's id tiebreaker, and skipping the
 * in-flight provider-operation flip on requeue.
 *
 * ONE MUTANT SURVIVES, deliberately: deleting the state/token re-check from the
 * claim's conditional UPDATE. It is not a missing test — see the note in "does
 * not re-lease a job that is already leased" for why that window cannot exist
 * on SQLite and why only the PostgreSQL suite can hold it honest.
 */

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

import {
  JUDGE_ATTEMPT_STATE,
  JUDGE_ERROR_CLASSIFICATION,
  JUDGE_JOB_STATE,
  JUDGE_JOB_TRIGGER_KIND,
  JUDGE_PROVIDER_OPERATION_STATE,
  type JudgeFencing,
  type NewJudgeJob,
} from "../src/db/contracts.js";
import { migrate } from "../src/db/sqlite/migrate.js";
import {
  SqliteJudgeAttemptRepository,
  SqliteJudgeJobRepository,
} from "../src/db/sqlite/store.js";

const QUEUE = "jq_main";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";

/** `T0 + n` hours, for tests that need a monotonically advancing clock. */
function hour(n: number): string {
  return new Date(Date.parse(T0) + n * 3_600_000).toISOString();
}

/** Expire every live lease as of `now`. Requeued jobs become available at `now`. */
async function expireAll(now: string): Promise<number> {
  return jobs.requeueExpiredLeases({ now, maxLeaseAgeMs: 0, limit: 100 });
}

let dir: string;
let dbPath: string;
let db: Database.Database;
let jobs: SqliteJudgeJobRepository;
let attempts: SqliteJudgeAttemptRepository;

function newJob(overrides: Partial<NewJudgeJob> = {}): NewJudgeJob {
  return {
    judgeQueueId: QUEUE,
    judgeQueueGenerationId: "jqg_1",
    sourceTriggerId: "evt_1",
    sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.archive_sealed,
    configSnapshotId: "cfg_1",
    configSnapshotSha256: "a".repeat(64),
    runId: "run_1",
    projectId: "proj_1",
    batchId: null,
    taskId: null,
    agentId: null,
    baseArchiveGenerationId: "gen_1",
    baseManifestSha256: "b".repeat(64),
    publicationPolicy: {
      makeCurrent: true,
      trackId: "track_1",
      expectedCurrentResultVersionId: null,
      expectedCurrentArchiveViewGenerationId: null,
    },
    priority: 0,
    availableAt: T0,
    ...overrides,
  };
}

/** Read a job row as raw SQL columns, for byte-identity assertions. */
function rawJob(id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM judge_jobs WHERE id = ?").get(id) as Record<string, unknown>;
}

function fencingOf(job: {
  id: string;
  activeAttemptId: string | null;
  state: string;
  fencingToken: number;
}): JudgeFencing {
  return {
    caseId: job.id,
    activeAttemptId: job.activeAttemptId as string,
    activeState: job.state as JudgeFencing["activeState"],
    fencingToken: job.fencingToken,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "themis-sqlite-"));
  dbPath = join(dir, "test.db");
  db = new Database(dbPath);
  migrate(db);
  jobs = new SqliteJudgeJobRepository(db);
  attempts = new SqliteJudgeAttemptRepository(db);
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration", () => {
  it("is idempotent: running it again on a populated database changes nothing", async () => {
    const { job } = await jobs.upsertByTrigger(newJob());
    const before = rawJob(job.id);

    migrate(db);
    migrate(db);

    expect(rawJob(job.id)).toEqual(before);
    expect(await jobs.get(job.id)).not.toBeNull();
  });

  it("does not declare a vacuous UNIQUE (id, fencing_token) on judge_jobs", () => {
    // `id` is the primary key, so UNIQUE (id, fencing_token) is satisfied by
    // construction and enforces nothing. Its presence would read as fencing
    // protection while providing none — the exact kind of decorative constraint
    // that makes a review conclude the invariant is covered when it is not.
    //
    // Asserted against the catalog's real index list, not the CREATE TABLE text:
    // a comment mentioning the constraint would satisfy a text match.
    const indexes = db.prepare("PRAGMA index_list('judge_jobs')").all() as {
      name: string;
      unique: number;
    }[];
    const uniqueColumnSets = indexes
      .filter((i) => i.unique === 1)
      .map((i) =>
        (db.prepare(`PRAGMA index_info('${i.name}')`).all() as { name: string }[])
          .map((c) => c.name)
          .join(","),
      );
    expect(uniqueColumnSets).not.toContain("id,fencing_token");
    expect(uniqueColumnSets).toContain("judge_queue_id,source_trigger_kind,source_trigger_id");
  });

  it("enforces (job_id, fencing_token) uniqueness where it has teeth", async () => {
    const { job } = await jobs.upsertByTrigger(newJob());
    const claimed = await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" });
    expect(claimed).not.toBeNull();

    // job_id is NOT unique on judge_attempts, so a second attempt reusing the
    // same fencing token is a real constraint violation, not a tautology.
    expect(() =>
      db
        .prepare(
          `INSERT INTO judge_attempts (id, job_id, attempt_number, worker_id, fencing_token,
             working_store_prefix, staging_prefix, state, evidence_bytes, estimated_cost)
           VALUES (?,?,?,?,?,?,?,?,0,0)`,
        )
        .run("jatt_dupe", job.id, 99, "w2", claimed!.fencingToken, "w/x", "s/x", "running"),
    ).toThrow(/UNIQUE/i);
  });
});

describe("upsertByTrigger", () => {
  it("creates once and returns the same job on replay", async () => {
    const first = await jobs.upsertByTrigger(newJob());
    const second = await jobs.upsertByTrigger(newJob());

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM judge_jobs").get()).toEqual({ n: 1 });
  });

  it("treats a different trigger kind on the same trigger id as a distinct job", async () => {
    // Rejudging is an explicit new trigger (design §3); it must not collide
    // with the auto-judge job for the same archive.
    const a = await jobs.upsertByTrigger(newJob());
    const b = await jobs.upsertByTrigger(
      newJob({ sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.rejudge }),
    );
    expect(b.created).toBe(true);
    expect(b.job.id).not.toBe(a.job.id);
  });

  it("starts a job queued with fencing token 0 and no lease", async () => {
    const { job } = await jobs.upsertByTrigger(newJob());
    expect(job.state).toBe(JUDGE_JOB_STATE.queued);
    expect(job.fencingToken).toBe(0);
    expect(job.lease).toBeNull();
    expect(job.attemptCount).toBe(0);
    expect(job.activeAttemptId).toBeNull();
  });

  it("round-trips the publication policy snapshot", async () => {
    const policy = {
      makeCurrent: false,
      trackId: "track_standalone",
      expectedCurrentResultVersionId: "rv_7",
      expectedCurrentArchiveViewGenerationId: "gen_9",
    };
    const { job } = await jobs.upsertByTrigger(newJob({ publicationPolicy: policy }));
    expect((await jobs.get(job.id))?.publicationPolicy).toEqual(policy);
  });
});

describe("claimNext", () => {
  it("increments the fencing token monotonically across claims", async () => {
    const { job } = await jobs.upsertByTrigger(newJob());
    const tokens: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      // A requeue makes the job available at the sweep time, so the clock must
      // advance: claim at hour i, sweep at hour i+1.
      const claim = await jobs.claimNext(QUEUE, {
        now: hour(i),
        leaseMs: 1_000,
        workerId: `w${i}`,
      });
      expect(claim).not.toBeNull();
      tokens.push(claim!.fencingToken);
      await expireAll(hour(i + 1));
    }

    expect(tokens).toEqual([1, 2, 3]);
    expect((await jobs.get(job.id))?.fencingToken).toBe(3);
  });

  it("gives the job to at most one of two connections in the same process", async () => {
    await jobs.upsertByTrigger(newJob());

    // Two separate better-sqlite3 handles on the SAME file. This is a useful
    // check of the conditional-update predicate, but it is NOT a concurrency
    // test: better-sqlite3 is synchronous, so `await` yields nothing and the
    // second claim begins only after the first has fully committed. The real
    // race is exercised by the multi-process test below; keeping this one
    // honest about its limits matters more than the reassurance it offers.
    const dbB = new Database(dbPath);
    try {
      const repoB = new SqliteJudgeJobRepository(dbB);
      const a = await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "wA" });
      const b = await repoB.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "wB" });

      expect([a, b].filter((c) => c !== null)).toHaveLength(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM judge_attempts").get()).toEqual({ n: 1 });
    } finally {
      dbB.close();
    }
  });

  it("gives one job to exactly one of six racing OS processes", async () => {
    const { job } = await jobs.upsertByTrigger(newJob());
    // Close our handle so the child processes contend only with each other and
    // no WAL reader of ours holds a snapshot open.
    db.close();

    const helper = join(import.meta.dirname, "helpers", "claim-once.mts");
    const startAt = Date.now() + 1_500;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        execFileAsync(process.execPath, [
          ...["--import", "tsx"],
          helper,
          dbPath,
          QUEUE,
          `w${i}`,
          String(startAt),
        ]).then(({ stdout }) => JSON.parse(stdout.trim()) as Record<string, unknown>),
      ),
    );

    // No process may crash. A SQLITE_BUSY thrown out of claimNext would be a
    // real defect at the contract boundary, not an acceptable outcome — the
    // caller was promised null-or-claim, not an exception under contention.
    expect(results.filter((r) => "error" in r)).toEqual([]);

    const winners = results.filter((r) => r.claimed === true);
    expect(winners).toHaveLength(1);
    expect(winners[0].jobId).toBe(job.id);

    // Reopen and verify the durable state: one attempt, token advanced once.
    db = new Database(dbPath);
    jobs = new SqliteJudgeJobRepository(db);
    attempts = new SqliteJudgeAttemptRepository(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM judge_attempts").get()).toEqual({ n: 1 });
    expect((await jobs.get(job.id))?.fencingToken).toBe(1);
  }, 60_000);

  it("does not re-lease a job that is already leased", async () => {
    await jobs.upsertByTrigger(newJob());
    const first = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "wA" }))!;

    const second = await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "wB" });
    expect(second).toBeNull();
    expect((await jobs.get(first.job.id))?.lease?.owner).toBe("wA");
    expect(db.prepare("SELECT COUNT(*) AS n FROM judge_attempts").get()).toEqual({ n: 1 });

    // NOT a test of the claim's conditional-update predicate. That predicate is
    // untestable on this backend, and the gap is recorded rather than papered
    // over: deleting `AND state = ? AND fencing_token = ?` from the claim UPDATE
    // leaves this whole file green (mutation-verified). The reason is
    // structural, not a missing test — the candidate SELECT and the UPDATE run
    // inside one IMMEDIATE transaction holding a database-wide write lock, so no
    // other connection can interleave between them, and any attempt to force an
    // interleave from inside the transaction deadlocks against that same lock.
    // The window the predicate closes does not exist in SQLite.
    //
    // It does exist on PostgreSQL, where FOR UPDATE SKIP LOCKED lets claimers
    // run genuinely in parallel on distinct rows. The predicate must therefore
    // stay in this implementation for parity, and the PostgreSQL store's own
    // concurrency suite is what will actually hold it honest. Do not read this
    // file's green result as evidence that claim fencing works.
  });

  it("returns null when nothing is eligible", async () => {
    expect(await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w" })).toBeNull();
  });

  it("does not claim a job whose availableAt is in the future", async () => {
    await jobs.upsertByTrigger(newJob({ availableAt: "2026-06-01T00:00:00.000Z" }));
    expect(await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w" })).toBeNull();
  });

  it("does not claim a job belonging to another queue", async () => {
    await jobs.upsertByTrigger(newJob({ judgeQueueId: "jq_other" }));
    expect(await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w" })).toBeNull();
  });

  it("claims higher priority first", async () => {
    await jobs.upsertByTrigger(newJob({ sourceTriggerId: "evt_low", priority: 0 }));
    const high = await jobs.upsertByTrigger(newJob({ sourceTriggerId: "evt_high", priority: 10 }));

    const claim = await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w" });
    expect(claim?.job.id).toBe(high.job.id);
  });

  it("sets the lease, the active attempt, and a running attempt row", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" });

    expect(claim!.job.state).toBe(JUDGE_JOB_STATE.leased);
    expect(claim!.job.attemptCount).toBe(1);
    expect(claim!.job.activeAttemptId).toBe(claim!.attempt.id);
    expect(claim!.job.activeAttemptNumber).toBe(1);
    expect(claim!.job.lease).toEqual({
      owner: "w1",
      token: claim!.fencingToken,
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    expect(claim!.attempt.state).toBe(JUDGE_ATTEMPT_STATE.running);
    expect(claim!.attempt.fencingToken).toBe(claim!.job.fencingToken);
  });

  it("gives each attempt a distinct working store and staging prefix", async () => {
    await jobs.upsertByTrigger(newJob());
    const first = await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w1" });
    await expireAll(T1);
    const second = await jobs.claimNext(QUEUE, { now: T1, leaseMs: 1_000, workerId: "w2" });

    // "Retries never share mutable working directories or staging keys" (§3).
    expect(second!.attempt.workingStorePrefix).not.toBe(first!.attempt.workingStorePrefix);
    expect(second!.attempt.stagingPrefix).not.toBe(first!.attempt.stagingPrefix);
  });
});

describe("fencing", () => {
  it("rejects a stale worker's update and leaves the row byte-identical", async () => {
    await jobs.upsertByTrigger(newJob());
    const stale = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "wA" }))!;
    const staleFencing = fencingOf(stale.job);

    // wA's lease expires; wB takes over and now owns the case.
    await expireAll(T1);
    const fresh = (await jobs.claimNext(QUEUE, {
      now: T1,
      leaseMs: 60_000,
      workerId: "wB",
    }))!;
    expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken);

    const before = rawJob(stale.job.id);
    const result = await jobs.updateFenced(stale.job.id, staleFencing, {
      state: JUDGE_JOB_STATE.completed,
      currentNode: "node4",
    });

    expect(result).toBeNull();
    // The row must be untouched — not merely "the call returned null". A store
    // that writes and then reports failure has already corrupted the case.
    expect(rawJob(stale.job.id)).toEqual(before);
  });

  it("rejects a stale worker's heartbeat and does not extend the new owner's lease", async () => {
    await jobs.upsertByTrigger(newJob());
    const stale = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "wA" }))!;
    const staleFencing = fencingOf(stale.job);

    await expireAll(T1);
    await jobs.claimNext(QUEUE, {
      now: T1,
      leaseMs: 60_000,
      workerId: "wB",
    });

    const before = rawJob(stale.job.id);
    const ok = await jobs.heartbeat(stale.job.id, staleFencing, "2030-01-01T00:00:00.000Z");

    expect(ok).toBe(false);
    expect(rawJob(stale.job.id).lease_expires_at).toBe(before.lease_expires_at);
  });

  it("rejects a superseded token even when attempt and state still match", async () => {
    // The two tests above pass against a store with NO fencing-token predicate
    // at all — confirmed by mutation. The requeue nulls `active_attempt_id`, so
    // a swept-out worker is rejected on the attempt id and the token is never
    // consulted. They prove takeover-after-sweep, not fencing.
    //
    // This is the case that isolates the token: recovery re-fencing (design §3,
    // "a recovery worker claims `sealing` under a new fencing token and may
    // adopt verified objects"). The attempt is ADOPTED, so activeAttemptId and
    // activeState are unchanged and the token is the only thing that moved. A
    // store without `AND fencing_token = ?` lets the superseded worker write.
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "wA" }))!;
    const superseded = fencingOf(claim.job);

    const recovered = await jobs.updateFenced(claim.job.id, superseded, {
      fencingToken: superseded.fencingToken + 1,
      lease: { owner: "wRecovery", token: superseded.fencingToken + 1, expiresAt: T1 },
    });
    expect(recovered?.fencingToken).toBe(superseded.fencingToken + 1);
    expect(recovered?.activeAttemptId).toBe(superseded.activeAttemptId);
    expect(recovered?.state).toBe(superseded.activeState);

    const before = rawJob(claim.job.id);
    expect(
      await jobs.updateFenced(claim.job.id, superseded, {
        state: JUDGE_JOB_STATE.completed,
      }),
    ).toBeNull();
    expect(rawJob(claim.job.id)).toEqual(before);
  });

  it("rejects a superseded token's heartbeat even when attempt and state match", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "wA" }))!;
    const superseded = fencingOf(claim.job);

    await jobs.updateFenced(claim.job.id, superseded, {
      fencingToken: superseded.fencingToken + 1,
    });

    const before = rawJob(claim.job.id);
    expect(await jobs.heartbeat(claim.job.id, superseded, "2030-01-01T00:00:00.000Z")).toBe(false);
    // A superseded worker that could still extend the lease would keep the
    // recovery worker's job alive under a dead owner indefinitely.
    expect(rawJob(claim.job.id).lease_expires_at).toBe(before.lease_expires_at);
  });

  it("accepts the current owner's update and heartbeat", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" }))!;
    const fencing = fencingOf(claim.job);

    expect(await jobs.heartbeat(claim.job.id, fencing, "2026-01-01T00:05:00.000Z")).toBe(true);
    const updated = await jobs.updateFenced(claim.job.id, fencing, {
      state: JUDGE_JOB_STATE.running,
      currentNode: "node0",
      currentRound: 1,
    });

    expect(updated?.state).toBe(JUDGE_JOB_STATE.running);
    expect(updated?.currentNode).toBe("node0");
    expect(updated?.currentRound).toBe(1);
    expect((await jobs.get(claim.job.id))?.lease?.expiresAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("rejects an update whose expected state has already moved on", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" }))!;
    const fencing = fencingOf(claim.job);

    const running = await jobs.updateFenced(claim.job.id, fencing, {
      state: JUDGE_JOB_STATE.running,
    });
    expect(running).not.toBeNull();

    // Same token, same attempt — but the job is no longer `leased`. Replaying
    // the transition must not re-apply.
    const before = rawJob(claim.job.id);
    expect(
      await jobs.updateFenced(claim.job.id, fencing, { state: JUDGE_JOB_STATE.sealing }),
    ).toBeNull();
    expect(rawJob(claim.job.id)).toEqual(before);
  });

  it("rejects an update from a worker holding a different attempt id", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" }))!;

    const before = rawJob(claim.job.id);
    const result = await jobs.updateFenced(
      claim.job.id,
      { ...fencingOf(claim.job), activeAttemptId: "jatt_someone_else" },
      { state: JUDGE_JOB_STATE.completed },
    );
    expect(result).toBeNull();
    expect(rawJob(claim.job.id)).toEqual(before);
  });

  it("clears the lease when the patch sets it null", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" }))!;
    const updated = await jobs.updateFenced(claim.job.id, fencingOf(claim.job), { lease: null });
    expect(updated?.lease).toBeNull();
  });
});

describe("requeueExpiredLeases", () => {
  it("requeues an expired job and marks its attempt lost", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w1" }))!;

    const n = await jobs.requeueExpiredLeases({
      now: "2026-01-01T01:00:00.000Z",
      maxLeaseAgeMs: 0,
      limit: 10,
    });

    expect(n).toBe(1);
    const job = await jobs.get(claim.job.id);
    expect(job?.state).toBe(JUDGE_JOB_STATE.waiting_retry);
    expect(job?.lease).toBeNull();
    expect(job?.activeAttemptId).toBeNull();

    const attempt = await attempts.get(claim.attempt.id);
    expect(attempt?.state).toBe(JUDGE_ATTEMPT_STATE.lost);
    expect(attempt?.errorClassification).toBe(JUDGE_ERROR_CLASSIFICATION.worker_loss);
  });

  it("flips the lost attempt's in-flight provider operations to unknown", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w1" }))!;

    const insertOp = db.prepare(
      `INSERT INTO judge_provider_operations
         (id, case_id, attempt_id, node, metric_or_role, operation_kind,
          canonical_request_digest, provider, state, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    insertOp.run("op_flight", claim.job.id, claim.attempt.id, "node2", "m1", "model",
      "d".repeat(64), "router", JUDGE_PROVIDER_OPERATION_STATE.in_flight, T0);
    insertOp.run("op_done", claim.job.id, claim.attempt.id, "node2", "m2", "model",
      "e".repeat(64), "router", JUDGE_PROVIDER_OPERATION_STATE.succeeded, T0);

    await jobs.requeueExpiredLeases({
      now: "2026-01-01T01:00:00.000Z",
      maxLeaseAgeMs: 0,
      limit: 10,
    });

    const rows = db
      .prepare("SELECT id, state, error_classification FROM judge_provider_operations ORDER BY id")
      .all() as { id: string; state: string; error_classification: string | null }[];

    // An op left `in_flight` forever is indistinguishable from one still
    // running, so retry policy would never learn a model call may have been
    // charged. `unknown` is the honest state.
    expect(rows).toEqual([
      { id: "op_done", state: JUDGE_PROVIDER_OPERATION_STATE.succeeded, error_classification: null },
      {
        id: "op_flight",
        state: JUDGE_PROVIDER_OPERATION_STATE.unknown,
        error_classification: JUDGE_ERROR_CLASSIFICATION.worker_loss,
      },
    ]);
  });

  it("leaves a live lease alone", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 3_600_000, workerId: "w1" }))!;

    const n = await jobs.requeueExpiredLeases({
      now: "2026-01-01T00:00:30.000Z",
      maxLeaseAgeMs: 0,
      limit: 10,
    });

    expect(n).toBe(0);
    expect((await jobs.get(claim.job.id))?.state).toBe(JUDGE_JOB_STATE.leased);
  });

  it("respects the batch limit rather than sweeping everything", async () => {
    for (let i = 0; i < 5; i += 1) {
      await jobs.upsertByTrigger(newJob({ sourceTriggerId: `evt_${i}` }));
      await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: `w${i}` });
    }

    const n = await jobs.requeueExpiredLeases({
      now: "2026-01-01T01:00:00.000Z",
      maxLeaseAgeMs: 0,
      limit: 2,
    });
    expect(n).toBe(2);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM judge_jobs WHERE state = ?").get("leased"),
    ).toEqual({ n: 3 });
  });

  it("does not requeue a job whose lease is within the grace age", async () => {
    await jobs.upsertByTrigger(newJob());
    await jobs.claimNext(QUEUE, { now: T0, leaseMs: 1_000, workerId: "w1" });

    // Lease expired at T0+1s; sweeping at T0+30s with a 60s grace must not fire.
    const n = await jobs.requeueExpiredLeases({
      now: "2026-01-01T00:00:30.000Z",
      maxLeaseAgeMs: 60_000,
      limit: 10,
    });
    expect(n).toBe(0);
  });
});

describe("attempts", () => {
  it("lists a job's attempts in attempt-number order", async () => {
    await jobs.upsertByTrigger(newJob());
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const claim = (await jobs.claimNext(QUEUE, {
        now: hour(i),
        leaseMs: 1_000,
        workerId: `w${i}`,
      }))!;
      ids.push(claim.attempt.id);
      await expireAll(hour(i + 1));
    }

    expect(await attempts.getByJob("jjob_nonexistent")).toEqual([]);

    const job = (await jobs.getByRunCursor("run_1", { cursor: null, limit: 10 })).items[0];
    const rows = await attempts.getByJob(job.id);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.attemptNumber)).toEqual([1, 2, 3]);
  });

  it("transitions only from the expected state", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" }))!;

    const ok = await attempts.transition(
      claim.attempt.id,
      JUDGE_ATTEMPT_STATE.running,
      JUDGE_ATTEMPT_STATE.succeeded,
      { endedAt: "2026-01-01T00:10:00.000Z" },
    );
    expect(ok?.state).toBe(JUDGE_ATTEMPT_STATE.succeeded);
    expect(ok?.endedAt).toBe("2026-01-01T00:10:00.000Z");

    // Replaying the same transition must not re-apply.
    const again = await attempts.transition(
      claim.attempt.id,
      JUDGE_ATTEMPT_STATE.running,
      JUDGE_ATTEMPT_STATE.failed,
    );
    expect(again).toBeNull();
    expect((await attempts.get(claim.attempt.id))?.state).toBe(JUDGE_ATTEMPT_STATE.succeeded);
  });

  it("stores and round-trips a checkpoint", async () => {
    await jobs.upsertByTrigger(newJob());
    const claim = (await jobs.claimNext(QUEUE, { now: T0, leaseMs: 60_000, workerId: "w1" }))!;
    const checkpoint = { node: "node2", round: 3 } as const;

    const moved = await attempts.transition(
      claim.attempt.id,
      JUDGE_ATTEMPT_STATE.running,
      JUDGE_ATTEMPT_STATE.succeeded,
      { checkpoint },
    );
    expect(moved?.checkpointReached).toEqual(checkpoint);
  });

  it("returns null for an unknown attempt", async () => {
    expect(await attempts.get("jatt_nope")).toBeNull();
  });
});

describe("keyset pagination", () => {
  async function seed(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const { job } = await jobs.upsertByTrigger(
        newJob({ sourceTriggerId: `evt_${String(i).padStart(3, "0")}` }),
      );
      ids.push(job.id);
    }
    return ids;
  }

  it("walks every row exactly once with no skips or duplicates", async () => {
    const expected = await seed(23);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await jobs.listByQueueCursor(QUEUE, { cursor, limit: 5 });
      seen.push(...page.items.map((j) => j.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // guard against a non-advancing cursor
    } while (cursor !== null);

    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it("reports hasMore honestly on the last page", async () => {
    await seed(6);
    const first = await jobs.listByQueueCursor(QUEUE, { cursor: null, limit: 3 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await jobs.listByQueueCursor(QUEUE, { cursor: first.nextCursor, limit: 3 });
    expect(second.items).toHaveLength(3);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("does not resurface rows inserted before the cursor position", async () => {
    await seed(10);
    const first = await jobs.listByQueueCursor(QUEUE, { cursor: null, limit: 4 });
    const firstIds = new Set(first.items.map((j) => j.id));

    // Concurrent insert while the caller walks.
    await jobs.upsertByTrigger(newJob({ sourceTriggerId: "evt_late" }));

    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await jobs.listByQueueCursor(QUEUE, { cursor, limit: 4 });
      rest.push(...page.items.map((j) => j.id));
      cursor = page.nextCursor;
    }

    for (const id of rest) expect(firstIds.has(id)).toBe(false);
  });

  it("scopes each listing to its own dimension", async () => {
    await jobs.upsertByTrigger(newJob({ sourceTriggerId: "a", runId: "run_a", projectId: "p1" }));
    await jobs.upsertByTrigger(newJob({ sourceTriggerId: "b", runId: "run_b", projectId: "p2" }));

    const byRun = await jobs.getByRunCursor("run_a", { cursor: null, limit: 10 });
    const byProject = await jobs.listByProjectCursor("p2", { cursor: null, limit: 10 });

    expect(byRun.items.map((j) => j.runId)).toEqual(["run_a"]);
    expect(byProject.items.map((j) => j.projectId)).toEqual(["p2"]);
  });

  it("rejects a nonsense limit rather than silently paging everything", async () => {
    await expect(jobs.listByQueueCursor(QUEUE, { cursor: null, limit: 0 })).rejects.toThrow(
      RangeError,
    );
    await expect(jobs.listByQueueCursor(QUEUE, { cursor: null, limit: -1 })).rejects.toThrow(
      RangeError,
    );
  });

  it("fails closed on a corrupted cursor", async () => {
    await seed(3);
    await expect(
      jobs.listByQueueCursor(QUEUE, { cursor: "not-a-real-cursor", limit: 5 }),
    ).rejects.toThrow();
  });
});

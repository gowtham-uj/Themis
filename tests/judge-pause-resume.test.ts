/**
 * Pause / resume on quota (design §3 retry classes).
 *
 * The locked rule: a provider quota or rate-limit pause must NOT consume a
 * retry attempt, and resume must put the job back on the queue from its last
 * committed checkpoint rather than restarting the case.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JUDGE_JOB_TRIGGER_KIND, type NewJudgeJob } from "../src/db/contracts.ts";
import { migrate } from "../src/db/sqlite/migrate.ts";
import { SqliteJudgeJobRepository } from "../src/db/sqlite/store.ts";
import { linkJudgeQueue } from "../src/judge/ingest/store.ts";
import {
  judgeQueueStatus,
  pauseJudgeQueue,
  resumeJudgeQueue,
} from "../src/judge/ingest/pause.ts";

const NOW = "2026-08-23T09:00:00.000Z";

function newJob(judgeQueueId: string, n: string): NewJudgeJob {
  return {
    judgeQueueId,
    judgeQueueGenerationId: `g_${n}`,
    sourceTriggerId: `trig_${n}`,
    sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.archive_sealed,
    configSnapshotId: `cfg_${n}`,
    configSnapshotSha256: "ab".repeat(32),
    runId: `run_${n}`,
    projectId: "proj",
    batchId: null,
    taskId: null,
    agentId: null,
    baseArchiveGenerationId: `gen_${n}`,
    baseManifestSha256: "cd".repeat(32),
    publicationPolicy: {
      makeCurrent: false,
      trackId: "t",
      expectedCurrentResultVersionId: null,
      expectedCurrentArchiveViewGenerationId: null,
    },
    priority: 0,
    availableAt: NOW,
  };
}

describe("judge pause / resume", () => {
  let db: Database.Database;
  let jobs: SqliteJudgeJobRepository;
  let queueId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    migrate(db);
    jobs = new SqliteJudgeJobRepository(db);
    queueId = linkJudgeQueue(db, {
      name: "q",
      projectId: "proj",
      linkedEvalQueueId: "evalq",
      autoJudge: true,
    }).id;
    await jobs.upsertByTrigger(newJob(queueId, "a"));
    await jobs.upsertByTrigger(newJob(queueId, "b"));
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it("quota pause stops claims without consuming a retry attempt", async () => {
    const before = db
      .prepare(`SELECT attempt_count AS n FROM judge_jobs WHERE judge_queue_id = ?`)
      .all(queueId) as Array<{ n: number }>;

    const paused = pauseJudgeQueue(db, queueId, {
      kind: "provider_quota",
      reason: "429 from provider",
      now: NOW,
    });
    expect(paused.pausedJobs).toBe(2);

    // Paused work is not claimable.
    const claim = await jobs.claimNext(queueId, {
      now: NOW,
      leaseMs: 60_000,
      workerId: "w",
    });
    expect(claim).toBeNull();

    // Retry budget untouched — a quota pause is not a failed attempt.
    const after = db
      .prepare(`SELECT attempt_count AS n FROM judge_jobs WHERE judge_queue_id = ?`)
      .all(queueId) as Array<{ n: number }>;
    expect(after.map((r) => r.n)).toEqual(before.map((r) => r.n));

    const status = judgeQueueStatus(db, queueId);
    expect(status.status).toBe("paused");
    expect(status.byState.paused).toBe(2);
    expect(status.pauseKinds.provider_quota).toBe(2);
  });

  it("resume requeues paused jobs and preserves their checkpoint position", async () => {
    // Advance one job's checkpoint so we can prove resume does not reset it.
    db.prepare(
      `UPDATE judge_jobs SET current_node = 'node3', current_round = 2 WHERE run_id = 'run_a'`,
    ).run();

    pauseJudgeQueue(db, queueId, { kind: "provider_quota", now: NOW });
    const resumed = resumeJudgeQueue(db, queueId, { now: NOW });
    expect(resumed.resumedJobs).toBe(2);

    const row = db
      .prepare(
        `SELECT state, pause_kind AS k, current_node AS node, current_round AS round
           FROM judge_jobs WHERE run_id = 'run_a'`,
      )
      .get() as { state: string; k: string | null; node: string | null; round: number | null };
    expect(row.state).toBe("queued");
    expect(row.k).toBeNull();
    // Resume continues from the last committed checkpoint.
    expect(row.node).toBe("node3");
    expect(row.round).toBe(2);

    // And the work is claimable again.
    const claim = await jobs.claimNext(queueId, {
      now: NOW,
      leaseMs: 60_000,
      workerId: "w",
    });
    expect(claim).not.toBeNull();
  });

  it("resume can target only one pause kind, leaving manual holds in place", () => {
    pauseJudgeQueue(db, queueId, { kind: "provider_quota", now: NOW });
    // An operator additionally holds one job by hand.
    db.prepare(`UPDATE judge_jobs SET pause_kind = 'manual' WHERE run_id = 'run_b'`).run();

    const resumed = resumeJudgeQueue(db, queueId, { now: NOW, onlyKind: "provider_quota" });
    expect(resumed.resumedJobs).toBe(1);

    const still = db
      .prepare(`SELECT state, pause_kind AS k FROM judge_jobs WHERE run_id = 'run_b'`)
      .get() as { state: string; k: string | null };
    expect(still.state).toBe("paused");
    expect(still.k).toBe("manual");
  });
});

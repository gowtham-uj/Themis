/**
 * Real multi-process claim race against PostgreSQL: N OS processes claim one
 * job concurrently; exactly one wins. This is the WP-5 exit gate that SQLite
 * structurally cannot prove (FOR UPDATE SKIP LOCKED parallelism).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { JUDGE_JOB_TRIGGER_KIND, type NewJudgeJob } from "../src/db/contracts.ts";
import { migrate } from "../src/db/postgres/migrate.ts";
import { PostgresJudgeJobRepository } from "../src/db/postgres/store.ts";

const execFileAsync = promisify(execFile);
const LIVE = Boolean(process.env.AGENTEVAL_DATABASE_URL) || process.env.AGENTEVAL_PG === "1";

function newJob(judgeQueueId: string): NewJudgeJob {
  const n = Math.random().toString(36).slice(2, 10);
  return {
    judgeQueueId,
    judgeQueueGenerationId: `g_${n}`,
    sourceTriggerId: `trig_${n}`,
    sourceTriggerKind: JUDGE_JOB_TRIGGER_KIND.archive_sealed,
    configSnapshotId: `cfg_${n}`,
    configSnapshotSha256: "ab".repeat(32),
    runId: `run_${n}`,
    projectId: "proj_race",
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
  };
}

describe.skipIf(!LIVE)("postgres claim — real multi-process race", () => {
  let pool: pg.Pool;
  let queue: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.AGENTEVAL_DATABASE_URL });
    await migrate(pool);
    queue = `q_race_${Math.random().toString(36).slice(2, 10)}`;
    await new PostgresJudgeJobRepository(pool).upsertByTrigger(newJob(queue));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("exactly one of six racing OS processes claims the job", async () => {
    const helper = "tests/helpers/pg-claim-once.mts";
    const url = process.env.AGENTEVAL_DATABASE_URL!;
    const workers = Array.from({ length: 6 }, (_, i) =>
      execFileAsync(
        process.execPath,
        ["--import", "tsx", helper, url, queue, `w${i}`],
        { env: { ...process.env } },
      ),
    );
    const results = await Promise.all(workers);
    const winners = results.filter(({ stdout }) => stdout.includes("claimed\":true"));
    expect(winners).toHaveLength(1);
    // No runner should have errored.
    for (const r of results) {
      expect(r.stdout).not.toContain("error");
    }
  }, 120_000);
});

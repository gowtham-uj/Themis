/**
 * Real throttle → pause → resume through the claim worker.
 *
 * A gateway that returns 429/quota must NOT crash the worker or burn a retry:
 * the queue pauses (provider_rate_limit / provider_quota) and the job returns to
 * `queued` at its committed checkpoint. A later resume makes it claimable again.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JUDGE_JOB_TRIGGER_KIND, type NewJudgeJob } from "../src/db/contracts.ts";
import { migrate } from "../src/db/sqlite/migrate.ts";
import { SqliteJudgeJobRepository } from "../src/db/sqlite/store.ts";
import { GatewayError, ModelGateway, ProviderThrottledError } from "../src/judge/gateway/client.ts";
import { loadGatewayConfig } from "../src/judge/gateway/config.ts";
import { linkJudgeQueue } from "../src/judge/ingest/store.ts";
import { judgeQueueStatus, resumeJudgeQueue } from "../src/judge/ingest/pause.ts";
import { JudgeClaimWorker } from "../src/judge/worker/claim-worker.ts";

const NOW = "2026-08-23T12:00:00.000Z";

/** A gateway whose chat always throws the given throttle kind. */
class ThrottlingGateway extends ModelGateway {
  constructor(private readonly kind: "rate_limit" | "quota") {
    super(loadGatewayConfig({
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "https://example.invalid/v1",
    }));
  }
  override async chat(): Promise<never> {
    throw new ProviderThrottledError("429 Too Many Requests", this.kind, 429);
  }
}


class TransientGateway extends ModelGateway {
  constructor() {
    super(loadGatewayConfig({
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "https://example.invalid/v1",
    }));
  }
  override async chat(): Promise<never> {
    throw new GatewayError(
      "auth_unavailable: no auth available (providers=openai-compatible-deepseek, model=deepseek-v4-flash)",
      "http",
      503,
    );
  }
}

function newJob(judgeQueueId: string): NewJudgeJob {
  const n = Math.random().toString(36).slice(2, 8);
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

describe("throttle → pause → resume (real worker)", () => {
  let dbPath: string;
  let archivesRoot: string;
  let db: Database.Database;
  let jobs: SqliteJudgeJobRepository;
  let queueId: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-throttle-"));
    dbPath = join(dir, "themis.sqlite");
    archivesRoot = join(dir, "archives");
    db = new Database(dbPath);
    migrate(db);
    jobs = new SqliteJudgeJobRepository(db);
    queueId = linkJudgeQueue(db, {
      name: "q",
      projectId: "proj",
      linkedEvalQueueId: "evalq",
      autoJudge: true,
    }).id;
    const job = newJob(queueId);
    await jobs.upsertByTrigger(job);
    // A real (minimal) archive so Node 0 reaches its model call, where the
    // throttled gateway throws — the worker must then pause, not crash.
    await mkdir(join(archivesRoot, job.runId), { recursive: true });
    await writeFile(join(archivesRoot, job.runId, "verifier-result.json"), `{"reward":1}\n`);
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it("429 rate-limit: worker pauses the queue instead of crashing, no retry burned", async () => {
    const worker = new JudgeClaimWorker({
      themisDbPath: dbPath,
      archivesRoot,
      gateway: new ThrottlingGateway("rate_limit"),
    });

    const result = await worker.tick({
      judgeQueueId: queueId,
      claim: { now: NOW, leaseMs: 60_000, workerId: "w1" },
    });
    // tick returned null (no result published) rather than throwing.
    expect(result).toBeNull();
    worker.close();

    const status = judgeQueueStatus(db, queueId);
    expect(status.status).toBe("paused");
    expect(status.pauseKinds.provider_rate_limit).toBe(1);

    const job = db
      .prepare(`SELECT state, attempt_count AS n FROM judge_jobs WHERE judge_queue_id = ?`)
      .get(queueId) as { state: string; n: number };
    // Paused (holding its checkpoint), NOT failed / dead-letter.
    expect(job.state).toBe("paused");
    // A rate-limit pause must not consume a retry attempt.
    expect(job.n).toBe(0);

    // And it is claimable again after resume.
    resumeJudgeQueue(db, queueId, { now: NOW });
    const claim = await jobs.claimNext(queueId, { now: NOW, leaseMs: 60_000, workerId: "w2" });
    expect(claim).not.toBeNull();
  });

  it("429 quota-exhaustion: worker pauses with provider_quota", async () => {
    const worker = new JudgeClaimWorker({
      themisDbPath: dbPath,
      archivesRoot,
      gateway: new ThrottlingGateway("quota"),
    });
    const result = await worker.tick({
      judgeQueueId: queueId,
      claim: { now: NOW, leaseMs: 60_000, workerId: "w1" },
    });
    expect(result).toBeNull();
    worker.close();

    const status = judgeQueueStatus(db, queueId);
    expect(status.status).toBe("paused");
    expect(status.pauseKinds.provider_quota).toBe(1);
    const job = db
      .prepare(`SELECT state, attempt_count AS n FROM judge_jobs WHERE judge_queue_id = ?`)
      .get(queueId) as { state: string; n: number };
    expect(job.state).toBe("paused");
    expect(job.n).toBe(0);
  });

  it("503 auth_unavailable becomes waiting_retry instead of crashing", async () => {
    const worker = new JudgeClaimWorker({
      themisDbPath: dbPath,
      archivesRoot,
      gateway: new TransientGateway(),
    });
    const result = await worker.tick({
      judgeQueueId: queueId,
      claim: { now: NOW, leaseMs: 60_000, workerId: "w1" },
    });
    expect(result).toBeNull();
    worker.close();

    const job = db.prepare(
      `SELECT state, terminal_error_kind AS kind, attempt_count AS n, available_at AS at
         FROM judge_jobs WHERE judge_queue_id = ?`,
    ).get(queueId) as { state: string; kind: string | null; n: number; at: string };
    expect(job.state).toBe("waiting_retry");
    expect(job.kind).toBe("transient");
    expect(job.n).toBe(1); // transient failures count, unlike quota/rate-limit
    expect(Date.parse(job.at)).toBeGreaterThan(Date.parse(NOW));
  });

});

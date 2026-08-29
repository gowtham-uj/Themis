/**
 * Durable 2-eval judge E2E — exactly how a developer uses the platform engine:
 * queue -> outbox relay -> claim worker -> pause on throttle -> resume SAME PI
 * session -> publish/reseal. No direct runPhase1 bypass.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { migrate } from "../src/db/sqlite/migrate.js";
import { createJudgeQueue } from "../src/db/sqlite/outbox.js";
import { judgeQueueStatus, resumeJudgeQueue } from "../src/judge/ingest/pause.js";
import { submitStandaloneArchives } from "../src/judge/ingest/store.js";
import { OutboxRelay } from "../src/judge/worker/outbox-relay.js";
import { JudgeClaimWorker } from "../src/judge/worker/claim-worker.js";

const RUN_IDS = process.argv.slice(2);
if (RUN_IDS.length !== 2) throw new Error("pass exactly two run ids");

const ROOT = "/work/agenteval";
const DATA = join(ROOT, "data");
const DB_PATH = join(DATA, "themis.sqlite");
const ARCHIVES = join(DATA, "archives");
const WORK_ROOT = join(DATA, "judge_work");
const VIEWS_ROOT = join(DATA, "judge_views");

// Latest-only policy: clear prior durable work + resealed views, never data/archives.
await rm(WORK_ROOT, { recursive: true, force: true });
await rm(VIEWS_ROOT, { recursive: true, force: true });
await mkdir(WORK_ROOT, { recursive: true });
await mkdir(VIEWS_ROOT, { recursive: true });

const db = new Database(DB_PATH);
migrate(db);
const runRows = RUN_IDS.map((runId) => {
  const manifest = JSON.parse(
    readFileSync(join(ARCHIVES, runId, "manifest.json"), "utf8"),
  ) as { project?: { id?: string } };
  const sealed = readFileSync(
    join(ARCHIVES, runId, "eval_lifecycle_logs", "archive.json"),
  );
  return {
    runId,
    projectId: manifest.project?.id ?? "unknown",
    evalQueueId: null,
    baseManifestSha256: createHash("sha256").update(sealed).digest("hex"),
  };
});

const queue = createJudgeQueue(db, {
  projectId: runRows[0]!.projectId,
  name: `durable-2eval-${Date.now()}`,
  autoJudge: false,
  trackId: "durable-two-eval-e2e",
  parallelism: 1,
});
submitStandaloneArchives(db, queue.id, runRows);
const relay = new OutboxRelay(db);
console.log("relay:", await relay.tick({ now: new Date().toISOString(), workerId: "relay-e2e", leaseMs: 60_000, limit: 10 }));

const jobRows = db.prepare(
  `SELECT id, run_id AS runId FROM judge_jobs WHERE judge_queue_id = ? ORDER BY created_at, id`,
).all(queue.id) as Array<{ id: string; runId: string }>;
console.log("queue", queue.id, "jobs", jobRows);
db.close();

// No session import/copy step. The durable job id owns its work directory from
// its first claim onward; pause leaves it in place and resume automatically
// reclaims that SAME job id / directory / PI session via --continue.
const worker = new JudgeClaimWorker({
  themisDbPath: DB_PATH,
  archivesRoot: ARCHIVES,
  workRoot: WORK_ROOT,
  viewsRoot: VIEWS_ROOT,
  node4TimeoutMs: 30 * 60_000,
});

async function tick(label: string): Promise<void> {
  const result = await worker.tick({
    judgeQueueId: queue.id,
    claim: { now: new Date().toISOString(), leaseMs: 30 * 60_000, workerId: label },
  });
  console.log(label, "result", result);
  const sdb = new Database(DB_PATH);
  console.log(label, "status", judgeQueueStatus(sdb, queue.id));
  for (const row of sdb.prepare(
    `SELECT run_id, state, pause_kind, attempt_count, current_node, current_round
       FROM judge_jobs WHERE judge_queue_id = ? ORDER BY created_at, id`,
  ).all(queue.id) as Array<Record<string, unknown>>) {
    console.log(" job", row);
  }
  sdb.close();
}

await tick("worker-1");

// If provider quota/rate limit paused the queue, try a real resume. The SAME
// workDir/session is reused; Node 4 auto-detects the session and passes
// --continue. If balance is still exhausted it pauses again without retry burn.
{
  const sdb = new Database(DB_PATH);
  const status = judgeQueueStatus(sdb, queue.id);
  if (status.status === "paused") {
    const job = jobRows[0]!;
    const sessionsDir = join(WORK_ROOT, job.id, "node4", "sessions");
    const before = await readdir(sessionsDir).catch(() => []);
    console.log("PAUSED — sessions before resume", before.filter((x) => x.endsWith(".jsonl")));
    resumeJudgeQueue(sdb, queue.id, { now: new Date().toISOString() });
    sdb.close();
    console.log("RESUMED queue; retrying same case/session");
    await new Promise((r) => setTimeout(r, 2_000));
    await tick("worker-resume");
    const after = await readdir(sessionsDir).catch(() => []);
    console.log("sessions after resume", after.filter((x) => x.endsWith(".jsonl")));
  } else {
    sdb.close();
  }
}

// Continue queued/waiting_retry work while capacity/provider allows it. A 503
// transient uses bounded available_at backoff, then reclaims the SAME case
// workdir/session; quota/rate-limit remains paused for an explicit resume.
for (let i = 0; i < 8; i += 1) {
  const sdb = new Database(DB_PATH);
  const status = judgeQueueStatus(sdb, queue.id);
  const ready = (status.byState.queued ?? 0) + (status.byState.waiting_retry ?? 0);
  const row = sdb.prepare(
    `SELECT MIN(available_at) AS at FROM judge_jobs
      WHERE judge_queue_id = ? AND state IN ('queued','waiting_retry')`,
  ).get(queue.id) as { at?: string | null };
  sdb.close();
  if (ready === 0 || status.status === "paused") break;
  const waitMs = row.at ? Math.max(0, Date.parse(row.at) - Date.now()) : 0;
  if (waitMs > 0) {
    console.log(`waiting ${waitMs}ms for transient backoff`);
    await new Promise((r) => setTimeout(r, Math.min(waitMs + 100, 65_000)));
  }
  await tick(`worker-next-${i + 1}`);
}

worker.close();
console.log("views:", await readdir(VIEWS_ROOT).catch(() => []));

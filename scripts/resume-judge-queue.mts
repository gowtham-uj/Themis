/**
 * Resume a durable judge queue in place.
 *
 * No archive/session import. Uses the existing judge_jobs rows and their stable
 * data/judge_work/<jobId> directories; Node 4 finds the persisted orchestrator
 * session and invokes pi --continue automatically.
 */
import Database from "better-sqlite3";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { judgeQueueStatus, resumeJudgeQueue } from "../src/judge/ingest/pause.js";
import { JudgeClaimWorker } from "../src/judge/worker/claim-worker.js";

const queueId = process.argv[2];
if (!queueId) throw new Error("usage: resume-judge-queue.mts <judgeQueueId>");

const ROOT = "/work/agenteval/data";
const dbPath = join(ROOT, "themis.sqlite");
const db = new Database(dbPath);
let status = judgeQueueStatus(db, queueId);
console.log("before resume", status);
if (status.status === "paused") {
  console.log("resume", resumeJudgeQueue(db, queueId, { now: new Date().toISOString() }));
}
const jobs = db.prepare(
  `SELECT id, run_id AS runId, state, attempt_count AS attemptCount
     FROM judge_jobs WHERE judge_queue_id = ? ORDER BY created_at, id`,
).all(queueId) as Array<{ id: string; runId: string; state: string; attemptCount: number }>;
db.close();
for (const job of jobs) {
  const sessionsDir = join(ROOT, "judge_work", job.id, "node4", "sessions");
  console.log(job, "sessions", (await readdir(sessionsDir).catch(() => [])).filter((x) => x.endsWith(".jsonl")));
}

const worker = new JudgeClaimWorker({
  themisDbPath: dbPath,
  archivesRoot: join(ROOT, "archives"),
  workRoot: join(ROOT, "judge_work"),
  viewsRoot: join(ROOT, "judge_views"),
  node4TimeoutMs: 30 * 60_000,
});

for (let i = 0; i < 10; i += 1) {
  const sdb = new Database(dbPath);
  status = judgeQueueStatus(sdb, queueId);
  const ready = (status.byState.queued ?? 0) + (status.byState.waiting_retry ?? 0);
  const next = sdb.prepare(
    `SELECT MIN(available_at) AS at FROM judge_jobs
      WHERE judge_queue_id = ? AND state IN ('queued','waiting_retry')`,
  ).get(queueId) as { at?: string | null };
  sdb.close();
  if (ready === 0 || status.status === "paused") break;
  const waitMs = next.at ? Math.max(0, Date.parse(next.at) - Date.now()) : 0;
  if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs + 100, 65_000)));
  const result = await worker.tick({
    judgeQueueId: queueId,
    claim: { now: new Date().toISOString(), leaseMs: 30 * 60_000, workerId: `resume-${i + 1}` },
  });
  console.log(`tick ${i + 1}`, result);
}
worker.close();
const finalDb = new Database(dbPath);
console.log("final", judgeQueueStatus(finalDb, queueId));
console.log(finalDb.prepare(
  `SELECT judge_jobs.id, judge_jobs.run_id, judge_jobs.state, judge_jobs.pause_kind,
          judge_jobs.attempt_count, judge_jobs.current_node, judge_jobs.current_round,
          judge_result_versions.archive_view_path
     FROM judge_jobs
     LEFT JOIN judge_result_versions ON judge_result_versions.run_id = judge_jobs.run_id
    WHERE judge_jobs.judge_queue_id = ?
    ORDER BY judge_jobs.created_at, judge_jobs.id`,
).all(queueId));
finalDb.close();

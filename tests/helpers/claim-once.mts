/**
 * One-shot claimer used by the real-concurrency test in
 * `tests/themis-sqlite-store.test.ts`. Runs as its own OS process against a
 * shared database file, so several of these genuinely race — which a
 * synchronous better-sqlite3 call inside one process never can.
 *
 * argv: <dbPath> <judgeQueueId> <workerId> <startAtEpochMs>
 * stdout: one JSON line — {claimed, jobId, attemptId, token} or {error}.
 */

import Database from "better-sqlite3";

import { SqliteJudgeJobRepository } from "../../src/db/sqlite/store.js";

const [dbPath, queueId, workerId, startAt] = process.argv.slice(2);

const db = new Database(dbPath);
// Every claimer busy-waits to the same wall-clock instant so their write-lock
// attempts overlap. Sleeping to a deadline beats a barrier here: no IPC, and
// the processes are already running by the time the deadline passes.
const deadline = Number(startAt);
while (Date.now() < deadline) {
  /* spin */
}

try {
  const repo = new SqliteJudgeJobRepository(db);
  const claim = await repo.claimNext(queueId, {
    now: "2026-01-01T00:00:00.000Z",
    leaseMs: 60_000,
    workerId,
  });
  process.stdout.write(
    `${JSON.stringify(
      claim === null
        ? { claimed: false }
        : {
            claimed: true,
            jobId: claim.job.id,
            attemptId: claim.attempt.id,
            token: claim.fencingToken,
          },
    )}\n`,
  );
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
} finally {
  db.close();
}

/**
 * One-shot Postgres claimer for the real multi-process race.
 * argv: <databaseUrl> <judgeQueueId> <workerId>
 * stdout: one JSON line — {claimed, jobId, attemptId, token} or {error}.
 */
import pg from "pg";

import { PostgresJudgeJobRepository } from "../../src/db/postgres/store.js";

const [databaseUrl, queueId, workerId] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const jobs = new PostgresJudgeJobRepository(pool);
  const claim = await jobs.claimNext(queueId, {
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
  await pool.end();
}

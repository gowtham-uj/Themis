/**
 * PostgreSQL backend handle (design §1): one pool, ten repositories, explicit
 * transactions, and fail-closed startup.
 *
 * `createPostgresThemisDb` is the ONLY production construction path. It
 * connects and migrates BEFORE returning, so a process cannot serve traffic
 * against a half-migrated or unreachable database. There is no memory/local
 * fallback here — production startup fails closed when PostgreSQL is
 * unavailable.
 */

import type { Pool } from "pg";

import {
  type JudgeAttemptRepository,
  type JudgeConfigSnapshotRepository,
  type JudgeCurrentPointerRepository,
  type JudgeJobRepository,
  type JudgeProviderOperationRepository,
  type JudgeQueueGenerationRepository,
  type JudgeQueueRepository,
  type JudgeResultVersionRepository,
  type IdempotencyKeyRepository,
  type OutboxEventRepository,
  type ThemisDb,
  type ThemisRepos,
  type ThemisTx,
} from "../contracts.js";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";
import {
  PostgresIdempotencyKeyRepository,
  PostgresJudgeAttemptRepository,
  PostgresJudgeConfigSnapshotRepository,
  PostgresJudgeCurrentPointerRepository,
  PostgresJudgeJobRepository,
  PostgresJudgeProviderOperationRepository,
  PostgresJudgeQueueGenerationRepository,
  PostgresJudgeQueueRepository,
  PostgresJudgeResultVersionRepository,
  PostgresOutboxEventRepository,
} from "./store.js";

/** Construction options for the PostgreSQL backend. */
export interface PostgresThemisDbOptions {
  /** `AGENTEVAL_DATABASE_URL` — required; missing throws (fail closed). */
  databaseUrl: string;
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

/**
 * Create the production Themis database handle. Migrates the schema before
 * returning; throws if the database is unreachable or the URL is absent.
 */
export async function createPostgresThemisDb(
  opts: PostgresThemisDbOptions,
): Promise<ThemisDb> {
  const pool: Pool = createPool(opts);
  // Fail closed BEFORE any repository is handed out: a process that cannot
  // reach or migrate PostgreSQL must not serve.
  await migrate(pool);

  const repos: ThemisRepos = {
    judgeQueues: new PostgresJudgeQueueRepository(pool),
    judgeQueueGenerations: new PostgresJudgeQueueGenerationRepository(pool),
    judgeConfigSnapshots: new PostgresJudgeConfigSnapshotRepository(pool),
    judgeJobs: new PostgresJudgeJobRepository(pool),
    judgeAttempts: new PostgresJudgeAttemptRepository(pool),
    judgeProviderOperations: new PostgresJudgeProviderOperationRepository(pool),
    judgeResultVersions: new PostgresJudgeResultVersionRepository(pool),
    judgeCurrentPointers: new PostgresJudgeCurrentPointerRepository(pool),
    outboxEvents: new PostgresOutboxEventRepository(pool),
    idempotencyKeys: new PostgresIdempotencyKeyRepository(pool),
  };

  return {
    ...repos,
    async transaction<T>(fn: (tx: ThemisTx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: ThemisTx = {
          judgeQueues: new PostgresJudgeQueueRepository(client),
          judgeQueueGenerations: new PostgresJudgeQueueGenerationRepository(client),
          judgeConfigSnapshots: new PostgresJudgeConfigSnapshotRepository(client),
          judgeJobs: new PostgresJudgeJobRepository(client),
          judgeAttempts: new PostgresJudgeAttemptRepository(client),
          judgeProviderOperations: new PostgresJudgeProviderOperationRepository(client),
          judgeResultVersions: new PostgresJudgeResultVersionRepository(client),
          judgeCurrentPointers: new PostgresJudgeCurrentPointerRepository(client),
          outboxEvents: new PostgresOutboxEventRepository(client),
          idempotencyKeys: new PostgresIdempotencyKeyRepository(client),
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore rollback failure — the original error is the actionable one */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

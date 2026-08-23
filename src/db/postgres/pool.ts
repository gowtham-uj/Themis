/**
 * PostgreSQL connection pool for the Themis async store.
 *
 * Production startup fails closed if the URL is missing — there is no silent
 * fallback to SQLite or memory (design §1). Statement timeout keeps a runaway
 * query from holding a worker forever; application_name shows up in pg_stat.
 */

import pg from "pg";

export interface PoolOptions {
  /** Connection string; required. */
  databaseUrl: string;
  /** Max clients in the pool (default 10). */
  max?: number;
  /** Per-statement timeout in ms (default 30_000). */
  statementTimeoutMs?: number;
  /** Shown in pg_stat_activity (default "agenteval-themis"). */
  applicationName?: string;
}

/** Create a configured pg Pool. Caller owns shutdown via pool.end(). */
export function createPool(opts: PoolOptions): pg.Pool {
  if (!opts.databaseUrl || typeof opts.databaseUrl !== "string") {
    throw new Error("AGENTEVAL_DATABASE_URL is required for the PostgreSQL backend");
  }
  const pool = new pg.Pool({
    connectionString: opts.databaseUrl,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "agenteval-themis",
  });
  const timeout = opts.statementTimeoutMs ?? 30_000;
  pool.on("connect", (client) => {
    void client.query(`SET statement_timeout = ${timeout}`);
  });
  return pool;
}

export type { Pool, PoolClient } from "pg";

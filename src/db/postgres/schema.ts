/**
 * Drizzle PG schema for the Themis judge-job slice is not required for the
 * repository — `migrate.ts` owns the DDL and `store.ts` uses parameterized
 * SQL. This module exists so the plan's `src/db/postgres/schema.ts` path is
 * present; table shapes mirror `src/db/sqlite/schema.ts`.
 */
export {};

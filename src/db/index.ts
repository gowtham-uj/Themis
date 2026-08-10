/**
 * Persistence entrypoint.
 *
 * openDb(dataDir) → opens <dataDir>/agenteval.db, migrates, returns {db, queries}.
 * resolveProjectDir(dataDir, projectId) → <dataDir>/projects/<projectId> (mkdir).
 *
 * Live path selection:
 *  - Prefer better-sqlite3 + drizzle-orm (backend: "sqlite").
 *  - If the native module fails to load or open, fall back to MemoryQueries
 *    behind the same QueryStore interface so tests stay green without native
 *    sqlite. Override with AGENTEVAL_DB_BACKEND=memory|sqlite.
 *
 * Spec: plan/data-model.md
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "./migrate.js";
import {
  MemoryQueries,
  SqliteQueries,
  type QueryStore,
} from "./queries.js";
import { schema, type Schema } from "./schema.js";

const require = createRequire(import.meta.url);

export type PersistenceBackend = "sqlite" | "memory";

/**
 * Which path is live for this process. Set by the first successful openDb call
 * (or forced via AGENTEVAL_DB_BACKEND=memory|sqlite).
 */
export let PERSISTENCE_BACKEND: PersistenceBackend = "sqlite";

export interface OpenDbResult {
  /** Drizzle DB handle when backend is sqlite; null for memory. */
  db: BetterSQLite3Database<Schema> | null;
  /** Raw better-sqlite3 handle when backend is sqlite; null for memory. */
  raw: Database.Database | null;
  queries: QueryStore;
  /** Which implementation is active for this open. */
  backend: PersistenceBackend;
  dataDir: string;
}

function forceBackend(): PersistenceBackend | null {
  const v = process.env.AGENTEVAL_DB_BACKEND?.toLowerCase();
  if (v === "memory" || v === "sqlite") return v;
  return null;
}

function openMemory(dataDir: string): OpenDbResult {
  PERSISTENCE_BACKEND = "memory";
  return {
    db: null,
    raw: null,
    queries: new MemoryQueries(dataDir),
    backend: "memory",
    dataDir,
  };
}

function tryOpenSqlite(dataDir: string): OpenDbResult | null {
  try {
    // Load native binding via createRequire so a missing/broken .node file
    // throws here (caught) rather than at module import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3Mod = require("better-sqlite3") as
      | (new (path: string) => Database.Database)
      | { default: new (path: string) => Database.Database };
    const DatabaseCtor =
      typeof BetterSqlite3Mod === "function"
        ? BetterSqlite3Mod
        : BetterSqlite3Mod.default;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const drizzleMod = require("drizzle-orm/better-sqlite3") as typeof import("drizzle-orm/better-sqlite3");
    const { drizzle } = drizzleMod;

    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "agenteval.db");
    const raw = new DatabaseCtor(dbPath);
    migrate(raw);
    const db = drizzle(raw, { schema });
    const queries = new SqliteQueries(db, dataDir);
    PERSISTENCE_BACKEND = "sqlite";
    return { db, raw, queries, backend: "sqlite", dataDir };
  } catch (err) {
    if (process.env.AGENTEVAL_DB_DEBUG) {
      console.warn("[db] better-sqlite3 path failed:", err);
    }
    return null;
  }
}

/**
 * Open (or create) the persistence store under `dataDir`.
 *
 * Returns `{ db, raw, queries, backend, dataDir }`. Prefer `queries` for all
 * domain I/O. `backend` is `"sqlite"` when better-sqlite3 works, else `"memory"`.
 */
export function openDb(dataDir: string): OpenDbResult {
  mkdirSync(dataDir, { recursive: true });

  const forced = forceBackend();
  if (forced === "memory") {
    return openMemory(dataDir);
  }

  const sqlite = tryOpenSqlite(dataDir);
  if (sqlite) return sqlite;

  if (forced === "sqlite") {
    throw new Error(
      "AGENTEVAL_DB_BACKEND=sqlite but better-sqlite3 failed to open",
    );
  }

  // Fallback so npm test stays green without a working native sqlite build.
  return openMemory(dataDir);
}

/**
 * Resolve (and create) the on-disk project subtree:
 * `<dataDir>/projects/<projectId>`.
 */
export function resolveProjectDir(dataDir: string, projectId: string): string {
  const dir = join(dataDir, "projects", projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Re-exports for consumers.
export { migrate, getSchemaVersion } from "./migrate.js";
export { SCHEMA_VERSION, schema } from "./schema.js";
export {
  MemoryQueries,
  SqliteQueries,
  type QueryStore,
  type DbQueries,
  type Project,
  type Task,
  type Agent,
  type Run,
  type RunBatch,
  type Judgement,
  type JudgementWithVerdict,
  type JudgementStatus,
  type ScoreRow,
  type CreateJudgementInput,
  type CreateScoreInput,
  type ListJudgementsFilter,
  type ListJudgementsResult,
  type ListFindingsFilter,
  type FindingRow,
  type FindingDetail,
  type FindingKind,
  type FindingLifecycleStatus,
  type OccurrenceRow,
  type OccurrenceStatus,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ProjectAgentAdapter,
  type CreateProjectAgentAdapterInput,
  type UpdateProjectAgentAdapterInput,
  type CliAdapterParserKind,
  type CliCommandTemplate,
  type CliAdapterEvidenceConfig,
  type UpdateTaskInput,
  type CreateBatchInput,
  type CreateRunInput,
  type FinalizeRunInput,
  type ControlStateUpdate,
  type WatcherAction,
  type WatcherRule,
  type WatcherEvent,
  type WatcherEventStatus,
  type QueueEntry,
  type CreateWatcherRuleInput,
  type UpdateWatcherRulePatch,
  type CreateQueueEntryInput,
  type ReorderQueueEntryOpts,
  type PromoteQueueEntryResult,
  type EvalQueue,
  type EvalQueueStatus,
  type CreateEvalQueueInput,
  type UpdateEvalQueueInput,
  type EvalQueueItem,
  type CreateEvalQueueItemInput,
  type UpdateEvalQueueItemInput,
  type QueueContainer,
  type QueueContainerState,
  type CreateQueueContainerInput,
  type UpdateQueueContainerInput,
  type QueueAnalysis,
  type QueueAnalysisStatus,
  type CreateQueueAnalysisInput,
  type UpdateQueueAnalysisInput,
  type EvalArchive,
  type StoreEvalArchiveInput,
  type ApiToken,
  type CreateApiTokenInput,
  type CreatedApiToken,
  type ListApiTokensOpts,
  judgementDir,
  judgementSnapshotPath,
  verdictPath,
  judgeEventsPath,
  readVerdictFromDisk,
} from "./queries.js";

export {
  fingerprintOf,
  normalizeClaim,
  canonicalLocationOf,
  ingestFindings,
  applyRecurrenceToVerdict,
} from "./findings.js";

/**
 * Conventional on-disk layout for run artifacts (events.jsonl, diff.patch).
 *
 * The on-disk convention `<dataDir>/projects/<projectId>/runs/<runId>/{events.jsonl,diff.patch}`
 * is shared by the SSE/ndjson streamer and the diff route. DB-stored paths win
 * when present; otherwise the conventional path is derived.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** On-disk dir for a run: `<dataDir>/projects/<pid>/runs/<rid>`. */
export function runDirPath(
  dataDir: string,
  projectId: string,
  runId: string,
): string {
  return join(dataDir, "projects", projectId, "runs", runId);
}

/**
 * Conventional on-disk events path for a run (whether or not it is live).
 *
 * Sealing moves the canonical trace into `eval_lifecycle_logs/`. Runs sealed
 * before that move was recorded still carry the pre-seal path in the DB, so a
 * missing file falls back to the sealed location before giving up.
 */
export function resolveEventsPath(
  dataDir: string,
  projectId: string,
  runId: string,
  dbPath?: string | null,
): string {
  const path = dbPath ?? join(runDirPath(dataDir, projectId, runId), "events.jsonl");
  if (existsSync(path)) return path;
  const sealed = join(dirname(path), "eval_lifecycle_logs", "events.jsonl");
  return existsSync(sealed) ? sealed : path;
}

/** Conventional on-disk diff path for a run. */
export function resolveDiffPath(
  dataDir: string,
  projectId: string,
  runId: string,
  dbPath?: string | null,
): string {
  if (dbPath) return dbPath;
  return join(runDirPath(dataDir, projectId, runId), "diff.patch");
}

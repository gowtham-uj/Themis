/**
 * WP-11/13 judge result version persistence (sqlite).
 */

import type Database from "better-sqlite3";

import type { JudgeResultVersion, ResultPublicationState } from "../../judge/results/types.js";

function newId(): string {
  return `jrv_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Insert or replace a result version row. */
export function upsertResultVersion(
  db: Database.Database,
  input: Omit<JudgeResultVersion, "id" | "createdAt"> & { id?: string; createdAt?: string },
): JudgeResultVersion {
  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO judge_result_versions (
       id, run_id, track_id, report_sha256, report_path, archive_view_path,
       publication_state, schema_version, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       report_sha256=excluded.report_sha256,
       report_path=excluded.report_path,
       archive_view_path=excluded.archive_view_path,
       publication_state=excluded.publication_state`,
  ).run(
    id,
    input.runId,
    input.trackId,
    input.reportSha256,
    input.reportPath,
    input.archiveViewPath,
    input.publicationState,
    input.schemaVersion,
    createdAt,
  );
  return getResultVersion(db, id)!;
}

/** Fetch one result version. */
export function getResultVersion(
  db: Database.Database,
  id: string,
): JudgeResultVersion | null {
  const r = db.prepare(`SELECT * FROM judge_result_versions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return mapRow(r);
}

/** Keyset-paginated list of result versions for a run, oldest first. */
export function listResultVersionsByRun(
  db: Database.Database,
  runId: string,
  opts: { limit?: number; /** Opaque cursor from a previous page's last item (`createdAt:id`). */ cursor?: string } = {},
): JudgeResultVersion[] {
  const limit = Math.max(0, opts.limit ?? 100);
  let sql = `SELECT * FROM judge_result_versions WHERE run_id = ?`;
  const params: unknown[] = [runId];
  if (opts.cursor !== undefined) {
    const sep = opts.cursor.lastIndexOf(":");
    if (sep <= 0) throw new Error(`invalid result-version cursor`);
    const cursorCreatedAt = opts.cursor.slice(0, sep);
    const cursorId = opts.cursor.slice(sep + 1);
    // Strict keyset: (created_at, id) > (cursor_created_at, cursor_id).
    sql += ` AND (created_at > ? OR (created_at = ? AND id > ?))`;
    params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }
  sql += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Opaque keyset cursor for the given result version (or null). */
export function resultVersionCursor(v: JudgeResultVersion): string {
  return `${v.createdAt}:${v.id}`;
}

function mapRow(r: Record<string, unknown>): JudgeResultVersion {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    trackId: String(r.track_id),
    reportSha256: String(r.report_sha256),
    reportPath: String(r.report_path),
    archiveViewPath: (r.archive_view_path as string | null) ?? null,
    publicationState: r.publication_state as ResultPublicationState,
    schemaVersion: Number(r.schema_version),
    createdAt: String(r.created_at),
  };
}

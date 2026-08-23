/**
 * WP-12 compare-and-swap current pointers for (run_id, track_id).
 */

import type Database from "better-sqlite3";

export interface CurrentPointer {
  runId: string;
  trackId: string;
  resultVersionId: string;
  archiveViewPath: string;
  baseManifestSha256: string;
  updatedAt: string;
}

/** Read the current pointer for a run/track, if any. */
export function getCurrentPointer(
  db: Database.Database,
  runId: string,
  trackId: string,
): CurrentPointer | null {
  const r = db
    .prepare(`SELECT * FROM judge_current_pointers WHERE run_id = ? AND track_id = ?`)
    .get(runId, trackId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    runId: String(r.run_id),
    trackId: String(r.track_id),
    resultVersionId: String(r.result_version_id),
    archiveViewPath: String(r.archive_view_path),
    baseManifestSha256: String(r.base_manifest_sha256),
    updatedAt: String(r.updated_at),
  };
}

/**
 * Advance the current pointer with compare-and-swap on expectedResultVersionId.
 * Pass expectedResultVersionId=null when no pointer should exist yet.
 */
export function advanceCurrentPointer(
  db: Database.Database,
  input: {
    runId: string;
    trackId: string;
    resultVersionId: string;
    archiveViewPath: string;
    baseManifestSha256: string;
    expectedResultVersionId: string | null;
  },
): { advanced: boolean; pointer: CurrentPointer | null } {
  const now = new Date().toISOString();
  const current = getCurrentPointer(db, input.runId, input.trackId);
  if (input.expectedResultVersionId === null) {
    if (current !== null) return { advanced: false, pointer: current };
    db.prepare(
      `INSERT INTO judge_current_pointers (
         run_id, track_id, result_version_id, archive_view_path, base_manifest_sha256, updated_at
       ) VALUES (?,?,?,?,?,?)`,
    ).run(
      input.runId,
      input.trackId,
      input.resultVersionId,
      input.archiveViewPath,
      input.baseManifestSha256,
      now,
    );
    return { advanced: true, pointer: getCurrentPointer(db, input.runId, input.trackId) };
  }
  if (!current || current.resultVersionId !== input.expectedResultVersionId) {
    return { advanced: false, pointer: current };
  }
  // Also require base hash still matches the expected view lineage.
  if (current.baseManifestSha256 !== input.baseManifestSha256) {
    return { advanced: false, pointer: current };
  }
  const updated = db
    .prepare(
      `UPDATE judge_current_pointers
         SET result_version_id = ?, archive_view_path = ?, updated_at = ?
         WHERE run_id = ? AND track_id = ? AND result_version_id = ? AND base_manifest_sha256 = ?`,
    )
    .run(
      input.resultVersionId,
      input.archiveViewPath,
      now,
      input.runId,
      input.trackId,
      input.expectedResultVersionId,
      input.baseManifestSha256,
    );
  if (updated.changes !== 1) {
    return { advanced: false, pointer: getCurrentPointer(db, input.runId, input.trackId) };
  }
  return { advanced: true, pointer: getCurrentPointer(db, input.runId, input.trackId) };
}

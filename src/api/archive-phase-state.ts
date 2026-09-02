/**
 * Phase sealing state for archives.
 *
 * A sealed archive is one of three things, and the base listing cannot tell
 * them apart:
 *
 *   base    only the execution platform's evidence
 *   phase1  a `judge/` view sealed over that base by the Phase-1 courtroom
 *   phase2  a `phase2/` view resealed over the Phase-1 view by a campaign
 *
 * Phase-1 state lives in `judge_current_pointers` and Phase-2 state in
 * `phase2_artifact_publications`, both in `<dataDir>/themis.sqlite`, which the
 * execution platform's own database never sees. This module reads both in one
 * pass and keys them by run so archive listing stays a single query per table
 * rather than two per row.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ArchivePhase1State {
  /** Judgement track the pointer belongs to (`default` for auto-judge). */
  trackId: string;
  resultVersionId: string;
  sealedAt: string;
}

export interface ArchivePhase2State {
  campaignId: string;
  /** Publication lifecycle: preparing, uploaded, verified, committed, published. */
  state: string;
  /** Evals in the campaign this archive was resealed as part of. */
  memberCount: number;
  publishedAt: string | null;
}

export interface ArchivePhaseState {
  /** Highest layer actually published over the base archive. */
  sealed: "base" | "phase1" | "phase2";
  phase1: ArchivePhase1State | null;
  phase2: ArchivePhase2State | null;
}

export const BASE_PHASE_STATE: ArchivePhaseState = { sealed: "base", phase1: null, phase2: null };

/**
 * Read Phase-1 and Phase-2 sealing state for every judged run, keyed by run ID.
 * Returns an empty map when no Themis database exists yet.
 */
export function readArchivePhaseStates(dataDir: string): Map<string, ArchivePhaseState> {
  const states = new Map<string, ArchivePhaseState>();
  const dbPath = join(dataDir, "themis.sqlite");
  if (!existsSync(dbPath)) return states;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return states;
  }

  try {
    if (!hasTable(db, "judge_current_pointers")) return states;
    const pointers = db
      .prepare(`SELECT run_id, track_id, result_version_id, updated_at FROM judge_current_pointers`)
      .all() as Record<string, unknown>[];
    for (const row of pointers) {
      states.set(String(row.run_id), {
        sealed: "phase1",
        phase1: {
          trackId: String(row.track_id),
          resultVersionId: String(row.result_version_id),
          sealedAt: String(row.updated_at),
        },
        phase2: null,
      });
    }

    if (!hasTable(db, "phase2_artifact_publications")) return states;
    const publications = db
      .prepare(
        `SELECT p.run_id AS run_id, p.campaign_id AS campaign_id, p.state AS state,
                p.published_at AS published_at,
                (SELECT COUNT(*) FROM phase2_campaign_members m
                  WHERE m.campaign_id = p.campaign_id) AS member_count
           FROM phase2_artifact_publications p`,
      )
      .all() as Record<string, unknown>[];
    for (const row of publications) {
      const runId = String(row.run_id);
      const phase2: ArchivePhase2State = {
        campaignId: String(row.campaign_id),
        state: String(row.state),
        memberCount: Number(row.member_count ?? 0),
        publishedAt: row.published_at === null ? null : String(row.published_at),
      };
      const existing = states.get(runId);
      states.set(runId, {
        sealed: phase2.state === "published" ? "phase2" : existing?.sealed ?? "base",
        phase1: existing?.phase1 ?? null,
        phase2,
      });
    }
  } finally {
    db.close();
  }

  return states;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

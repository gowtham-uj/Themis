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

/** The project-level start that owns one eval run. */
export interface ArchivePipelineRun {
  generationId: string;
  ordinal: number;
  name: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ArchiveCatalogMetadata {
  phases: Map<string, ArchivePhaseState>;
  pipelineRuns: Map<string, ArchivePipelineRun>;
}

export const BASE_PHASE_STATE: ArchivePhaseState = { sealed: "base", phase1: null, phase2: null };

/** Read archive phase and project-run identity in one Themis database pass. */
export function readArchiveCatalogMetadata(dataDir: string): ArchiveCatalogMetadata {
  const phases = new Map<string, ArchivePhaseState>();
  const pipelineRuns = new Map<string, ArchivePipelineRun>();
  const empty = { phases, pipelineRuns };
  const dbPath = join(dataDir, "themis.sqlite");
  if (!existsSync(dbPath)) return empty;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return empty;
  }

  try {
    if (hasTable(db, "project_pipeline_items") && hasTable(db, "project_pipeline_generations")) {
      const rows = db
        .prepare(
          `SELECT i.run_id AS run_id, g.id AS generation_id, g.ordinal AS ordinal,
                  g.name AS name, g.created_at AS created_at, g.completed_at AS completed_at
             FROM project_pipeline_items i
             JOIN project_pipeline_generations g ON g.id = i.generation_id
            WHERE i.run_id IS NOT NULL`,
        )
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        pipelineRuns.set(String(row.run_id), {
          generationId: String(row.generation_id),
          ordinal: Number(row.ordinal),
          name: row.name === null ? null : String(row.name),
          createdAt: String(row.created_at),
          completedAt: row.completed_at === null ? null : String(row.completed_at),
        });
      }
    }

    if (hasTable(db, "judge_current_pointers")) {
      const pointers = db
        .prepare(`SELECT run_id, track_id, result_version_id, updated_at FROM judge_current_pointers`)
        .all() as Record<string, unknown>[];
      for (const row of pointers) {
        phases.set(String(row.run_id), {
          sealed: "phase1",
          phase1: {
            trackId: String(row.track_id),
            resultVersionId: String(row.result_version_id),
            sealedAt: String(row.updated_at),
          },
          phase2: null,
        });
      }
    }

    if (hasTable(db, "phase2_artifact_publications")) {
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
        const existing = phases.get(runId);
        phases.set(runId, {
          sealed: phase2.state === "published" ? "phase2" : existing?.sealed ?? "base",
          phase1: existing?.phase1 ?? null,
          phase2,
        });
      }
    }
  } finally {
    db.close();
  }

  return empty;
}

/** Read only phase state for callers that do not need project-run identity. */
export function readArchivePhaseStates(dataDir: string): Map<string, ArchivePhaseState> {
  return readArchiveCatalogMetadata(dataDir).phases;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

/**
 * Migration coverage for the phase2_campaigns rebuild.
 *
 * The rest of the suite creates its databases fresh from the current DDL, so
 * the rebuild branch in migrate() never fires and was shipped untested. It
 * failed on the first real database it met: migrate() enables foreign keys and
 * three child tables reference phase2_campaigns(id), so DROP TABLE aborted with
 * SQLITE_CONSTRAINT_FOREIGNKEY and left the half-built scratch table behind,
 * which then made every later startup fail with "table phase2_campaigns_new
 * already exists". These tests build the OLD schema by hand and assert both the
 * data-preserving happy path and that a poisoned leftover recovers.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db/sqlite/migrate.js";

/** The pre-ordinal schema: one campaign per generation, enforced by UNIQUE. */
const OLD_DDL = `
CREATE TABLE phase2_campaigns (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pipeline_generation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0, sut_fingerprint TEXT NOT NULL,
  ontology_version TEXT NOT NULL, membership_sha256 TEXT NOT NULL, config_json TEXT NOT NULL,
  developer_pack_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT);
CREATE TABLE phase2_campaign_members (
  campaign_id TEXT NOT NULL REFERENCES phase2_campaigns(id), pipeline_item_id TEXT NOT NULL,
  run_id TEXT NOT NULL, phase1_result_version_id TEXT NOT NULL, phase1_archive_view_id TEXT NOT NULL,
  valid_for_agent_learning INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(campaign_id, pipeline_item_id));
CREATE TABLE phase2_records (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES phase2_campaigns(id),
  kind TEXT NOT NULL, signature TEXT, owner TEXT, status TEXT,
  source_operation_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE phase2_artifact_publications (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES phase2_campaigns(id), run_id TEXT NOT NULL,
  phase1_archive_view_id TEXT NOT NULL, final_archive_view_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT);
INSERT INTO phase2_campaigns VALUES
  ('p2c_one','proj-1','pgen-1','published',3,'fp','phase2-v1','msha','{}','pack','t0','t1','t2');
INSERT INTO phase2_campaign_members VALUES ('p2c_one','item-1','run-1','rv-1','/work/agenteval/data/projects/proj-1/evals/run-1',1,1);
INSERT INTO phase2_records VALUES ('rec-1','p2c_one','pattern',NULL,NULL,NULL,'op-1','{}','t0');
INSERT INTO phase2_artifact_publications VALUES
  ('pub-1','p2c_one','run-1','/work/agenteval/data/projects/proj-1/evals/run-1','fav-1','msha','published','t0','t1');
`;

describe("phase2_campaigns migration off the one-campaign-per-generation schema", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "themis-migrate-"));
    db = new Database(join(dir, "old.sqlite"));
    db.exec(OLD_DDL);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds ordinal, drops the UNIQUE, and keeps every child row referencing its campaign", () => {
    migrate(db);

    const cols = (db.prepare(`PRAGMA table_info(phase2_campaigns)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain("ordinal");

    // Every column of the one existing row survives, and it becomes ordinal 1.
    const row = db.prepare(`SELECT * FROM phase2_campaigns`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "p2c_one", project_id: "proj-1", pipeline_generation_id: "pgen-1", ordinal: 1,
      state: "published", fencing_token: 3, sut_fingerprint: "fp", ontology_version: "phase2-v1",
      membership_sha256: "msha", config_json: "{}", developer_pack_sha256: "pack",
      created_at: "t0", updated_at: "t1", published_at: "t2",
    });

    // The three child tables reference phase2_campaigns(id). If the rebuild had
    // orphaned them, this is what would say so.
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) n FROM phase2_campaign_members`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) n FROM phase2_records`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) n FROM phase2_artifact_publications`).get()).toEqual({ n: 1 });
    // Old rows stored a host path as an ID. Migration replaces it with the
    // immutable result-version ID already present on the member.
    expect(db.prepare(`SELECT phase1_archive_view_id id FROM phase2_campaign_members`).get()).toEqual({ id: "rv-1" });
    expect(db.prepare(`SELECT phase1_archive_view_id id FROM phase2_artifact_publications`).get()).toEqual({ id: "rv-1" });

    // The point of the whole migration: a second campaign for one generation.
    db.prepare(`INSERT INTO phase2_campaigns VALUES
      ('p2c_two','proj-1','pgen-1',2,'draft',0,'fp','phase2-v1','msha2','{}',NULL,'t3','t3',NULL)`).run();
    expect(db.prepare(`SELECT COUNT(*) n FROM phase2_campaigns`).get()).toEqual({ n: 2 });

    // Second run is a no-op, not a second rebuild.
    migrate(db);
    expect(db.prepare(`SELECT COUNT(*) n FROM phase2_campaigns`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='phase2_campaigns_new'`).all()).toEqual([]);
  });

  it("removes absolute host paths from every pipeline-facing archive-view identity", () => {
    migrate(db);
    db.exec(`
      INSERT INTO project_pipeline_queues
        (id,project_id,eval_queue_id,name,status,revision,auto_eval,auto_phase1,auto_phase2,created_at,updated_at)
        VALUES ('pq-1','proj-1','eq-1','q','running',1,1,1,1,'t0','t0');
      INSERT INTO project_pipeline_generations
        (id,queue_id,ordinal,name,state,fencing_token,config_json,created_at,updated_at)
        VALUES ('pgen-item','pq-1',1,NULL,'completed',0,'{}','t0','t0');
      INSERT INTO project_pipeline_items
        (id,generation_id,ordinal,eval_id,state,run_id,base_archive_id,
         phase1_result_version_id,phase1_archive_view_id,final_archive_view_id,
         error_kind,error_detail,retry_count,created_at,updated_at)
        VALUES ('item-path','pgen-item',1,'eval-1','phase1_published','run-1','a-1',
                'rv-item','/work/agenteval/data/projects/proj-1/evals/run-1',NULL,
                NULL,NULL,0,'t0','t0');
      UPDATE phase2_campaign_members
         SET phase1_archive_view_id='/work/agenteval/data/projects/proj-1/evals/run-1';
      UPDATE phase2_artifact_publications
         SET phase1_archive_view_id='/work/agenteval/data/projects/proj-1/evals/run-1';
    `);

    migrate(db);

    expect(db.prepare(`SELECT phase1_archive_view_id id FROM project_pipeline_items`).get()).toEqual({ id: "rv-item" });
    expect(db.prepare(`SELECT phase1_archive_view_id id FROM phase2_campaign_members`).get()).toEqual({ id: "rv-1" });
    expect(db.prepare(`SELECT phase1_archive_view_id id FROM phase2_artifact_publications`).get()).toEqual({ id: "rv-1" });
  });

  it("reclaims a scratch table left by a failed earlier attempt", () => {
    // Exactly what the first live run left behind: the CREATE and INSERT
    // committed, the DROP tripped foreign keys, and the scratch table stayed.
    db.exec(`CREATE TABLE phase2_campaigns_new (id TEXT PRIMARY KEY, junk TEXT)`);
    db.prepare(`INSERT INTO phase2_campaigns_new VALUES ('stale','x')`).run();

    migrate(db);

    expect(db.prepare(`SELECT ordinal FROM phase2_campaigns`).get()).toEqual({ ordinal: 1 });
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='phase2_campaigns_new'`).all()).toEqual([]);
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});

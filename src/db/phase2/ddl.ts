/** Phase-2 / unified-pipeline DDL for SQLite and PostgreSQL. */

export const PHASE2_SQLITE_DDL: readonly string[] = [
`CREATE TABLE IF NOT EXISTS project_pipeline_queues (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, eval_queue_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1, auto_eval INTEGER NOT NULL DEFAULT 1,
  auto_phase1 INTEGER NOT NULL DEFAULT 1, auto_phase2 INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS project_pipeline_generations (
  id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES project_pipeline_queues(id),
  ordinal INTEGER NOT NULL, name TEXT, state TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  completed_at TEXT, UNIQUE(queue_id, ordinal))`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_active_generation
  ON project_pipeline_generations(queue_id)
  WHERE state IN ('draft','ready','eval_running','phase1_running','phase2_ready','phase2_running','finalizing','waiting_retry','paused')`,
`CREATE INDEX IF NOT EXISTS idx_pipeline_generation_queue ON project_pipeline_generations(queue_id, ordinal, id)`,
`CREATE TABLE IF NOT EXISTS project_pipeline_items (
  id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES project_pipeline_generations(id),
  ordinal INTEGER NOT NULL, eval_id TEXT NOT NULL, state TEXT NOT NULL,
  run_id TEXT, base_archive_id TEXT, phase1_result_version_id TEXT,
  phase1_archive_view_id TEXT, final_archive_view_id TEXT,
  error_kind TEXT, error_detail TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(generation_id, ordinal), UNIQUE(generation_id, eval_id))`,
`CREATE INDEX IF NOT EXISTS idx_pipeline_item_ready ON project_pipeline_items(generation_id, state, ordinal, id)`,
`CREATE TABLE IF NOT EXISTS project_pipeline_events (
  id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES project_pipeline_generations(id),
  item_id TEXT, operation_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE INDEX IF NOT EXISTS idx_pipeline_events_generation ON project_pipeline_events(generation_id, created_at, id)`,
`CREATE TABLE IF NOT EXISTS phase2_campaigns (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pipeline_generation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, fencing_token INTEGER NOT NULL DEFAULT 0, sut_fingerprint TEXT NOT NULL,
  ontology_version TEXT NOT NULL, membership_sha256 TEXT NOT NULL, config_json TEXT NOT NULL,
  developer_pack_sha256 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT)`,
`CREATE INDEX IF NOT EXISTS idx_phase2_campaign_project ON phase2_campaigns(project_id, created_at, id)`,
`CREATE TABLE IF NOT EXISTS phase2_campaign_members (
  campaign_id TEXT NOT NULL REFERENCES phase2_campaigns(id), pipeline_item_id TEXT NOT NULL,
  run_id TEXT NOT NULL, phase1_result_version_id TEXT NOT NULL, phase1_archive_view_id TEXT NOT NULL,
  valid_for_agent_learning INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(campaign_id, pipeline_item_id), UNIQUE(campaign_id, ordinal), UNIQUE(campaign_id, run_id))`,
`CREATE INDEX IF NOT EXISTS idx_phase2_members_campaign ON phase2_campaign_members(campaign_id, ordinal, run_id)`,
`CREATE TABLE IF NOT EXISTS phase2_records (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES phase2_campaigns(id),
  kind TEXT NOT NULL, signature TEXT, owner TEXT, status TEXT,
  source_operation_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(campaign_id, kind, source_operation_id))`,
`CREATE INDEX IF NOT EXISTS idx_phase2_records_campaign_kind ON phase2_records(campaign_id, kind, created_at, id)`,
`CREATE INDEX IF NOT EXISTS idx_phase2_records_signature ON phase2_records(signature, campaign_id, id) WHERE signature IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS phase2_artifact_publications (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES phase2_campaigns(id), run_id TEXT NOT NULL,
  phase1_archive_view_id TEXT NOT NULL, final_archive_view_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, published_at TEXT,
  UNIQUE(campaign_id, run_id), UNIQUE(final_archive_view_id))`,
`CREATE INDEX IF NOT EXISTS idx_phase2_publications_campaign ON phase2_artifact_publications(campaign_id, created_at, id)`,
];

export const PHASE2_POSTGRES_DDL: readonly string[] = PHASE2_SQLITE_DDL.map((sql) =>
  sql.replace("auto_eval INTEGER NOT NULL DEFAULT 1", "auto_eval BOOLEAN NOT NULL DEFAULT TRUE")
     .replace("auto_phase1 INTEGER NOT NULL DEFAULT 1", "auto_phase1 BOOLEAN NOT NULL DEFAULT TRUE")
     .replace("auto_phase2 INTEGER NOT NULL DEFAULT 1", "auto_phase2 BOOLEAN NOT NULL DEFAULT TRUE")
     .replace("valid_for_agent_learning INTEGER NOT NULL", "valid_for_agent_learning BOOLEAN NOT NULL")
);

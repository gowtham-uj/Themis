/**
 * Idempotent PostgreSQL migration for the Themis judge-job slice.
 */

import type { Pool } from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS judge_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  judge_queue_id TEXT NOT NULL,
  judge_queue_generation_id TEXT NOT NULL,
  source_trigger_id TEXT NOT NULL,
  source_trigger_kind TEXT NOT NULL,
  config_snapshot_id TEXT NOT NULL,
  config_snapshot_sha256 TEXT NOT NULL,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  batch_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  base_archive_generation_id TEXT NOT NULL,
  base_manifest_sha256 TEXT NOT NULL,
  publication_policy_json TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  active_attempt_id TEXT,
  active_attempt_number INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_token INTEGER,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  current_node TEXT,
  current_round INTEGER,
  pause_kind TEXT,
  pause_reason TEXT,
  terminal_error_kind TEXT,
  terminal_error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  -- No UNIQUE (id, fencing_token): id is PK so that pair is vacuous.
  CONSTRAINT uq_judge_jobs_trigger UNIQUE (judge_queue_id, source_trigger_kind, source_trigger_id)
);

CREATE INDEX IF NOT EXISTS idx_judge_jobs_ready
  ON judge_jobs (available_at, priority DESC, created_at, id);
CREATE INDEX IF NOT EXISTS idx_judge_jobs_lease_expiry
  ON judge_jobs (lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_judge_jobs_run ON judge_jobs (run_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_judge_jobs_queue ON judge_jobs (judge_queue_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_judge_jobs_project ON judge_jobs (project_id, created_at, id);

CREATE TABLE IF NOT EXISTS judge_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES judge_jobs(id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  working_store_prefix TEXT NOT NULL,
  staging_prefix TEXT NOT NULL,
  state TEXT NOT NULL,
  error_classification TEXT,
  aggregate_model_usage_json TEXT,
  aggregate_web_usage_json TEXT,
  evidence_bytes INTEGER NOT NULL DEFAULT 0,
  estimated_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  checkpoint_reached_json TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  CONSTRAINT uq_judge_attempts_job_number UNIQUE (job_id, attempt_number),
  CONSTRAINT uq_judge_attempts_job_token UNIQUE (job_id, fencing_token)
);
CREATE INDEX IF NOT EXISTS idx_judge_attempts_job ON judge_attempts (job_id);

CREATE TABLE IF NOT EXISTS judge_provider_operations (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  node TEXT NOT NULL,
  metric_or_role TEXT NOT NULL,
  round INTEGER,
  round_execution_id TEXT,
  assignment_id TEXT,
  operation_kind TEXT NOT NULL,
  canonical_request_digest TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  canonical_url TEXT,
  provider_idempotency_key TEXT,
  provider_request_id TEXT,
  state TEXT NOT NULL,
  authoritative BOOLEAN NOT NULL DEFAULT FALSE,
  response_blob_key TEXT,
  response_blob_hash TEXT,
  usage_json TEXT,
  cost DOUBLE PRECISION,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  error_classification TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jpo_attempt_state
  ON judge_provider_operations (attempt_id, state);
CREATE INDEX IF NOT EXISTS idx_jpo_attempt_created
  ON judge_provider_operations (attempt_id, created_at, id);

CREATE TABLE IF NOT EXISTS judge_queues (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  linked_eval_queue_id TEXT,
  auto_judge BOOLEAN NOT NULL DEFAULT FALSE,
  track_id TEXT NOT NULL,
  parallelism INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_judge_queues_linked
  ON judge_queues (linked_eval_queue_id) WHERE linked_eval_queue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_judge_queues_project
  ON judge_queues (project_id, created_at, id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_token INTEGER,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (aggregate_type, aggregate_id, event_type, payload_version)
);
CREATE INDEX IF NOT EXISTS idx_outbox_undelivered
  ON outbox_events (available_at, created_at, id);

CREATE TABLE IF NOT EXISTS judge_result_versions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  report_sha256 TEXT NOT NULL,
  report_path TEXT NOT NULL,
  archive_view_path TEXT,
  publication_state TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_judge_result_versions_run
  ON judge_result_versions (run_id, created_at, id);

CREATE TABLE IF NOT EXISTS judge_current_pointers (
  run_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  result_version_id TEXT NOT NULL,
  archive_view_path TEXT NOT NULL,
  base_manifest_sha256 TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, track_id)
);

CREATE TABLE IF NOT EXISTS judge_documents (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  node TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_judge_documents_case
  ON judge_documents (case_id, round, sequence, id);

CREATE TABLE IF NOT EXISTS judge_config_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  judge_queue_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (judge_queue_id, sha256)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  route TEXT NOT NULL,
  caller_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_status INTEGER,
  response_body_json TEXT,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, route, caller_key)
);
`;

/** Apply the slice's DDL. Safe to call repeatedly. */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(DDL);
}

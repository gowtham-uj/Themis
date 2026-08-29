/**
 * Idempotent, versioned PostgreSQL migration for the Themis async store.
 *
 * Two guarantees:
 *  1. IDEMPOTENT — running it against an already-migrated database is a no-op.
 *     Every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
 *     EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so the whole DDL can
 *     replay safely. Column additions for databases created by an older slice
 *     are applied as guarded ALTERs so existing rows survive.
 *  2. SINGLE-FLIGHT — concurrent migrators (two API pods booting at once) cannot
 *     interleave DDL. `migrate` takes a transaction-level advisory lock first;
 *     the second process waits, then finds every object already present and
 *     applies nothing.
 *
 * Versioning: `themis_schema_migrations` records each migration step with an
 * ordinal; `schemaVersion()` reports the highest applied ordinal without
 * re-running anything.
 */

import type { Pool } from "pg";

import { PHASE2_POSTGRES_DDL } from "../phase2/ddl.js";

/** Advisory-lock key (arbitrary but fixed). Shared by every migrator process. */
const MIGRATION_LOCK_KEY = 746_291_001;

/** Ordered migration steps. Append-only: never edit or reorder an entry that
 *  has shipped, or version numbers stop meaning anything. */
const MIGRATIONS: readonly { id: number; name: string; statements: readonly string[] }[] = [
  {
    id: 1,
    name: "judge_jobs + judge_attempts",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_jobs (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_ready
         ON judge_jobs (available_at, priority DESC, created_at, id)`,
      // Claim hot path: exact WHERE prefix + ORDER BY, partial to exclude terminal rows.
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_claim
         ON judge_jobs (judge_queue_id, priority DESC, available_at, created_at, id)
         WHERE state IN ('queued', 'waiting_retry')`,
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_lease_expiry
         ON judge_jobs (lease_expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_reap
         ON judge_jobs (lease_expires_at, id)
         WHERE state IN ('leased', 'running', 'sealing')`,
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_run ON judge_jobs (run_id, created_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_queue ON judge_jobs (judge_queue_id, created_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_judge_jobs_project ON judge_jobs (project_id, created_at, id)`,
      `CREATE TABLE IF NOT EXISTS judge_attempts (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_judge_attempts_job ON judge_attempts (job_id)`,
    ],
  },
  {
    id: 2,
    name: "judge_provider_operations",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_provider_operations (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jpo_attempt_state
         ON judge_provider_operations (attempt_id, state)`,
      `CREATE INDEX IF NOT EXISTS idx_jpo_attempt_created
         ON judge_provider_operations (attempt_id, created_at, id)`,
      // Authoritative-once per logical unit: exactly one succeeded operation may
      // be authoritative for (attempt, node, metricOrRole, round, roundExec,
      // assignment, requestDigest, provider, model).
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_jpo_authoritative
         ON judge_provider_operations (
           attempt_id, node, metric_or_role,
           COALESCE(round, -1), COALESCE(round_execution_id, ''),
           COALESCE(assignment_id, ''), canonical_request_digest,
           provider, COALESCE(model, '')
         )
         WHERE authoritative AND state = 'succeeded'`,
    ],
  },
  {
    id: 3,
    name: "judge_queues",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_queues (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        linked_eval_queue_id TEXT,
        auto_judge BOOLEAN NOT NULL DEFAULT FALSE,
        track_key TEXT NOT NULL,
        parallelism INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        retry_policy_json TEXT NOT NULL DEFAULT '{}',
        model_settings_json TEXT NOT NULL DEFAULT '{}',
        node0_chunk_size INTEGER NOT NULL DEFAULT 1,
        node2_metric_selection_json TEXT NOT NULL DEFAULT '[]',
        clerk_settings_json TEXT NOT NULL DEFAULT '{}',
        node4_settings_json TEXT NOT NULL DEFAULT '{}',
        budget_limits_json TEXT NOT NULL DEFAULT '{}',
        pause_kind TEXT,
        pause_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_judge_queues_linked
         ON judge_queues (linked_eval_queue_id) WHERE linked_eval_queue_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_judge_queues_project
         ON judge_queues (project_id, created_at, id)`,
      // Guarded column additions for databases created by the WP-5 sqlite-parity
      // slice (which lacked the frozen-contract columns). Existing rows keep
      // their values; new writes use the contract fields.
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS track_key TEXT`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS retry_policy_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS model_settings_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS node0_chunk_size INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS node2_metric_selection_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS clerk_settings_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS node4_settings_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS budget_limits_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS pause_kind TEXT`,
      `ALTER TABLE judge_queues ADD COLUMN IF NOT EXISTS pause_reason TEXT`,
      // Backfill track_key so rows created before the backfill (or by a legacy
      // writer between the ADD COLUMN and this statement) read through the
      // repository instead of failing on NOT NULL. The legacy track_id column
      // is not referenced here: on a fresh database it does not exist, and on a
      // legacy database its rows were already backfilled when the column was
      // first added.
      `UPDATE judge_queues SET track_key = id WHERE track_key IS NULL`,
      `ALTER TABLE judge_queues ALTER COLUMN track_key SET NOT NULL`,
    ],
  },
  {
    id: 4,
    name: "outbox_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL DEFAULT 1,
        event_type TEXT NOT NULL,
        payload_version INTEGER NOT NULL DEFAULT 1,
        payload_body TEXT NOT NULL,
        available_at TIMESTAMPTZ NOT NULL,
        lease_owner TEXT,
        lease_token INTEGER,
        lease_expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        -- Outbox event identity per aggregate (contract): redelivered events dedupe.
        CONSTRAINT uq_outbox_aggregate_event
          UNIQUE (aggregate_type, event_type, aggregate_version, aggregate_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_pending
         ON outbox_events (available_at, created_at, id)
         WHERE delivered_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_undelivered
         ON outbox_events (available_at, created_at, id)`,
    ],
  },
  {
    id: 5,
    name: "idempotency_keys",
    statements: [
      `CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        route TEXT NOT NULL,
        caller_identity TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        response_status INTEGER,
        response_body_ref TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (project_id, route, caller_identity, key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at)`,
    ],
  },
  {
    id: 6,
    name: "judge_config_snapshots",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_config_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        judge_queue_id TEXT NOT NULL REFERENCES judge_queues(id),
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        queue_revision INTEGER NOT NULL,
        config_sha256 TEXT NOT NULL,
        prompt_bodies_encrypted TEXT,
        prompt_sha256_by_role_json TEXT NOT NULL DEFAULT '{}',
        model_settings_json TEXT NOT NULL DEFAULT '{}',
        retry_policy_json TEXT NOT NULL DEFAULT '{}',
        budget_limits_json TEXT NOT NULL DEFAULT '{}',
        sub_agent_cap INTEGER NOT NULL DEFAULT 1,
        max_rounds INTEGER NOT NULL DEFAULT 10,
        tool_registry_version TEXT NOT NULL DEFAULT '',
        template_schema_version TEXT NOT NULL DEFAULT '',
        graph_version TEXT NOT NULL DEFAULT '',
        extractor_version TEXT NOT NULL DEFAULT '',
        runtime_versions_json TEXT NOT NULL DEFAULT '{}',
        input_archive_generation_id TEXT NOT NULL DEFAULT '',
        input_manifest_sha256 TEXT NOT NULL DEFAULT '',
        provenance_json TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (job_id)
      )`,
      // Guarded additions for the legacy sha256/body_json slice table. These
      // MUST run before any index that references them: a database created by
      // the WP-5 slice lacks job_id, so an index on it would fail with 42703.
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS job_id TEXT`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS queue_revision INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS config_sha256 TEXT`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS prompt_bodies_encrypted TEXT`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS prompt_sha256_by_role_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS model_settings_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS retry_policy_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS budget_limits_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS sub_agent_cap INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS max_rounds INTEGER NOT NULL DEFAULT 10`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS tool_registry_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS template_schema_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS graph_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS extractor_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS runtime_versions_json TEXT NOT NULL DEFAULT '{}'`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS input_archive_generation_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS input_manifest_sha256 TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_config_snapshots ADD COLUMN IF NOT EXISTS provenance_json TEXT NOT NULL DEFAULT '{}'`,
      `CREATE INDEX IF NOT EXISTS idx_judge_config_snapshots_job
         ON judge_config_snapshots (job_id)`,
    ],
  },
  {
    id: 7,
    name: "judge_result_versions",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_result_versions (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        judge_queue_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        pipeline_version TEXT NOT NULL DEFAULT '',
        template_version TEXT NOT NULL DEFAULT '',
        schema_version INTEGER NOT NULL DEFAULT 1,
        config_snapshot_id TEXT NOT NULL DEFAULT '',
        config_sha256 TEXT NOT NULL DEFAULT '',
        rejudge_trigger_id TEXT,
        base_archive_generation_id TEXT NOT NULL DEFAULT '',
        archive_generation_id TEXT NOT NULL DEFAULT '',
        report_blob_key TEXT NOT NULL DEFAULT '',
        report_sha256 TEXT NOT NULL,
        report_byte_length INTEGER NOT NULL DEFAULT 0,
        publication_state TEXT NOT NULL DEFAULT 'preparing',
        result_sequence INTEGER,
        official_reward DOUBLE PRECISION,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      )`,
      // Per-project monotonic publish sequence.
      `CREATE SEQUENCE IF NOT EXISTS seq_jrv_result_sequence`,
      // Guarded additions for the legacy report_path/archive_view_path slice.
      // These MUST run before any index that references them: the legacy table
      // lacks project_id/judge_queue_id/result_sequence, so an index on them
      // would fail with 42703.
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS case_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS judge_queue_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS template_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS config_snapshot_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS config_sha256 TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS rejudge_trigger_id TEXT`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS base_archive_generation_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS archive_generation_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS report_blob_key TEXT`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS report_byte_length INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS result_sequence INTEGER`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS official_reward DOUBLE PRECISION`,
      `ALTER TABLE judge_result_versions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
      `CREATE INDEX IF NOT EXISTS idx_jrv_run_completed
         ON judge_result_versions (run_id, completed_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_jrv_project_completed
         ON judge_result_versions (project_id, completed_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_jrv_queue_completed
         ON judge_result_versions (judge_queue_id, completed_at, id)`,
      // Export hot path: published versions of a project up to a sequence mark.
      `CREATE INDEX IF NOT EXISTS idx_jrv_project_sequence
         ON judge_result_versions (project_id, result_sequence, id)
         WHERE publication_state = 'published'`,
    ],
  },
  {
    id: 8,
    name: "judge_current_pointers",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_current_pointers (
        run_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        result_version_id TEXT NOT NULL,
        archive_view_generation_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (run_id, track_id)
      )`,
      // Guarded addition for the legacy archive_view_path slice.
      `ALTER TABLE judge_current_pointers ADD COLUMN IF NOT EXISTS archive_view_generation_id TEXT`,
      `UPDATE judge_current_pointers
          SET archive_view_generation_id = COALESCE(archive_view_generation_id, result_version_id)
        WHERE archive_view_generation_id IS NULL`,
      `ALTER TABLE judge_current_pointers ALTER COLUMN archive_view_generation_id SET NOT NULL`,
    ],
  },
  {
    id: 9,
    name: "judge_queue_generations",
    statements: [
      `CREATE TABLE IF NOT EXISTS judge_queue_generations (
        id TEXT PRIMARY KEY NOT NULL,
        judge_queue_id TEXT NOT NULL REFERENCES judge_queues(id),
        queue_revision INTEGER NOT NULL,
        config_snapshot_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        state TEXT NOT NULL,
        source_trigger TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        closed_at TIMESTAMPTZ,
        CONSTRAINT uq_jqg_queue_ordinal UNIQUE (judge_queue_id, ordinal)
      )`,
      // Only one accepting generation per queue — the partial unique index the
      // design's getCurrentAccepting/createNext/close protocol relies on.
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_jqg_accepting
         ON judge_queue_generations (judge_queue_id) WHERE state = 'accepting'`,
      `CREATE INDEX IF NOT EXISTS idx_jqg_queue_ordinal
         ON judge_queue_generations (judge_queue_id, ordinal, id)`,
    ],
  },
  {
    id: 10,
    name: "reconcile legacy judge_queues.track_id",
    statements: [
      // A database created by the WP-5 sqlite-parity slice carries
      // `judge_queues.track_id NOT NULL` with no default, while the frozen
      // contract writes only `track_key`. Reconcile the superseded column so
      // contract-shaped INSERTs are not rejected. Guarded by a column-existence
      // check so a fresh database (which never had track_id) replays as a no-op.
      `DO $$ BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'judge_queues' AND column_name = 'track_id'
         ) THEN
           ALTER TABLE judge_queues ALTER COLUMN track_id DROP NOT NULL;
           ALTER TABLE judge_queues ALTER COLUMN track_id SET DEFAULT '';
           UPDATE judge_queues SET track_id = COALESCE(track_id, track_key) WHERE track_id IS NULL;
         END IF;
       END $$`,
    ],
  },
  {
    id: 11,
    name: "reconcile legacy slices to the frozen contract columns",
    statements: [
      // Each of these tables was created by the WP-5 sqlite-parity slice with
      // columns the frozen contract does not carry (report_path, payload_json,
      // archive_view_path, base_manifest_sha256, sha256, body_json) as NOT NULL.
      // The contract-shaped INSERTs in store.ts do not supply them, so they must
      // become nullable. Every legacy-column touch is guarded by a column
      // existence check so a FRESH database (which never had those columns)
      // replays this step as a no-op; the frozen-contract columns the legacy
      // tables lack are added with IF NOT EXISTS so either shape reads/writes.
      `ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS aggregate_version INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS payload_body TEXT`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'judge_result_versions' AND column_name = 'report_path') THEN
           ALTER TABLE judge_result_versions ALTER COLUMN report_path DROP NOT NULL;
           ALTER TABLE judge_result_versions ALTER COLUMN report_path SET DEFAULT '';
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'judge_current_pointers' AND column_name = 'archive_view_path') THEN
           ALTER TABLE judge_current_pointers ALTER COLUMN archive_view_path DROP NOT NULL;
           ALTER TABLE judge_current_pointers ALTER COLUMN archive_view_path SET DEFAULT '';
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'judge_current_pointers' AND column_name = 'base_manifest_sha256') THEN
           ALTER TABLE judge_current_pointers ALTER COLUMN base_manifest_sha256 DROP NOT NULL;
           ALTER TABLE judge_current_pointers ALTER COLUMN base_manifest_sha256 SET DEFAULT '';
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'outbox_events' AND column_name = 'payload_json') THEN
           ALTER TABLE outbox_events ALTER COLUMN payload_json DROP NOT NULL;
           ALTER TABLE outbox_events ALTER COLUMN payload_json SET DEFAULT '';
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'judge_config_snapshots' AND column_name = 'sha256') THEN
           ALTER TABLE judge_config_snapshots ALTER COLUMN sha256 DROP NOT NULL;
           ALTER TABLE judge_config_snapshots ALTER COLUMN sha256 SET DEFAULT '';
         END IF;
       END $$`,
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'judge_config_snapshots' AND column_name = 'body_json') THEN
           ALTER TABLE judge_config_snapshots ALTER COLUMN body_json DROP NOT NULL;
           ALTER TABLE judge_config_snapshots ALTER COLUMN body_json SET DEFAULT '';
         END IF;
       END $$`,
    ],
  },
  {
    id: 12,
    name: "reconcile outbox event identity to the frozen contract",
    statements: [
      // The WP-5 slice keyed outbox identity on (aggregate_type, aggregate_id,
      // event_type, payload_version); the frozen contract keys it on
      // (aggregate_type, event_type, aggregate_version, aggregate_id). The
      // legacy key cannot express "a new aggregate_version of the same event",
      // and the frozen key cannot be a second unique index beside it. Drop the
      // autogenerated legacy constraint (guarded) and install the frozen one.
      `DO $$ BEGIN
         IF EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'outbox_events_aggregate_type_aggregate_id_event_type_payloa_key'
             AND conrelid = 'outbox_events'::regclass
         ) THEN
           ALTER TABLE outbox_events
             DROP CONSTRAINT outbox_events_aggregate_type_aggregate_id_event_type_payloa_key;
         END IF;
       END $$`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_aggregate_event
         ON outbox_events (aggregate_type, event_type, aggregate_version, aggregate_id)`,
    ],
  },
  {
    id: 13,
    name: "project pipeline and black-box phase2 metadata",
    statements: PHASE2_POSTGRES_DDL,
  },
  {
    id: 14,
    name: "link project pipeline queue to eval queue",
    statements: [
      `ALTER TABLE project_pipeline_queues ADD COLUMN IF NOT EXISTS eval_queue_id TEXT`,
      `UPDATE project_pipeline_queues SET eval_queue_id = id WHERE eval_queue_id IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_pipeline_eval_queue ON project_pipeline_queues(eval_queue_id)`,
    ],
  },
];

/** Create the bookkeeping table itself (outside the steps, first). */
const BOOKKEEPING_DDL = `
CREATE TABLE IF NOT EXISTS themis_schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** Apply every not-yet-applied migration step. Safe to call repeatedly and
 *  concurrently: an advisory lock serializes migrators; the bookkeeping table
 *  makes replays no-ops even when the objects already exist. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Single-flight: concurrent migrators block here instead of racing DDL.
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(BOOKKEEPING_DDL);
    const { rows } = await client.query<{ id: number }>(
      "SELECT id FROM themis_schema_migrations",
    );
    const applied = new Set(rows.map((r) => r.id));
    for (const step of MIGRATIONS) {
      if (applied.has(step.id)) continue;
      for (const statement of step.statements) {
        await client.query(statement);
      }
      await client.query(
        "INSERT INTO themis_schema_migrations (id, name) VALUES ($1, $2)",
        [step.id, step.name],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Highest applied migration ordinal (0 when none). */
export async function schemaVersion(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string | number }>(
    "SELECT COALESCE(MAX(id), 0)::text AS id FROM themis_schema_migrations",
  ).catch(() => ({ rows: [{ id: 0 }] as Array<{ id: string | number }> }));
  return Number(rows[0]?.id ?? 0);
}

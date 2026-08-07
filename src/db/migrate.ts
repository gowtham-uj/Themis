/**
 * Idempotent migration runner for the agenteval SQLite store.
 *
 * Strategy:
 *  - Stamp schema version via `PRAGMA user_version` and a `schema_migrations` table.
 *  - All CREATE TABLE / INDEX statements use IF NOT EXISTS so re-running is safe.
 *  - Safe to call repeatedly on an already-migrated DB.
 *
 * Spec: plan/data-model.md
 */

import type Database from "better-sqlite3";
import { SCHEMA_VERSION } from "./schema.js";

/**
 * Raw SQL DDL matching plan/data-model.md. Order respects FK dependencies
 * (agents before projects; projects/tasks before runs; etc.).
 */
const DDL: string[] = [
  // Global agents first (referenced by projects.default_agent_id, run_batches, runs, queue).
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    default_model TEXT,
    default_provider TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    task_source_json TEXT NOT NULL,
    default_agent_id TEXT REFERENCES agents(id),
    default_model TEXT,
    default_provider TEXT,
    default_judge_model TEXT,
    workspace_image TEXT,
    check_runners_json TEXT,
    adapter_overrides_json TEXT,
    network_policy TEXT DEFAULT 'allow',
    retention_runs INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    external_id TEXT,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    workspace_source TEXT NOT NULL,
    workspace_repo TEXT,
    workspace_ref TEXT,
    rubric_json TEXT NOT NULL,
    rubric_version INTEGER NOT NULL DEFAULT 1,
    agent_category TEXT NOT NULL DEFAULT 'coding',
    profile TEXT,
    reference_solution TEXT,
    checks_json TEXT,
    tags TEXT,
    source_kind TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, external_id)
  )`,

  `CREATE TABLE IF NOT EXISTS run_batches (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    params_json TEXT NOT NULL,
    repeats INTEGER NOT NULL,
    trigger TEXT,
    trigger_ref TEXT,
    agent_image TEXT,
    agent_commit TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS watcher_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    role TEXT NOT NULL,
    repo TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ref TEXT,
    semver_filter TEXT,
    action_json TEXT NOT NULL,
    webhook_secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES run_batches(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    repeat_index INTEGER NOT NULL,
    status TEXT NOT NULL,
    workspace_commit TEXT,
    agent_image TEXT,
    agent_commit TEXT,
    agent_image_source TEXT,
    trigger TEXT,
    trigger_ref TEXT,
    trigger_rule_id TEXT REFERENCES watcher_rules(id),
    control_state TEXT,
    paused_at TEXT,
    resumed_at TEXT,
    pause_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_cost REAL,
    events_path TEXT,
    diff_path TEXT,
    error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS watcher_events (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES watcher_rules(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    received_at TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ref TEXT,
    resolved_sha TEXT,
    status TEXT NOT NULL,
    batch_id TEXT REFERENCES run_batches(id),
    error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS queue_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    trigger_ref TEXT,
    target_kind TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id),
    task_tags_json TEXT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    model TEXT,
    provider TEXT,
    repeats INTEGER,
    params_json TEXT,
    adapter_overrides_json TEXT,
    auto_judge INTEGER,
    judge_model TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    dedup_key TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    promoted_at TEXT,
    promoted_batch_id TEXT REFERENCES run_batches(id),
    removed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_project_status ON queue_entries(project_id, status)`,

  `CREATE TABLE IF NOT EXISTS judgements (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    judge_model TEXT NOT NULL,
    judge_provider TEXT NOT NULL,
    judge_prompt TEXT,
    system_prompt_version TEXT NOT NULL,
    status TEXT NOT NULL,
    overall_score REAL,
    verdict TEXT,
    report_path TEXT,
    events_path TEXT,
    verdict_path TEXT,
    created_at TEXT,
    ended_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    judgement_id TEXT NOT NULL REFERENCES judgements(id),
    criterion TEXT NOT NULL,
    weight REAL NOT NULL,
    score REAL NOT NULL,
    rationale TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS findings (
    fingerprint TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    claim TEXT NOT NULL,
    latest_severity TEXT,
    latest_confidence REAL,
    first_seen_judgement TEXT REFERENCES judgements(id),
    last_seen_judgement TEXT REFERENCES judgements(id),
    first_seen_at TEXT,
    last_seen_at TEXT,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    resolved_at TEXT,
    status TEXT NOT NULL DEFAULT 'open'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_findings_task ON findings(task_id)`,

  `CREATE TABLE IF NOT EXISTS finding_occurrences (
    id TEXT PRIMARY KEY,
    finding_fingerprint TEXT NOT NULL REFERENCES findings(fingerprint),
    judgement_id TEXT NOT NULL REFERENCES judgements(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    claim TEXT NOT NULL,
    criterion TEXT,
    refs_json TEXT NOT NULL,
    fix_json TEXT,
    status TEXT NOT NULL DEFAULT 'introduced',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_occurrences_run ON finding_occurrences(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_occurrences_judgement ON finding_occurrences(judgement_id)`,

  `CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    passed INTEGER,
    detail TEXT
  )`,

  // Users (P9-settings). username + scrypt password_hash; first user = admin.
  // Note: older DBs may have had (email, pw_hash) — ensureUserColumns() heals.
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT,
    created_at TEXT,
    email TEXT UNIQUE
  )`,

  // Global settings (P9) — key/value JSON; secrets never stored as raw values.
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // API tokens (P8b-auth). Plaintext is NEVER stored — only sha256 hex of bearer.
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    project_id TEXT,
    token_hash TEXT NOT NULL,
    label TEXT,
    read_only INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)`,

  // Outbound webhook subscriptions (P8c) — secret returned once at create.
  `CREATE TABLE IF NOT EXISTS outbound_subscriptions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    event_types_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_subs_project ON outbound_subscriptions(project_id)`,

  // Delivery attempt log for outbound webhooks.
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES outbound_subscriptions(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    response_status INTEGER,
    response_body TEXT,
    error TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project_created ON webhook_deliveries(project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub ON webhook_deliveries(subscription_id)`,

  // Deterministic check results (P9, rubric.md §5). The verdict JSON also
  // carries checkResults; this table is a run-keyed DB mirror so API consumers
  // can query pass-rates without parsing the verdict body.
  `CREATE TABLE IF NOT EXISTS check_results (
    run_id TEXT NOT NULL,
    results_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_check_results_run ON check_results(run_id)`,

  // Project-scoped reusable rubrics (plan/rubric.md §6 profiles). A task may
  // embed its own rubric_json OR reference one of these by id; the project
  // rubric is the shared, versioned baseline that many tasks can point at.
  `CREATE TABLE IF NOT EXISTS project_rubrics (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    description TEXT,
    rubric_json TEXT NOT NULL,
    rubric_version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_rubrics_project ON project_rubrics(project_id)`,

  // Version bookkeeping (in addition to PRAGMA user_version).
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
];

/**
 * Best-effort ADD COLUMN for DBs created before a column existed.
 * SQLite has no IF NOT EXISTS for columns — ignore "duplicate column" errors.
 */
function ensureColumns(db: Database.Database): void {
  const alters = [
    "ALTER TABLE users ADD COLUMN username TEXT",
    "ALTER TABLE users ADD COLUMN password_hash TEXT",
    "ALTER TABLE users ADD COLUMN role TEXT",
    "ALTER TABLE users ADD COLUMN created_at TEXT",
    "ALTER TABLE users ADD COLUMN email TEXT",
    // Artifact retention: what survives judgement (keep|referenced|all).
    "ALTER TABLE projects ADD COLUMN artifact_retention TEXT DEFAULT 'keep'",
    // Sandbox policy: per-project container controls (caps, mounts, devices…).
    "ALTER TABLE projects ADD COLUMN sandbox_json TEXT",
    // Per-run adapter overrides (image, env, params, tools) as submitted.
    "ALTER TABLE runs ADD COLUMN adapter_overrides_json TEXT",
    // Per-eval environment spec (greenfield/brownfield, image, setup script).
    "ALTER TABLE tasks ADD COLUMN env_json TEXT",
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch {
      // column already present — ok
    }
  }
}

/**
 * Apply schema migrations to an open better-sqlite3 Database.
 * Idempotent: CREATE IF NOT EXISTS + version stamp.
 */
export function migrate(db: Database.Database): void {
  // Foreign keys on for integrity after tables exist.
  db.pragma("foreign_keys = ON");

  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);

  if (current >= SCHEMA_VERSION) {
    // Still re-run IF NOT EXISTS DDL so partially-created DBs heal, and
    // ensure the migrations table has a row for the current version.
    const apply = db.transaction(() => {
      for (const stmt of DDL) {
        db.exec(stmt);
      }
      ensureColumns(db);
      const row = db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(SCHEMA_VERSION) as { version: number } | undefined;
      if (!row) {
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(SCHEMA_VERSION, new Date().toISOString());
      }
    });
    apply();
    return;
  }

  const apply = db.transaction(() => {
    for (const stmt of DDL) {
      db.exec(stmt);
    }
    ensureColumns(db);
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(SCHEMA_VERSION, new Date().toISOString());
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  apply();
}

/** Read the stamped schema version (0 if never migrated). */
export function getSchemaVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}

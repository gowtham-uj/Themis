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

  `CREATE TABLE IF NOT EXISTS project_agent_adapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL,
    description TEXT,
    format_version INTEGER NOT NULL DEFAULT 1,
    image TEXT NOT NULL,
    command_json TEXT NOT NULL,
    connection_check_json TEXT NOT NULL,
    connection_check_derived INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL,
    parser_kind TEXT NOT NULL,
    parser_config_json TEXT,
    provider_config_json TEXT,
    source_repo TEXT,
    source_ref TEXT,
    containerfile TEXT,
    generator_script TEXT,
    install_type TEXT NOT NULL DEFAULT 'source-build',
    configure_json TEXT,
    shared INTEGER NOT NULL DEFAULT 0,
    build_status TEXT NOT NULL DEFAULT 'unbuilt',
    built_image_id TEXT,
    built_commit TEXT,
    build_log_path TEXT,
    last_built_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_project_agent_adapters_project ON project_agent_adapters(project_id, enabled)`,

  `CREATE TABLE IF NOT EXISTS eval_queues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    description TEXT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    adapter_overrides_json TEXT,
    sandbox_json TEXT,
    network_policy TEXT NOT NULL DEFAULT 'allow',
    ports_json TEXT,
    judge_model TEXT,
    judge_provider TEXT,
    auto_judge INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    active_batch_id TEXT,
    shared_adapter_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_queues_project_status ON eval_queues(project_id, status)`,

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
    version INTEGER NOT NULL DEFAULT 1,
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

  `CREATE TABLE IF NOT EXISTS eval_queue_items (
    id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL REFERENCES eval_queues(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    position REAL NOT NULL,
    repeats INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    overrides_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_queue_items_order ON eval_queue_items(queue_id, position)`,

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
    queue_id TEXT REFERENCES eval_queues(id),
    queue_revision INTEGER,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS queue_containers (
    id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL REFERENCES eval_queues(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    batch_id TEXT NOT NULL REFERENCES run_batches(id),
    runtime_container_id TEXT,
    image TEXT NOT NULL,
    state TEXT NOT NULL,
    ports_json TEXT,
    workspace_dir TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_containers_queue_state ON queue_containers(queue_id, state)`,

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
    queue_id TEXT REFERENCES eval_queues(id),
    queue_item_id TEXT REFERENCES eval_queue_items(id),
    queue_container_id TEXT REFERENCES queue_containers(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    repeat_index INTEGER NOT NULL,
    eval_version INTEGER,
    eval_snapshot_json TEXT,
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

  `CREATE TABLE IF NOT EXISTS eval_archives (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    queue_id TEXT REFERENCES eval_queues(id),
    batch_id TEXT NOT NULL REFERENCES run_batches(id),
    manifest_path TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sealed_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS queue_analyses (
    id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL REFERENCES eval_queues(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    batch_id TEXT NOT NULL REFERENCES run_batches(id),
    selected_run_ids_json TEXT NOT NULL,
    evidence_hashes_json TEXT NOT NULL,
    judge_model TEXT NOT NULL,
    judge_provider TEXT NOT NULL,
    judge_params_json TEXT,
    judge_prompt TEXT,
    system_prompt_version TEXT NOT NULL,
    parent_analysis_id TEXT,
    status TEXT NOT NULL,
    verdict_path TEXT,
    report_path TEXT,
    events_path TEXT,
    raw_response_path TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_analyses_queue_batch ON queue_analyses(queue_id, batch_id)`,

  `CREATE TABLE IF NOT EXISTS judgements (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    queue_analysis_id TEXT REFERENCES queue_analyses(id),
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
    "ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
    // Commit/ref this run evaluates, overriding the task's own workspace ref.
    "ALTER TABLE runs ADD COLUMN workspace_ref TEXT",
    "ALTER TABLE runs ADD COLUMN workspace_repo TEXT",
    // Queue-owned persistent container provenance.
    "ALTER TABLE run_batches ADD COLUMN queue_id TEXT REFERENCES eval_queues(id)",
    "ALTER TABLE run_batches ADD COLUMN queue_revision INTEGER",
    "ALTER TABLE runs ADD COLUMN queue_id TEXT REFERENCES eval_queues(id)",
    "ALTER TABLE runs ADD COLUMN queue_item_id TEXT REFERENCES eval_queue_items(id)",
    "ALTER TABLE runs ADD COLUMN queue_container_id TEXT REFERENCES queue_containers(id)",
    "ALTER TABLE runs ADD COLUMN eval_version INTEGER",
    "ALTER TABLE runs ADD COLUMN eval_snapshot_json TEXT",
    "ALTER TABLE judgements ADD COLUMN queue_analysis_id TEXT REFERENCES queue_analyses(id)",
    // Adapter generator + connection-check derivation.
    "ALTER TABLE project_agent_adapters ADD COLUMN connection_check_derived INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE project_agent_adapters ADD COLUMN generator_script TEXT",
    "ALTER TABLE project_agent_adapters ADD COLUMN install_type TEXT NOT NULL DEFAULT 'source-build'",
    "ALTER TABLE project_agent_adapters ADD COLUMN configure_json TEXT",
    "ALTER TABLE project_agent_adapters ADD COLUMN shared INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE eval_queues ADD COLUMN shared_adapter_id TEXT",
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
 * Convert every still-queued legacy backlog entry into a named persistent queue.
 * Deterministic ids make this idempotent without another migration marker.
 */
function migrateLegacyQueueEntries(db: Database.Database): void {
  type Legacy = {
    id: string;
    project_id: string;
    task_id: string | null;
    task_tags_json: string | null;
    agent_id: string;
    model: string | null;
    provider: string | null;
    repeats: number | null;
    params_json: string | null;
    adapter_overrides_json: string | null;
    auto_judge: number | null;
    judge_model: string | null;
    created_at: string;
    project_model: string | null;
    project_provider: string | null;
    agent_model: string | null;
    agent_provider: string | null;
  };
  const legacy = db.prepare(`
    SELECT qe.*, p.default_model AS project_model,
      p.default_provider AS project_provider,
      a.default_model AS agent_model,
      a.default_provider AS agent_provider
    FROM queue_entries qe
    JOIN projects p ON p.id = qe.project_id
    LEFT JOIN agents a ON a.id = qe.agent_id
    WHERE qe.status = 'queued'
  `).all() as Legacy[];

  const insertQueue = db.prepare(`
    INSERT OR IGNORE INTO eval_queues (
      id, project_id, name, description, agent_id, model, provider,
      adapter_overrides_json, sandbox_json, network_policy, ports_json,
      judge_model, judge_provider, auto_judge, status, active_batch_id,
      revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'allow', '[]', ?, 'anthropic', ?,
      'draft', NULL, 1, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO eval_queue_items (
      id, queue_id, project_id, task_id, position, repeats, enabled,
      overrides_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
  `);
  const tasksForProject = db.prepare(
    "SELECT id, tags FROM tasks WHERE project_id = ? AND archived = 0",
  );

  for (const row of legacy) {
    const queueId = `legacy-${row.id}`;
    let overrides: Record<string, unknown> | null = null;
    try {
      const parsed = row.adapter_overrides_json
        ? (JSON.parse(row.adapter_overrides_json) as unknown)
        : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        overrides = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      overrides = null;
    }
    if (row.params_json) {
      try {
        const params = JSON.parse(row.params_json) as unknown;
        if (params && typeof params === "object" && !Array.isArray(params)) {
          overrides = { ...(overrides ?? {}), params };
        }
      } catch {
        // Keep the queue migratable even if a legacy JSON blob is malformed.
      }
    }
    const model = row.model ?? row.project_model ?? row.agent_model ?? "claude-opus-4-6";
    const provider = row.provider ?? row.project_provider ?? row.agent_provider ?? "anthropic";
    const ts = row.created_at || new Date().toISOString();
    insertQueue.run(
      queueId,
      row.project_id,
      `Migrated queue ${row.id.slice(0, 8)}`,
      `Migrated from legacy queue entry ${row.id}`,
      row.agent_id,
      model,
      provider,
      overrides ? JSON.stringify(overrides) : null,
      row.judge_model,
      row.auto_judge === 0 ? 0 : 1,
      ts,
      ts,
    );

    let taskIds: string[] = [];
    if (row.task_id) {
      taskIds = [row.task_id];
    } else {
      let wanted: string[] = [];
      try {
        const parsed = row.task_tags_json
          ? (JSON.parse(row.task_tags_json) as unknown)
          : [];
        if (Array.isArray(parsed)) {
          wanted = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        wanted = [];
      }
      const candidates = tasksForProject.all(row.project_id) as Array<{
        id: string;
        tags: string | null;
      }>;
      taskIds = candidates
        .filter((task) => {
          if (wanted.length === 0) return true;
          try {
            const tags = task.tags ? (JSON.parse(task.tags) as unknown) : [];
            return Array.isArray(tags) && tags.some((tag) => wanted.includes(String(tag)));
          } catch {
            return false;
          }
        })
        .map((task) => task.id);
    }
    taskIds.forEach((taskId, index) => {
      insertItem.run(
        `legacy-item-${row.id}-${taskId}`,
        queueId,
        row.project_id,
        taskId,
        index + 1,
        Math.max(1, row.repeats ?? 1),
        ts,
        ts,
      );
    });
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
      migrateLegacyQueueEntries(db);
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
    migrateLegacyQueueEntries(db);
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

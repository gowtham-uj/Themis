/**
 * Drizzle table definitions — SQLite schema for agenteval.
 * Source of truth: plan/data-model.md (SQL mirrored faithfully).
 *
 * Domain tables are project-scoped (project_id FK) except agents (global).
 */

import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Agents — GLOBAL, shared across projects
// ---------------------------------------------------------------------------

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(), // "reapercode" | "pi"
  displayName: text("display_name").notNull(),
  defaultModel: text("default_model"),
  defaultProvider: text("default_provider"),
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  /** {kind:"repo-md"|"manifest-yaml"|"ci-artifact"|"http-push"|"ui-builder", params} */
  taskSourceJson: text("task_source_json").notNull(),
  defaultAgentId: text("default_agent_id").references(() => agents.id),
  defaultModel: text("default_model"),
  defaultProvider: text("default_provider"),
  /** Base image for this project's workspaces. */
  workspaceImage: text("workspace_image"),
  /** Command templates per check kind: {test_suite:"cargo test", ...} */
  checkRunnersJson: text("check_runners_json"),
  /** env, allowed tools, network policy, image tag per agent */
  adapterOverridesJson: text("adapter_overrides_json"),
  /** allow|allowlist|offline */
  networkPolicy: text("network_policy").default("allow"),
  /** Keep last N runs per task; null = unlimited. */
  retentionRuns: integer("retention_runs"),
  /** Enabled evals required before this project may start runs. Null = 1. */
  minEvals: integer("min_evals"),
  /** Per-project sandbox controls (capabilities, mounts, devices, ports…). */
  sandboxJson: text("sandbox_json"),
  /** Per-stage model provider overrides; falls through to the global config. */
  modelConfigJson: text("model_config_json"),
  /** Per-project prompt overrides keyed by filename; missing keys use the built-in draft. */
  promptConfigJson: text("prompt_config_json"),
  archived: integer("archived").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Project agent adapters — declarative integrations for real CLI agents
// ---------------------------------------------------------------------------

export const projectAgentAdapters = sqliteTable(
  "project_agent_adapters",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    name: text("name").notNull(),
    description: text("description"),
    formatVersion: integer("format_version").notNull().default(1),
    image: text("image").notNull(),
    commandJson: text("command_json").notNull(),
    connectionCheckJson: text("connection_check_json").notNull(),
    connectionCheckDerived: integer("connection_check_derived")
      .notNull()
      .default(0),
    evidenceJson: text("evidence_json").notNull(),
    parserKind: text("parser_kind").notNull(),
    parserConfigJson: text("parser_config_json"),
    providerConfigJson: text("provider_config_json"),
    sourceRepo: text("source_repo"),
    sourceRef: text("source_ref"),
    containerfile: text("containerfile"),
    generatorScript: text("generator_script"),
    installType: text("install_type").notNull().default("source-build"),
    configureJson: text("configure_json"),
    shared: integer("shared").notNull().default(0),
    buildStatus: text("build_status").notNull().default("unbuilt"),
    builtImageId: text("built_image_id"),
    builtCommit: text("built_commit"),
    buildLogPath: text("build_log_path"),
    lastBuiltAt: text("last_built_at"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("uq_project_agent_adapter").on(t.projectId),
    index("idx_project_agent_adapters_project").on(t.projectId, t.enabled),
  ],
);

// ---------------------------------------------------------------------------
// Eval queues — persistent definitions, one live container per active queue
// ---------------------------------------------------------------------------

export const adapterBuilds = sqliteTable(
  "adapter_builds",
  {
    /** Deterministic: `${adapterId}:${commit}`. */
    id: text("id").primaryKey(),
    /** Adapter this build materializes (project or shared adapter row id). */
    adapterId: text("adapter_id")
      .notNull()
      .references(() => projectAgentAdapters.id),
    commitSha: text("commit_sha").notNull(),
    /** building|ready|failed */
    status: text("status").notNull().default("building"),
    /** Commit-addressed image tag; unique across adapters/commits. */
    image: text("image"),
    imageId: text("image_id"),
    /** Deterministic agent version (stable short SHA unless trustworthy version extracted). */
    agentVersion: text("agent_version"),
    logPath: text("log_path"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    unique("uq_adapter_build_adapter_commit").on(t.adapterId, t.commitSha),
    index("idx_adapter_builds_commit").on(t.commitSha),
  ],
);

export const evalQueues = sqliteTable(
  "eval_queues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    adapterOverridesJson: text("adapter_overrides_json"),
    sandboxJson: text("sandbox_json"),
    networkPolicy: text("network_policy").notNull().default("allow"),
    portsJson: text("ports_json"),
    status: text("status").notNull().default("draft"),
    activeBatchId: text("active_batch_id"),
    sharedAdapterId: text("shared_adapter_id").references(() => projectAgentAdapters.id),
    /** Explicit built-in adapter id ("reapercode"|"pi") when the queue opts into a built-in; no implicit fallback. */
    builtinAdapterId: text("builtin_adapter_id"),
    /** resolved agent commit (full SHA) this queue builds/runs. Null for built-in adapters. */
    agentCommit: text("agent_commit"),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_eval_queues_project_status").on(t.projectId, t.status)],
);

// ---------------------------------------------------------------------------
// Watcher rules + events (schema only for P8)
// ---------------------------------------------------------------------------

export const watcherRules = sqliteTable("watcher_rules", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  /** Queue this watcher owns; watcher fires that queue's agent-commit generation. */
  queueId: text("queue_id").references(() => evalQueues.id),
  /** "agent" | "workspace" */
  role: text("role").notNull(),
  /** full url or "owner/name" */
  repo: text("repo").notNull(),
  /** tag|commit|pr|schedule|manual|webhook */
  trigger: text("trigger").notNull(),
  /** branch ("main"), tag pattern ("v*") */
  ref: text("ref"),
  /** ">=2.0.0 <3.0.0" */
  semverFilter: text("semver_filter"),
  actionJson: text("action_json").notNull(),
  webhookSecret: text("webhook_secret"),
  enabled: integer("enabled").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const watcherEvents = sqliteTable("watcher_events", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id")
    .notNull()
    .references(() => watcherRules.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  receivedAt: text("received_at").notNull(),
  trigger: text("trigger").notNull(),
  ref: text("ref"),
  resolvedSha: text("resolved_sha"),
  /** matched|ignored(semver)|deduped|pending|launching|launched|failed|building */
  status: text("status").notNull(),
  batchId: text("batch_id"),
  queueId: text("queue_id").references(() => evalQueues.id),
  /** Durable FIFO order for pending events awaiting a free queue generation. */
  fifoSeq: integer("fifo_seq"),
  /** resolvedSha for the generation this event (when launched) corresponds to. */
  processedSha: text("processed_sha"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Tasks (project-scoped)
// ---------------------------------------------------------------------------

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Stable id from the task source (e.g. file path); unique per project. */
    externalId: text("external_id"),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /** "git" | "empty" */
    workspaceSource: text("workspace_source").notNull(),
    workspaceRepo: text("workspace_repo"),
    workspaceRef: text("workspace_ref"),
    /** Per-task rubric (criteria, weights, checks, anchors, profile). */
    rubricJson: text("rubric_json").notNull(),
    /** Bumps on any eval definition edit; queue executions snapshot this version. */
    version: integer("version").notNull().default(1),
    /** Bumps on rubric edit → new comparison baseline. */
    rubricVersion: integer("rubric_version").notNull().default(1),
    /** coding|research|general|browser|data|conversational execution semantics. */
    agentCategory: text("agent_category").notNull().default("coding"),
    /** Arbitrary project-scoped grouping label; does not change execution semantics. */
    categoryName: text("category_name"),
    /** bugfix|feature|refactor|research|general|browser|etl|conversational */
    profile: text("profile"),
    referenceSolution: text("reference_solution"),
    /** Deterministic hooks (rubric §5). */
    checksJson: text("checks_json"),
    /** Env this eval needs: greenfield/brownfield, image, setup script. */
    envJson: text("env_json"),
    /** csv/json */
    tags: text("tags"),
    /** Which task source created this. */
    sourceKind: text("source_kind"),
    packagePath: text("package_path"),
    packageDigest: text("package_digest"),
    packageManifestJson: text("package_manifest_json"),
    packageValidationJson: text("package_validation_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archived: integer("archived").notNull().default(0),
  },
  (t) => [unique("tasks_project_external_id").on(t.projectId, t.externalId)],
);

/**
 * Shared eval packages. Projects copy from here into their own store.
 * The global row stays; deleting a project copy does not delete this.
 */
export const evalStore = sqliteTable("eval_store", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  workspaceSource: text("workspace_source").notNull(),
  workspaceRepo: text("workspace_repo"),
  workspaceRef: text("workspace_ref"),
  rubricJson: text("rubric_json").notNull(),
  version: integer("version").notNull().default(1),
  rubricVersion: integer("rubric_version").notNull().default(1),
  agentCategory: text("agent_category").notNull().default("coding"),
  categoryName: text("category_name"),
  profile: text("profile"),
  referenceSolution: text("reference_solution"),
  checksJson: text("checks_json"),
  envJson: text("env_json"),
  tags: text("tags"),
  packagePath: text("package_path"),
  packageDigest: text("package_digest"),
  packageManifestJson: text("package_manifest_json"),
  packageValidationJson: text("package_validation_json"),
  archived: integer("archived").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const evalQueueItems = sqliteTable(
  "eval_queue_items",
  {
    id: text("id").primaryKey(),
    queueId: text("queue_id")
      .notNull()
      .references(() => evalQueues.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    position: real("position").notNull(),
    repeats: integer("repeats").notNull().default(1),
    enabled: integer("enabled").notNull().default(1),
    overridesJson: text("overrides_json"),
    /** Number of repeats already claimed across all generations (immutable floor). */
    claimedRepeats: integer("claimed_repeats").notNull().default(0),
    /** Soft-deletion: deleted_at set instead of hard delete once execution history exists. */
    deletedAt: text("deleted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_eval_queue_items_order").on(t.queueId, t.position)],
);

// ---------------------------------------------------------------------------
// Run batches + runs
// ---------------------------------------------------------------------------

export const runBatches = sqliteTable("run_batches", {
  id: text("id").primaryKey(),
  /** Null for multi-eval generations (one batch = many evals). Single-eval batches retain the task id. */
  taskId: text("task_id").references(() => tasks.id),
  /** Denormalized for fast project filtering. */
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  /** temperature, reasoningEffort, maxTokens, timeoutMs */
  paramsJson: text("params_json").notNull(),
  repeats: integer("repeats").notNull(),
  /** tag|commit|pr|schedule|manual|webhook (null for ad-hoc) */
  trigger: text("trigger"),
  /** The tag/branch/pr that fired (release-compare grouping). */
  triggerRef: text("trigger_ref"),
  agentImage: text("agent_image"),
  agentCommit: text("agent_commit"),
  /** Commit-addressed image + resolved agent commit snapshot (generation genesis). */
  agentImageId: text("agent_image_id"),
  agentVersion: text("agent_version"),
  buildId: text("build_id"),
  /** Queue definition that created this immutable execution snapshot. */
  queueId: text("queue_id").references(() => evalQueues.id),
  queueRevision: integer("queue_revision"),
  createdAt: text("created_at").notNull(),
  /** Immutable generation state; accepting until atomic empty-close flips it false. */
  accepting: integer("accepting").notNull().default(1),
  /** Queue definition revision observed at atomic empty-close. */
  closedRevision: integer("closed_revision"),
  closedAt: text("closed_at"),
});

export const queueContainers = sqliteTable(
  "queue_containers",
  {
    id: text("id").primaryKey(),
    queueId: text("queue_id")
      .notNull()
      .references(() => evalQueues.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    batchId: text("batch_id")
      .notNull()
      .references(() => runBatches.id),
    runtimeContainerId: text("runtime_container_id"),
    image: text("image").notNull(),
    /** Commit-addressed image id + resolved agent commit (generation snapshot). */
    imageId: text("image_id"),
    agentCommit: text("agent_commit"),
    agentVersion: text("agent_version"),
    buildId: text("build_id"),
    /** Generation container states: starting|running|idle|closing|completed|tainted|stopping|stopped|paused|failed */
    state: text("state").notNull(),
    portsJson: text("ports_json"),
    workspaceDir: text("workspace_dir").notNull(),
    startedAt: text("started_at"),
    stoppedAt: text("stopped_at"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_queue_containers_queue_state").on(t.queueId, t.state)],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => runBatches.id),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  /** Denormalized for fast project filtering. */
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  queueId: text("queue_id").references(() => evalQueues.id),
  queueItemId: text("queue_item_id").references(() => evalQueueItems.id),
  queueContainerId: text("queue_container_id").references(
    () => queueContainers.id,
  ),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  /** k of N */
  repeatIndex: integer("repeat_index").notNull(),
  /** Exact eval-store version and full definition used by this execution. */
  evalVersion: integer("eval_version"),
  evalSnapshotJson: text("eval_snapshot_json"),
  /** Immutable queue-item snapshot copied at claim time (repeats/overrides/position). */
  itemSnapshotJson: text("item_snapshot_json"),
  /** queued|running|paused|resuming|completed|failed|aborted|timeout */
  status: text("status").notNull(),
  /** Resolved workspace sha (reproducibility). */
  workspaceCommit: text("workspace_commit"),
  agentImage: text("agent_image"),
  agentCommit: text("agent_commit"),
  /** registry|built */
  agentImageSource: text("agent_image_source"),
  /** adapter_builds row this run executed, when the adapter was source-built. */
  buildId: text("build_id"),
  /** Human-readable agent version reported by that build. */
  agentVersion: text("agent_version"),
  /** Per-run adapter overrides as submitted (image, env, params, tools). */
  adapterOverridesJson: text("adapter_overrides_json"),
  /** Repo this run evaluates, overriding the task's workspace repo. */
  workspaceRepo: text("workspace_repo"),
  /** Commit/ref this run evaluates, overriding the task's workspace ref. */
  workspaceRef: text("workspace_ref"),
  trigger: text("trigger"),
  triggerRef: text("trigger_ref"),
  triggerRuleId: text("trigger_rule_id"),
  /** running|paused-soft|paused-hard|resuming|aborting|aborted|done */
  controlState: text("control_state"),
  pausedAt: text("paused_at"),
  resumedAt: text("resumed_at"),
  pauseCount: integer("pause_count").notNull().default(0),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  /** Excludes paused intervals. */
  durationMs: integer("duration_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  totalCost: real("total_cost"),
  eventsPath: text("events_path"),
  diffPath: text("diff_path"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Immutable eval archives
// ---------------------------------------------------------------------------

export const evalArchives = sqliteTable("eval_archives", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  queueId: text("queue_id").references(() => evalQueues.id),
  batchId: text("batch_id")
    .notNull()
    .references(() => runBatches.id),
  manifestPath: text("manifest_path").notNull(),
  /** Immutable canonical manifest key in the local ArtifactStore. */
  manifestKey: text("manifest_key"),
  manifestSha256: text("manifest_sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sealedAt: text("sealed_at").notNull(),
  archivedAt: text("archived_at"),
});

/** Versioned exact and derived per-eval metrics projection. */
export const evalMetrics = sqliteTable("eval_metrics", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  schemaVersion: integer("schema_version").notNull(),
  executionJson: text("execution_json").notNull(),
  outcomeJson: text("outcome_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Checks + users
// ---------------------------------------------------------------------------

export const checks = sqliteTable("checks", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  passed: integer("passed"),
  detail: text("detail"),
});

/**
 * Deployment users (P9-settings). Password is scrypt-hashed (password_hash);
 * plaintext is NEVER stored. role: "admin" | "user".
 * First registered user is auto-admin (bootstrap).
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  /** Unique login name (plan also listed email; username is the auth identifier). */
  username: text("username").notNull().unique(),
  /** scrypt salt:hash hex. NEVER plaintext. */
  passwordHash: text("password_hash").notNull(),
  /** "admin" | "user" */
  role: text("role").notNull(),
  createdAt: text("created_at").notNull(),
  /** Optional legacy/plan email column (nullable). */
  email: text("email").unique(),
});

/**
 * Global key/value settings (P9). value is JSON-encoded text.
 * Secrets (API keys) are stored as name-only references, never raw secret values.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON-encoded value. */
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// API tokens (P8b-auth) — store hash only; plaintext returned once at create
// ---------------------------------------------------------------------------

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    /** Null = project-scoped system token (no user). */
    userId: text("user_id"),
    /** Null = all projects; set value scopes the token to one project. */
    projectId: text("project_id"),
    /** sha256 hex of the plaintext bearer token. NEVER store plaintext. */
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    /** 1 = read-only (GET only). */
    readOnly: integer("read_only").notNull().default(0),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("idx_api_tokens_hash").on(t.tokenHash)],
);

/**
 * Project membership (v10). Non-admin users only see/write projects they belong
 * to. Admins and system tokens remain unrestricted.
 */
export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("uq_project_members").on(t.projectId, t.userId),
    index("idx_project_members_user").on(t.userId),
    index("idx_project_members_project").on(t.projectId),
  ],
);

// Deterministic check results (P9, rubric.md §5). Run-keyed JSON mirror of the
// Run-keyed deterministic check results for API consumers. One row per run.
export const checkResults = sqliteTable(
  "check_results",
  {
    runId: text("run_id").notNull(),
    resultsJson: text("results_json").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [index("idx_check_results_run").on(t.runId)],
);

// ---------------------------------------------------------------------------
// Schema registry (for drizzle + openDb)
// ---------------------------------------------------------------------------

export const schema = {
  agents,
  projects,
  projectAgentAdapters,
  adapterBuilds,
  evalQueues,
  watcherRules,
  watcherEvents,
  tasks,
  evalStore,
  evalQueueItems,
  runBatches,
  queueContainers,
  runs,
  evalArchives,
  evalMetrics,
  checks,
  users,
  settings,
  apiTokens,
  projectMembers,
  checkResults,
};

export type Schema = typeof schema;

/** Migration version stamped into pragma user_version / migrations table. */
export const SCHEMA_VERSION = 10;

/**
 * Drizzle table definitions — SQLite schema for agenteval.
 * Source of truth: plan/data-model.md (SQL mirrored faithfully).
 *
 * Domain tables are project-scoped (project_id FK) except agents (global).
 * Judgements/scores/findings tables are defined here for later phases (P4/P6);
 * query methods for those are stubbed in queries.ts.
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
  defaultJudgeModel: text("default_judge_model"),
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
  /** What run artifacts survive judgement: keep|referenced|all. */
  artifactRetention: text("artifact_retention").default("keep"),
  /** Per-project sandbox controls (capabilities, mounts, devices, ports…). */
  sandboxJson: text("sandbox_json"),
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
    judgeModel: text("judge_model"),
    judgeProvider: text("judge_provider"),
    autoJudge: integer("auto_judge").notNull().default(1),
    status: text("status").notNull().default("draft"),
    activeBatchId: text("active_batch_id"),
    sharedAdapterId: text("shared_adapter_id").references(() => projectAgentAdapters.id),
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
  /** matched|ignored(semver)|deduped|enqueued|failed|building */
  status: text("status").notNull(),
  batchId: text("batch_id"),
  error: text("error"),
});

// ---------------------------------------------------------------------------
// Eval queue (schema only for P8)
// ---------------------------------------------------------------------------

export const queueEntries = sqliteTable(
  "queue_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    triggerRef: text("trigger_ref"),
    /** "task" | "task_set" */
    targetKind: text("target_kind").notNull(),
    taskId: text("task_id"),
    taskTagsJson: text("task_tags_json"),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    model: text("model"),
    provider: text("provider"),
    repeats: integer("repeats"),
    paramsJson: text("params_json"),
    adapterOverridesJson: text("adapter_overrides_json"),
    autoJudge: integer("auto_judge"),
    judgeModel: text("judge_model"),
    priority: integer("priority").notNull().default(0),
    position: real("position").notNull(),
    /** queued|promoted|running|removed|failed */
    status: text("status").notNull().default("queued"),
    dedupKey: text("dedup_key"),
    source: text("source"),
    createdAt: text("created_at").notNull(),
    promotedAt: text("promoted_at"),
    promotedBatchId: text("promoted_batch_id"),
    removedAt: text("removed_at"),
  },
  (t) => [index("idx_queue_project_status").on(t.projectId, t.status)],
);

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
    /** coding|research|general|browser|data|conversational */
    agentCategory: text("agent_category").notNull().default("coding"),
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
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archived: integer("archived").notNull().default(0),
  },
  (t) => [unique("tasks_project_external_id").on(t.projectId, t.externalId)],
);

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
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
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
  /** Queue definition that created this immutable execution snapshot. */
  queueId: text("queue_id").references(() => evalQueues.id),
  queueRevision: integer("queue_revision"),
  createdAt: text("created_at").notNull(),
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
  /** queued|running|paused|resuming|completed|failed|aborted|timeout */
  status: text("status").notNull(),
  /** Resolved workspace sha (reproducibility). */
  workspaceCommit: text("workspace_commit"),
  agentImage: text("agent_image"),
  agentCommit: text("agent_commit"),
  /** registry|built */
  agentImageSource: text("agent_image_source"),
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
// Immutable eval archives + append-only queue judgement revisions
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
  manifestSha256: text("manifest_sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sealedAt: text("sealed_at").notNull(),
});

export const queueAnalyses = sqliteTable(
  "queue_analyses",
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
    selectedRunIdsJson: text("selected_run_ids_json").notNull(),
    evidenceHashesJson: text("evidence_hashes_json").notNull(),
    judgeModel: text("judge_model").notNull(),
    judgeProvider: text("judge_provider").notNull(),
    judgeParamsJson: text("judge_params_json"),
    judgePrompt: text("judge_prompt"),
    systemPromptVersion: text("system_prompt_version").notNull(),
    parentAnalysisId: text("parent_analysis_id"),
    status: text("status").notNull(),
    verdictPath: text("verdict_path"),
    reportPath: text("report_path"),
    eventsPath: text("events_path"),
    rawResponsePath: text("raw_response_path"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    error: text("error"),
  },
  (t) => [index("idx_queue_analyses_queue_batch").on(t.queueId, t.batchId)],
);

// ---------------------------------------------------------------------------
// Judgements + scores (schema only; queries stubbed until P4)
// ---------------------------------------------------------------------------

export const judgements = sqliteTable("judgements", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  queueAnalysisId: text("queue_analysis_id").references(() => queueAnalyses.id),
  judgeModel: text("judge_model").notNull(),
  judgeProvider: text("judge_provider").notNull(),
  judgePrompt: text("judge_prompt"),
  systemPromptVersion: text("system_prompt_version").notNull(),
  /** queued|running|completed|failed */
  status: text("status").notNull(),
  overallScore: real("overall_score"),
  /** pass|fail|partial */
  verdict: text("verdict"),
  reportPath: text("report_path"),
  eventsPath: text("events_path"),
  verdictPath: text("verdict_path"),
  createdAt: text("created_at"),
  endedAt: text("ended_at"),
});

export const scores = sqliteTable("scores", {
  id: text("id").primaryKey(),
  judgementId: text("judgement_id")
    .notNull()
    .references(() => judgements.id),
  criterion: text("criterion").notNull(),
  weight: real("weight").notNull(),
  score: real("score").notNull(),
  rationale: text("rationale"),
});

// ---------------------------------------------------------------------------
// Findings (schema only; queries stubbed until P6)
// ---------------------------------------------------------------------------

export const findings = sqliteTable(
  "findings",
  {
    fingerprint: text("fingerprint").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    category: text("category").notNull(),
    /** "defect" | "positive" | "meta" */
    kind: text("kind").notNull(),
    claim: text("claim").notNull(),
    latestSeverity: text("latest_severity"),
    latestConfidence: real("latest_confidence"),
    firstSeenJudgement: text("first_seen_judgement"),
    lastSeenJudgement: text("last_seen_judgement"),
    firstSeenAt: text("first_seen_at"),
    lastSeenAt: text("last_seen_at"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    resolvedAt: text("resolved_at"),
    /** open|resolved|regressed|wontfix */
    status: text("status").notNull().default("open"),
  },
  (t) => [index("idx_findings_task").on(t.taskId)],
);

export const findingOccurrences = sqliteTable(
  "finding_occurrences",
  {
    id: text("id").primaryKey(),
    findingFingerprint: text("finding_fingerprint")
      .notNull()
      .references(() => findings.fingerprint),
    judgementId: text("judgement_id")
      .notNull()
      .references(() => judgements.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    severity: text("severity").notNull(),
    confidence: real("confidence").notNull(),
    claim: text("claim").notNull(),
    criterion: text("criterion"),
    refsJson: text("refs_json").notNull(),
    fixJson: text("fix_json"),
    /** introduced|persisted|resolved */
    status: text("status").notNull().default("introduced"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_occurrences_run").on(t.runId),
    index("idx_occurrences_judgement").on(t.judgementId),
  ],
);

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

// ---------------------------------------------------------------------------
// Outbound webhook subscriptions + delivery log (P8c)
// ---------------------------------------------------------------------------

export const outboundSubscriptions = sqliteTable(
  "outbound_subscriptions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    url: text("url").notNull(),
    /** Per-subscription HMAC signing secret. NEVER returned after create. */
    secret: text("secret").notNull(),
    /** JSON array of event types; empty array = all events. */
    eventTypesJson: text("event_types_json").notNull(),
    enabled: integer("enabled").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_outbound_subs_project").on(t.projectId)],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => outboundSubscriptions.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    /** pending|success|failed */
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    responseStatus: integer("response_status"),
    /** Truncated response body (≤2KB). */
    responseBody: text("response_body"),
    error: text("error"),
    deliveredAt: text("delivered_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_webhook_deliveries_project_created").on(
      t.projectId,
      t.createdAt,
    ),
    index("idx_webhook_deliveries_sub").on(t.subscriptionId),
  ],
);

// Deterministic check results (P9, rubric.md §5). Run-keyed JSON mirror of the
// verdict's checkResults array so API consumers can query pass-rates without
// parsing the verdict body. One row per run (upserted on re-store).
export const checkResults = sqliteTable(
  "check_results",
  {
    runId: text("run_id").notNull(),
    resultsJson: text("results_json").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [index("idx_check_results_run").on(t.runId)],
);

// Project-scoped reusable rubrics (plan/rubric.md §6). A task may embed its own
// rubric_json or reference one of these; the project rubric is the shared,
// versioned baseline. Editing the criteria bumps rubric_version (new baseline).
export const projectRubrics = sqliteTable(
  "project_rubrics",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    rubricJson: text("rubric_json").notNull(),
    rubricVersion: integer("rubric_version").notNull().default(1),
    isDefault: integer("is_default").notNull().default(0),
    archived: integer("archived").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_project_rubrics_project").on(t.projectId)],
);

// ---------------------------------------------------------------------------
// Schema registry (for drizzle + openDb)
// ---------------------------------------------------------------------------

export const schema = {
  agents,
  projects,
  projectAgentAdapters,
  evalQueues,
  watcherRules,
  watcherEvents,
  queueEntries,
  tasks,
  evalQueueItems,
  runBatches,
  queueContainers,
  runs,
  evalArchives,
  queueAnalyses,
  judgements,
  scores,
  findings,
  findingOccurrences,
  checks,
  users,
  settings,
  apiTokens,
  outboundSubscriptions,
  webhookDeliveries,
  checkResults,
  projectRubrics,
};

export type Schema = typeof schema;

/** Migration version stamped into pragma user_version / migrations table. */
export const SCHEMA_VERSION = 5;

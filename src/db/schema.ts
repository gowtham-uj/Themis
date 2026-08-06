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
  archived: integer("archived").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
    /** Bumps on rubric edit → new comparison baseline. */
    rubricVersion: integer("rubric_version").notNull().default(1),
    /** coding|research|general|browser|data|conversational */
    agentCategory: text("agent_category").notNull().default("coding"),
    /** bugfix|feature|refactor|research|general|browser|etl|conversational */
    profile: text("profile"),
    referenceSolution: text("reference_solution"),
    /** Deterministic hooks (rubric §5). */
    checksJson: text("checks_json"),
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
  createdAt: text("created_at").notNull(),
});

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
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  model: text("model").notNull(),
  provider: text("provider").notNull(),
  /** k of N */
  repeatIndex: integer("repeat_index").notNull(),
  /** queued|running|paused|resuming|completed|failed|aborted|timeout */
  status: text("status").notNull(),
  /** Resolved workspace sha (reproducibility). */
  workspaceCommit: text("workspace_commit"),
  agentImage: text("agent_image"),
  agentCommit: text("agent_commit"),
  /** registry|built */
  agentImageSource: text("agent_image_source"),
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

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  pwHash: text("pw_hash"),
  role: text("role"),
});

// ---------------------------------------------------------------------------
// Schema registry (for drizzle + openDb)
// ---------------------------------------------------------------------------

export const schema = {
  agents,
  projects,
  watcherRules,
  watcherEvents,
  queueEntries,
  tasks,
  runBatches,
  runs,
  judgements,
  scores,
  findings,
  findingOccurrences,
  checks,
  users,
};

export type Schema = typeof schema;

/** Migration version stamped into pragma user_version / migrations table. */
export const SCHEMA_VERSION = 1;

/**
 * DbQueries facade over the persistence connection.
 *
 * Two backends share the same QueryStore interface:
 *  - SqliteQueries  — drizzle-orm + better-sqlite3 (primary path)
 *  - MemoryQueries  — pure in-memory Maps (fallback when native sqlite is unavailable)
 *
 * Spec: plan/data-model.md. Domain I/O uses types from src/domain.ts.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, desc, inArray, isNotNull, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentCategory,
  Rubric,
  TaskProfile,
  TaskSpec,
} from "../domain.js";
import type { EvidenceEntry, WorkspaceSpec } from "../adapters/types.js";
import type { PortMapping, ResolvedPort } from "../runner/runtime.js";
import type { CheckResult } from "../check-types.js";
import {
  adapterBuilds,
  agents,
  apiTokens,
  checkResults,
  evalArchives,
  evalMetrics,
  evalQueueItems,
  evalQueues,
  projectAgentAdapters,
  projectMembers,
  projects,
  queueContainers,
  runBatches,
  runs,
  settings,
  tasks,
  users,
  watcherEvents,
  watcherRules,
  type Schema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Domain row types (I/O of the query layer)
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  taskSource: { kind: string; params?: Record<string, unknown> };
  defaultAgentId: string | null;
  defaultModel: string | null;
  defaultProvider: string | null;
  workspaceImage: string | null;
  checkRunners: Record<string, string> | null;
  adapterOverrides: Record<string, unknown> | null;
  networkPolicy: string;
  retentionRuns: number | null;
  /** Retention policy for generated run outputs. */
  /** Per-project sandbox controls; null when the project configures none. */
  sandbox: Record<string, unknown> | null;
  /** Per-stage model provider overrides; null when the project sets none. */
  modelConfig: Record<string, unknown> | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  description?: string;
  taskSource?: { kind: string; params?: Record<string, unknown> };
  defaultAgentId?: string;
  defaultModel?: string;
  defaultProvider?: string;
  workspaceImage?: string;
  checkRunners?: Record<string, string>;
  adapterOverrides?: Record<string, unknown>;
  networkPolicy?: string;
  retentionRuns?: number | null;
  sandbox?: Record<string, unknown> | null;
  modelConfig?: Record<string, unknown> | null;
  id?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  taskSource?: { kind: string; params?: Record<string, unknown> };
  defaultAgentId?: string | null;
  defaultModel?: string | null;
  defaultProvider?: string | null;
  workspaceImage?: string | null;
  checkRunners?: Record<string, string> | null;
  adapterOverrides?: Record<string, unknown> | null;
  networkPolicy?: string;
  retentionRuns?: number | null;
  sandbox?: Record<string, unknown> | null;
  modelConfig?: Record<string, unknown> | null;
}

export interface Task {
  id: string;
  projectId: string;
  externalId: string | null;
  name: string;
  prompt: string;
  workspace: WorkspaceSpec;
  rubric: Rubric;
  /** Bumps on every eval definition edit. */
  version: number;
  rubricVersion: number;
  agentCategory: AgentCategory;
  /** Arbitrary grouping label; does not alter execution semantics. */
  categoryName: string | null;
  profile: TaskProfile | null;
  referenceSolution: string | null;
  checks: unknown[] | null;
  /** Env this eval needs (greenfield/brownfield, image, setup script). */
  env: Record<string, unknown> | null;
  tags: string[] | null;
  sourceKind: string | null;
  packagePath: string | null;
  packageDigest: string | null;
  packageManifest: Record<string, unknown> | null;
  packageValidation: Record<string, unknown> | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTaskInput {
  name?: string;
  prompt?: string;
  workspace?: WorkspaceSpec;
  rubric?: Rubric;
  agentCategory?: AgentCategory;
  categoryName?: string | null;
  profile?: TaskProfile | null;
  referenceSolution?: string | null;
  checks?: unknown[] | null;
  /** Env this eval needs (greenfield/brownfield, image, setup script). */
  env?: Record<string, unknown> | null;
  tags?: string[] | null;
  externalId?: string | null;
  sourceKind?: string | null;
}

export interface Agent {
  id: string;
  displayName: string;
  defaultModel: string | null;
  defaultProvider: string | null;
}

export interface RegisterAgentInput {
  id: string;
  displayName: string;
  defaultModel?: string;
  defaultProvider?: string;
}

export type CliAdapterParserKind =
  | "canonical-jsonl"
  | "pi-jsonl"
  | "reapercode-jsonl";

export interface CliCommandTemplate {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface CliAdapterEvidenceConfig {
  paths: string[];
  requiredPaths?: string[];
  /** Role-typed map of native evidence (see AdapterEvidenceSpec.manifest). */
  manifest?: EvidenceEntry[];
}

/** Project-scoped declarative integration for one real CLI agent. */
export interface ProjectAgentAdapter {
  id: string;
  projectId: string;
  agentId: string;
  name: string;
  description: string | null;
  formatVersion: number;
  image: string;
  command: CliCommandTemplate;
  connectionCheck: CliCommandTemplate;
  connectionCheckDerived: boolean;
  evidence: CliAdapterEvidenceConfig;
  parserKind: CliAdapterParserKind | string;
  parserConfig: Record<string, unknown> | null;
  providerConfig: Record<string, unknown> | null;
  sourceRepo: string | null;
  sourceRef: string | null;
  containerfile: string | null;
  generatorScript: string | null;
  installType: string;
  configure: CliCommandTemplate | null;
  shared: boolean;
  buildStatus: string;
  builtImageId: string | null;
  builtCommit: string | null;
  buildLogPath: string | null;
  lastBuiltAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectAgentAdapterInput {
  id?: string;
  agentId: string;
  name: string;
  description?: string | null;
  formatVersion?: number;
  image: string;
  command: CliCommandTemplate;
  connectionCheck: CliCommandTemplate;
  connectionCheckDerived?: boolean;
  evidence: CliAdapterEvidenceConfig;
  parserKind: CliAdapterParserKind | string;
  parserConfig?: Record<string, unknown> | null;
  providerConfig?: Record<string, unknown> | null;
  sourceRepo?: string | null;
  sourceRef?: string | null;
  containerfile?: string | null;
  generatorScript?: string | null;
  installType?: string;
  configure?: CliCommandTemplate | null;
  shared?: boolean;
  enabled?: boolean;
  defaultModel?: string;
  defaultProvider?: string;
}

export interface UpdateProjectAgentAdapterInput {
  name?: string;
  description?: string | null;
  formatVersion?: number;
  image?: string;
  command?: CliCommandTemplate;
  connectionCheck?: CliCommandTemplate;
  connectionCheckDerived?: boolean;
  evidence?: CliAdapterEvidenceConfig;
  parserKind?: CliAdapterParserKind | string;
  parserConfig?: Record<string, unknown> | null;
  providerConfig?: Record<string, unknown> | null;
  sourceRepo?: string | null;
  sourceRef?: string | null;
  containerfile?: string | null;
  generatorScript?: string | null;
  installType?: string;
  configure?: CliCommandTemplate | null;
  shared?: boolean;
  buildStatus?: string;
  builtImageId?: string | null;
  builtCommit?: string | null;
  buildLogPath?: string | null;
  lastBuiltAt?: string | null;
  enabled?: boolean;
  defaultModel?: string | null;
  defaultProvider?: string | null;
}

export interface RunBatch {
  id: string;
  /** Null for multi-eval generations (one batch = many evals). */
  taskId: string | null;
  projectId: string;
  agentId: string;
  model: string;
  provider: string;
  params: Record<string, unknown>;
  repeats: number;
  trigger: string | null;
  triggerRef: string | null;
  agentImage: string | null;
  agentCommit: string | null;
  agentImageId: string | null;
  agentVersion: string | null;
  buildId: string | null;
  queueId: string | null;
  queueRevision: number | null;
  createdAt: string;
  /** Immutable generation state: accepting until atomic empty-close. */
  accepting: boolean;
  /** Queue revision observed at atomic empty-close. */
  closedRevision: number | null;
  closedAt: string | null;
}

export interface CreateBatchInput {
  taskId?: string | null;
  projectId: string;
  agentId: string;
  model: string;
  provider: string;
  params?: Record<string, unknown>;
  repeats: number;
  trigger?: string;
  triggerRef?: string;
  agentImage?: string;
  agentCommit?: string;
  agentImageId?: string;
  agentVersion?: string;
  buildId?: string;
  queueId?: string | null;
  queueRevision?: number | null;
  id?: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "resuming"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export type ControlState =
  | "running"
  | "paused-soft"
  | "paused-hard"
  | "resuming"
  | "aborting"
  | "aborted"
  | "done"
  | string;

export interface Run {
  id: string;
  batchId: string;
  taskId: string;
  projectId: string;
  queueId: string | null;
  queueItemId: string | null;
  queueContainerId: string | null;
  agentId: string;
  model: string;
  provider: string;
  repeatIndex: number;
  evalVersion: number | null;
  evalSnapshot: Record<string, unknown> | null;
  /** Immutable queue-item snapshot captured at claim time. */
  itemSnapshot: Record<string, unknown> | null;
  status: RunStatus | string;
  workspaceCommit: string | null;
  agentImage: string | null;
  agentCommit: string | null;
  agentImageSource: string | null;
  /** Per-run adapter overrides as submitted; null when the run set none. */
  adapterOverrides: Record<string, unknown> | null;
  workspaceRepo: string | null;
  /** Commit/ref this run evaluates; null → use the task's own ref. */
  workspaceRef: string | null;
  trigger: string | null;
  triggerRef: string | null;
  triggerRuleId: string | null;
  controlState: ControlState | null;
  pausedAt: string | null;
  resumedAt: string | null;
  pauseCount: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalCost: number | null;
  eventsPath: string | null;
  diffPath: string | null;
  error: string | null;
}

export interface CreateRunInput {
  batchId: string;
  taskId: string;
  projectId: string;
  queueId?: string | null;
  queueItemId?: string | null;
  queueContainerId?: string | null;
  agentId: string;
  model: string;
  provider: string;
  repeatIndex: number;
  evalVersion?: number | null;
  evalSnapshot?: Record<string, unknown> | null;
  /** Immutable queue-item snapshot captured at claim time. */
  itemSnapshot?: Record<string, unknown> | null;
  status?: RunStatus | string;
  workspaceCommit?: string;
  agentImage?: string;
  agentCommit?: string;
  agentImageSource?: string;
  adapterOverrides?: Record<string, unknown> | null;
  /** Repo this run evaluates, overriding the task workspace repo. */
  workspaceRepo?: string | null;
  /** Commit/ref this run evaluates, overriding the task workspace ref. */
  workspaceRef?: string | null;
  trigger?: string;
  triggerRef?: string;
  /** Watcher rule that enqueued this run (null for ad-hoc / queue promote). */
  triggerRuleId?: string;
  controlState?: ControlState;
  startedAt?: string;
  id?: string;
}

export interface ControlStateUpdate {
  controlState: ControlState;
  pausedAt?: string | null;
  resumedAt?: string | null;
  /** When true, increments pause_count by 1. */
  incrementPauseCount?: boolean;
  status?: RunStatus | string;
}

export interface FinalizeRunInput {
  status: RunStatus | string;
  endedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalCost?: number;
  eventsPath?: string;
  diffPath?: string;
  error?: string | null;
  controlState?: ControlState;
}

export interface ListRunsFilter {
  projectId?: string;
  batchId?: string;
  /** Optional task scope (additive; AND-combined with projectId/batchId). */
  taskId?: string;
}

export interface CreateTaskOptions {
  sourceKind?: string;
  id?: string;
  packagePath?: string;
  packageDigest?: string;
  packageManifest?: Record<string, unknown>;
  packageValidation?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Watcher rules + events + eval queue (P8a)
// ---------------------------------------------------------------------------

export type WatcherRole = "agent";
export type WatcherTrigger =
  | "tag"
  | "commit"
  | "pr"
  | "schedule"
  | "manual"
  | "webhook";
/** matched|ignored|deduped|pending|launching|launched|failed|building — see plan/data-model.md */
export type WatcherEventStatus =
  | "matched"
  | "ignored"
  | "deduped"
  | "pending"
  | "launching"
  | "launched"
  | "failed"
  | "building"
  | "enqueued";

/**
 * Watcher rule domain row. A watcher belongs to a project + exactly one queue and
 * fires that queue's agent-commit generations. webhookSecret is present only on
 * create result. The legacy `role` column is retired to the constant "agent".
 */
export interface WatcherRule {
  id: string;
  projectId: string;
  /** Queue this watcher owns; fires that queue's agent-commit generation. */
  queueId: string | null;
  role: WatcherRole;
  repo: string;
  trigger: WatcherTrigger | string;
  ref: string | null;
  semverFilter: string | null;
  /** Plaintext secret; stripped (null) on get/list/update. Present only on create. */
  webhookSecret: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWatcherRuleInput {
  repo: string;
  trigger: WatcherTrigger | string;
  /** The queue this watcher fires. Required; must belong to the same project. */
  queueId: string;
  ref?: string | null;
  semverFilter?: string | null;
  /** If absent, generated as newId()+"-"+newId() and returned once. */
  webhookSecret?: string;
  enabled?: boolean;
}

export interface UpdateWatcherRulePatch {
  ref?: string | null;
  semverFilter?: string | null;
  enabled?: boolean;
  repo?: string;
  queueId?: string | null;
}

export interface WatcherEvent {
  id: string;
  ruleId: string;
  projectId: string;
  receivedAt: string;
  trigger: string;
  ref: string | null;
  resolvedSha: string | null;
  status: WatcherEventStatus | string;
  batchId: string | null;
  /** Queue this event targets (from the owning rule). */
  queueId: string | null;
  /** Durable FIFO order for pending events awaiting a free generation. */
  fifoSeq: number | null;
  /** resolvedSha of the generation this event launched (when launched). */
  processedSha: string | null;
  error: string | null;
}

export interface RecordWatcherEventInput {
  ruleId: string;
  projectId: string;
  trigger: string;
  ref?: string | null;
  resolvedSha?: string | null;
  status: WatcherEventStatus | string;
  batchId?: string | null;
  queueId?: string | null;
  fifoSeq?: number | null;
  processedSha?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Persistent eval queues + queue containers + archived evidence
// ---------------------------------------------------------------------------

export type EvalQueueStatus =
  | "draft"
  | "starting"
  | "running"
  | "paused"
  | "completed"
  | "tainted"
  | "stopped"
  | "failed";

export interface EvalQueue {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  agentId: string;
  model: string;
  provider: string;
  adapterOverrides: Record<string, unknown> | null;
  sandbox: Record<string, unknown> | null;
  networkPolicy: string;
  ports: PortMapping[];
  status: EvalQueueStatus | string;
  activeBatchId: string | null;
  sharedAdapterId: string | null;
  builtinAdapterId: string | null;
  /** Resolved agent commit (full SHA) this queue builds/runs; null for built-in adapters. */
  agentCommit: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEvalQueueInput {
  name: string;
  description?: string | null;
  agentId: string;
  model: string;
  provider: string;
  adapterOverrides?: Record<string, unknown> | null;
  sandbox?: Record<string, unknown> | null;
  networkPolicy?: string;
  ports?: PortMapping[];
  sharedAdapterId?: string | null;
  builtinAdapterId?: string | null;
  agentCommit?: string | null;
  id?: string;
}

export interface UpdateEvalQueueInput {
  name?: string;
  description?: string | null;
  agentId?: string;
  model?: string;
  provider?: string;
  adapterOverrides?: Record<string, unknown> | null;
  sandbox?: Record<string, unknown> | null;
  networkPolicy?: string;
  ports?: PortMapping[];
  status?: EvalQueueStatus | string;
  activeBatchId?: string | null;
  sharedAdapterId?: string | null;
  builtinAdapterId?: string | null;
  agentCommit?: string | null;
  incrementRevision?: boolean;
}

export interface EvalQueueItem {
  id: string;
  queueId: string;
  projectId: string;
  taskId: string;
  position: number;
  repeats: number;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
  /** Repeats already claimed across all generations (immutable floor). */
  claimedRepeats: number;
  /** Soft-deletion timestamp; null = live. */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEvalQueueItemInput {
  taskId: string;
  position?: number | { before?: string; after?: string };
  repeats?: number;
  enabled?: boolean;
  overrides?: Record<string, unknown> | null;
  id?: string;
}

export interface UpdateEvalQueueItemInput {
  position?: number;
  before?: string;
  after?: string;
  repeats?: number;
  enabled?: boolean;
  overrides?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Adapter builds — commit-addressed reusable image build records (SCHEMA v9)
// ---------------------------------------------------------------------------

export type AdapterBuildStatus = "building" | "ready" | "failed";

export interface AdapterBuild {
  id: string;
  adapterId: string;
  commitSha: string;
  status: AdapterBuildStatus | string;
  image: string | null;
  imageId: string | null;
  agentVersion: string | null;
  logPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateAdapterBuildInput {
  id?: string;
  adapterId: string;
  commitSha: string;
  status?: AdapterBuildStatus | string;
  image?: string | null;
  imageId?: string | null;
  agentVersion?: string | null;
  logPath?: string | null;
}

export interface UpdateAdapterBuildInput {
  status?: AdapterBuildStatus | string;
  image?: string | null;
  imageId?: string | null;
  agentVersion?: string | null;
  logPath?: string | null;
  error?: string | null;
  completedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Queue generation claim — atomic claim-or-empty-close (SCHEMA v9)
// ---------------------------------------------------------------------------

/** Generation immutable snapshot captured at claim time. */
export interface GenerationSnapshot {
  batchId: string;
  queueId: string;
  queueRevision: number;
  queueContainerId: string;
  agentCommit: string | null;
  agentImage: string | null;
  agentImageId: string | null;
  agentVersion: string | null;
  buildId: string | null;
  model: string;
  provider: string;
  adapterOverrides: Record<string, unknown> | null;
  networkPolicy: string;
}

export interface ClaimQueueWorkInput {
  /** Active generation (run batch) to claim against. */
  batchId: string;
  queueId: string;
  projectId: string;
  queueContainerId: string;
  /** Values stamped onto the generation's runs/archives at claim. */
  snapshot: GenerationSnapshot;
  /**
   * Immutable item snapshot copied onto the claimed run. When omitted, the
   * claim op snapshots the selected queue-item row itself.
   */
  itemSnapshot?: Record<string, unknown>;
  /**
   * Immutable eval snapshot copied onto the claimed run. When omitted (or the
   * supplied taskId does not match the claimed item), the claim op loads and
   * snapshots the claimed item's task from the store.
   */
  evalSnapshot?: Record<string, unknown>;
  evalVersion?: number;
  /** Expected task for the caller-supplied evalSnapshot. Ignored when the claimed item differs. */
  taskId?: string;
  /** Agent id. When omitted, resolved from the active generation's batch. */
  agentId?: string;
}

export type ClaimQueueWorkResult =
  | {
      claimed: true;
      run: Run;
      queueItemId: string;
      repeatIndex: number;
    }
  | {
      claimed: false;
      /** Generation was atomically closed as empty; queue may launch again. */
      closed: true;
      closedRevision: number | null;
    };

export type QueueContainerState =
  | "starting"
  | "running"
  | "idle"
  | "closing"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "tainted"
  | "failed";

export interface QueueContainer {
  id: string;
  queueId: string;
  projectId: string;
  batchId: string;
  runtimeContainerId: string | null;
  image: string;
  /** Commit-addressed image id + resolved agent commit (generation snapshot). */
  imageId: string | null;
  agentCommit: string | null;
  agentVersion: string | null;
  buildId: string | null;
  state: QueueContainerState | string;
  ports: ResolvedPort[];
  workspaceDir: string;
  startedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateQueueContainerInput {
  id?: string;
  queueId: string;
  projectId: string;
  batchId: string;
  runtimeContainerId?: string | null;
  image: string;
  imageId?: string | null;
  agentCommit?: string | null;
  agentVersion?: string | null;
  buildId?: string | null;
  state: QueueContainerState | string;
  ports?: ResolvedPort[];
  workspaceDir: string;
  startedAt?: string | null;
  error?: string | null;
}

export interface UpdateQueueContainerInput {
  runtimeContainerId?: string | null;
  state?: QueueContainerState | string;
  ports?: ResolvedPort[];
  startedAt?: string | null;
  stoppedAt?: string | null;
  error?: string | null;
}

export interface EvalMetricsRecord {
  runId: string;
  projectId: string;
  schemaVersion: number;
  execution: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvalArchive {
  runId: string;
  projectId: string;
  queueId: string | null;
  batchId: string;
  manifestPath: string;
  /** Immutable canonical manifest key in the local ArtifactStore. */
  manifestKey: string | null;
  manifestSha256: string;
  sizeBytes: number;
  sealedAt: string;
  archivedAt: string | null;
}

export interface StoreEvalArchiveInput {
  runId: string;
  projectId: string;
  queueId?: string | null;
  batchId: string;
  manifestPath: string;
  manifestKey?: string | null;
  manifestSha256: string;
  sizeBytes: number;
  sealedAt?: string;
  archivedAt?: string | null;
}

// ---------------------------------------------------------------------------
// API tokens (P8b-auth) — hash only; plaintext returned once at create
// ---------------------------------------------------------------------------

/** Durable token row. NEVER includes plaintext. */
export interface ApiToken {
  id: string;
  /** Null = project-scoped system token (no user). */
  userId: string | null;
  /** Null = all projects; a value scopes the token. */
  projectId: string | null;
  /** sha256 hex of the plaintext bearer. */
  tokenHash: string;
  label: string | null;
  readOnly: boolean;
  createdAt: string;
  /** ISO timestamp when revoked; null = active. */
  revokedAt: string | null;
}

export interface CreateApiTokenInput {
  userId?: string | null;
  projectId?: string | null;
  label?: string | null;
  readOnly?: boolean;
}

/** createApiToken result — plaintext surfaces ONCE, never stored. */
export interface CreatedApiToken extends ApiToken {
  /** Plaintext bearer (`aev_` + 32 url-safe base64). Only on create. */
  token: string;
}

export interface ListApiTokensOpts {
  projectId?: string;
  userId?: string;
  /** When true, include revoked rows (default false). */
  includeRevoked?: boolean;
}

// ---- Users + settings (P9) ----

/** Deployment user role. First registered user is always admin (bootstrap). */
export type UserRole = "admin" | "user";

/**
 * User row. passwordHash is the scrypt salt:hash hex — NEVER log or export it
 * in API responses (auth-users strips it).
 */
export interface User {
  id: string;
  username: string;
  /** scrypt `saltHex:hashHex`. Present on query-layer rows; strip before API. */
  passwordHash: string;
  role: UserRole | string;
  createdAt: string;
  email?: string | null;
}

export interface CreateUserInput {
  username: string;
  /** Already-hashed password (scrypt). Callers hash before insert. */
  passwordHash: string;
  /** Defaults: first user → admin, subsequent → user. */
  role?: UserRole | string;
  id?: string;
  email?: string | null;
}

/** One global settings row (value is already JSON-parsed). */
export interface SettingRow {
  key: string;
  value: unknown;
  updatedAt: string;
}

/**
 * Portable project export rows (P9). Secrets stripped: watcher webhookSecret
 * (inbound), and no api_tokens.
 */
export interface ProjectExportRows {
  project: Project;
  tasks: Task[];
  /** Run metadata only (no event payloads). */
  runs: Run[];
  /** Watcher rules with webhookSecret forced to null. */
  watchers: WatcherRule[];
}

/**
 * Shared query surface. Both SqliteQueries and MemoryQueries implement this.
 */
export interface QueryStore {
  /** Run synchronous persistence as one atomic unit. */
  transaction<T>(operation: () => T): T;

  createProject(input: CreateProjectInput): Project;
  getProject(id: string): Project | null;
  listProjects(opts?: { includeArchived?: boolean }): Project[];
  updateProject(id: string, patch: UpdateProjectInput): Project;
  archiveProject(id: string): Project;

  createTask(
    projectId: string,
    spec: TaskSpec,
    opts?: CreateTaskOptions,
  ): Task;
  getTask(id: string): Task | null;
  listTasks(
    projectId: string,
    opts?: { includeArchived?: boolean },
  ): Task[];
  updateTask(id: string, patch: UpdateTaskInput): Task;
  archiveTask(id: string): Task;

  registerAgent(input: RegisterAgentInput): Agent;
  getAgent(id: string): Agent | null;
  listAgents(): Agent[];

  createProjectAgentAdapter(
    projectId: string,
    input: CreateProjectAgentAdapterInput,
  ): ProjectAgentAdapter;
  getProjectAgentAdapter(id: string): ProjectAgentAdapter | null;
  getProjectAgentAdapterByAgentId(
    projectId: string,
    agentId: string,
  ): ProjectAgentAdapter | null;
  /** List enabled adapter-store entries; consumers still select one exact row id. */
  listSharedAdapters(): ProjectAgentAdapter[];
  listProjectAgentAdapters(
    projectId: string,
    opts?: { includeDisabled?: boolean },
  ): ProjectAgentAdapter[];
  /**
   * Find a ready-built adapter (any project, including shared) whose source repo
   * and resolved commit match exactly, so a freshly-created adapter can reuse an
   * already-built CLI image instead of rebuilding the same `npm ci && npm run
   * build` from an unchanged commit. Returns the newest ready match, or null.
   */
  findReadyAdapterForSourceCommit(
    sourceRepo: string,
    commit: string,
  ): ProjectAgentAdapter | null;
  upsertAdapterBuild(input: CreateAdapterBuildInput): AdapterBuild;
  getAdapterBuild(id: string): AdapterBuild | null;
  getReadyAdapterBuild(
    adapterId: string,
    commitSha: string,
  ): AdapterBuild | null;
  listAdapterBuilds(
    adapterId: string,
    opts?: { status?: AdapterBuildStatus | string; limit?: number },
  ): AdapterBuild[];
  updateAdapterBuild(id: string, patch: UpdateAdapterBuildInput): AdapterBuild;

  updateProjectAgentAdapter(
    id: string,
    patch: UpdateProjectAgentAdapterInput,
  ): ProjectAgentAdapter;
  deleteProjectAgentAdapter(id: string): void;

  createBatch(input: CreateBatchInput): RunBatch;
  createRun(input: CreateRunInput): Run;
  getRun(id: string): Run | null;
  listRuns(filter: ListRunsFilter): Run[];
  updateRunControlState(id: string, update: ControlStateUpdate): Run;
  updateRunStatus(id: string, status: RunStatus | string): Run;
  /** Persist the run's on-disk events path before the agent launches (SSE/NDJSON tail). */
  setRunEventsPath(id: string, eventsPath: string): Run;
  finalizeRun(id: string, result: FinalizeRunInput): Run;

  // ---- watcher rules + events (P8a) ----
  /** Create a watcher rule. Returns webhookSecret once (only time it surfaces). */
  createWatcherRule(projectId: string, input: CreateWatcherRuleInput): WatcherRule;
  /** Get a rule with webhookSecret stripped to null. */
  getWatcherRule(id: string): WatcherRule | null;
  /**
   * Return the raw webhook secret for HMAC verification (webhook ingress).
   * NEVER log the return value. Returns null when the rule is missing or has
   * no secret configured.
   */
  getRawWatcherSecret(ruleId: string): string | null;
  /** List project rules with secrets stripped. */
  listWatcherRules(
    projectId: string,
    opts?: { includeDisabled?: boolean },
  ): WatcherRule[];
  /** Patch a rule (secret never touchable). Secret stripped on return. */
  updateWatcherRule(id: string, patch: UpdateWatcherRulePatch): WatcherRule;
  /** Hard-delete a rule; watcher_events rows remain for audit. */
  deleteWatcherRule(id: string): void;
  /** Insert a watcher_events row and return it. */
  recordWatcherEvent(input: RecordWatcherEventInput): WatcherEvent;
  /**
   * Atomically allocate a FIFO seq and insert a pending watcher event, or return
   * a deduped event when the same rule already has an active SHA. Prevents
   * concurrent identical webhooks from launching the same commit twice.
   */
  enqueueWatcherPendingEvent(input: {
    ruleId: string;
    projectId: string;
    queueId: string;
    trigger: string;
    ref?: string | null;
    resolvedSha: string;
  }): { status: "pending" | "deduped"; event: WatcherEvent };
  /** Newest-receivedAt-first. */
  listWatcherEvents(
    projectId: string,
    opts?: { ruleId?: string; limit?: number },
  ): WatcherEvent[];
  /**
   * Next durable pending event for a queue, oldest FIFO sequence first.
   * A watcher event is `pending` (fifo_seq set) until a generation is free to
   * launch it, then it transitions to launching/launched atomically.
   */
  nextPendingWatcherEvent(queueId: string): WatcherEvent | null;
  /**
   * The next durable FIFO sequence number for a queue's watcher events. Never
   * reused; monotonic per queue so pending events retain a stable FIFO order.
   */
  nextWatcherFifoSeq(queueId: string): number;
  /** Transition a pending watcher event to `launching` (a generation is preparing its commit). */
  markWatcherEventLaunching(id: string): WatcherEvent;
  /** Revert a `launching` event back to durable `pending` (launch did not start). */
  markWatcherEventPending(id: string): WatcherEvent;
  /** Mark a pending/launching watcher event as launched against a generation (SHA swap). */
  markWatcherEventLaunched(id: string, batchId: string, sha: string): WatcherEvent;
  /** Dedupe check: has the queue already processed this exact SHA as a queued event? */
  watcherEventExistsForSha(ruleId: string, sha: string): boolean;

  // ---- persistent eval queues + containers ----
  createEvalQueue(projectId: string, input: CreateEvalQueueInput): EvalQueue;
  getEvalQueue(id: string): EvalQueue | null;
  listEvalQueues(projectId: string): EvalQueue[];
  updateEvalQueue(id: string, patch: UpdateEvalQueueInput): EvalQueue;
  deleteEvalQueue(id: string): void;

  createEvalQueueItem(queueId: string, input: CreateEvalQueueItemInput): EvalQueueItem;
  getEvalQueueItem(id: string): EvalQueueItem | null;
  listEvalQueueItems(queueId: string, opts?: { includeDisabled?: boolean }): EvalQueueItem[];
  /** Queue ids that reference a given eval (live, non-deleted items) — for the eval store's "used by" view and delete guard. */
  listEvalQueuesUsingTask(projectId: string, taskId: string): EvalQueue[];
  updateEvalQueueItem(id: string, patch: UpdateEvalQueueItemInput): EvalQueueItem;
  deleteEvalQueueItem(id: string): void;

  createQueueContainer(input: CreateQueueContainerInput): QueueContainer;
  getQueueContainer(id: string): QueueContainer | null;
  getActiveQueueContainer(queueId: string): QueueContainer | null;
  listQueueContainers(queueId: string): QueueContainer[];
  updateQueueContainer(id: string, patch: UpdateQueueContainerInput): QueueContainer;
  /**
   * Mark abandoned active generation containers as failed. Used at API boot and
   * before starting a generation so a crashed process cannot permanently block a
   * queue with an orphaned `starting`/`running` row.
   */
  recoverStaleQueueContainers(opts?: {
    olderThanMs?: number;
    now?: string;
  }): QueueContainer[];
  /**
   * Atomically create the batch + active container for one generation, or throw
   * with code ALREADY_ACTIVE when another generation already owns the queue.
   */
  beginQueueGeneration(input: {
    batch: CreateBatchInput;
    container: Omit<CreateQueueContainerInput, "batchId">;
  }): { batch: RunBatch; container: QueueContainer };

  /**
   * Atomic claim-or-empty-close for a queue generation.
   * Claims the next enabled, non-deleted queue item repeat (position, id order),
   * comparing against already-claimed runs for the generation; creates exactly
   * one queue-backed run with immutable eval/item snapshots. When no work
   * remains, atomically marks the generation `closing` and stops accepting.
   * SQLite runs this under BEGIN IMMEDIATE; MemoryQueries is synchronous/atomic.
   */
  claimQueueWork(input: ClaimQueueWorkInput): ClaimQueueWorkResult;
  /** List runs claimed for a queue generation (used by atomic claim comparison). */
  listRunsByBatch(batchId: string): Run[];

  upsertEvalMetrics(input: {
    runId: string;
    projectId: string;
    schemaVersion: number;
    execution: Record<string, unknown>;
    outcome?: Record<string, unknown> | null;
  }): EvalMetricsRecord;
  getEvalMetrics(runId: string): EvalMetricsRecord | null;

  storeEvalArchive(input: StoreEvalArchiveInput): EvalArchive;
  getEvalArchive(runId: string): EvalArchive | null;
  listEvalArchives(filter: { projectId?: string; queueId?: string; batchId?: string }): EvalArchive[];

  // ---- API tokens (P8b-auth) ----
  /**
   * Mint a token. Returns plaintext ONCE (`token`) + the durable row fields.
   * Only the sha256 hash is stored — never the plaintext.
   */
  createApiToken(input?: CreateApiTokenInput): CreatedApiToken;
  /** Lookup by token_hash. Returns null when missing. Includes revoked rows. */
  getApiToken(tokenHash: string): ApiToken | null;
  /** Soft-revoke by token_hash (sets revoked_at). No-op if already revoked/missing. */
  revokeApiToken(tokenHash: string): void;
  /**
   * List tokens (hashes only — never plaintext). Filters optional.
   * Excludes revoked by default.
   */
  listApiTokens(opts?: ListApiTokensOpts): ApiToken[];

  // ---- Users (P9-settings) ----
  /**
   * Insert a user row. Caller supplies passwordHash (scrypt). Role defaults:
   * admin when the table is empty, otherwise "user" (unless role is passed).
   */
  createUser(input: CreateUserInput): User;
  getUser(id: string): User | null;
  getUserByUsername(username: string): User | null;
  listUsers(): User[];
  /** Hard-delete a user by id. No-op if missing. */
  deleteUser(id: string): void;
  /** Number of users (for first-user bootstrap). */
  countUsers(): number;

  addProjectMember(projectId: string, userId: string): void;
  removeProjectMember(projectId: string, userId: string): void;
  listProjectMembers(projectId: string): string[];
  listUserProjectIds(userId: string): string[];
  isProjectMember(projectId: string, userId: string): boolean;

  // ---- Settings (P9) ----
  /** Read a single setting (JSON-parsed). null when missing. */
  getSetting(key: string): unknown | null;
  /** Upsert a setting value (JSON-encoded). */
  setSetting(key: string, value: unknown): void;
  /** All settings rows (values JSON-parsed). */
  listSettings(): SettingRow[];
  /** Delete a setting key. */
  deleteSetting(key: string): void;

  // ---- Project export (P9) ----
  /**
   * Assemble portable DB rows for a project. Secrets stripped (inbound webhook
   * secrets); does NOT include api_tokens. Throws if project missing.
   */
  exportRows(projectId: string): ProjectExportRows;

  /** Persist deterministic check results for a run (P9 DB mirror). */
  storeCheckResults(runId: string, results: CheckResult[]): void;
  /** Load persisted check results for a run (P9 DB mirror). */
  getCheckResults(runId: string): CheckResult[];


}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return randomUUID();
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function workspaceFromRow(
  source: string,
  repo: string | null,
  ref: string | null,
): WorkspaceSpec {
  if (source === "git") {
    return {
      source: "git",
      repo: repo ?? "",
      ...(ref != null ? { ref } : {}),
    };
  }
  return { source: "empty" };
}

function workspaceToCols(ws: WorkspaceSpec): {
  workspaceSource: string;
  workspaceRepo: string | null;
  workspaceRef: string | null;
} {
  if (ws.source === "git") {
    return {
      workspaceSource: "git",
      workspaceRepo: ws.repo,
      workspaceRef: ws.ref ?? null,
    };
  }
  return {
    workspaceSource: "empty",
    workspaceRepo: null,
    workspaceRef: null,
  };
}

/**
 * Best-effort write of a denormalized snapshot next to the DB row.
 * Failures are swallowed — the DB is the query index; files are artifacts.
 */
export function writeSnapshot(
  filePath: string,
  data: unknown,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    // best-effort
  }
}

export function taskSnapshotPath(
  dataDir: string,
  projectId: string,
  taskId: string,
): string {
  return join(dataDir, "projects", projectId, "tasks", taskId, "task.json");
}

export function runSnapshotPath(
  dataDir: string,
  projectId: string,
  runId: string,
): string {
  return join(dataDir, "projects", projectId, "runs", runId, "run.json");
}

// ---------------------------------------------------------------------------
// Row mappers (SQLite / drizzle)
// ---------------------------------------------------------------------------

type DrizzleDb = BetterSQLite3Database<Schema>;

function mapProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    taskSource: parseJson(row.taskSourceJson, { kind: "ui-builder" }),
    defaultAgentId: row.defaultAgentId,
    defaultModel: row.defaultModel,
    defaultProvider: row.defaultProvider,
    workspaceImage: row.workspaceImage,
    checkRunners: parseJson(row.checkRunnersJson, null),
    adapterOverrides: parseJson(row.adapterOverridesJson, null),
    networkPolicy: row.networkPolicy ?? "allow",
    retentionRuns: row.retentionRuns,
    sandbox: parseJson(row.sandboxJson, null),
    modelConfig: parseJson(row.modelConfigJson, null),
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapTask(row: typeof tasks.$inferSelect): Task {
  const rubric = parseJson<Rubric>(row.rubricJson, {
    criteria: [],
    profile: "general",
    version: row.rubricVersion,
  });
  return {
    id: row.id,
    projectId: row.projectId,
    externalId: row.externalId,
    name: row.name,
    prompt: row.prompt,
    workspace: workspaceFromRow(
      row.workspaceSource,
      row.workspaceRepo,
      row.workspaceRef,
    ),
    rubric,
    version: row.version ?? 1,
    rubricVersion: row.rubricVersion,
    agentCategory: (row.agentCategory ?? "coding") as AgentCategory,
    categoryName: row.categoryName ?? null,
    profile: (row.profile as TaskProfile | null) ?? null,
    referenceSolution: row.referenceSolution,
    checks: parseJson(row.checksJson, null),
    env: parseJson(row.envJson, null),
    tags: parseJson(row.tags, null),
    sourceKind: row.sourceKind,
    packagePath: row.packagePath ?? null,
    packageDigest: row.packageDigest ?? null,
    packageManifest: parseJson(row.packageManifestJson, null),
    packageValidation: parseJson(row.packageValidationJson, null),
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    displayName: row.displayName,
    defaultModel: row.defaultModel,
    defaultProvider: row.defaultProvider,
  };
}

function mapProjectAgentAdapter(
  row: typeof projectAgentAdapters.$inferSelect,
): ProjectAgentAdapter {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    formatVersion: row.formatVersion,
    image: row.image,
    command: parseJson(row.commandJson, { argv: [] }),
    connectionCheck: parseJson(row.connectionCheckJson, { argv: [] }),
    connectionCheckDerived: row.connectionCheckDerived === 1,
    evidence: parseJson(row.evidenceJson, { paths: [] }),
    parserKind: row.parserKind,
    parserConfig: parseJson(row.parserConfigJson, null),
    providerConfig: parseJson(row.providerConfigJson, null),
    sourceRepo: row.sourceRepo,
    sourceRef: row.sourceRef,
    containerfile: row.containerfile,
    generatorScript: row.generatorScript,
    installType: row.installType,
    configure: parseJson(row.configureJson, null),
    shared: row.shared === 1,
    buildStatus: row.buildStatus,
    builtImageId: row.builtImageId,
    builtCommit: row.builtCommit,
    buildLogPath: row.buildLogPath,
    lastBuiltAt: row.lastBuiltAt,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapBatch(row: typeof runBatches.$inferSelect): RunBatch {
  return {
    id: row.id,
    taskId: row.taskId ?? null,
    projectId: row.projectId,
    agentId: row.agentId,
    model: row.model,
    provider: row.provider,
    params: parseJson(row.paramsJson, {}),
    repeats: row.repeats,
    trigger: row.trigger,
    triggerRef: row.triggerRef,
    agentImage: row.agentImage,
    agentCommit: row.agentCommit,
    agentImageId: row.agentImageId ?? null,
    agentVersion: row.agentVersion ?? null,
    buildId: row.buildId ?? null,
    queueId: row.queueId ?? null,
    queueRevision: row.queueRevision ?? null,
    createdAt: row.createdAt,
    accepting: (row.accepting ?? 1) === 1,
    closedRevision: row.closedRevision ?? null,
    closedAt: row.closedAt ?? null,
  };
}

function mapAdapterBuildRow(
  row: typeof adapterBuilds.$inferSelect,
): AdapterBuild {
  return {
    id: row.id,
    adapterId: row.adapterId,
    commitSha: row.commitSha,
    status: row.status,
    image: row.image ?? null,
    imageId: row.imageId ?? null,
    agentVersion: row.agentVersion ?? null,
    logPath: row.logPath ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? null,
  };
}

function taskSnapshotFromRow(row: typeof tasks.$inferSelect): string {
  return stringifyJson({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    workspace: { source: row.workspaceSource, ...(row.workspaceRepo ? { repo: row.workspaceRepo } : {}), ...(row.workspaceRef ? { ref: row.workspaceRef } : {}) },
    rubric: parseJson(row.rubricJson, null),
    version: row.version,
    rubricVersion: row.rubricVersion,
    agentCategory: row.agentCategory,
    categoryName: row.categoryName,
    profile: row.profile,
    checks: parseJson(row.checksJson, null),
    env: parseJson(row.envJson, null),
    packagePath: row.packagePath,
    packageDigest: row.packageDigest,
    packageManifest: parseJson(row.packageManifestJson, null),
    packageValidation: parseJson(row.packageValidationJson, null),
  }) as string;
}

function mapRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    batchId: row.batchId,
    taskId: row.taskId,
    projectId: row.projectId,
    queueId: row.queueId ?? null,
    queueItemId: row.queueItemId ?? null,
    queueContainerId: row.queueContainerId ?? null,
    agentId: row.agentId,
    model: row.model,
    provider: row.provider,
    repeatIndex: row.repeatIndex,
    evalVersion: row.evalVersion ?? null,
    evalSnapshot: parseJson(row.evalSnapshotJson, null),
    itemSnapshot: parseJson(row.itemSnapshotJson, null),
    status: row.status,
    workspaceCommit: row.workspaceCommit,
    agentImage: row.agentImage,
    agentCommit: row.agentCommit,
    agentImageSource: row.agentImageSource,
    adapterOverrides: parseJson(row.adapterOverridesJson, null),
    workspaceRepo: row.workspaceRepo ?? null,
    workspaceRef: row.workspaceRef ?? null,
    trigger: row.trigger,
    triggerRef: row.triggerRef,
    triggerRuleId: row.triggerRuleId,
    controlState: row.controlState,
    pausedAt: row.pausedAt,
    resumedAt: row.resumedAt,
    pauseCount: row.pauseCount ?? 0,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    totalCost: row.totalCost,
    eventsPath: row.eventsPath,
    diffPath: row.diffPath,
    error: row.error,
  };
}

function notFound(kind: string, id: string): Error {
  return new Error(`${kind} not found: ${id}`);
}

/**
 * A queue generation container is "active" unless it has reached a terminal
 * disposition (stopped/failed, or its stop timestamp is set). Deliberately NOT
 * keyed on runtimeContainerId: a container row is created in `starting` state
 * before the runtime handle exists, and the one-active-generation guard must
 * hold across that whole window or two generations can start for one queue.
 */
function isActiveContainerState(c: QueueContainer): boolean {
  if (c.stoppedAt !== null) return false;
  return c.state !== "stopped" && c.state !== "failed";
}

/** Strip webhook secret so it is never leaked after create. */
function stripWebhookSecret(rule: WatcherRule): WatcherRule {
  return { ...rule, webhookSecret: null };
}

function mapWatcherRuleRow(row: typeof watcherRules.$inferSelect): WatcherRule {
  return {
    id: row.id,
    projectId: row.projectId,
    queueId: row.queueId ?? null,
    role: "agent",
    repo: row.repo,
    trigger: row.trigger,
    ref: row.ref ?? null,
    semverFilter: row.semverFilter ?? null,
    webhookSecret: row.webhookSecret ?? null,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapWatcherEventRow(
  row: typeof watcherEvents.$inferSelect,
): WatcherEvent {
  return {
    id: row.id,
    ruleId: row.ruleId,
    projectId: row.projectId,
    receivedAt: row.receivedAt,
    trigger: row.trigger,
    ref: row.ref ?? null,
    resolvedSha: row.resolvedSha ?? null,
    status: row.status,
    batchId: row.batchId ?? null,
    queueId: row.queueId ?? null,
    fifoSeq: row.fifoSeq ?? null,
    processedSha: row.processedSha ?? null,
    error: row.error ?? null,
  };
}

function mapApiTokenRow(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    userId: row.userId ?? null,
    projectId: row.projectId ?? null,
    tokenHash: row.tokenHash,
    label: row.label ?? null,
    readOnly: row.readOnly === 1,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt ?? null,
  };
}

function mapUserRow(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username ?? "",
    passwordHash: row.passwordHash ?? "",
    role: (row.role as UserRole) ?? "user",
    createdAt: row.createdAt ?? "",
    email: row.email ?? null,
  };
}

/**
 * Generate plaintext `aev_` + 32 url-safe base64 chars and its sha256 hex.
 * Plaintext must never be written to the DB.
 */
function mintApiTokenPair(): { token: string; tokenHash: string } {
  const token = `aev_${randomBytes(24).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  return { token, tokenHash };
}

function mapEvalQueueRow(row: typeof evalQueues.$inferSelect): EvalQueue {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description ?? null,
    agentId: row.agentId,
    model: row.model,
    provider: row.provider,
    adapterOverrides: parseJson(row.adapterOverridesJson, null),
    sandbox: parseJson(row.sandboxJson, null),
    networkPolicy: row.networkPolicy ?? "allow",
    ports: parseJson<PortMapping[]>(row.portsJson, []),
    status: row.status,
    activeBatchId: row.activeBatchId ?? null,
    sharedAdapterId: row.sharedAdapterId ?? null,
    builtinAdapterId: row.builtinAdapterId ?? null,
    agentCommit: row.agentCommit ?? null,
    revision: row.revision ?? 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEvalQueueItemRow(
  row: typeof evalQueueItems.$inferSelect,
): EvalQueueItem {
  return {
    id: row.id,
    queueId: row.queueId,
    projectId: row.projectId,
    taskId: row.taskId,
    position: row.position,
    repeats: row.repeats,
    enabled: row.enabled === 1,
    overrides: parseJson(row.overridesJson, null),
    claimedRepeats: row.claimedRepeats ?? 0,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapQueueContainerRow(
  row: typeof queueContainers.$inferSelect,
): QueueContainer {
  return {
    id: row.id,
    queueId: row.queueId,
    projectId: row.projectId,
    batchId: row.batchId,
    runtimeContainerId: row.runtimeContainerId ?? null,
    image: row.image,
    imageId: row.imageId ?? null,
    agentCommit: row.agentCommit ?? null,
    agentVersion: row.agentVersion ?? null,
    buildId: row.buildId ?? null,
    state: row.state,
    ports: parseJson<ResolvedPort[]>(row.portsJson, []),
    workspaceDir: row.workspaceDir,
    startedAt: row.startedAt ?? null,
    stoppedAt: row.stoppedAt ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEvalMetricsRow(row: typeof evalMetrics.$inferSelect): EvalMetricsRecord {
  return {
    runId: row.runId,
    projectId: row.projectId,
    schemaVersion: row.schemaVersion,
    execution: parseJson(row.executionJson, {}),
    outcome: parseJson(row.outcomeJson, null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEvalArchiveRow(row: typeof evalArchives.$inferSelect): EvalArchive {
  return {
    runId: row.runId,
    projectId: row.projectId,
    queueId: row.queueId ?? null,
    batchId: row.batchId,
    manifestPath: row.manifestPath,
    manifestKey: row.manifestKey ?? null,
    manifestSha256: row.manifestSha256,
    sizeBytes: row.sizeBytes,
    sealedAt: row.sealedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// SqliteQueries
// ---------------------------------------------------------------------------

export class SqliteQueries implements QueryStore {
  constructor(
    private readonly db: DrizzleDb,
    private readonly dataDir: string,
  ) {}

  transaction<T>(operation: () => T): T {
    // better-sqlite3/drizzle support BEGIN IMMEDIATE via behavior: "immediate".
    // Queue starts and watcher FIFO dedupe need this to serialize writers.
    return this.db.transaction(operation, { behavior: "immediate" });
  }

  createProject(input: CreateProjectInput): Project {
    const id = input.id ?? newId();
    const ts = nowIso();
    const taskSource = input.taskSource ?? { kind: "ui-builder" };
    this.db.insert(projects).values({
      id,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      taskSourceJson: JSON.stringify(taskSource),
      defaultAgentId: input.defaultAgentId ?? null,
      defaultModel: input.defaultModel ?? null,
      defaultProvider: input.defaultProvider ?? null,
      workspaceImage: input.workspaceImage ?? null,
      checkRunnersJson: stringifyJson(input.checkRunners ?? null),
      adapterOverridesJson: stringifyJson(input.adapterOverrides ?? null),
      networkPolicy: input.networkPolicy ?? "allow",
      retentionRuns: input.retentionRuns ?? null,
      sandboxJson: stringifyJson(input.sandbox ?? null),
      modelConfigJson: stringifyJson(input.modelConfig ?? null),
      archived: 0,
      createdAt: ts,
      updatedAt: ts,
    }).run();
    const row = this.getProject(id);
    if (!row) throw new Error("failed to create project");
    return row;
  }

  getProject(id: string): Project | null {
    const row = this.db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .get();
    return row ? mapProject(row) : null;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const rows = this.db.select().from(projects).all();
    return rows
      .map(mapProject)
      .filter((p) => opts.includeArchived || !p.archived);
  }

  updateProject(id: string, patch: UpdateProjectInput): Project {
    const existing = this.getProject(id);
    if (!existing) throw notFound("project", id);
    const ts = nowIso();
    this.db
      .update(projects)
      .set({
        name: patch.name ?? existing.name,
        description:
          patch.description !== undefined
            ? patch.description
            : existing.description,
        taskSourceJson: patch.taskSource
          ? JSON.stringify(patch.taskSource)
          : JSON.stringify(existing.taskSource),
        defaultAgentId:
          patch.defaultAgentId !== undefined
            ? patch.defaultAgentId
            : existing.defaultAgentId,
        defaultModel:
          patch.defaultModel !== undefined
            ? patch.defaultModel
            : existing.defaultModel,
        defaultProvider:
          patch.defaultProvider !== undefined
            ? patch.defaultProvider
            : existing.defaultProvider,
        workspaceImage:
          patch.workspaceImage !== undefined
            ? patch.workspaceImage
            : existing.workspaceImage,
        checkRunnersJson:
          patch.checkRunners !== undefined
            ? stringifyJson(patch.checkRunners)
            : stringifyJson(existing.checkRunners),
        adapterOverridesJson:
          patch.adapterOverrides !== undefined
            ? stringifyJson(patch.adapterOverrides)
            : stringifyJson(existing.adapterOverrides),
        networkPolicy: patch.networkPolicy ?? existing.networkPolicy,
        retentionRuns:
          patch.retentionRuns !== undefined
            ? patch.retentionRuns
            : existing.retentionRuns,
        sandboxJson:
          patch.sandbox !== undefined
            ? stringifyJson(patch.sandbox)
            : stringifyJson(existing.sandbox),
        modelConfigJson:
          patch.modelConfig !== undefined
            ? stringifyJson(patch.modelConfig)
            : stringifyJson(existing.modelConfig),
        updatedAt: ts,
      })
      .where(eq(projects.id, id))
      .run();
    const row = this.getProject(id);
    if (!row) throw notFound("project", id);
    return row;
  }

  archiveProject(id: string): Project {
    const existing = this.getProject(id);
    if (!existing) throw notFound("project", id);
    this.db
      .update(projects)
      .set({ archived: 1, updatedAt: nowIso() })
      .where(eq(projects.id, id))
      .run();
    const row = this.getProject(id);
    if (!row) throw notFound("project", id);
    return row;
  }

  // ---- tasks ----

  createTask(
    projectId: string,
    spec: TaskSpec,
    opts: CreateTaskOptions = {},
  ): Task {
    const project = this.getProject(projectId);
    if (!project) throw notFound("project", projectId);
    const id = opts.id ?? newId();
    const ts = nowIso();
    const ws = workspaceToCols(spec.workspace);
    const rubricVersion = spec.rubric.version ?? 1;
    const checks = spec.checks ?? spec.rubric.checks ?? null;
    this.db
      .insert(tasks)
      .values({
        id,
        projectId,
        externalId: spec.id ?? null,
        name: spec.name,
        prompt: spec.prompt,
        workspaceSource: ws.workspaceSource,
        workspaceRepo: ws.workspaceRepo,
        workspaceRef: ws.workspaceRef,
        rubricJson: JSON.stringify(spec.rubric),
        version: 1,
        rubricVersion,
        agentCategory: spec.agentCategory ?? "coding",
        categoryName: spec.categoryName?.trim() || null,
        profile: spec.profile ?? spec.rubric.profile ?? null,
        referenceSolution: spec.referenceSolution ?? null,
        checksJson: stringifyJson(checks),
        envJson: stringifyJson(spec.env ?? null),
        tags: stringifyJson(spec.tags ?? null),
        sourceKind: opts.sourceKind ?? null,
        packagePath: opts.packagePath ?? null,
        packageDigest: opts.packageDigest ?? null,
        packageManifestJson: stringifyJson(opts.packageManifest ?? null),
        packageValidationJson: stringifyJson(opts.packageValidation ?? null),
        createdAt: ts,
        updatedAt: ts,
        archived: 0,
      })
      .run();
    const row = this.getTask(id);
    if (!row) throw new Error("failed to create task");
    writeSnapshot(taskSnapshotPath(this.dataDir, projectId, id), row);
    return row;
  }

  getTask(id: string): Task | null {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? mapTask(row) : null;
  }

  listTasks(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): Task[] {
    const rows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .all();
    return rows
      .map(mapTask)
      .filter((t) => opts.includeArchived || !t.archived);
  }

  updateTask(id: string, patch: UpdateTaskInput): Task {
    const existing = this.getTask(id);
    if (!existing) throw notFound("task", id);

    let rubricVersion = existing.rubricVersion;
    let rubricToStore = existing.rubric;
    if (patch.rubric !== undefined) {
      // Compare content ignoring embedded version — the column owns versioning.
      const strip = (r: Rubric) => {
        const { version: _v, ...rest } = r;
        return JSON.stringify(rest);
      };
      if (strip(patch.rubric) !== strip(existing.rubric)) {
        rubricVersion = existing.rubricVersion + 1;
        rubricToStore = { ...patch.rubric, version: rubricVersion };
      } else {
        // Content unchanged: keep stored rubric (and its column-synced version).
        rubricToStore = existing.rubric;
      }
    }
    const rubricJson = JSON.stringify(rubricToStore);

    const ws = patch.workspace
      ? workspaceToCols(patch.workspace)
      : workspaceToCols(existing.workspace);

    const ts = nowIso();
    this.db
      .update(tasks)
      .set({
        name: patch.name ?? existing.name,
        prompt: patch.prompt ?? existing.prompt,
        workspaceSource: ws.workspaceSource,
        workspaceRepo: ws.workspaceRepo,
        workspaceRef: ws.workspaceRef,
        rubricJson,
        version: existing.version + 1,
        rubricVersion,
        agentCategory: patch.agentCategory ?? existing.agentCategory,
        categoryName:
          patch.categoryName !== undefined
            ? patch.categoryName?.trim() || null
            : existing.categoryName,
        profile:
          patch.profile !== undefined ? patch.profile : existing.profile,
        referenceSolution:
          patch.referenceSolution !== undefined
            ? patch.referenceSolution
            : existing.referenceSolution,
        checksJson:
          patch.checks !== undefined
            ? stringifyJson(patch.checks)
            : stringifyJson(existing.checks),
        envJson:
          patch.env !== undefined
            ? stringifyJson(patch.env)
            : stringifyJson(existing.env),
        tags:
          patch.tags !== undefined
            ? stringifyJson(patch.tags)
            : stringifyJson(existing.tags),
        externalId:
          patch.externalId !== undefined
            ? patch.externalId
            : existing.externalId,
        sourceKind:
          patch.sourceKind !== undefined
            ? patch.sourceKind
            : existing.sourceKind,
        updatedAt: ts,
      })
      .where(eq(tasks.id, id))
      .run();

    const row = this.getTask(id);
    if (!row) throw notFound("task", id);
    writeSnapshot(
      taskSnapshotPath(this.dataDir, row.projectId, row.id),
      row,
    );
    return row;
  }

  archiveTask(id: string): Task {
    const existing = this.getTask(id);
    if (!existing) throw notFound("task", id);
    this.db
      .update(tasks)
      .set({ archived: 1, version: existing.version + 1, updatedAt: nowIso() })
      .where(eq(tasks.id, id))
      .run();
    const row = this.getTask(id);
    if (!row) throw notFound("task", id);
    return row;
  }

  // ---- agents ----

  registerAgent(input: RegisterAgentInput): Agent {
    const existing = this.getAgent(input.id);
    if (existing) {
      this.db
        .update(agents)
        .set({
          displayName: input.displayName,
          defaultModel: input.defaultModel ?? existing.defaultModel,
          defaultProvider: input.defaultProvider ?? existing.defaultProvider,
        })
        .where(eq(agents.id, input.id))
        .run();
      const row = this.getAgent(input.id);
      if (!row) throw notFound("agent", input.id);
      return row;
    }
    this.db
      .insert(agents)
      .values({
        id: input.id,
        displayName: input.displayName,
        defaultModel: input.defaultModel ?? null,
        defaultProvider: input.defaultProvider ?? null,
      })
      .run();
    const row = this.getAgent(input.id);
    if (!row) throw new Error("failed to register agent");
    return row;
  }

  getAgent(id: string): Agent | null {
    const row = this.db.select().from(agents).where(eq(agents.id, id)).get();
    return row ? mapAgent(row) : null;
  }

  listAgents(): Agent[] {
    return this.db.select().from(agents).all().map(mapAgent);
  }

  createProjectAgentAdapter(
    projectId: string,
    input: CreateProjectAgentAdapterInput,
  ): ProjectAgentAdapter {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    this.registerAgent({
      id: input.agentId,
      displayName: input.name,
      ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
    });
    if (this.listProjectAgentAdapters(projectId, { includeDisabled: true }).length > 0) {
      throw new Error(`project ${projectId} already has an agent adapter`);
    }
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db.insert(projectAgentAdapters).values({
      id,
      projectId,
      agentId: input.agentId,
      name: input.name,
      description: input.description ?? null,
      formatVersion: input.formatVersion ?? 1,
      image: input.image,
      commandJson: JSON.stringify(input.command),
      connectionCheckJson: JSON.stringify(input.connectionCheck),
      connectionCheckDerived: input.connectionCheckDerived === true ? 1 : 0,
      evidenceJson: JSON.stringify(input.evidence),
      parserKind: input.parserKind,
      parserConfigJson:
        input.parserConfig === undefined || input.parserConfig === null
          ? null
          : JSON.stringify(input.parserConfig),
      providerConfigJson:
        input.providerConfig === undefined || input.providerConfig === null
          ? null
          : JSON.stringify(input.providerConfig),
      sourceRepo: input.sourceRepo ?? null,
      sourceRef: input.sourceRef ?? null,
      containerfile: input.containerfile ?? null,
      generatorScript: input.generatorScript ?? null,
      installType: input.installType ?? "source-build",
      configureJson:
        input.configure === undefined || input.configure === null
          ? null
          : JSON.stringify(input.configure),
      shared: input.shared === true ? 1 : 0,
      buildStatus: "unbuilt",
      builtImageId: null,
      builtCommit: null,
      buildLogPath: null,
      lastBuiltAt: null,
      enabled: input.enabled === false ? 0 : 1,
      createdAt: ts,
      updatedAt: ts,
    }).run();
    return this.getProjectAgentAdapter(id)!;
  }

  getProjectAgentAdapter(id: string): ProjectAgentAdapter | null {
    const row = this.db
      .select()
      .from(projectAgentAdapters)
      .where(eq(projectAgentAdapters.id, id))
      .get();
    return row ? mapProjectAgentAdapter(row) : null;
  }

  getProjectAgentAdapterByAgentId(
    projectId: string,
    agentId: string,
  ): ProjectAgentAdapter | null {
    const row = this.db
      .select()
      .from(projectAgentAdapters)
      .where(
        and(
          eq(projectAgentAdapters.projectId, projectId),
          eq(projectAgentAdapters.agentId, agentId),
        ),
      )
      .get();
    return row ? mapProjectAgentAdapter(row) : null;
  }

  listSharedAdapters(): ProjectAgentAdapter[] {
    return this.db
      .select()
      .from(projectAgentAdapters)
      .where(
        and(
          eq(projectAgentAdapters.shared, 1),
          eq(projectAgentAdapters.enabled, 1),
        ),
      )
      .all()
      .map(mapProjectAgentAdapter)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listProjectAgentAdapters(
    projectId: string,
    opts: { includeDisabled?: boolean } = {},
  ): ProjectAgentAdapter[] {
    return this.db
      .select()
      .from(projectAgentAdapters)
      .where(eq(projectAgentAdapters.projectId, projectId))
      .all()
      .map(mapProjectAgentAdapter)
      .filter((adapter) => opts.includeDisabled === true || adapter.enabled)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  findReadyAdapterForSourceCommit(
    sourceRepo: string,
    commit: string,
  ): ProjectAgentAdapter | null {
    const rows = this.db
      .select()
      .from(projectAgentAdapters)
      .where(
        and(
          eq(projectAgentAdapters.sourceRepo, sourceRepo),
          eq(projectAgentAdapters.builtCommit, commit),
          eq(projectAgentAdapters.buildStatus, "ready"),
          isNotNull(projectAgentAdapters.builtImageId),
        ),
      )
      .all()
      .map(mapProjectAgentAdapter)
      // newest ready build wins, so a re-tag of the same commit is preferred
      .sort((a, b) =>
        (b.lastBuiltAt ?? b.createdAt).localeCompare(
          a.lastBuiltAt ?? a.createdAt,
        ),
      );
    return rows[0] ?? null;
  }

  updateProjectAgentAdapter(
    id: string,
    patch: UpdateProjectAgentAdapterInput,
  ): ProjectAgentAdapter {
    const existing = this.getProjectAgentAdapter(id);
    if (!existing) throw notFound("project agent adapter", id);
    this.db.update(projectAgentAdapters).set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.formatVersion !== undefined ? { formatVersion: patch.formatVersion } : {}),
      ...(patch.image !== undefined ? { image: patch.image } : {}),
      ...(patch.command !== undefined ? { commandJson: JSON.stringify(patch.command) } : {}),
      ...(patch.connectionCheck !== undefined
        ? { connectionCheckJson: JSON.stringify(patch.connectionCheck) }
        : {}),
      ...(patch.connectionCheckDerived !== undefined
        ? { connectionCheckDerived: patch.connectionCheckDerived ? 1 : 0 }
        : {}),
      ...(patch.evidence !== undefined ? { evidenceJson: JSON.stringify(patch.evidence) } : {}),
      ...(patch.parserKind !== undefined ? { parserKind: patch.parserKind } : {}),
      ...(patch.parserConfig !== undefined
        ? { parserConfigJson: patch.parserConfig === null ? null : JSON.stringify(patch.parserConfig) }
        : {}),
      ...(patch.providerConfig !== undefined
        ? { providerConfigJson: patch.providerConfig === null ? null : JSON.stringify(patch.providerConfig) }
        : {}),
      ...(patch.sourceRepo !== undefined ? { sourceRepo: patch.sourceRepo } : {}),
      ...(patch.sourceRef !== undefined ? { sourceRef: patch.sourceRef } : {}),
      ...(patch.containerfile !== undefined ? { containerfile: patch.containerfile } : {}),
      ...(patch.generatorScript !== undefined ? { generatorScript: patch.generatorScript } : {}),
      ...(patch.installType !== undefined ? { installType: patch.installType } : {}),
      ...(patch.configure !== undefined
        ? { configureJson: patch.configure === null ? null : JSON.stringify(patch.configure) }
        : {}),
      ...(patch.shared !== undefined ? { shared: patch.shared ? 1 : 0 } : {}),
      ...(patch.buildStatus !== undefined ? { buildStatus: patch.buildStatus } : {}),
      ...(patch.builtImageId !== undefined ? { builtImageId: patch.builtImageId } : {}),
      ...(patch.builtCommit !== undefined ? { builtCommit: patch.builtCommit } : {}),
      ...(patch.buildLogPath !== undefined ? { buildLogPath: patch.buildLogPath } : {}),
      ...(patch.lastBuiltAt !== undefined ? { lastBuiltAt: patch.lastBuiltAt } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
      updatedAt: nowIso(),
    }).where(eq(projectAgentAdapters.id, id)).run();
    if (
      patch.name !== undefined ||
      patch.defaultModel !== undefined ||
      patch.defaultProvider !== undefined
    ) {
      this.registerAgent({
        id: existing.agentId,
        displayName: patch.name ?? existing.name,
        ...(patch.defaultModel ? { defaultModel: patch.defaultModel } : {}),
        ...(patch.defaultProvider ? { defaultProvider: patch.defaultProvider } : {}),
      });
    }
    return this.getProjectAgentAdapter(id)!;
  }

  deleteProjectAgentAdapter(id: string): void {
    if (!this.getProjectAgentAdapter(id)) throw notFound("project agent adapter", id);
    this.db.delete(projectAgentAdapters).where(eq(projectAgentAdapters.id, id)).run();
  }

  // ---- adapter builds (commit-addressed, SCHEMA v9) ----

  upsertAdapterBuild(input: CreateAdapterBuildInput): AdapterBuild {
    const id = input.id ?? `${input.adapterId}:${input.commitSha}`;
    const existing = this.getAdapterBuild(id);
    const ts = nowIso();
    if (existing) {
      this.db
        .update(adapterBuilds)
        .set({
          status: input.status ?? existing.status,
          image: input.image !== undefined ? input.image : existing.image,
          imageId: input.imageId !== undefined ? input.imageId : existing.imageId,
          agentVersion:
            input.agentVersion !== undefined
              ? input.agentVersion
              : existing.agentVersion,
          logPath: input.logPath !== undefined ? input.logPath : existing.logPath,
          completedAt:
            input.status === "ready" || input.status === "failed"
              ? nowIso()
              : existing.completedAt,
          updatedAt: ts,
        })
        .where(eq(adapterBuilds.id, id))
        .run();
    } else {
      this.db
        .insert(adapterBuilds)
        .values({
          id,
          adapterId: input.adapterId,
          commitSha: input.commitSha,
          status: input.status ?? "building",
          image: input.image ?? null,
          imageId: input.imageId ?? null,
          agentVersion: input.agentVersion ?? null,
          logPath: input.logPath ?? null,
          error: null,
          createdAt: ts,
          updatedAt: ts,
          completedAt: null,
        })
        .run();
    }
    const row = this.getAdapterBuild(id);
    if (!row) throw notFound("adapter build", id);
    return row;
  }

  getAdapterBuild(id: string): AdapterBuild | null {
    const row = this.db.select().from(adapterBuilds).where(eq(adapterBuilds.id, id)).get();
    return row ? mapAdapterBuildRow(row) : null;
  }

  getReadyAdapterBuild(adapterId: string, commitSha: string): AdapterBuild | null {
    const row = this.db
      .select()
      .from(adapterBuilds)
      .where(
        and(
          eq(adapterBuilds.adapterId, adapterId),
          eq(adapterBuilds.commitSha, commitSha),
          eq(adapterBuilds.status, "ready"),
        ),
      )
      .get();
    return row ? mapAdapterBuildRow(row) : null;
  }

  listAdapterBuilds(
    adapterId: string,
    opts: { status?: AdapterBuildStatus | string; limit?: number } = {},
  ): AdapterBuild[] {
    const conditions = [eq(adapterBuilds.adapterId, adapterId)];
    if (opts.status) conditions.push(eq(adapterBuilds.status, opts.status));
    const rows = this.db
      .select()
      .from(adapterBuilds)
      .where(and(...conditions))
      .orderBy(desc(adapterBuilds.createdAt))
      .limit(opts.limit ?? 200)
      .all();
    return rows.map(mapAdapterBuildRow);
  }

  updateAdapterBuild(id: string, patch: UpdateAdapterBuildInput): AdapterBuild {
    if (!this.getAdapterBuild(id)) throw notFound("adapter build", id);
    const values: Partial<typeof adapterBuilds.$inferInsert> = { updatedAt: nowIso() };
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.image !== undefined) values.image = patch.image;
    if (patch.imageId !== undefined) values.imageId = patch.imageId;
    if (patch.agentVersion !== undefined) values.agentVersion = patch.agentVersion;
    if (patch.logPath !== undefined) values.logPath = patch.logPath;
    if (patch.error !== undefined) values.error = patch.error;
    if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;
    if (patch.status === "ready" || patch.status === "failed") {
      values.completedAt = patch.completedAt ?? nowIso();
    }
    this.db
      .update(adapterBuilds)
      .set(values)
      .where(eq(adapterBuilds.id, id))
      .run();
    const row = this.getAdapterBuild(id);
    if (!row) throw notFound("adapter build", id);
    return row;
  }

  // ---- batches + runs ----

  createBatch(input: CreateBatchInput): RunBatch {
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db
      .insert(runBatches)
      .values({
        id,
        taskId: input.taskId ?? null,
        projectId: input.projectId,
        agentId: input.agentId,
        model: input.model,
        provider: input.provider,
        paramsJson: JSON.stringify(input.params ?? {}),
        repeats: input.repeats,
        trigger: input.trigger ?? null,
        triggerRef: input.triggerRef ?? null,
        agentImage: input.agentImage ?? null,
        agentCommit: input.agentCommit ?? null,
        agentImageId: input.agentImageId ?? null,
        agentVersion: input.agentVersion ?? null,
        buildId: input.buildId ?? null,
        queueId: input.queueId ?? null,
        queueRevision: input.queueRevision ?? null,
        createdAt: ts,
      })
      .run();
    const row = this.db
      .select()
      .from(runBatches)
      .where(eq(runBatches.id, id))
      .get();
    if (!row) throw new Error("failed to create batch");
    return mapBatch(row);
  }

  createRun(input: CreateRunInput): Run {
    const id = input.id ?? newId();
    this.db
      .insert(runs)
      .values({
        id,
        batchId: input.batchId,
        taskId: input.taskId,
        projectId: input.projectId,
        queueId: input.queueId ?? null,
        queueItemId: input.queueItemId ?? null,
        queueContainerId: input.queueContainerId ?? null,
        agentId: input.agentId,
        model: input.model,
        provider: input.provider,
        repeatIndex: input.repeatIndex,
        evalVersion: input.evalVersion ?? null,
        evalSnapshotJson: stringifyJson(input.evalSnapshot ?? null),
        itemSnapshotJson: stringifyJson(input.itemSnapshot ?? null),
        status: input.status ?? "queued",
        workspaceCommit: input.workspaceCommit ?? null,
        agentImage: input.agentImage ?? null,
        agentCommit: input.agentCommit ?? null,
        agentImageSource: input.agentImageSource ?? null,
        adapterOverridesJson: stringifyJson(input.adapterOverrides ?? null),
        workspaceRepo: input.workspaceRepo ?? null,
        workspaceRef: input.workspaceRef ?? null,
        trigger: input.trigger ?? null,
        triggerRef: input.triggerRef ?? null,
        triggerRuleId: input.triggerRuleId ?? null,
        controlState: input.controlState ?? null,
        pausedAt: null,
        resumedAt: null,
        pauseCount: 0,
        startedAt: input.startedAt ?? null,
        endedAt: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalCost: null,
        eventsPath: null,
        diffPath: null,
        error: null,
      })
      .run();
    const row = this.getRun(id);
    if (!row) throw new Error("failed to create run");
    writeSnapshot(runSnapshotPath(this.dataDir, row.projectId, row.id), row);
    return row;
  }

  getRun(id: string): Run | null {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get();
    return row ? mapRun(row) : null;
  }

  listRuns(filter: ListRunsFilter): Run[] {
    const conditions = [];
    if (filter.projectId) {
      conditions.push(eq(runs.projectId, filter.projectId));
    }
    if (filter.batchId) {
      conditions.push(eq(runs.batchId, filter.batchId));
    }
    if (filter.taskId) {
      conditions.push(eq(runs.taskId, filter.taskId));
    }
    if (conditions.length === 0) {
      return this.db.select().from(runs).all().map(mapRun);
    }
    if (conditions.length === 1) {
      return this.db
        .select()
        .from(runs)
        .where(conditions[0]!)
        .all()
        .map(mapRun);
    }
    return this.db
      .select()
      .from(runs)
      .where(and(...conditions))
      .all()
      .map(mapRun);
  }

  updateRunControlState(id: string, update: ControlStateUpdate): Run {
    const existing = this.getRun(id);
    if (!existing) throw notFound("run", id);
    const pauseCount = update.incrementPauseCount
      ? existing.pauseCount + 1
      : existing.pauseCount;
    this.db
      .update(runs)
      .set({
        controlState: update.controlState,
        pausedAt:
          update.pausedAt !== undefined ? update.pausedAt : existing.pausedAt,
        resumedAt:
          update.resumedAt !== undefined
            ? update.resumedAt
            : existing.resumedAt,
        pauseCount,
        status: update.status ?? existing.status,
      })
      .where(eq(runs.id, id))
      .run();
    const row = this.getRun(id);
    if (!row) throw notFound("run", id);
    writeSnapshot(runSnapshotPath(this.dataDir, row.projectId, row.id), row);
    return row;
  }

  updateRunStatus(id: string, status: RunStatus | string): Run {
    const existing = this.getRun(id);
    if (!existing) throw notFound("run", id);
    this.db.update(runs).set({ status }).where(eq(runs.id, id)).run();
    const row = this.getRun(id);
    if (!row) throw notFound("run", id);
    return row;
  }

  setRunEventsPath(id: string, eventsPath: string): Run {
    const existing = this.getRun(id);
    if (!existing) throw notFound("run", id);
    this.db
      .update(runs)
      .set({ eventsPath })
      .where(eq(runs.id, id))
      .run();
    const row = this.getRun(id);
    if (!row) throw notFound("run", id);
    writeSnapshot(runSnapshotPath(this.dataDir, row.projectId, row.id), row);
    return row;
  }

  finalizeRun(id: string, result: FinalizeRunInput): Run {
    const existing = this.getRun(id);
    if (!existing) throw notFound("run", id);
    const endedAt = result.endedAt ?? nowIso();
    this.db
      .update(runs)
      .set({
        status: result.status,
        endedAt,
        durationMs:
          result.durationMs !== undefined
            ? result.durationMs
            : existing.durationMs,
        inputTokens:
          result.inputTokens !== undefined
            ? result.inputTokens
            : existing.inputTokens,
        outputTokens:
          result.outputTokens !== undefined
            ? result.outputTokens
            : existing.outputTokens,
        reasoningTokens:
          result.reasoningTokens !== undefined
            ? result.reasoningTokens
            : existing.reasoningTokens,
        totalCost:
          result.totalCost !== undefined
            ? result.totalCost
            : existing.totalCost,
        eventsPath:
          result.eventsPath !== undefined
            ? result.eventsPath
            : existing.eventsPath,
        diffPath:
          result.diffPath !== undefined ? result.diffPath : existing.diffPath,
        error: result.error !== undefined ? result.error : existing.error,
        controlState: result.controlState ?? "done",
      })
      .where(eq(runs.id, id))
      .run();
    const row = this.getRun(id);
    if (!row) throw notFound("run", id);
    writeSnapshot(runSnapshotPath(this.dataDir, row.projectId, row.id), row);
    return row;
  }

  // ---- watcher rules + events (P8a) ----

  createWatcherRule(
    projectId: string,
    input: CreateWatcherRuleInput,
  ): WatcherRule {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    const id = newId();
    const ts = nowIso();
    const secret =
      input.webhookSecret !== undefined && input.webhookSecret !== ""
        ? input.webhookSecret
        : `${newId()}-${newId()}`;
    const enabled = input.enabled === false ? 0 : 1;
    this.db
      .insert(watcherRules)
      .values({
        id,
        projectId,
        queueId: input.queueId ?? null,
        role: "agent",
        repo: input.repo,
        trigger: input.trigger,
        ref: input.ref ?? null,
        semverFilter: input.semverFilter ?? null,
        actionJson: "{}",
        webhookSecret: secret,
        enabled,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    const row = this.db
      .select()
      .from(watcherRules)
      .where(eq(watcherRules.id, id))
      .get();
    if (!row) throw new Error("failed to create watcher rule");
    // Return WITH secret present — only create surfaces it.
    return mapWatcherRuleRow(row);
  }

  getWatcherRule(id: string): WatcherRule | null {
    const row = this.db
      .select()
      .from(watcherRules)
      .where(eq(watcherRules.id, id))
      .get();
    return row ? stripWebhookSecret(mapWatcherRuleRow(row)) : null;
  }

  /**
   * Raw webhook secret for HMAC verify. NEVER log the return value.
   */
  getRawWatcherSecret(ruleId: string): string | null {
    const row = this.db
      .select()
      .from(watcherRules)
      .where(eq(watcherRules.id, ruleId))
      .get();
    if (!row) return null;
    const secret = row.webhookSecret;
    if (secret == null || secret === "") return null;
    return secret;
  }

  listWatcherRules(
    projectId: string,
    opts: { includeDisabled?: boolean } = {},
  ): WatcherRule[] {
    const rows = this.db
      .select()
      .from(watcherRules)
      .where(eq(watcherRules.projectId, projectId))
      .all();
    return rows
      .map(mapWatcherRuleRow)
      .filter((r) => opts.includeDisabled || r.enabled)
      .map(stripWebhookSecret);
  }

  updateWatcherRule(
    id: string,
    patch: UpdateWatcherRulePatch,
  ): WatcherRule {
    const existing = this.db
      .select()
      .from(watcherRules)
      .where(eq(watcherRules.id, id))
      .get();
    if (!existing) throw notFound("watcher rule", id);
    const next = {
      ref: patch.ref !== undefined ? patch.ref : existing.ref,
      semverFilter:
        patch.semverFilter !== undefined
          ? patch.semverFilter
          : existing.semverFilter,
      enabled:
        patch.enabled !== undefined
          ? patch.enabled
            ? 1
            : 0
          : existing.enabled,
      repo: patch.repo !== undefined ? patch.repo : existing.repo,
      queueId:
        patch.queueId !== undefined ? patch.queueId : existing.queueId,
      updatedAt: nowIso(),
    };
    this.db
      .update(watcherRules)
      .set(next)
      .where(eq(watcherRules.id, id))
      .run();
    const row = this.db
      .select()
      .from(watcherRules)
      .where(eq(watcherRules.id, id))
      .get();
    if (!row) throw notFound("watcher rule", id);
    return stripWebhookSecret(mapWatcherRuleRow(row));
  }

  deleteWatcherRule(id: string): void {
    this.db.delete(watcherRules).where(eq(watcherRules.id, id)).run();
  }

  recordWatcherEvent(input: RecordWatcherEventInput): WatcherEvent {
    const id = newId();
    const receivedAt = nowIso();
    this.db
      .insert(watcherEvents)
      .values({
        id,
        ruleId: input.ruleId,
        projectId: input.projectId,
        receivedAt,
        trigger: input.trigger,
        ref: input.ref ?? null,
        resolvedSha: input.resolvedSha ?? null,
        status: input.status,
        batchId: input.batchId ?? null,
        queueId: input.queueId ?? null,
        fifoSeq: input.fifoSeq ?? null,
        processedSha: input.processedSha ?? null,
        error: input.error ?? null,
      })
      .run();
    const row = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!row) throw new Error("failed to record watcher event");
    return mapWatcherEventRow(row);
  }

  enqueueWatcherPendingEvent(input: {
    ruleId: string;
    projectId: string;
    queueId: string;
    trigger: string;
    ref?: string | null;
    resolvedSha: string;
  }): { status: "pending" | "deduped"; event: WatcherEvent } {
    return this.transaction(() => {
      const active = this.db
        .select()
        .from(watcherEvents)
        .where(
          and(
            eq(watcherEvents.ruleId, input.ruleId),
            eq(watcherEvents.resolvedSha, input.resolvedSha),
          ),
        )
        .all()
        .map(mapWatcherEventRow)
        .find((e) => ["pending", "launching", "launched"].includes(e.status));
      if (active) {
        const deduped = this.recordWatcherEvent({
          ruleId: input.ruleId,
          projectId: input.projectId,
          queueId: input.queueId,
          trigger: input.trigger,
          ref: input.ref ?? null,
          resolvedSha: input.resolvedSha,
          status: "deduped",
        });
        return { status: "deduped", event: deduped };
      }
      const fifoSeq = this.nextWatcherFifoSeq(input.queueId);
      try {
        const pending = this.recordWatcherEvent({
          ruleId: input.ruleId,
          projectId: input.projectId,
          queueId: input.queueId,
          trigger: input.trigger,
          ref: input.ref ?? null,
          resolvedSha: input.resolvedSha,
          status: "pending",
          fifoSeq,
        });
        return { status: "pending", event: pending };
      } catch (err) {
        // Unique active-sha index: a concurrent writer won the race.
        const message = err instanceof Error ? err.message : String(err);
        if (/UNIQUE|unique/i.test(message)) {
          const deduped = this.recordWatcherEvent({
            ruleId: input.ruleId,
            projectId: input.projectId,
            queueId: input.queueId,
            trigger: input.trigger,
            ref: input.ref ?? null,
            resolvedSha: input.resolvedSha,
            status: "deduped",
          });
          return { status: "deduped", event: deduped };
        }
        throw err;
      }
    });
  }

  listWatcherEvents(
    projectId: string,
    opts: { ruleId?: string; limit?: number } = {},
  ): WatcherEvent[] {
    const rows = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.projectId, projectId))
      .all();
    let events = rows.map(mapWatcherEventRow);
    if (opts.ruleId) {
      events = events.filter((e) => e.ruleId === opts.ruleId);
    }
    events.sort((a, b) =>
      a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0,
    );
    if (opts.limit !== undefined) {
      const lim = Math.max(0, Math.floor(opts.limit));
      events = events.slice(0, lim);
    }
    return events;
  }

  nextPendingWatcherEvent(queueId: string): WatcherEvent | null {
    const rows = this.db
      .select()
      .from(watcherEvents)
      .where(and(eq(watcherEvents.queueId, queueId), isNotNull(watcherEvents.fifoSeq)))
      .all()
      .map(mapWatcherEventRow)
      .filter((e) => e.status === "pending");
    rows.sort((a, b) => (a.fifoSeq ?? Infinity) - (b.fifoSeq ?? Infinity));
    return rows[0] ?? null;
  }

  markWatcherEventLaunching(id: string): WatcherEvent {
    const existing = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!existing) throw notFound("watcher event", id);
    this.db
      .update(watcherEvents)
      .set({ status: "launching" })
      .where(eq(watcherEvents.id, id))
      .run();
    const row = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!row) throw notFound("watcher event", id);
    return mapWatcherEventRow(row);
  }

  markWatcherEventPending(id: string): WatcherEvent {
    const existing = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!existing) throw notFound("watcher event", id);
    this.db
      .update(watcherEvents)
      .set({ status: "pending" })
      .where(eq(watcherEvents.id, id))
      .run();
    const row = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!row) throw notFound("watcher event", id);
    return mapWatcherEventRow(row);
  }

  markWatcherEventLaunched(
    id: string,
    batchId: string,
    sha: string,
  ): WatcherEvent {
    const existing = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!existing) throw notFound("watcher event", id);
    this.db
      .update(watcherEvents)
      .set({ status: "launched", batchId, processedSha: sha })
      .where(eq(watcherEvents.id, id))
      .run();
    const row = this.db
      .select()
      .from(watcherEvents)
      .where(eq(watcherEvents.id, id))
      .get();
    if (!row) throw notFound("watcher event", id);
    return mapWatcherEventRow(row);
  }

  nextWatcherFifoSeq(queueId: string): number {
    const row = this.db
      .select({ m: max(watcherEvents.fifoSeq) })
      .from(watcherEvents)
      .where(eq(watcherEvents.queueId, queueId))
      .get();
    return (row?.m ?? 0) + 1;
  }

  watcherEventExistsForSha(ruleId: string, sha: string): boolean {
    const row = this.db
      .select()
      .from(watcherEvents)
      .where(
        and(
          eq(watcherEvents.ruleId, ruleId),
          eq(watcherEvents.processedSha, sha),
        ),
      )
      .get();
    return row !== undefined;
  }

  // ---- persistent eval queues + containers ----

  createEvalQueue(projectId: string, input: CreateEvalQueueInput): EvalQueue {
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db.insert(evalQueues).values({
      id, projectId, name: input.name, description: input.description ?? null,
      agentId: input.agentId, model: input.model, provider: input.provider,
      adapterOverridesJson: stringifyJson(input.adapterOverrides ?? null),
      sandboxJson: stringifyJson(input.sandbox ?? null),
      networkPolicy: input.networkPolicy ?? "allow",
      portsJson: stringifyJson(input.ports ?? []), status: "draft",
      activeBatchId: null, sharedAdapterId: input.sharedAdapterId ?? null,
      builtinAdapterId: input.builtinAdapterId ?? null,
      agentCommit: input.agentCommit ?? null,
      revision: 1, createdAt: ts, updatedAt: ts,
    }).run();
    return this.getEvalQueue(id)!;
  }

  getEvalQueue(id: string): EvalQueue | null {
    const row = this.db.select().from(evalQueues).where(eq(evalQueues.id, id)).get();
    return row ? mapEvalQueueRow(row) : null;
  }

  listEvalQueues(projectId: string): EvalQueue[] {
    return this.db.select().from(evalQueues).where(eq(evalQueues.projectId, projectId)).all()
      .map(mapEvalQueueRow).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateEvalQueue(id: string, patch: UpdateEvalQueueInput): EvalQueue {
    const existing = this.getEvalQueue(id);
    if (!existing) throw notFound("eval queue", id);
    const values: Partial<typeof evalQueues.$inferInsert> = { updatedAt: nowIso() };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.agentId !== undefined) values.agentId = patch.agentId;
    if (patch.model !== undefined) values.model = patch.model;
    if (patch.provider !== undefined) values.provider = patch.provider;
    if (patch.adapterOverrides !== undefined) values.adapterOverridesJson = stringifyJson(patch.adapterOverrides);
    if (patch.sandbox !== undefined) values.sandboxJson = stringifyJson(patch.sandbox);
    if (patch.networkPolicy !== undefined) values.networkPolicy = patch.networkPolicy;
    if (patch.ports !== undefined) values.portsJson = stringifyJson(patch.ports);
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.activeBatchId !== undefined) values.activeBatchId = patch.activeBatchId;
    if (patch.sharedAdapterId !== undefined) values.sharedAdapterId = patch.sharedAdapterId;
    if (patch.builtinAdapterId !== undefined) values.builtinAdapterId = patch.builtinAdapterId;
    if (patch.agentCommit !== undefined) values.agentCommit = patch.agentCommit;
    if (patch.incrementRevision) values.revision = existing.revision + 1;
    this.db.update(evalQueues).set(values).where(eq(evalQueues.id, id)).run();
    return this.getEvalQueue(id)!;
  }

  deleteEvalQueue(id: string): void {
    if (!this.getEvalQueue(id)) throw notFound("eval queue", id);
    this.db.delete(evalQueueItems).where(eq(evalQueueItems.queueId, id)).run();
    this.db.delete(evalQueues).where(eq(evalQueues.id, id)).run();
  }

  createEvalQueueItem(queueId: string, input: CreateEvalQueueItemInput): EvalQueueItem {
    const queue = this.getEvalQueue(queueId);
    if (!queue) throw notFound("eval queue", queueId);
    const task = this.getTask(input.taskId);
    if (!task || task.projectId !== queue.projectId) throw notFound("task", input.taskId);
    const items = this.listEvalQueueItems(queueId, { includeDisabled: true });
    let position = items.length === 0 ? 1 : items[items.length - 1]!.position + 1;
    const requestedPosition = input.position;
    if (typeof requestedPosition === "number") position = requestedPosition;
    else if (requestedPosition?.before) {
      const beforeId = requestedPosition.before;
      const at = items.findIndex((i) => i.id === beforeId);
      if (at < 0) throw notFound("eval queue item", beforeId);
      position = ((items[at - 1]?.position ?? items[at]!.position - 1) + items[at]!.position) / 2;
    } else if (requestedPosition?.after) {
      const afterId = requestedPosition.after;
      const at = items.findIndex((i) => i.id === afterId);
      if (at < 0) throw notFound("eval queue item", afterId);
      position = (items[at]!.position + (items[at + 1]?.position ?? items[at]!.position + 1)) / 2;
    }
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db.insert(evalQueueItems).values({
      id, queueId, projectId: queue.projectId, taskId: input.taskId, position,
      repeats: Math.max(1, input.repeats ?? 1), enabled: input.enabled === false ? 0 : 1,
      overridesJson: stringifyJson(input.overrides ?? null),
      claimedRepeats: 0, deletedAt: null, createdAt: ts, updatedAt: ts,
    }).run();
    this.updateEvalQueue(queueId, { incrementRevision: true });
    return this.getEvalQueueItem(id)!;
  }

  getEvalQueueItem(id: string): EvalQueueItem | null {
    const row = this.db.select().from(evalQueueItems).where(eq(evalQueueItems.id, id)).get();
    return row ? mapEvalQueueItemRow(row) : null;
  }

  listEvalQueueItems(queueId: string, opts: { includeDisabled?: boolean } = {}): EvalQueueItem[] {
    return this.db.select().from(evalQueueItems).where(eq(evalQueueItems.queueId, queueId)).all()
      .map(mapEvalQueueItemRow)
      .filter((i) => (opts.includeDisabled === true || i.enabled) && i.deletedAt === null)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }

  listEvalQueuesUsingTask(projectId: string, taskId: string): EvalQueue[] {
    const rows = this.db
      .select()
      .from(evalQueueItems)
      .where(and(eq(evalQueueItems.projectId, projectId), eq(evalQueueItems.taskId, taskId)))
      .all()
      .map(mapEvalQueueItemRow)
      .filter((i) => i.deletedAt === null);
    const ids = [...new Set(rows.map((r) => r.queueId))];
    return ids
      .map((id) => this.getEvalQueue(id))
      .filter((q): q is EvalQueue => q !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  updateEvalQueueItem(id: string, patch: UpdateEvalQueueItemInput): EvalQueueItem {
    const existing = this.getEvalQueueItem(id);
    if (!existing) throw notFound("eval queue item", id);
    const items = this.listEvalQueueItems(existing.queueId, { includeDisabled: true });
    const values: Partial<typeof evalQueueItems.$inferInsert> = { updatedAt: nowIso() };
    if (patch.position !== undefined) values.position = patch.position;
    if (patch.before !== undefined) {
      const at = items.findIndex((i) => i.id === patch.before);
      if (at < 0) throw notFound("eval queue item", patch.before);
      values.position = ((items[at - 1]?.position ?? items[at]!.position - 1) + items[at]!.position) / 2;
    }
    if (patch.after !== undefined) {
      const at = items.findIndex((i) => i.id === patch.after);
      if (at < 0) throw notFound("eval queue item", patch.after);
      values.position = (items[at]!.position + (items[at + 1]?.position ?? items[at]!.position + 1)) / 2;
    }
    if (patch.repeats !== undefined) values.repeats = Math.max(1, patch.repeats);
    if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;
    if (patch.overrides !== undefined) values.overridesJson = stringifyJson(patch.overrides);
    this.db.update(evalQueueItems).set(values).where(eq(evalQueueItems.id, id)).run();
    this.updateEvalQueue(existing.queueId, { incrementRevision: true });
    return this.getEvalQueueItem(id)!;
  }

  deleteEvalQueueItem(id: string): void {
    const existing = this.getEvalQueueItem(id);
    if (!existing) throw notFound("eval queue item", id);
    // Soft delete: prevents future claims without breaking run provenance/FKs.
    this.db
      .update(evalQueueItems)
      .set({ deletedAt: nowIso(), enabled: 0, updatedAt: nowIso() })
      .where(eq(evalQueueItems.id, id))
      .run();
    this.updateEvalQueue(existing.queueId, { incrementRevision: true });
  }

  createQueueContainer(input: CreateQueueContainerInput): QueueContainer {
    const active = this.getActiveQueueContainer(input.queueId);
    if (active) throw new Error(`eval queue ${input.queueId} already has active container ${active.id}`);
    const id = input.id ?? newId();
    const ts = nowIso();
    try {
      this.db.insert(queueContainers).values({
        id, queueId: input.queueId, projectId: input.projectId, batchId: input.batchId,
        runtimeContainerId: input.runtimeContainerId ?? null, image: input.image,
        imageId: input.imageId ?? null, agentCommit: input.agentCommit ?? null,
        agentVersion: input.agentVersion ?? null, buildId: input.buildId ?? null,
        state: input.state, portsJson: stringifyJson(input.ports ?? []), workspaceDir: input.workspaceDir,
        startedAt: input.startedAt ?? null, stoppedAt: null, error: input.error ?? null,
        createdAt: ts, updatedAt: ts,
      }).run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|unique/i.test(message)) {
        throw Object.assign(
          new Error(`eval queue ${input.queueId} already has an active container`),
          { code: "ALREADY_ACTIVE" },
        );
      }
      throw err;
    }
    return this.getQueueContainer(id)!;
  }

  getQueueContainer(id: string): QueueContainer | null {
    const row = this.db.select().from(queueContainers).where(eq(queueContainers.id, id)).get();
    return row ? mapQueueContainerRow(row) : null;
  }

  getActiveQueueContainer(queueId: string): QueueContainer | null {
    return this.listQueueContainers(queueId).find((c) => isActiveContainerState(c)) ?? null;
  }

  listQueueContainers(queueId: string): QueueContainer[] {
    return this.db.select().from(queueContainers).where(eq(queueContainers.queueId, queueId)).all()
      .map(mapQueueContainerRow).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateQueueContainer(id: string, patch: UpdateQueueContainerInput): QueueContainer {
    if (!this.getQueueContainer(id)) throw notFound("queue container", id);
    const values: Partial<typeof queueContainers.$inferInsert> = { updatedAt: nowIso() };
    if (patch.runtimeContainerId !== undefined) values.runtimeContainerId = patch.runtimeContainerId;
    if (patch.state !== undefined) values.state = patch.state;
    if (patch.ports !== undefined) values.portsJson = stringifyJson(patch.ports);
    if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
    if (patch.stoppedAt !== undefined) values.stoppedAt = patch.stoppedAt;
    if (patch.error !== undefined) values.error = patch.error;
    this.db.update(queueContainers).set(values).where(eq(queueContainers.id, id)).run();
    return this.getQueueContainer(id)!;
  }

  recoverStaleQueueContainers(opts: {
    olderThanMs?: number;
    now?: string;
  } = {}): QueueContainer[] {
    const olderThanMs = opts.olderThanMs ?? 0;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const recovered: QueueContainer[] = [];
    for (const row of this.db.select().from(queueContainers).all().map(mapQueueContainerRow)) {
      if (!isActiveContainerState(row)) continue;
      const startedMs = Date.parse(row.startedAt ?? row.createdAt);
      if (!Number.isFinite(startedMs) || nowMs - startedMs < olderThanMs) continue;
      const updated = this.updateQueueContainer(row.id, {
        state: "failed",
        stoppedAt: opts.now ?? nowIso(),
        error: row.error ?? "recovered stale queue container after process restart",
      });
      // Close the generation batch so it cannot keep accepting claims.
      this.db
        .update(runBatches)
        .set({ accepting: 0, closedAt: opts.now ?? nowIso() })
        .where(eq(runBatches.id, row.batchId))
        .run();
      const queue = this.getEvalQueue(row.queueId);
      if (queue?.activeBatchId === row.batchId) {
        this.updateEvalQueue(row.queueId, { status: "failed", activeBatchId: null });
      }
      // Any still-queued runs under the orphaned generation become failed.
      for (const run of this.listRunsByBatch(row.batchId)) {
        if (run.status === "queued" || run.status === "running") {
          this.finalizeRun(run.id, {
            status: "failed",
            error: "queue generation recovered after process restart",
            controlState: "done",
          });
        }
      }
      recovered.push(updated);
    }
    return recovered;
  }

  beginQueueGeneration(input: {
    batch: CreateBatchInput;
    container: Omit<CreateQueueContainerInput, "batchId">;
  }): { batch: RunBatch; container: QueueContainer } {
    return this.transaction(() => {
      const active = this.getActiveQueueContainer(input.container.queueId);
      if (active) {
        throw Object.assign(
          new Error(`eval queue ${input.container.queueId} already has active container ${active.id}`),
          { code: "ALREADY_ACTIVE" },
        );
      }
      const batch = this.createBatch(input.batch);
      const container = this.createQueueContainer({
        ...input.container,
        batchId: batch.id,
      });
      this.updateEvalQueue(input.container.queueId, {
        status: "starting",
        activeBatchId: batch.id,
      });
      return { batch, container };
    });
  }

  listRunsByBatch(batchId: string): Run[] {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.batchId, batchId))
      .all()
      .map(mapRun);
  }

  claimQueueWork(input: ClaimQueueWorkInput): ClaimQueueWorkResult {
    return this.db.transaction(
      (tx) => this.claimQueueWorkInner(tx, input),
      { behavior: "immediate" },
    );
  }

  /** Inner claim logic bound to a transaction handle (BEGIN IMMEDIATE). */
  private claimQueueWorkInner(
    tx: BetterSQLite3Database<Schema>,
    input: ClaimQueueWorkInput,
  ): ClaimQueueWorkResult {
    // 1. Load the active generation and confirm it is still accepting.
    const batchRow = tx.select().from(runBatches).where(eq(runBatches.id, input.batchId)).get();
    if (!batchRow) throw notFound("run batch", input.batchId);
    if ((batchRow.accepting ?? 1) !== 1) {
      throw Object.assign(
        new Error(`queue generation ${input.batchId} is closed; start a new generation`),
        { code: "GENERATION_CLOSED" },
      );
    }

    // 2. Select enabled, non-deleted queue items in position, id order.
    const items = tx
      .select()
      .from(evalQueueItems)
      .where(eq(evalQueueItems.queueId, input.queueId))
      .all()
      .map(mapEvalQueueItemRow)
      .filter((i) => i.enabled && i.deletedAt === null)
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.id.localeCompare(b.id),
      );

    // 3. Compare each item's repeats with runs already claimed for the generation.
    const claimed = tx
      .select()
      .from(runs)
      .where(eq(runs.batchId, input.batchId))
      .all()
      .map(mapRun);
    const claimedPerItem = new Map<string, number>();
    for (const run of claimed) {
      if (!run.queueItemId) continue;
      claimedPerItem.set(run.queueItemId, (claimedPerItem.get(run.queueItemId) ?? 0) + 1);
    }

    let claim: { item: EvalQueueItem; repeatIndex: number; task: typeof tasks.$inferSelect } | null = null;
    for (const item of items) {
      // claimedRepeats is an immutable floor across generations. A new queue
      // container (new batchId) must NOT re-claim work already claimed in a
      // prior generation — that was re-running finished evals after API crashes
      // and pushing claimedRepeats above repeats (E2E observation).
      const claimedCount = Math.max(claimedPerItem.get(item.id) ?? 0, item.claimedRepeats);
      if (claimedCount >= item.repeats) continue;
      const taskForItem = tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, item.taskId))
        .get();
      // Soft-skip unavailable/archived evals instead of aborting the whole
      // generation. Soft-delete the queue item so it is not reselected forever.
      if (!taskForItem || taskForItem.archived === 1) {
        tx.update(evalQueueItems)
          .set({ deletedAt: nowIso(), enabled: 0, updatedAt: nowIso() })
          .where(eq(evalQueueItems.id, item.id))
          .run();
        continue;
      }
      claim = { item, repeatIndex: claimedCount, task: taskForItem };
      break;
    }

    // 5. If no work exists, atomically mark the generation closing.
    if (!claim) {
      const closedRevision = input.snapshot.queueRevision;
      tx.update(runBatches)
        .set({
          accepting: 0,
          closedRevision,
          closedAt: nowIso(),
        })
        .where(eq(runBatches.id, input.batchId))
        .run();
      return { claimed: false, closed: true, closedRevision };
    }

    // 4. Create exactly one queue-backed run with immutable eval/item snapshots.
    // The claim op does not know which item will be claimed until the atomic
    // selection above, so it resolves the eval + item snapshots for THAT item.
    const runId = newId();
    const { item, repeatIndex, task: taskForItem } = claim;
    const agentId = input.agentId ?? batchRow.agentId;
    const evalSnapshot =
      input.evalSnapshot !== undefined && input.taskId === item.taskId
        ? stringifyJson(input.evalSnapshot)
        : taskSnapshotFromRow(taskForItem);
    const evalVersion =
      input.evalVersion ?? taskForItem.version ?? 1;
    const itemSnapshot = stringifyJson(input.itemSnapshot ?? {
      id: item.id,
      queueId: item.queueId,
      taskId: item.taskId,
      position: item.position,
      repeats: item.repeats,
      enabled: item.enabled ? 1 : 0,
      overrides: item.overrides,
      claimedRepeats: item.claimedRepeats,
    });
    const run = mapRun(
      tx
        .insert(runs)
        .values({
          id: runId,
          batchId: input.batchId,
          taskId: item.taskId,
          projectId: input.projectId,
          queueId: input.queueId,
          queueItemId: item.id,
          queueContainerId: input.queueContainerId,
          agentId,
          model: input.snapshot.model,
          provider: input.snapshot.provider,
          repeatIndex,
          evalVersion,
          evalSnapshotJson: evalSnapshot,
          itemSnapshotJson: itemSnapshot,
          status: "queued",
          agentImage: input.snapshot.agentImage,
          agentCommit: input.snapshot.agentCommit,
          agentImageSource: "built",
          adapterOverridesJson: stringifyJson(input.snapshot.adapterOverrides),
          trigger: "eval-queue",
          triggerRef: input.queueId,
          controlState: "running",
        })
        .returning()
        .get(),
    );

    // Bump the item's immutable claimed-repeat floor.
    tx.update(evalQueueItems)
      .set({
        claimedRepeats: item.claimedRepeats + 1,
        updatedAt: nowIso(),
      })
      .where(eq(evalQueueItems.id, item.id))
      .run();

    writeSnapshot(runSnapshotPath(this.dataDir, run.projectId, run.id), run);
    return { claimed: true, run, queueItemId: item.id, repeatIndex };
  }

  upsertEvalMetrics(input: {
    runId: string;
    projectId: string;
    schemaVersion: number;
    execution: Record<string, unknown>;
    outcome?: Record<string, unknown> | null;
  }): EvalMetricsRecord {
    const existing = this.getEvalMetrics(input.runId);
    const ts = nowIso();
    this.db.insert(evalMetrics).values({
      runId: input.runId,
      projectId: input.projectId,
      schemaVersion: input.schemaVersion,
      executionJson: JSON.stringify(input.execution),
      outcomeJson: stringifyJson(input.outcome ?? existing?.outcome ?? null),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    }).onConflictDoUpdate({
      target: evalMetrics.runId,
      set: {
        schemaVersion: input.schemaVersion,
        executionJson: JSON.stringify(input.execution),
        outcomeJson: stringifyJson(input.outcome ?? existing?.outcome ?? null),
        updatedAt: ts,
      },
    }).run();
    return this.getEvalMetrics(input.runId)!;
  }

  getEvalMetrics(runId: string): EvalMetricsRecord | null {
    const row = this.db.select().from(evalMetrics).where(eq(evalMetrics.runId, runId)).get();
    return row ? mapEvalMetricsRow(row) : null;
  }

  storeEvalArchive(input: StoreEvalArchiveInput): EvalArchive {
    const sealedAt = input.sealedAt ?? nowIso();
    this.db.insert(evalArchives).values({
      runId: input.runId, projectId: input.projectId, queueId: input.queueId ?? null,
      batchId: input.batchId, manifestPath: input.manifestPath,
      manifestKey: input.manifestKey ?? null,
      manifestSha256: input.manifestSha256, sizeBytes: input.sizeBytes, sealedAt,
      archivedAt: input.archivedAt ?? sealedAt,
    }).onConflictDoUpdate({
      target: evalArchives.runId,
      set: { manifestPath: input.manifestPath, manifestKey: input.manifestKey ?? null,
        manifestSha256: input.manifestSha256, sizeBytes: input.sizeBytes, sealedAt,
        archivedAt: input.archivedAt ?? sealedAt },
    }).run();
    return this.getEvalArchive(input.runId)!;
  }

  getEvalArchive(runId: string): EvalArchive | null {
    const row = this.db.select().from(evalArchives).where(eq(evalArchives.runId, runId)).get();
    return row ? mapEvalArchiveRow(row) : null;
  }

  listEvalArchives(filter: { projectId?: string; queueId?: string; batchId?: string }): EvalArchive[] {
    return this.db.select().from(evalArchives).all().map(mapEvalArchiveRow)
      .filter((a) => (!filter.projectId || a.projectId === filter.projectId) &&
        (!filter.queueId || a.queueId === filter.queueId) &&
        (!filter.batchId || a.batchId === filter.batchId))
      .sort((a, b) => b.sealedAt.localeCompare(a.sealedAt));
  }

  // ---- API tokens (P8b-auth) ----

  createApiToken(input: CreateApiTokenInput = {}): CreatedApiToken {
    const id = newId();
    const ts = nowIso();
    const { token, tokenHash } = mintApiTokenPair();
    const readOnly = input.readOnly === true ? 1 : 0;
    this.db
      .insert(apiTokens)
      .values({
        id,
        userId: input.userId ?? null,
        projectId: input.projectId ?? null,
        tokenHash,
        label: input.label ?? null,
        readOnly,
        createdAt: ts,
        revokedAt: null,
      })
      .run();
    const row = this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .get();
    if (!row) throw new Error("failed to create api token");
    return { ...mapApiTokenRow(row), token };
  }

  getApiToken(tokenHash: string): ApiToken | null {
    const row = this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .get();
    return row ? mapApiTokenRow(row) : null;
  }

  revokeApiToken(tokenHash: string): void {
    const existing = this.getApiToken(tokenHash);
    if (!existing) return;
    if (existing.revokedAt) return;
    this.db
      .update(apiTokens)
      .set({ revokedAt: nowIso() })
      .where(eq(apiTokens.tokenHash, tokenHash))
      .run();
  }

  listApiTokens(opts: ListApiTokensOpts = {}): ApiToken[] {
    let rows = this.db.select().from(apiTokens).all().map(mapApiTokenRow);
    if (opts.projectId !== undefined) {
      rows = rows.filter((t) => t.projectId === opts.projectId);
    }
    if (opts.userId !== undefined) {
      rows = rows.filter((t) => t.userId === opts.userId);
    }
    if (!opts.includeRevoked) {
      rows = rows.filter((t) => t.revokedAt == null);
    }
    // Newest first.
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.id.localeCompare(a.id);
    });
    return rows;
  }

  // ---- Users (P9-settings) ----

  createUser(input: CreateUserInput): User {
    const id = input.id ?? newId();
    const ts = nowIso();
    const count = this.countUsers();
    const role =
      input.role ?? (count === 0 ? "admin" : "user");
    this.db
      .insert(users)
      .values({
        id,
        username: input.username,
        passwordHash: input.passwordHash,
        role: String(role),
        createdAt: ts,
        email: input.email ?? null,
      })
      .run();
    const row = this.getUser(id);
    if (!row) throw new Error("failed to create user");
    return row;
  }

  getUser(id: string): User | null {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    return row ? mapUserRow(row) : null;
  }

  getUserByUsername(username: string): User | null {
    const row = this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
    return row ? mapUserRow(row) : null;
  }

  listUsers(): User[] {
    const rows = this.db.select().from(users).all().map(mapUserRow);
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      return a.username.localeCompare(b.username);
    });
    return rows;
  }

  deleteUser(id: string): void {
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  countUsers(): number {
    return this.db.select().from(users).all().length;
  }

  addProjectMember(projectId: string, userId: string): void {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    if (!this.getUser(userId)) throw notFound("user", userId);
    if (this.isProjectMember(projectId, userId)) return;
    this.db.insert(projectMembers).values({
      projectId,
      userId,
      createdAt: nowIso(),
    }).run();
  }

  removeProjectMember(projectId: string, userId: string): void {
    this.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .run();
  }

  listProjectMembers(projectId: string): string[] {
    return this.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .all()
      .map((row) => row.userId)
      .sort();
  }

  listUserProjectIds(userId: string): string[] {
    return this.db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId))
      .all()
      .map((row) => row.projectId)
      .sort();
  }

  isProjectMember(projectId: string, userId: string): boolean {
    return (
      this.db
        .select()
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
        .get() !== undefined
    );
  }

  // ---- Settings (P9) ----

  getSetting(key: string): unknown | null {
    const row = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    if (!row) return null;
    return parseJson(row.value, null);
  }

  setSetting(key: string, value: unknown): void {
    const ts = nowIso();
    const encoded = JSON.stringify(value ?? null);
    const existing = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    if (existing) {
      this.db
        .update(settings)
        .set({ value: encoded, updatedAt: ts })
        .where(eq(settings.key, key))
        .run();
    } else {
      this.db
        .insert(settings)
        .values({ key, value: encoded, updatedAt: ts })
        .run();
    }
  }

  listSettings(): SettingRow[] {
    return this.db
      .select()
      .from(settings)
      .all()
      .map((row) => ({
        key: row.key,
        value: parseJson(row.value, null),
        updatedAt: row.updatedAt,
      }));
  }

  deleteSetting(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  // ---- Project export (P9) ----

  exportRows(projectId: string): ProjectExportRows {
    const project = this.getProject(projectId);
    if (!project) throw notFound("project", projectId);
    const taskList = this.listTasks(projectId, { includeArchived: true });
    const runList = this.listRuns({ projectId });
    // Secrets stripped on list.
    const watchers = this.listWatcherRules(projectId, { includeDisabled: true });
    return {
      project,
      tasks: taskList,
      runs: runList,
      watchers,
    };
  }


  storeCheckResults(runId: string, results: CheckResult[]): void {
    // Upsert: replace any existing row for this run (one row per run).
    const ts = nowIso();
    this.db
      .delete(checkResults)
      .where(eq(checkResults.runId, runId))
      .run();
    this.db
      .insert(checkResults)
      .values({
        runId,
        resultsJson: JSON.stringify(results),
        recordedAt: ts,
      })
      .run();
  }

  getCheckResults(runId: string): CheckResult[] {
    const row = this.db
      .select()
      .from(checkResults)
      .where(eq(checkResults.runId, runId))
      .get();
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.resultsJson) as unknown;
      return Array.isArray(parsed)
        ? (parsed.filter(
            (r) =>
              r &&
              typeof r === "object" &&
              typeof (r as CheckResult).checkId === "string" &&
              typeof (r as CheckResult).status === "string",
          ) as CheckResult[])
        : [];
    } catch {
      return [];
    }
  }


}

// ---------------------------------------------------------------------------
// MemoryQueries — in-memory fallback (same QueryStore interface)
// ---------------------------------------------------------------------------

export class MemoryQueries implements QueryStore {
  private projects = new Map<string, Project>();
  private tasks = new Map<string, Task>();
  private agents = new Map<string, Agent>();
  private projectAgentAdapters = new Map<string, ProjectAgentAdapter>();
  private adapterBuilds = new Map<string, AdapterBuild>();
  private batches = new Map<string, RunBatch>();
  private runs = new Map<string, Run>();
  private watcherRules = new Map<string, WatcherRule>();
  private watcherEvents = new Map<string, WatcherEvent>();
  private evalQueues = new Map<string, EvalQueue>();
  private evalQueueItems = new Map<string, EvalQueueItem>();
  private queueContainers = new Map<string, QueueContainer>();
  private evalMetrics = new Map<string, EvalMetricsRecord>();
  private evalArchives = new Map<string, EvalArchive>();
  private apiTokens = new Map<string, ApiToken>();
  private users = new Map<string, User>();
  /** Keyed by `${projectId}\0${userId}`. */
  private projectMembers = new Map<string, { projectId: string; userId: string; createdAt: string }>();
  private settings = new Map<string, SettingRow>();
  private checkResultsByRun = new Map<string, CheckResult[]>();

  constructor(private readonly dataDir: string) {
    // Built-in agents must exist for builtin_adapter_id queues (same invariant as
    // SqliteQueries seedBuiltinAgents). In-memory store seeds them eagerly.
    for (const agent of [
      { id: "reapercode", displayName: "ReaperCode", defaultModel: "deepseek-v4-flash", defaultProvider: "nuralwatt" },
      { id: "pi", displayName: "pi coding agent", defaultModel: "deepseek-v4-flash", defaultProvider: "nuralwatt" },
    ]) {
      this.agents.set(agent.id, agent);
    }
  }

  transaction<T>(operation: () => T): T {
    return operation();
  }

  createProject(input: CreateProjectInput): Project {
    const ts = nowIso();
    const p: Project = {
      id: input.id ?? newId(),
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      taskSource: input.taskSource ?? { kind: "ui-builder" },
      defaultAgentId: input.defaultAgentId ?? null,
      defaultModel: input.defaultModel ?? null,
      defaultProvider: input.defaultProvider ?? null,
      workspaceImage: input.workspaceImage ?? null,
      checkRunners: input.checkRunners ?? null,
      adapterOverrides: input.adapterOverrides ?? null,
      networkPolicy: input.networkPolicy ?? "allow",
      retentionRuns: input.retentionRuns ?? null,
      sandbox: input.sandbox ?? null,
      modelConfig: input.modelConfig ?? null,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.projects.set(p.id, p);
    return { ...p };
  }

  getProject(id: string): Project | null {
    const p = this.projects.get(id);
    return p ? { ...p } : null;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    return [...this.projects.values()]
      .filter((p) => opts.includeArchived || !p.archived)
      .map((p) => ({ ...p }));
  }

  updateProject(id: string, patch: UpdateProjectInput): Project {
    const existing = this.projects.get(id);
    if (!existing) throw notFound("project", id);
    const next: Project = {
      ...existing,
      name: patch.name ?? existing.name,
      description:
        patch.description !== undefined
          ? patch.description
          : existing.description,
      taskSource: patch.taskSource ?? existing.taskSource,
      defaultAgentId:
        patch.defaultAgentId !== undefined
          ? patch.defaultAgentId
          : existing.defaultAgentId,
      defaultModel:
        patch.defaultModel !== undefined
          ? patch.defaultModel
          : existing.defaultModel,
      defaultProvider:
        patch.defaultProvider !== undefined
          ? patch.defaultProvider
          : existing.defaultProvider,
      workspaceImage:
        patch.workspaceImage !== undefined
          ? patch.workspaceImage
          : existing.workspaceImage,
      checkRunners:
        patch.checkRunners !== undefined
          ? patch.checkRunners
          : existing.checkRunners,
      adapterOverrides:
        patch.adapterOverrides !== undefined
          ? patch.adapterOverrides
          : existing.adapterOverrides,
      networkPolicy: patch.networkPolicy ?? existing.networkPolicy,
      retentionRuns:
        patch.retentionRuns !== undefined
          ? patch.retentionRuns
          : existing.retentionRuns,
      sandbox: patch.sandbox !== undefined ? patch.sandbox : existing.sandbox,
      modelConfig:
        patch.modelConfig !== undefined ? patch.modelConfig : existing.modelConfig,
      updatedAt: nowIso(),
    };
    this.projects.set(id, next);
    return { ...next };
  }

  archiveProject(id: string): Project {
    const existing = this.projects.get(id);
    if (!existing) throw notFound("project", id);
    const next = { ...existing, archived: true, updatedAt: nowIso() };
    this.projects.set(id, next);
    return { ...next };
  }

  createTask(
    projectId: string,
    spec: TaskSpec,
    opts: CreateTaskOptions = {},
  ): Task {
    if (!this.projects.has(projectId)) throw notFound("project", projectId);
    const ts = nowIso();
    const task: Task = {
      id: opts.id ?? newId(),
      projectId,
      externalId: spec.id ?? null,
      name: spec.name,
      prompt: spec.prompt,
      workspace: spec.workspace,
      rubric: spec.rubric,
      version: 1,
      rubricVersion: spec.rubric.version ?? 1,
      agentCategory: spec.agentCategory ?? "coding",
      categoryName: spec.categoryName?.trim() || null,
      profile: spec.profile ?? spec.rubric.profile ?? null,
      referenceSolution: spec.referenceSolution ?? null,
      checks: (spec.checks ?? spec.rubric.checks ?? null) as unknown[] | null,
      env: (spec.env ?? null) as Record<string, unknown> | null,
      tags: spec.tags ?? null,
      sourceKind: opts.sourceKind ?? null,
      packagePath: opts.packagePath ?? null,
      packageDigest: opts.packageDigest ?? null,
      packageManifest: opts.packageManifest ? structuredClone(opts.packageManifest) : null,
      packageValidation: opts.packageValidation ? structuredClone(opts.packageValidation) : null,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.tasks.set(task.id, task);
    writeSnapshot(
      taskSnapshotPath(this.dataDir, projectId, task.id),
      task,
    );
    return { ...task };
  }

  getTask(id: string): Task | null {
    const t = this.tasks.get(id);
    return t ? { ...t } : null;
  }

  listTasks(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): Task[] {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          t.projectId === projectId && (opts.includeArchived || !t.archived),
      )
      .map((t) => ({ ...t }));
  }

  updateTask(id: string, patch: UpdateTaskInput): Task {
    const existing = this.tasks.get(id);
    if (!existing) throw notFound("task", id);

    let rubric = existing.rubric;
    let rubricVersion = existing.rubricVersion;
    if (patch.rubric !== undefined) {
      const strip = (r: Rubric) => {
        const { version: _v, ...rest } = r;
        return JSON.stringify(rest);
      };
      if (strip(patch.rubric) !== strip(existing.rubric)) {
        rubricVersion = existing.rubricVersion + 1;
        rubric = { ...patch.rubric, version: rubricVersion };
      }
    }

    const next: Task = {
      ...existing,
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      workspace: patch.workspace ?? existing.workspace,
      rubric,
      version: existing.version + 1,
      rubricVersion,
      agentCategory: patch.agentCategory ?? existing.agentCategory,
      categoryName:
        patch.categoryName !== undefined
          ? patch.categoryName?.trim() || null
          : existing.categoryName,
      profile: patch.profile !== undefined ? patch.profile : existing.profile,
      referenceSolution:
        patch.referenceSolution !== undefined
          ? patch.referenceSolution
          : existing.referenceSolution,
      checks: patch.checks !== undefined ? patch.checks : existing.checks,
      env: patch.env !== undefined ? patch.env : existing.env,
      tags: patch.tags !== undefined ? patch.tags : existing.tags,
      externalId:
        patch.externalId !== undefined
          ? patch.externalId
          : existing.externalId,
      sourceKind:
        patch.sourceKind !== undefined
          ? patch.sourceKind
          : existing.sourceKind,
      updatedAt: nowIso(),
    };
    this.tasks.set(id, next);
    writeSnapshot(
      taskSnapshotPath(this.dataDir, next.projectId, next.id),
      next,
    );
    return { ...next };
  }

  archiveTask(id: string): Task {
    const existing = this.tasks.get(id);
    if (!existing) throw notFound("task", id);
    const next = {
      ...existing,
      archived: true,
      version: existing.version + 1,
      updatedAt: nowIso(),
    };
    this.tasks.set(id, next);
    return { ...next };
  }

  registerAgent(input: RegisterAgentInput): Agent {
    const existing = this.agents.get(input.id);
    const agent: Agent = {
      id: input.id,
      displayName: input.displayName,
      defaultModel:
        input.defaultModel ?? existing?.defaultModel ?? null,
      defaultProvider:
        input.defaultProvider ?? existing?.defaultProvider ?? null,
    };
    this.agents.set(input.id, agent);
    return { ...agent };
  }

  getAgent(id: string): Agent | null {
    const a = this.agents.get(id);
    return a ? { ...a } : null;
  }

  listAgents(): Agent[] {
    return [...this.agents.values()].map((a) => ({ ...a }));
  }

  createProjectAgentAdapter(
    projectId: string,
    input: CreateProjectAgentAdapterInput,
  ): ProjectAgentAdapter {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    if (this.listProjectAgentAdapters(projectId, { includeDisabled: true }).length > 0) {
      throw new Error(`project ${projectId} already has an agent adapter`);
    }
    this.registerAgent({
      id: input.agentId,
      displayName: input.name,
      ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
      ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
    });
    const ts = nowIso();
    const adapter: ProjectAgentAdapter = {
      id: input.id ?? newId(),
      projectId,
      agentId: input.agentId,
      name: input.name,
      description: input.description ?? null,
      formatVersion: input.formatVersion ?? 1,
      image: input.image,
      command: structuredClone(input.command),
      connectionCheck: structuredClone(input.connectionCheck),
      connectionCheckDerived: input.connectionCheckDerived === true,
      evidence: structuredClone(input.evidence),
      parserKind: input.parserKind,
      parserConfig: input.parserConfig ? structuredClone(input.parserConfig) : null,
      providerConfig: input.providerConfig ? structuredClone(input.providerConfig) : null,
      sourceRepo: input.sourceRepo ?? null,
      sourceRef: input.sourceRef ?? null,
      containerfile: input.containerfile ?? null,
      generatorScript: input.generatorScript ?? null,
      installType: input.installType ?? "source-build",
      configure: input.configure ? structuredClone(input.configure) : null,
      shared: input.shared === true,
      buildStatus: "unbuilt",
      builtImageId: null,
      builtCommit: null,
      buildLogPath: null,
      lastBuiltAt: null,
      enabled: input.enabled !== false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.projectAgentAdapters.set(adapter.id, adapter);
    return structuredClone(adapter);
  }

  getProjectAgentAdapter(id: string): ProjectAgentAdapter | null {
    const adapter = this.projectAgentAdapters.get(id);
    return adapter ? structuredClone(adapter) : null;
  }

  getProjectAgentAdapterByAgentId(
    projectId: string,
    agentId: string,
  ): ProjectAgentAdapter | null {
    const adapter = [...this.projectAgentAdapters.values()].find(
      (entry) => entry.projectId === projectId && entry.agentId === agentId,
    );
    return adapter ? structuredClone(adapter) : null;
  }

  listSharedAdapters(): ProjectAgentAdapter[] {
    return [...this.projectAgentAdapters.values()]
      .filter((a) => a.shared && a.enabled)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => structuredClone(a));
  }

  listProjectAgentAdapters(
    projectId: string,
    opts: { includeDisabled?: boolean } = {},
  ): ProjectAgentAdapter[] {
    return [...this.projectAgentAdapters.values()]
      .filter(
        (adapter) =>
          adapter.projectId === projectId &&
          (opts.includeDisabled === true || adapter.enabled),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((adapter) => structuredClone(adapter));
  }

  findReadyAdapterForSourceCommit(
    sourceRepo: string,
    commit: string,
  ): ProjectAgentAdapter | null {
    const rows = [...this.projectAgentAdapters.values()]
      .filter(
        (adapter) =>
          adapter.sourceRepo === sourceRepo &&
          adapter.builtCommit === commit &&
          adapter.buildStatus === "ready" &&
          adapter.builtImageId !== null,
      )
      .sort((a, b) =>
        (b.lastBuiltAt ?? b.createdAt).localeCompare(
          a.lastBuiltAt ?? a.createdAt,
        ),
      )
      .map((adapter) => structuredClone(adapter));
    return rows[0] ?? null;
  }

  updateProjectAgentAdapter(
    id: string,
    patch: UpdateProjectAgentAdapterInput,
  ): ProjectAgentAdapter {
    const existing = this.projectAgentAdapters.get(id);
    if (!existing) throw notFound("project agent adapter", id);
    const next: ProjectAgentAdapter = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.formatVersion !== undefined ? { formatVersion: patch.formatVersion } : {}),
      ...(patch.image !== undefined ? { image: patch.image } : {}),
      ...(patch.command !== undefined ? { command: structuredClone(patch.command) } : {}),
      ...(patch.connectionCheck !== undefined
        ? { connectionCheck: structuredClone(patch.connectionCheck) }
        : {}),
      ...(patch.connectionCheckDerived !== undefined
        ? { connectionCheckDerived: patch.connectionCheckDerived }
        : {}),
      ...(patch.evidence !== undefined ? { evidence: structuredClone(patch.evidence) } : {}),
      ...(patch.parserKind !== undefined ? { parserKind: patch.parserKind } : {}),
      ...(patch.parserConfig !== undefined
        ? { parserConfig: patch.parserConfig ? structuredClone(patch.parserConfig) : null }
        : {}),
      ...(patch.providerConfig !== undefined
        ? { providerConfig: patch.providerConfig ? structuredClone(patch.providerConfig) : null }
        : {}),
      ...(patch.sourceRepo !== undefined ? { sourceRepo: patch.sourceRepo } : {}),
      ...(patch.sourceRef !== undefined ? { sourceRef: patch.sourceRef } : {}),
      ...(patch.containerfile !== undefined ? { containerfile: patch.containerfile } : {}),
      ...(patch.generatorScript !== undefined ? { generatorScript: patch.generatorScript } : {}),
      ...(patch.installType !== undefined ? { installType: patch.installType } : {}),
      ...(patch.configure !== undefined
        ? { configure: patch.configure ? structuredClone(patch.configure) : null }
        : {}),
      ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
      ...(patch.buildStatus !== undefined ? { buildStatus: patch.buildStatus } : {}),
      ...(patch.builtImageId !== undefined ? { builtImageId: patch.builtImageId } : {}),
      ...(patch.builtCommit !== undefined ? { builtCommit: patch.builtCommit } : {}),
      ...(patch.buildLogPath !== undefined ? { buildLogPath: patch.buildLogPath } : {}),
      ...(patch.lastBuiltAt !== undefined ? { lastBuiltAt: patch.lastBuiltAt } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: nowIso(),
    };
    this.projectAgentAdapters.set(id, next);
    if (patch.name !== undefined || patch.defaultModel || patch.defaultProvider) {
      this.registerAgent({
        id: existing.agentId,
        displayName: patch.name ?? existing.name,
        ...(patch.defaultModel ? { defaultModel: patch.defaultModel } : {}),
        ...(patch.defaultProvider ? { defaultProvider: patch.defaultProvider } : {}),
      });
    }
    return structuredClone(next);
  }

  deleteProjectAgentAdapter(id: string): void {
    if (!this.projectAgentAdapters.delete(id)) throw notFound("project agent adapter", id);
  }

  // ---- adapter builds (commit-addressed, SCHEMA v9) ----

  upsertAdapterBuild(input: CreateAdapterBuildInput): AdapterBuild {
    const id = input.id ?? `${input.adapterId}:${input.commitSha}`;
    const existing = this.adapterBuilds.get(id);
    const ts = nowIso();
    const build: AdapterBuild = existing
      ? {
          ...existing,
          status: input.status ?? existing.status,
          image: input.image !== undefined ? input.image : existing.image,
          imageId: input.imageId !== undefined ? input.imageId : existing.imageId,
          agentVersion:
            input.agentVersion !== undefined
              ? input.agentVersion
              : existing.agentVersion,
          logPath: input.logPath !== undefined ? input.logPath : existing.logPath,
          completedAt:
            input.status === "ready" || input.status === "failed"
              ? nowIso()
              : existing.completedAt,
          updatedAt: ts,
        }
      : {
          id,
          adapterId: input.adapterId,
          commitSha: input.commitSha,
          status: input.status ?? "building",
          image: input.image ?? null,
          imageId: input.imageId ?? null,
          agentVersion: input.agentVersion ?? null,
          logPath: input.logPath ?? null,
          error: null,
          createdAt: ts,
          updatedAt: ts,
          completedAt: null,
        };
    this.adapterBuilds.set(id, build);
    return structuredClone(build);
  }

  getAdapterBuild(id: string): AdapterBuild | null {
    const b = this.adapterBuilds.get(id);
    return b ? structuredClone(b) : null;
  }

  getReadyAdapterBuild(adapterId: string, commitSha: string): AdapterBuild | null {
    const matches = [...this.adapterBuilds.values()].filter(
      (b) =>
        b.adapterId === adapterId &&
        b.commitSha === commitSha &&
        b.status === "ready",
    );
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  listAdapterBuilds(
    adapterId: string,
    opts: { status?: AdapterBuildStatus | string; limit?: number } = {},
  ): AdapterBuild[] {
    let list = [...this.adapterBuilds.values()].filter(
      (b) => b.adapterId === adapterId,
    );
    if (opts.status) list = list.filter((b) => b.status === opts.status);
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (opts.limit !== undefined) list = list.slice(0, opts.limit);
    return list.map((b) => structuredClone(b));
  }

  updateAdapterBuild(id: string, patch: UpdateAdapterBuildInput): AdapterBuild {
    const existing = this.adapterBuilds.get(id);
    if (!existing) throw notFound("adapter build", id);
    const next: AdapterBuild = {
      ...existing,
      status: patch.status ?? existing.status,
      image: patch.image !== undefined ? patch.image : existing.image,
      imageId: patch.imageId !== undefined ? patch.imageId : existing.imageId,
      agentVersion:
        patch.agentVersion !== undefined
          ? patch.agentVersion
          : existing.agentVersion,
      logPath: patch.logPath !== undefined ? patch.logPath : existing.logPath,
      error: patch.error !== undefined ? patch.error : existing.error,
      completedAt:
        patch.completedAt !== undefined
          ? patch.completedAt
          : patch.status === "ready" || patch.status === "failed"
            ? nowIso()
            : existing.completedAt,
      updatedAt: nowIso(),
    };
    this.adapterBuilds.set(id, next);
    return structuredClone(next);
  }

  createBatch(input: CreateBatchInput): RunBatch {
    const batch: RunBatch = {
      id: input.id ?? newId(),
      taskId: input.taskId ?? null,
      projectId: input.projectId,
      agentId: input.agentId,
      model: input.model,
      provider: input.provider,
      params: input.params ?? {},
      repeats: input.repeats,
      trigger: input.trigger ?? null,
      triggerRef: input.triggerRef ?? null,
      agentImage: input.agentImage ?? null,
      agentCommit: input.agentCommit ?? null,
      agentImageId: input.agentImageId ?? null,
      agentVersion: input.agentVersion ?? null,
      buildId: input.buildId ?? null,
      queueId: input.queueId ?? null,
      queueRevision: input.queueRevision ?? null,
      createdAt: nowIso(),
      accepting: true,
      closedRevision: null,
      closedAt: null,
    };
    this.batches.set(batch.id, batch);
    return { ...batch };
  }

  createRun(input: CreateRunInput): Run {
    const run: Run = {
      id: input.id ?? newId(),
      batchId: input.batchId,
      taskId: input.taskId,
      projectId: input.projectId,
      queueId: input.queueId ?? null,
      queueItemId: input.queueItemId ?? null,
      queueContainerId: input.queueContainerId ?? null,
      agentId: input.agentId,
      model: input.model,
      provider: input.provider,
      repeatIndex: input.repeatIndex,
      evalVersion: input.evalVersion ?? null,
      evalSnapshot: input.evalSnapshot ?? null,
      itemSnapshot: input.itemSnapshot ?? null,
      status: input.status ?? "queued",
      workspaceCommit: input.workspaceCommit ?? null,
      agentImage: input.agentImage ?? null,
      agentCommit: input.agentCommit ?? null,
      agentImageSource: input.agentImageSource ?? null,
      adapterOverrides: input.adapterOverrides ?? null,
      workspaceRepo: input.workspaceRepo ?? null,
      workspaceRef: input.workspaceRef ?? null,
      trigger: input.trigger ?? null,
      triggerRef: input.triggerRef ?? null,
      triggerRuleId: input.triggerRuleId ?? null,
      controlState: input.controlState ?? null,
      pausedAt: null,
      resumedAt: null,
      pauseCount: 0,
      startedAt: input.startedAt ?? null,
      endedAt: null,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalCost: null,
      eventsPath: null,
      diffPath: null,
      error: null,
    };
    this.runs.set(run.id, run);
    writeSnapshot(runSnapshotPath(this.dataDir, run.projectId, run.id), run);
    return { ...run };
  }

  getRun(id: string): Run | null {
    const r = this.runs.get(id);
    return r ? { ...r } : null;
  }

  listRuns(filter: ListRunsFilter): Run[] {
    return [...this.runs.values()]
      .filter((r) => {
        if (filter.projectId && r.projectId !== filter.projectId) return false;
        if (filter.batchId && r.batchId !== filter.batchId) return false;
        if (filter.taskId && r.taskId !== filter.taskId) return false;
        return true;
      })
      .map((r) => ({ ...r }));
  }

  updateRunControlState(id: string, update: ControlStateUpdate): Run {
    const existing = this.runs.get(id);
    if (!existing) throw notFound("run", id);
    const next: Run = {
      ...existing,
      controlState: update.controlState,
      pausedAt:
        update.pausedAt !== undefined ? update.pausedAt : existing.pausedAt,
      resumedAt:
        update.resumedAt !== undefined
          ? update.resumedAt
          : existing.resumedAt,
      pauseCount: update.incrementPauseCount
        ? existing.pauseCount + 1
        : existing.pauseCount,
      status: update.status ?? existing.status,
    };
    this.runs.set(id, next);
    writeSnapshot(runSnapshotPath(this.dataDir, next.projectId, next.id), next);
    return { ...next };
  }

  updateRunStatus(id: string, status: RunStatus | string): Run {
    const existing = this.runs.get(id);
    if (!existing) throw notFound("run", id);
    const next = { ...existing, status };
    this.runs.set(id, next);
    return { ...next };
  }

  setRunEventsPath(id: string, eventsPath: string): Run {
    const existing = this.runs.get(id);
    if (!existing) throw notFound("run", id);
    const next = { ...existing, eventsPath };
    this.runs.set(id, next);
    writeSnapshot(runSnapshotPath(this.dataDir, next.projectId, next.id), next);
    return { ...next };
  }

  finalizeRun(id: string, result: FinalizeRunInput): Run {
    const existing = this.runs.get(id);
    if (!existing) throw notFound("run", id);
    const next: Run = {
      ...existing,
      status: result.status,
      endedAt: result.endedAt ?? nowIso(),
      durationMs:
        result.durationMs !== undefined
          ? result.durationMs
          : existing.durationMs,
      inputTokens:
        result.inputTokens !== undefined
          ? result.inputTokens
          : existing.inputTokens,
      outputTokens:
        result.outputTokens !== undefined
          ? result.outputTokens
          : existing.outputTokens,
      reasoningTokens:
        result.reasoningTokens !== undefined
          ? result.reasoningTokens
          : existing.reasoningTokens,
      totalCost:
        result.totalCost !== undefined
          ? result.totalCost
          : existing.totalCost,
      eventsPath:
        result.eventsPath !== undefined
          ? result.eventsPath
          : existing.eventsPath,
      diffPath:
        result.diffPath !== undefined ? result.diffPath : existing.diffPath,
      error: result.error !== undefined ? result.error : existing.error,
      controlState: result.controlState ?? "done",
    };
    this.runs.set(id, next);
    writeSnapshot(runSnapshotPath(this.dataDir, next.projectId, next.id), next);
    return { ...next };
  }

  // ---- watcher rules + events (P8a) ----

  createWatcherRule(
    projectId: string,
    input: CreateWatcherRuleInput,
  ): WatcherRule {
    if (!this.projects.has(projectId)) throw notFound("project", projectId);
    const ts = nowIso();
    const secret =
      input.webhookSecret !== undefined && input.webhookSecret !== ""
        ? input.webhookSecret
        : `${newId()}-${newId()}`;
    const rule: WatcherRule = {
      id: newId(),
      projectId,
      queueId: input.queueId ?? null,
      role: "agent",
      repo: input.repo,
      trigger: input.trigger,
      ref: input.ref ?? null,
      semverFilter: input.semverFilter ?? null,
      webhookSecret: secret,
      enabled: input.enabled === false ? false : true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.watcherRules.set(rule.id, rule);
    // Return WITH secret present — only create surfaces it.
    return { ...rule };
  }

  getWatcherRule(id: string): WatcherRule | null {
    const r = this.watcherRules.get(id);
    return r ? stripWebhookSecret({ ...r }) : null;
  }

  /**
   * Raw webhook secret for HMAC verify. NEVER log the return value.
   */
  getRawWatcherSecret(ruleId: string): string | null {
    const r = this.watcherRules.get(ruleId);
    if (!r) return null;
    if (r.webhookSecret == null || r.webhookSecret === "") return null;
    return r.webhookSecret;
  }

  listWatcherRules(
    projectId: string,
    opts: { includeDisabled?: boolean } = {},
  ): WatcherRule[] {
    return [...this.watcherRules.values()]
      .filter(
        (r) =>
          r.projectId === projectId && (opts.includeDisabled || r.enabled),
      )
      .map((r) => stripWebhookSecret({ ...r }));
  }

  updateWatcherRule(
    id: string,
    patch: UpdateWatcherRulePatch,
  ): WatcherRule {
    const existing = this.watcherRules.get(id);
    if (!existing) throw notFound("watcher rule", id);
    const next: WatcherRule = {
      ...existing,
      ref: patch.ref !== undefined ? patch.ref : existing.ref,
      semverFilter:
        patch.semverFilter !== undefined
          ? patch.semverFilter
          : existing.semverFilter,
      enabled:
        patch.enabled !== undefined ? patch.enabled : existing.enabled,
      repo: patch.repo !== undefined ? patch.repo : existing.repo,
      queueId: patch.queueId !== undefined ? patch.queueId : existing.queueId,
      updatedAt: nowIso(),
      // Secret is never touchable via update.
      webhookSecret: existing.webhookSecret,
    };
    this.watcherRules.set(id, next);
    return stripWebhookSecret({ ...next });
  }

  deleteWatcherRule(id: string): void {
    this.watcherRules.delete(id);
  }

  recordWatcherEvent(input: RecordWatcherEventInput): WatcherEvent {
    const event: WatcherEvent = {
      id: newId(),
      ruleId: input.ruleId,
      projectId: input.projectId,
      receivedAt: nowIso(),
      trigger: input.trigger,
      ref: input.ref ?? null,
      resolvedSha: input.resolvedSha ?? null,
      status: input.status,
      batchId: input.batchId ?? null,
      queueId: input.queueId ?? null,
      fifoSeq: input.fifoSeq ?? null,
      processedSha: input.processedSha ?? null,
      error: input.error ?? null,
    };
    this.watcherEvents.set(event.id, event);
    return { ...event };
  }

  enqueueWatcherPendingEvent(input: {
    ruleId: string;
    projectId: string;
    queueId: string;
    trigger: string;
    ref?: string | null;
    resolvedSha: string;
  }): { status: "pending" | "deduped"; event: WatcherEvent } {
    return this.transaction(() => {
      const active = [...this.watcherEvents.values()].find(
        (e) =>
          e.ruleId === input.ruleId &&
          e.resolvedSha === input.resolvedSha &&
          ["pending", "launching", "launched"].includes(e.status),
      );
      if (active) {
        return {
          status: "deduped",
          event: this.recordWatcherEvent({
            ruleId: input.ruleId,
            projectId: input.projectId,
            queueId: input.queueId,
            trigger: input.trigger,
            ref: input.ref ?? null,
            resolvedSha: input.resolvedSha,
            status: "deduped",
          }),
        };
      }
      const fifoSeq = this.nextWatcherFifoSeq(input.queueId);
      return {
        status: "pending",
        event: this.recordWatcherEvent({
          ruleId: input.ruleId,
          projectId: input.projectId,
          queueId: input.queueId,
          trigger: input.trigger,
          ref: input.ref ?? null,
          resolvedSha: input.resolvedSha,
          status: "pending",
          fifoSeq,
        }),
      };
    });
  }

  listWatcherEvents(
    projectId: string,
    opts: { ruleId?: string; limit?: number } = {},
  ): WatcherEvent[] {
    let events = [...this.watcherEvents.values()].filter(
      (e) => e.projectId === projectId,
    );
    if (opts.ruleId) {
      events = events.filter((e) => e.ruleId === opts.ruleId);
    }
    events.sort((a, b) =>
      a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0,
    );
    if (opts.limit !== undefined) {
      const lim = Math.max(0, Math.floor(opts.limit));
      events = events.slice(0, lim);
    }
    return events.map((e) => ({ ...e }));
  }

  nextPendingWatcherEvent(queueId: string): WatcherEvent | null {
    const pending = [...this.watcherEvents.values()].filter(
      (e) => e.queueId === queueId && e.status === "pending" && e.fifoSeq != null,
    );
    pending.sort((a, b) => (a.fifoSeq ?? Infinity) - (b.fifoSeq ?? Infinity));
    return pending[0] ? { ...pending[0] } : null;
  }

  nextWatcherFifoSeq(queueId: string): number {
    let maxSeq = 0;
    for (const e of this.watcherEvents.values()) {
      if (e.queueId === queueId && e.fifoSeq != null && e.fifoSeq > maxSeq) {
        maxSeq = e.fifoSeq;
      }
    }
    return maxSeq + 1;
  }

  markWatcherEventLaunching(id: string): WatcherEvent {
    const existing = this.watcherEvents.get(id);
    if (!existing) throw notFound("watcher event", id);
    const next: WatcherEvent = { ...existing, status: "launching" };
    this.watcherEvents.set(id, next);
    return { ...next };
  }

  markWatcherEventPending(id: string): WatcherEvent {
    const existing = this.watcherEvents.get(id);
    if (!existing) throw notFound("watcher event", id);
    const next: WatcherEvent = { ...existing, status: "pending" };
    this.watcherEvents.set(id, next);
    return { ...next };
  }

  markWatcherEventLaunched(
    id: string,
    batchId: string,
    sha: string,
  ): WatcherEvent {
    const existing = this.watcherEvents.get(id);
    if (!existing) throw notFound("watcher event", id);
    const next: WatcherEvent = {
      ...existing,
      status: "launched",
      batchId,
      processedSha: sha,
    };
    this.watcherEvents.set(id, next);
    return { ...next };
  }

  watcherEventExistsForSha(ruleId: string, sha: string): boolean {
    return [...this.watcherEvents.values()].some(
      (e) => e.ruleId === ruleId && e.processedSha === sha,
    );
  }

  // ---- persistent eval queues + containers ----

  createEvalQueue(projectId: string, input: CreateEvalQueueInput): EvalQueue {
    if (!this.projects.has(projectId)) throw notFound("project", projectId);
    const ts = nowIso();
    const queue: EvalQueue = {
      id: input.id ?? newId(), projectId, name: input.name,
      description: input.description ?? null, agentId: input.agentId,
      model: input.model, provider: input.provider,
      adapterOverrides: input.adapterOverrides ?? null, sandbox: input.sandbox ?? null,
      networkPolicy: input.networkPolicy ?? "allow", ports: [...(input.ports ?? [])],
      status: "draft", activeBatchId: null,
      sharedAdapterId: input.sharedAdapterId ?? null,
      builtinAdapterId: input.builtinAdapterId ?? null,
      agentCommit: input.agentCommit ?? null,
      revision: 1, createdAt: ts, updatedAt: ts,
    };
    this.evalQueues.set(queue.id, queue);
    return structuredClone(queue);
  }

  getEvalQueue(id: string): EvalQueue | null {
    const row = this.evalQueues.get(id);
    return row ? structuredClone(row) : null;
  }

  listEvalQueues(projectId: string): EvalQueue[] {
    return [...this.evalQueues.values()].filter((q) => q.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((q) => structuredClone(q));
  }

  updateEvalQueue(id: string, patch: UpdateEvalQueueInput): EvalQueue {
    const existing = this.evalQueues.get(id);
    if (!existing) throw notFound("eval queue", id);
    const next: EvalQueue = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description !== undefined ? patch.description : existing.description,
      agentId: patch.agentId ?? existing.agentId,
      model: patch.model ?? existing.model,
      provider: patch.provider ?? existing.provider,
      adapterOverrides: patch.adapterOverrides !== undefined ? patch.adapterOverrides : existing.adapterOverrides,
      sandbox: patch.sandbox !== undefined ? patch.sandbox : existing.sandbox,
      networkPolicy: patch.networkPolicy ?? existing.networkPolicy,
      ports: patch.ports !== undefined ? [...patch.ports] : existing.ports,
      status: patch.status ?? existing.status,
      activeBatchId: patch.activeBatchId !== undefined ? patch.activeBatchId : existing.activeBatchId,
      sharedAdapterId: patch.sharedAdapterId !== undefined ? patch.sharedAdapterId : existing.sharedAdapterId,
      builtinAdapterId: patch.builtinAdapterId !== undefined ? patch.builtinAdapterId : existing.builtinAdapterId,
      agentCommit: patch.agentCommit !== undefined ? patch.agentCommit : existing.agentCommit,
      revision: patch.incrementRevision ? existing.revision + 1 : existing.revision,
      updatedAt: nowIso(),
    };
    this.evalQueues.set(id, next);
    return structuredClone(next);
  }

  deleteEvalQueue(id: string): void {
    if (!this.evalQueues.has(id)) throw notFound("eval queue", id);
    for (const [itemId, item] of this.evalQueueItems) {
      if (item.queueId === id) this.evalQueueItems.delete(itemId);
    }
    this.evalQueues.delete(id);
  }

  createEvalQueueItem(queueId: string, input: CreateEvalQueueItemInput): EvalQueueItem {
    const queue = this.evalQueues.get(queueId);
    if (!queue) throw notFound("eval queue", queueId);
    const task = this.tasks.get(input.taskId);
    if (!task || task.projectId !== queue.projectId) throw notFound("task", input.taskId);
    const items = this.listEvalQueueItems(queueId, { includeDisabled: true });
    let position = items.length === 0 ? 1 : items[items.length - 1]!.position + 1;
    const requestedPosition = input.position;
    if (typeof requestedPosition === "number") position = requestedPosition;
    else if (requestedPosition?.before) {
      const beforeId = requestedPosition.before;
      const at = items.findIndex((i) => i.id === beforeId);
      if (at < 0) throw notFound("eval queue item", beforeId);
      position = ((items[at - 1]?.position ?? items[at]!.position - 1) + items[at]!.position) / 2;
    } else if (requestedPosition?.after) {
      const afterId = requestedPosition.after;
      const at = items.findIndex((i) => i.id === afterId);
      if (at < 0) throw notFound("eval queue item", afterId);
      position = (items[at]!.position + (items[at + 1]?.position ?? items[at]!.position + 1)) / 2;
    }
    const ts = nowIso();
    const item: EvalQueueItem = {
      id: input.id ?? newId(), queueId, projectId: queue.projectId, taskId: input.taskId,
      position, repeats: Math.max(1, input.repeats ?? 1), enabled: input.enabled !== false,
      overrides: input.overrides ?? null, claimedRepeats: 0, deletedAt: null,
      createdAt: ts, updatedAt: ts,
    };
    this.evalQueueItems.set(item.id, item);
    this.updateEvalQueue(queueId, { incrementRevision: true });
    return structuredClone(item);
  }

  getEvalQueueItem(id: string): EvalQueueItem | null {
    const item = this.evalQueueItems.get(id);
    return item ? structuredClone(item) : null;
  }

  listEvalQueueItems(queueId: string, opts: { includeDisabled?: boolean } = {}): EvalQueueItem[] {
    return [...this.evalQueueItems.values()].filter((i) => i.queueId === queueId &&
      (opts.includeDisabled === true || i.enabled) && i.deletedAt === null)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
      .map((i) => structuredClone(i));
  }

  listEvalQueuesUsingTask(projectId: string, taskId: string): EvalQueue[] {
    const ids = [...new Set(
      [...this.evalQueueItems.values()]
        .filter((i) => i.projectId === projectId && i.taskId === taskId && i.deletedAt === null)
        .map((i) => i.queueId),
    )];
    return ids
      .map((id) => this.evalQueues.get(id))
      .filter((q): q is EvalQueue => q !== undefined)
      .map((q) => structuredClone(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  updateEvalQueueItem(id: string, patch: UpdateEvalQueueItemInput): EvalQueueItem {
    const existing = this.evalQueueItems.get(id);
    if (!existing) throw notFound("eval queue item", id);
    const items = this.listEvalQueueItems(existing.queueId, { includeDisabled: true });
    let position = patch.position ?? existing.position;
    if (patch.before !== undefined) {
      const at = items.findIndex((i) => i.id === patch.before);
      if (at < 0) throw notFound("eval queue item", patch.before);
      position = ((items[at - 1]?.position ?? items[at]!.position - 1) + items[at]!.position) / 2;
    }
    if (patch.after !== undefined) {
      const at = items.findIndex((i) => i.id === patch.after);
      if (at < 0) throw notFound("eval queue item", patch.after);
      position = (items[at]!.position + (items[at + 1]?.position ?? items[at]!.position + 1)) / 2;
    }
    const next: EvalQueueItem = {
      ...existing, position, repeats: patch.repeats !== undefined ? Math.max(1, patch.repeats) : existing.repeats,
      enabled: patch.enabled ?? existing.enabled,
      overrides: patch.overrides !== undefined ? patch.overrides : existing.overrides,
      updatedAt: nowIso(),
    };
    this.evalQueueItems.set(id, next);
    this.updateEvalQueue(existing.queueId, { incrementRevision: true });
    return structuredClone(next);
  }

  deleteEvalQueueItem(id: string): void {
    const existing = this.evalQueueItems.get(id);
    if (!existing) throw notFound("eval queue item", id);
    // Soft delete: prevents future claims without breaking run provenance/FKs.
    this.evalQueueItems.set(id, {
      ...existing,
      enabled: false,
      deletedAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.updateEvalQueue(existing.queueId, { incrementRevision: true });
  }

  createQueueContainer(input: CreateQueueContainerInput): QueueContainer {
    const active = this.getActiveQueueContainer(input.queueId);
    if (active) throw new Error(`eval queue ${input.queueId} already has active container ${active.id}`);
    const ts = nowIso();
    const row: QueueContainer = {
      id: input.id ?? newId(), queueId: input.queueId, projectId: input.projectId,
      batchId: input.batchId, runtimeContainerId: input.runtimeContainerId ?? null,
      image: input.image, imageId: input.imageId ?? null,
      agentCommit: input.agentCommit ?? null, agentVersion: input.agentVersion ?? null,
      buildId: input.buildId ?? null,
      state: input.state, ports: [...(input.ports ?? [])],
      workspaceDir: input.workspaceDir, startedAt: input.startedAt ?? null,
      stoppedAt: null, error: input.error ?? null, createdAt: ts, updatedAt: ts,
    };
    this.queueContainers.set(row.id, row);
    return structuredClone(row);
  }

  getQueueContainer(id: string): QueueContainer | null {
    const row = this.queueContainers.get(id);
    return row ? structuredClone(row) : null;
  }

  getActiveQueueContainer(queueId: string): QueueContainer | null {
    return this.listQueueContainers(queueId).find((c) => isActiveContainerState(c)) ?? null;
  }

  listQueueContainers(queueId: string): QueueContainer[] {
    return [...this.queueContainers.values()].filter((c) => c.queueId === queueId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c: any) => structuredClone(c));
  }

  updateQueueContainer(id: string, patch: UpdateQueueContainerInput): QueueContainer {
    const existing = this.queueContainers.get(id);
    if (!existing) throw notFound("queue container", id);
    const next: QueueContainer = {
      ...existing,
      runtimeContainerId: patch.runtimeContainerId !== undefined ? patch.runtimeContainerId : existing.runtimeContainerId,
      state: patch.state ?? existing.state,
      ports: patch.ports !== undefined ? [...patch.ports] : existing.ports,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
      stoppedAt: patch.stoppedAt !== undefined ? patch.stoppedAt : existing.stoppedAt,
      error: patch.error !== undefined ? patch.error : existing.error,
      updatedAt: nowIso(),
    };
    this.queueContainers.set(id, next);
    return structuredClone(next);
  }

  recoverStaleQueueContainers(opts: {
    olderThanMs?: number;
    now?: string;
  } = {}): QueueContainer[] {
    const olderThanMs = opts.olderThanMs ?? 0;
    const nowMs = Date.parse(opts.now ?? nowIso());
    const recovered: QueueContainer[] = [];
    for (const row of [...this.queueContainers.values()]) {
      if (!isActiveContainerState(row)) continue;
      const startedMs = Date.parse(row.startedAt ?? row.createdAt);
      if (!Number.isFinite(startedMs) || nowMs - startedMs < olderThanMs) continue;
      const updated = this.updateQueueContainer(row.id, {
        state: "failed",
        stoppedAt: opts.now ?? nowIso(),
        error: row.error ?? "recovered stale queue container after process restart",
      });
      const batch = this.batches.get(row.batchId);
      if (batch) {
        this.batches.set(row.batchId, {
          ...batch,
          accepting: false,
          closedAt: opts.now ?? nowIso(),
        });
      }
      const queue = this.getEvalQueue(row.queueId);
      if (queue?.activeBatchId === row.batchId) {
        this.updateEvalQueue(row.queueId, { status: "failed", activeBatchId: null });
      }
      for (const run of this.listRunsByBatch(row.batchId)) {
        if (run.status === "queued" || run.status === "running") {
          this.finalizeRun(run.id, {
            status: "failed",
            error: "queue generation recovered after process restart",
            controlState: "done",
          });
        }
      }
      recovered.push(updated);
    }
    return recovered;
  }

  beginQueueGeneration(input: {
    batch: CreateBatchInput;
    container: Omit<CreateQueueContainerInput, "batchId">;
  }): { batch: RunBatch; container: QueueContainer } {
    return this.transaction(() => {
      const active = this.getActiveQueueContainer(input.container.queueId);
      if (active) {
        throw Object.assign(
          new Error(`eval queue ${input.container.queueId} already has active container ${active.id}`),
          { code: "ALREADY_ACTIVE" },
        );
      }
      const batch = this.createBatch(input.batch);
      const container = this.createQueueContainer({
        ...input.container,
        batchId: batch.id,
      });
      this.updateEvalQueue(input.container.queueId, {
        status: "starting",
        activeBatchId: batch.id,
      });
      return { batch, container };
    });
  }

  listRunsByBatch(batchId: string): Run[] {
    return [...this.runs.values()]
      .filter((r) => r.batchId === batchId)
      .map((r) => ({ ...r }));
  }

  claimQueueWork(input: ClaimQueueWorkInput): ClaimQueueWorkResult {
    // Synchronous atomic equivalent of the SQLite BEGIN IMMEDIATE claim:
    // no awaits, no interleaving, complete before returning.
    // 1. Load the active generation and confirm it is still accepting.
    const batch = this.batches.get(input.batchId);
    if (!batch) throw notFound("run batch", input.batchId);
    if (!batch.accepting) {
      throw Object.assign(
        new Error(`queue generation ${input.batchId} is closed; start a new generation`),
        { code: "GENERATION_CLOSED" },
      );
    }

    // 2. Select enabled, non-deleted queue items in position, id order.
    const items = [...this.evalQueueItems.values()]
      .filter(
        (i) =>
          i.queueId === input.queueId &&
          i.enabled &&
          i.deletedAt === null,
      )
      .sort(
        (a, b) => a.position - b.position || a.id.localeCompare(b.id),
      );

    // 3. Compare each item's repeats with runs already claimed for this generation.
    const claimedPerItem = new Map<string, number>();
    for (const run of this.runs.values()) {
      if (run.batchId !== input.batchId || !run.queueItemId) continue;
      claimedPerItem.set(run.queueItemId, (claimedPerItem.get(run.queueItemId) ?? 0) + 1);
    }

    let claim: { item: EvalQueueItem; repeatIndex: number; task: Task } | null = null;
    for (const item of items) {
      // Same floor as the SQLite path: claimedRepeats survives across batches.
      const claimedCount = Math.max(claimedPerItem.get(item.id) ?? 0, item.claimedRepeats);
      if (claimedCount >= item.repeats) continue;
      const taskForItem = this.tasks.get(item.taskId);
      if (!taskForItem || taskForItem.archived) {
        this.evalQueueItems.set(item.id, {
          ...item,
          enabled: false,
          deletedAt: nowIso(),
          updatedAt: nowIso(),
        });
        continue;
      }
      claim = { item, repeatIndex: claimedCount, task: taskForItem };
      break;
    }

    // 5. If no work exists, atomically mark the generation closing.
    if (!claim) {
      const closedRevision = input.snapshot.queueRevision;
      this.batches.set(input.batchId, {
        ...batch,
        accepting: false,
        closedRevision,
        closedAt: nowIso(),
      });
      return { claimed: false, closed: true, closedRevision };
    }

    // 4. Create exactly one queue-backed run with immutable eval/item snapshots.
    // The claimed item may differ from the caller's expected task (the claim op
    // selects the item atomically), so resolve snapshots for the actual item.
    const { item, repeatIndex, task: taskForItem } = claim;
    const evalSnapshot =
      input.evalSnapshot &&
      input.taskId === item.taskId
        ? input.evalSnapshot
        : JSON.parse(JSON.stringify(taskForItem));
    const evalVersion = input.evalVersion ?? taskForItem.version ?? 1;
    const itemSnapshot = input.itemSnapshot ?? {
      id: item.id,
      queueId: item.queueId,
      taskId: item.taskId,
      position: item.position,
      repeats: item.repeats,
      enabled: item.enabled ? 1 : 0,
      overrides: item.overrides,
      claimedRepeats: item.claimedRepeats,
    };
    const run = this.createRun({
      batchId: input.batchId,
      taskId: item.taskId,
      projectId: input.projectId,
      queueId: input.queueId,
      queueItemId: item.id,
      queueContainerId: input.queueContainerId,
      agentId: input.agentId ?? batch.agentId,
      model: input.snapshot.model,
      provider: input.snapshot.provider,
      repeatIndex,
      evalVersion,
      evalSnapshot,
      itemSnapshot,
      status: "queued",
      agentImage: input.snapshot.agentImage ?? undefined,
      agentCommit: input.snapshot.agentCommit ?? undefined,
      agentImageSource: "built",
      adapterOverrides: input.snapshot.adapterOverrides,
      trigger: "eval-queue",
      triggerRef: input.queueId,
      controlState: "running",
    });

    // Bump the item's immutable claimed-repeat floor.
    this.evalQueueItems.set(item.id, {
      ...item,
      claimedRepeats: item.claimedRepeats + 1,
      updatedAt: nowIso(),
    });

    return { claimed: true, run, queueItemId: item.id, repeatIndex };
  }

  upsertEvalMetrics(input: {
    runId: string;
    projectId: string;
    schemaVersion: number;
    execution: Record<string, unknown>;
    outcome?: Record<string, unknown> | null;
  }): EvalMetricsRecord {
    const existing = this.evalMetrics.get(input.runId);
    const ts = nowIso();
    const row: EvalMetricsRecord = {
      runId: input.runId,
      projectId: input.projectId,
      schemaVersion: input.schemaVersion,
      execution: structuredClone(input.execution),
      outcome: structuredClone(input.outcome ?? existing?.outcome ?? null),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.evalMetrics.set(row.runId, row);
    return structuredClone(row);
  }

  getEvalMetrics(runId: string): EvalMetricsRecord | null {
    const row = this.evalMetrics.get(runId);
    return row ? structuredClone(row) : null;
  }

  storeEvalArchive(input: StoreEvalArchiveInput): EvalArchive {
    const row: EvalArchive = {
      runId: input.runId, projectId: input.projectId, queueId: input.queueId ?? null,
      batchId: input.batchId, manifestPath: input.manifestPath,
      manifestKey: input.manifestKey ?? null,
      manifestSha256: input.manifestSha256, sizeBytes: input.sizeBytes,
      sealedAt: input.sealedAt ?? nowIso(),
      archivedAt: input.archivedAt ?? input.sealedAt ?? nowIso(),
    };
    this.evalArchives.set(row.runId, row);
    return { ...row };
  }

  getEvalArchive(runId: string): EvalArchive | null {
    const row = this.evalArchives.get(runId);
    return row ? { ...row } : null;
  }

  listEvalArchives(filter: { projectId?: string; queueId?: string; batchId?: string }): EvalArchive[] {
    return [...this.evalArchives.values()].filter((a) =>
      (!filter.projectId || a.projectId === filter.projectId) &&
      (!filter.queueId || a.queueId === filter.queueId) &&
      (!filter.batchId || a.batchId === filter.batchId))
      .sort((a, b) => b.sealedAt.localeCompare(a.sealedAt)).map((a) => ({ ...a }));
  }

  // ---- API tokens (P8b-auth) ----

  createApiToken(input: CreateApiTokenInput = {}): CreatedApiToken {
    const { token, tokenHash } = mintApiTokenPair();
    const row: ApiToken = {
      id: newId(),
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      tokenHash,
      label: input.label ?? null,
      readOnly: input.readOnly === true,
      createdAt: nowIso(),
      revokedAt: null,
    };
    this.apiTokens.set(tokenHash, row);
    return { ...row, token };
  }

  getApiToken(tokenHash: string): ApiToken | null {
    const row = this.apiTokens.get(tokenHash);
    return row ? { ...row } : null;
  }

  revokeApiToken(tokenHash: string): void {
    const existing = this.apiTokens.get(tokenHash);
    if (!existing) return;
    if (existing.revokedAt) return;
    this.apiTokens.set(tokenHash, {
      ...existing,
      revokedAt: nowIso(),
    });
  }

  listApiTokens(opts: ListApiTokensOpts = {}): ApiToken[] {
    let rows = [...this.apiTokens.values()].map((t) => ({ ...t }));
    if (opts.projectId !== undefined) {
      rows = rows.filter((t) => t.projectId === opts.projectId);
    }
    if (opts.userId !== undefined) {
      rows = rows.filter((t) => t.userId === opts.userId);
    }
    if (!opts.includeRevoked) {
      rows = rows.filter((t) => t.revokedAt == null);
    }
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.id.localeCompare(a.id);
    });
    return rows;
  }

  // ---- Users (P9-settings) ----

  createUser(input: CreateUserInput): User {
    const count = this.users.size;
    const role = input.role ?? (count === 0 ? "admin" : "user");
    const user: User = {
      id: input.id ?? newId(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: String(role),
      createdAt: nowIso(),
      email: input.email ?? null,
    };
    this.users.set(user.id, user);
    return { ...user };
  }

  getUser(id: string): User | null {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  getUserByUsername(username: string): User | null {
    for (const u of this.users.values()) {
      if (u.username === username) return { ...u };
    }
    return null;
  }

  listUsers(): User[] {
    const rows = [...this.users.values()].map((u) => ({ ...u }));
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      return a.username.localeCompare(b.username);
    });
    return rows;
  }

  deleteUser(id: string): void {
    this.users.delete(id);
  }

  countUsers(): number {
    return this.users.size;
  }

  addProjectMember(projectId: string, userId: string): void {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    if (!this.getUser(userId)) throw notFound("user", userId);
    const key = `${projectId}\0${userId}`;
    if (this.projectMembers.has(key)) return;
    this.projectMembers.set(key, { projectId, userId, createdAt: nowIso() });
  }

  removeProjectMember(projectId: string, userId: string): void {
    this.projectMembers.delete(`${projectId}\0${userId}`);
  }

  listProjectMembers(projectId: string): string[] {
    return [...this.projectMembers.values()]
      .filter((row) => row.projectId === projectId)
      .map((row) => row.userId)
      .sort();
  }

  listUserProjectIds(userId: string): string[] {
    return [...this.projectMembers.values()]
      .filter((row) => row.userId === userId)
      .map((row) => row.projectId)
      .sort();
  }

  isProjectMember(projectId: string, userId: string): boolean {
    return this.projectMembers.has(`${projectId}\0${userId}`);
  }

  // ---- Settings (P9) ----

  getSetting(key: string): unknown | null {
    const row = this.settings.get(key);
    return row ? row.value : null;
  }

  setSetting(key: string, value: unknown): void {
    this.settings.set(key, {
      key,
      value: value ?? null,
      updatedAt: nowIso(),
    });
  }

  listSettings(): SettingRow[] {
    return [...this.settings.values()].map((s) => ({ ...s }));
  }

  deleteSetting(key: string): void {
    this.settings.delete(key);
  }

  // ---- Project export (P9) ----

  exportRows(projectId: string): ProjectExportRows {
    const project = this.getProject(projectId);
    if (!project) throw notFound("project", projectId);
    return {
      project,
      tasks: this.listTasks(projectId, { includeArchived: true }),
      runs: this.listRuns({ projectId }),
      watchers: this.listWatcherRules(projectId, { includeDisabled: true }),
    };
  }


  storeCheckResults(runId: string, results: CheckResult[]): void {
    this.checkResultsByRun.set(runId, results.map((r) => ({ ...r })));
  }

  getCheckResults(runId: string): CheckResult[] {
    const stored = this.checkResultsByRun.get(runId);
    return stored ? stored.map((r) => ({ ...r })) : [];
  }


}

/** Alias kept for call-site ergonomics. */
export type DbQueries = QueryStore;

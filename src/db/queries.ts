/**
 * DbQueries facade over the persistence connection.
 *
 * Two backends share the same QueryStore interface:
 *  - SqliteQueries  — drizzle-orm + better-sqlite3 (primary path)
 *  - MemoryQueries  — pure in-memory Maps (fallback when native sqlite is unavailable)
 *
 * Spec: plan/data-model.md. Domain I/O uses types from src/domain.ts.
 * Judgement/score/finding write APIs are intentionally stubbed (P4/P6 fill them).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, desc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentCategory,
  Rubric,
  TaskProfile,
  TaskSpec,
} from "../domain.js";
import type { WorkspaceSpec } from "../adapters/types.js";
import type { PortMapping, ResolvedPort } from "../runner/runtime.js";
import type { CheckResult, Verdict } from "../judge/verdict.js";
import {
  applyRecurrenceToVerdict,
  ingestFindings as runIngestFindings,
  type FindingDetail,
  type FindingKind,
  type FindingLifecycleStatus,
  type FindingRow,
  type FindingsIngestStore,
  type OccurrenceRow,
  type OccurrenceStatus,
} from "./findings.js";
import {
  agents,
  apiTokens,
  checkResults,
  evalArchives,
  evalQueueItems,
  evalQueues,
  findingOccurrences,
  findings,
  judgements,
  outboundSubscriptions,
  projectAgentAdapters,
  projectRubrics,
  projects,
  queueAnalyses,
  queueContainers,
  queueEntries,
  runBatches,
  runs,
  scores,
  settings,
  tasks,
  users,
  watcherEvents,
  watcherRules,
  webhookDeliveries,
  type Schema,
} from "./schema.js";
import { rubricsEqual } from "../tasks/index.js";
import {
  DEFAULT_ARTIFACT_RETENTION,
  resolveRetentionPolicy,
} from "../runner/artifact-retention.js";

// Re-export finding row types for consumers.
export type {
  FindingDetail,
  FindingKind,
  FindingLifecycleStatus,
  FindingRow,
  OccurrenceRow,
  OccurrenceStatus,
} from "./findings.js";

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
  defaultJudgeModel: string | null;
  workspaceImage: string | null;
  checkRunners: Record<string, string> | null;
  adapterOverrides: Record<string, unknown> | null;
  networkPolicy: string;
  retentionRuns: number | null;
  /** What run artifacts survive judgement: keep|referenced|all. */
  artifactRetention: string;
  /** Per-project sandbox controls; null when the project configures none. */
  sandbox: Record<string, unknown> | null;
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
  defaultJudgeModel?: string;
  workspaceImage?: string;
  checkRunners?: Record<string, string>;
  adapterOverrides?: Record<string, unknown>;
  networkPolicy?: string;
  retentionRuns?: number | null;
  artifactRetention?: string;
  sandbox?: Record<string, unknown> | null;
  id?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  taskSource?: { kind: string; params?: Record<string, unknown> };
  defaultAgentId?: string | null;
  defaultModel?: string | null;
  defaultProvider?: string | null;
  defaultJudgeModel?: string | null;
  workspaceImage?: string | null;
  checkRunners?: Record<string, string> | null;
  adapterOverrides?: Record<string, unknown> | null;
  networkPolicy?: string;
  retentionRuns?: number | null;
  artifactRetention?: string;
  sandbox?: Record<string, unknown> | null;
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
  profile: TaskProfile | null;
  referenceSolution: string | null;
  checks: unknown[] | null;
  /** Env this eval needs (greenfield/brownfield, image, setup script). */
  env: Record<string, unknown> | null;
  tags: string[] | null;
  sourceKind: string | null;
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
  profile?: TaskProfile | null;
  referenceSolution?: string | null;
  checks?: unknown[] | null;
  /** Env this eval needs (greenfield/brownfield, image, setup script). */
  env?: Record<string, unknown> | null;
  tags?: string[] | null;
  externalId?: string | null;
  sourceKind?: string | null;
}

/**
 * A project-scoped reusable rubric (plan/rubric.md §6). Tasks may embed their
 * own rubric; a project rubric is the shared, versioned baseline many tasks can
 * start from. Editing the criteria bumps `rubricVersion` (new comparison
 * baseline), exactly as a task rubric edit does.
 */
export interface ProjectRubric {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rubric: Rubric;
  rubricVersion: number;
  /** Exactly one rubric per project may be the default (enforced on write). */
  isDefault: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRubricInput {
  projectId: string;
  name: string;
  description?: string | null;
  rubric: Rubric;
  isDefault?: boolean;
  id?: string;
}

export interface UpdateProjectRubricInput {
  name?: string;
  description?: string | null;
  rubric?: Rubric;
  isDefault?: boolean;
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
  taskId: string;
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
  queueId: string | null;
  queueRevision: number | null;
  createdAt: string;
}

export interface CreateBatchInput {
  taskId: string;
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
}

// ---------------------------------------------------------------------------
// Judgements + scores (P4c)
// ---------------------------------------------------------------------------

export type JudgementStatus = "queued" | "running" | "completed" | "failed";

/** pass|fail|partial — denormalized overall verdict level. */
export type VerdictLevel = "pass" | "fail" | "partial";

export interface Judgement {
  id: string;
  runId: string;
  projectId: string;
  queueAnalysisId: string | null;
  judgeModel: string;
  judgeProvider: string;
  judgePrompt: string | null;
  systemPromptVersion: string;
  status: JudgementStatus | string;
  overallScore: number | null;
  /** Denormalized overall level: pass|fail|partial. */
  verdict: VerdictLevel | string | null;
  reportPath: string | null;
  eventsPath: string | null;
  verdictPath: string | null;
  createdAt: string | null;
  endedAt: string | null;
}

/** getJudgement: row + full verdict body loaded from verdict.json (when present). */
export interface JudgementWithVerdict extends Judgement {
  /** Structured verdict from disk; null until storeVerdict writes it. */
  verdictBody: Verdict | null;
}

export interface CreateJudgementInput {
  runId: string;
  projectId: string;
  queueAnalysisId?: string | null;
  judgeModel: string;
  judgeProvider: string;
  judgePrompt?: string;
  systemPromptVersion: string;
  status: JudgementStatus;
  id?: string;
}

export interface ScoreRow {
  id: string;
  judgementId: string;
  criterion: string;
  weight: number;
  score: number;
  rationale: string | null;
}

export interface CreateScoreInput {
  criterion: string;
  weight: number;
  score: number;
  rationale?: string;
}

export interface ListJudgementsFilter {
  projectId?: string;
  runId?: string;
  status?: string;
  /** Max rows (default 50, cap 200). */
  limit?: number;
  /** Opaque cursor (offset as decimal string) for pagination. */
  cursor?: string;
}

export interface ListJudgementsResult {
  judgements: Judgement[];
  nextCursor: string | null;
}

/** Filter for listFindings (all fields optional; AND-combined). */
export interface ListFindingsFilter {
  projectId?: string;
  taskId?: string;
  status?: string;
  kind?: FindingKind | string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Watcher rules + events + eval queue (P8a)
// ---------------------------------------------------------------------------

export type WatcherRole = "agent" | "workspace";
export type WatcherTrigger =
  | "tag"
  | "commit"
  | "pr"
  | "schedule"
  | "manual"
  | "webhook";
/** matched|ignored|deduped|enqueued|failed|building — see plan/data-model.md */
export type WatcherEventStatus =
  | "matched"
  | "ignored"
  | "deduped"
  | "enqueued"
  | "failed"
  | "building";
export type QueueTargetKind = "task" | "task_set";
export type QueueEntryStatus =
  | "queued"
  | "promoted"
  | "running"
  | "removed"
  | "failed";

/** Action payload stored as action_json on a watcher rule. */
export interface WatcherAction {
  enqueue: "all" | "subset";
  taskTags?: string[];
  repeats?: number;
  adapterOverrides?: Record<string, unknown>;
  autoJudge?: boolean;
  judgeModel?: string;
}

/** Watcher rule domain row. webhookSecret is present only on create result. */
export interface WatcherRule {
  id: string;
  projectId: string;
  role: WatcherRole;
  repo: string;
  trigger: WatcherTrigger | string;
  ref: string | null;
  semverFilter: string | null;
  action: WatcherAction;
  /** Plaintext secret; stripped (null) on get/list/update. Present only on create. */
  webhookSecret: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWatcherRuleInput {
  role: WatcherRole;
  repo: string;
  trigger: WatcherTrigger | string;
  ref?: string | null;
  semverFilter?: string | null;
  action: WatcherAction;
  /** If absent, generated as newId()+"-"+newId() and returned once. */
  webhookSecret?: string;
  enabled?: boolean;
}

export interface UpdateWatcherRulePatch {
  ref?: string | null;
  semverFilter?: string | null;
  action?: WatcherAction;
  enabled?: boolean;
  repo?: string;
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
  error?: string | null;
}

/** Eval-queue domain row. JSON columns are parsed. */
export interface QueueEntry {
  id: string;
  projectId: string;
  triggerRef: string | null;
  targetKind: QueueTargetKind | string;
  taskId: string | null;
  /** Parsed from task_tags_json. */
  taskTags: string[] | null;
  agentId: string;
  model: string | null;
  provider: string | null;
  repeats: number | null;
  /** Parsed from params_json. */
  params: Record<string, unknown> | null;
  /** Parsed from adapter_overrides_json. */
  adapterOverrides: Record<string, unknown> | null;
  /** int 1 === true; null when unset. */
  autoJudge: boolean | null;
  judgeModel: string | null;
  priority: number;
  position: number;
  status: QueueEntryStatus | string;
  dedupKey: string | null;
  source: string | null;
  createdAt: string;
  promotedAt: string | null;
  promotedBatchId: string | null;
  removedAt: string | null;
}

export type QueuePositionSpec =
  | number
  | { after?: string }
  | { before?: string };

export interface CreateQueueEntryInput {
  triggerRef?: string | null;
  targetKind: QueueTargetKind;
  taskId?: string | null;
  taskTags?: string[];
  agentId: string;
  model?: string | null;
  provider?: string | null;
  repeats?: number | null;
  params?: Record<string, unknown> | null;
  adapterOverrides?: Record<string, unknown> | null;
  autoJudge?: boolean | null;
  judgeModel?: string | null;
  priority?: number;
  /** Absolute position, or relative {after|before} entry id. Omitted → append tail. */
  position?: QueuePositionSpec;
  dedupKey?: string | null;
  source?: string | null;
}

export interface ReorderQueueEntryOpts {
  position?: number;
  after?: string;
  before?: string;
  priority?: number;
}

export interface PromoteQueueEntryResult {
  entry: QueueEntry;
  /** First batch created (also stored as promotedBatchId). */
  batchId: string;
  runIds: string[];
  /** All batches when task_set fans out to multiple tasks. */
  batchIds: string[];
}

// ---------------------------------------------------------------------------
// Persistent eval queues + queue containers + archived evidence
// ---------------------------------------------------------------------------

export type EvalQueueStatus =
  | "draft"
  | "starting"
  | "running"
  | "paused"
  | "judging"
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
  judgeModel: string | null;
  judgeProvider: string | null;
  autoJudge: boolean;
  status: EvalQueueStatus | string;
  activeBatchId: string | null;
  sharedAdapterId: string | null;
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
  judgeModel?: string | null;
  judgeProvider?: string | null;
  autoJudge?: boolean;
  sharedAdapterId?: string | null;
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
  judgeModel?: string | null;
  judgeProvider?: string | null;
  autoJudge?: boolean;
  status?: EvalQueueStatus | string;
  activeBatchId?: string | null;
  sharedAdapterId?: string | null;
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

export type QueueContainerState =
  | "starting"
  | "running"
  | "idle"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

export interface QueueContainer {
  id: string;
  queueId: string;
  projectId: string;
  batchId: string;
  runtimeContainerId: string | null;
  image: string;
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

export type QueueAnalysisStatus = "queued" | "running" | "completed" | "failed";

export interface QueueAnalysis {
  id: string;
  queueId: string;
  projectId: string;
  batchId: string;
  selectedRunIds: string[];
  evidenceHashes: Record<string, string>;
  judgeModel: string;
  judgeProvider: string;
  judgeParams: Record<string, unknown> | null;
  judgePrompt: string | null;
  systemPromptVersion: string;
  parentAnalysisId: string | null;
  status: QueueAnalysisStatus | string;
  verdictPath: string | null;
  reportPath: string | null;
  eventsPath: string | null;
  rawResponsePath: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export interface CreateQueueAnalysisInput {
  id?: string;
  queueId: string;
  projectId: string;
  batchId: string;
  selectedRunIds: string[];
  evidenceHashes: Record<string, string>;
  judgeModel: string;
  judgeProvider: string;
  judgeParams?: Record<string, unknown> | null;
  judgePrompt?: string | null;
  systemPromptVersion: string;
  parentAnalysisId?: string | null;
  status?: QueueAnalysisStatus | string;
}

export interface UpdateQueueAnalysisInput {
  status?: QueueAnalysisStatus | string;
  verdictPath?: string | null;
  reportPath?: string | null;
  eventsPath?: string | null;
  rawResponsePath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: string | null;
}

export interface EvalArchive {
  runId: string;
  projectId: string;
  queueId: string | null;
  batchId: string;
  manifestPath: string;
  manifestSha256: string;
  sizeBytes: number;
  sealedAt: string;
}

export interface StoreEvalArchiveInput {
  runId: string;
  projectId: string;
  queueId?: string | null;
  batchId: string;
  manifestPath: string;
  manifestSha256: string;
  sizeBytes: number;
  sealedAt?: string;
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
 * Portable project export rows (P9). Secrets stripped: watcher webhookSecret,
 * outbound subscription secret, and no api_tokens.
 */
export interface ProjectExportRows {
  project: Project;
  tasks: Task[];
  /** Run metadata only (no event payloads). */
  runs: Run[];
  /** Watcher rules with webhookSecret forced to null. */
  watchers: WatcherRule[];
  queue: QueueEntry[];
  /** Outbound webhook subs with secret forced to null. */
  outboundWebhooks: OutboundSubscription[];
}

// ---- Outbound webhook subscriptions + deliveries (P8c) ----

/** Event types an outbound subscription may filter on. Empty list = all. */
export type OutboundEventType =
  | "run.completed"
  | "verdict.completed"
  | "release.compared";

/** Delivery attempt status. */
export type WebhookDeliveryStatus = "pending" | "success" | "failed";

/**
 * Outbound webhook subscription. `secret` is present ONLY on create result;
 * get/list/update always strip it to null.
 */
export interface OutboundSubscription {
  id: string;
  projectId: string;
  url: string;
  /** Plaintext signing secret; null after create (stripped). */
  secret: string | null;
  /** Parsed event type filter; empty array means match-all. */
  eventTypes: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOutboundSubscriptionInput {
  url: string;
  /** If absent, generated as newId()+"-"+newId() and returned once. */
  secret?: string;
  /** Empty / omitted = all event types. */
  eventTypes?: string[];
  enabled?: boolean;
}

export interface UpdateOutboundSubscriptionPatch {
  url?: string;
  eventTypes?: string[];
  enabled?: boolean;
}

/** Recorded delivery attempt for an outbound webhook POST. */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  projectId: string;
  eventType: string;
  payload: unknown;
  status: WebhookDeliveryStatus | string;
  attempt: number;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface RecordWebhookDeliveryInput {
  subscriptionId: string;
  projectId: string;
  eventType: string;
  payload: unknown;
  status: WebhookDeliveryStatus | string;
  attempt: number;
  responseStatus?: number | null;
  responseBody?: string | null;
  error?: string | null;
  deliveredAt?: string | null;
}

export interface ListWebhookDeliveriesOpts {
  subscriptionId?: string;
  eventType?: string;
  status?: string;
  limit?: number;
}

/**
 * Shared query surface. Both SqliteQueries and MemoryQueries implement this.
 */
export interface QueryStore {
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
  finalizeRun(id: string, result: FinalizeRunInput): Run;

  /** Create a judgement row + on-disk judgement.json snapshot. */
  createJudgement(input: CreateJudgementInput): Judgement;
  /** Insert per-criterion score rows (for trend charts). */
  createScores(judgementId: string, scores: CreateScoreInput[]): ScoreRow[];
  /**
   * Persist a completed verdict: write verdict.json, mirror overall + per-criterion
   * scores into SQLite, mark judgement completed, then ingest findings (P6a).
   * Findings-ingest errors are caught + console.warn'd — they must not break
   * verdict persistence (verdict.json remains the source of truth).
   */
  storeVerdict(judgementId: string, verdict: Verdict): JudgementWithVerdict;
  /** Load judgement row + verdict.json body (if present). */
  getJudgement(id: string): JudgementWithVerdict | null;
  /** List judgements with optional filters + cursor pagination. */
  listJudgements(filter?: ListJudgementsFilter): ListJudgementsResult;
  /** Update judgement status (and optional ended_at). */
  setJudgementStatus(
    id: string,
    status: JudgementStatus | string,
    endedAt?: string | null,
  ): Judgement;

  /**
   * Ingest findings/positiveFindings/metaFindings from a verdict into the
   * durable issues log (findings + finding_occurrences). Called by storeVerdict;
   * also usable standalone. Rewrites verdict.json with Finding.recurring when
   * an occurrence is "persisted" (same call, single-threaded).
   */
  ingestFindings(judgementId: string, verdict: Verdict): void;
  /** List de-duplicated findings (issues log), filterable. */
  listFindings(filter?: ListFindingsFilter): FindingRow[];
  /** One finding + its occurrences, or null. */
  getFinding(fingerprint: string): FindingDetail | null;
  /** Occurrences for a fingerprint (newest first). */
  listOccurrences(findingFingerprint: string): OccurrenceRow[];

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
  /** Newest-receivedAt-first. */
  listWatcherEvents(
    projectId: string,
    opts?: { ruleId?: string; limit?: number },
  ): WatcherEvent[];

  // ---- eval queue (P8a) ----
  /** Enqueue an eval. Fractional position + default dedupKey when applicable. */
  createQueueEntry(projectId: string, input: CreateQueueEntryInput): QueueEntry;
  getQueueEntry(id: string): QueueEntry | null;
  /** Sorted by priority DESC then position ASC (stable run order). */
  listQueueEntries(
    projectId: string,
    opts?: { status?: string },
  ): QueueEntry[];
  /** Recompute fractional position and/or priority. */
  reorderQueueEntry(id: string, opts: ReorderQueueEntryOpts): QueueEntry;
  /**
   * Resolve a queued entry into run_batch(es) + runs (status queued).
   * Does not start runs — promotion only creates queued work for the runner.
   */
  promoteQueueEntry(id: string): PromoteQueueEntryResult;
  /** Soft-remove (status=removed). Idempotent if already removed. */
  removeQueueEntry(id: string): QueueEntry;
  /** Soft-remove all status=queued entries. Leaves promoted/running untouched. */
  drainQueue(projectId: string): { removed: number };

  // ---- persistent eval queues + containers ----
  createEvalQueue(projectId: string, input: CreateEvalQueueInput): EvalQueue;
  getEvalQueue(id: string): EvalQueue | null;
  listEvalQueues(projectId: string): EvalQueue[];
  updateEvalQueue(id: string, patch: UpdateEvalQueueInput): EvalQueue;
  deleteEvalQueue(id: string): void;

  createEvalQueueItem(queueId: string, input: CreateEvalQueueItemInput): EvalQueueItem;
  getEvalQueueItem(id: string): EvalQueueItem | null;
  listEvalQueueItems(queueId: string, opts?: { includeDisabled?: boolean }): EvalQueueItem[];
  updateEvalQueueItem(id: string, patch: UpdateEvalQueueItemInput): EvalQueueItem;
  deleteEvalQueueItem(id: string): void;

  createQueueContainer(input: CreateQueueContainerInput): QueueContainer;
  getQueueContainer(id: string): QueueContainer | null;
  getActiveQueueContainer(queueId: string): QueueContainer | null;
  listQueueContainers(queueId: string): QueueContainer[];
  updateQueueContainer(id: string, patch: UpdateQueueContainerInput): QueueContainer;

  createQueueAnalysis(input: CreateQueueAnalysisInput): QueueAnalysis;
  getQueueAnalysis(id: string): QueueAnalysis | null;
  listQueueAnalyses(queueId: string, opts?: { batchId?: string }): QueueAnalysis[];
  updateQueueAnalysis(id: string, patch: UpdateQueueAnalysisInput): QueueAnalysis;

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
   * Assemble portable DB rows for a project. Secrets stripped (webhook secrets,
   * outbound secrets). Does NOT include api_tokens. Throws if project missing.
   */
  exportRows(projectId: string): ProjectExportRows;

  // ---- Outbound webhooks (P8c) ----
  /**
   * Create an outbound subscription. Returns the sub WITH secret surfaced ONCE
   * (only time). Auto-generates secret when input.secret is absent.
   */
  createOutboundSubscription(
    projectId: string,
    input: CreateOutboundSubscriptionInput,
  ): OutboundSubscription;
  /** Get a subscription with secret stripped to null. */
  getOutboundSubscription(id: string): OutboundSubscription | null;
  /**
   * Return the raw signing secret for outbound HMAC. NEVER log the return value.
   * Returns null when the subscription is missing.
   */
  getOutboundSubscriptionWithSecret(id: string): string | null;
  /** List project subscriptions with secrets stripped. */
  listOutboundSubscriptions(projectId: string): OutboundSubscription[];
  /** Patch a subscription (secret never touchable). Secret stripped on return. */
  updateOutboundSubscription(
    id: string,
    patch: UpdateOutboundSubscriptionPatch,
  ): OutboundSubscription;
  /** Hard-delete a subscription. */
  deleteOutboundSubscription(id: string): void;
  /** Insert a delivery log row. */
  recordWebhookDelivery(input: RecordWebhookDeliveryInput): WebhookDelivery;
  /** Newest-createdAt-first delivery list with optional filters. */
  listWebhookDeliveries(
    projectId: string,
    opts?: ListWebhookDeliveriesOpts,
  ): WebhookDelivery[];

  /** Persist deterministic check results for a run (P9 DB mirror). */
  storeCheckResults(runId: string, results: CheckResult[]): void;
  /** Load persisted check results for a run (P9 DB mirror). */
  getCheckResults(runId: string): CheckResult[];

  /** Create a project-scoped reusable rubric. */
  createProjectRubric(input: CreateProjectRubricInput): ProjectRubric;
  /** Fetch one project rubric by id (null when missing). */
  getProjectRubric(id: string): ProjectRubric | null;
  /** List a project's rubrics, newest first; archived excluded by default. */
  listProjectRubrics(
    projectId: string,
    opts?: { includeArchived?: boolean },
  ): ProjectRubric[];
  /** The project's default rubric, if one is marked (null otherwise). */
  getDefaultProjectRubric(projectId: string): ProjectRubric | null;
  /** Patch a project rubric; a semantic rubric edit bumps rubricVersion. */
  updateProjectRubric(id: string, patch: UpdateProjectRubricInput): ProjectRubric;
  /** Soft-delete (archive) a project rubric. */
  archiveProjectRubric(id: string): ProjectRubric;
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

/** On-disk dir for a judgement: <dataDir>/projects/<pid>/judgements/<jid>. */
export function judgementDir(
  dataDir: string,
  projectId: string,
  judgementId: string,
): string {
  return join(dataDir, "projects", projectId, "judgements", judgementId);
}

export function judgementSnapshotPath(
  dataDir: string,
  projectId: string,
  judgementId: string,
): string {
  return join(judgementDir(dataDir, projectId, judgementId), "judgement.json");
}

export function verdictPath(
  dataDir: string,
  projectId: string,
  judgementId: string,
): string {
  return join(judgementDir(dataDir, projectId, judgementId), "verdict.json");
}

export function judgeEventsPath(
  dataDir: string,
  projectId: string,
  judgementId: string,
): string {
  return join(judgementDir(dataDir, projectId, judgementId), "judge.jsonl");
}

/**
 * Read verdict.json from disk (null when missing / unparseable).
 */
export function readVerdictFromDisk(
  dataDir: string,
  projectId: string,
  judgementId: string,
  dbPath?: string | null,
): Verdict | null {
  const path =
    dbPath && dbPath.length > 0
      ? dbPath
      : verdictPath(dataDir, projectId, judgementId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as Verdict;
  } catch {
    return null;
  }
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
    defaultJudgeModel: row.defaultJudgeModel,
    workspaceImage: row.workspaceImage,
    checkRunners: parseJson(row.checkRunnersJson, null),
    adapterOverrides: parseJson(row.adapterOverridesJson, null),
    networkPolicy: row.networkPolicy ?? "allow",
    retentionRuns: row.retentionRuns,
    artifactRetention: row.artifactRetention ?? "keep",
    sandbox: parseJson(row.sandboxJson, null),
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
    profile: (row.profile as TaskProfile | null) ?? null,
    referenceSolution: row.referenceSolution,
    checks: parseJson(row.checksJson, null),
    env: parseJson(row.envJson, null),
    tags: parseJson(row.tags, null),
    sourceKind: row.sourceKind,
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
    taskId: row.taskId,
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
    queueId: row.queueId ?? null,
    queueRevision: row.queueRevision ?? null,
    createdAt: row.createdAt,
  };
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

function mapJudgement(row: typeof judgements.$inferSelect): Judgement {
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    queueAnalysisId: row.queueAnalysisId ?? null,
    judgeModel: row.judgeModel,
    judgeProvider: row.judgeProvider,
    judgePrompt: row.judgePrompt,
    systemPromptVersion: row.systemPromptVersion,
    status: row.status,
    overallScore: row.overallScore,
    verdict: row.verdict,
    reportPath: row.reportPath,
    eventsPath: row.eventsPath,
    verdictPath: row.verdictPath,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  };
}

function mapScore(row: typeof scores.$inferSelect): ScoreRow {
  return {
    id: row.id,
    judgementId: row.judgementId,
    criterion: row.criterion,
    weight: row.weight,
    score: row.score,
    rationale: row.rationale,
  };
}

function mapFinding(row: typeof findings.$inferSelect): FindingRow {
  return {
    fingerprint: row.fingerprint,
    taskId: row.taskId,
    projectId: row.projectId,
    category: row.category,
    kind: row.kind as FindingKind,
    claim: row.claim,
    latestSeverity: row.latestSeverity,
    latestConfidence: row.latestConfidence,
    firstSeenJudgement: row.firstSeenJudgement,
    lastSeenJudgement: row.lastSeenJudgement,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    occurrenceCount: row.occurrenceCount ?? 1,
    resolvedAt: row.resolvedAt,
    status: row.status,
  };
}

function mapOccurrence(
  row: typeof findingOccurrences.$inferSelect,
): OccurrenceRow {
  return {
    id: row.id,
    findingFingerprint: row.findingFingerprint,
    judgementId: row.judgementId,
    runId: row.runId,
    severity: row.severity,
    confidence: row.confidence,
    claim: row.claim,
    criterion: row.criterion,
    refsJson: row.refsJson,
    fixJson: row.fixJson,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function clampLimit(n: number | undefined): number {
  const v = Number.isFinite(n) ? Number(n) : 50;
  return Math.max(1, Math.min(200, Math.floor(v) || 50));
}

function parseCursorOffset(cursor: string | undefined): number {
  if (cursor == null || cursor === "") return 0;
  const n = Number(cursor);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function notFound(kind: string, id: string): Error {
  return new Error(`${kind} not found: ${id}`);
}

/** Map a project_rubrics row to the domain shape (rubric_json parsed). */
function mapProjectRubric(
  row: typeof projectRubrics.$inferSelect,
): ProjectRubric {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    rubric: parseJson<Rubric>(row.rubricJson, {
      criteria: [],
      profile: "bugfix",
      version: 1,
    } as Rubric),
    rubricVersion: row.rubricVersion,
    isDefault: row.isDefault === 1,
    archived: row.archived === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Newest-first ordering shared by both project-rubric list impls
 * (createdAt desc, id desc as a stable tiebreak for same-ms inserts).
 */
function sortProjectRubrics(rows: ProjectRubric[]): ProjectRubric[] {
  return rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return b.id.localeCompare(a.id);
  });
}

/** Default gap for fractional queue positions (leave room for inserts). */
const QUEUE_POSITION_GAP = 1000;

/** Strip webhook secret so it is never leaked after create. */
function stripWebhookSecret(rule: WatcherRule): WatcherRule {
  return { ...rule, webhookSecret: null };
}

/** Parse watcher action_json with a safe default. */
function parseWatcherAction(raw: string | null | undefined): WatcherAction {
  const parsed = parseJson<Partial<WatcherAction>>(raw, {});
  return {
    enqueue: parsed.enqueue === "subset" ? "subset" : "all",
    ...(parsed.taskTags !== undefined ? { taskTags: parsed.taskTags } : {}),
    ...(parsed.repeats !== undefined ? { repeats: parsed.repeats } : {}),
    ...(parsed.adapterOverrides !== undefined
      ? { adapterOverrides: parsed.adapterOverrides }
      : {}),
    ...(parsed.autoJudge !== undefined ? { autoJudge: parsed.autoJudge } : {}),
    ...(parsed.judgeModel !== undefined ? { judgeModel: parsed.judgeModel } : {}),
  };
}

function defaultQueueDedupKey(
  triggerRef: string | null | undefined,
  targetKind: string,
  taskId: string | null | undefined,
  taskTags: string[] | null | undefined,
): string {
  const refPart = triggerRef ?? "";
  if (targetKind === "task") {
    return `${refPart}:task:${taskId ?? ""}`;
  }
  return `${refPart}:tags:${(taskTags ?? []).join(",")}`;
}

/**
 * Fractional indexing for queue order (spreadsheet-row style).
 * - absolute number → use as-is
 * - {after:id} → midpoint between that entry and its next neighbor (or tail gap)
 * - {before:id} → midpoint between previous neighbor and that entry (or head gap)
 * - omitted → append after max (or QUEUE_POSITION_GAP when empty)
 */
function computeFractionalPosition(
  entries: Array<{ id: string; position: number }>,
  opts?: QueuePositionSpec,
): number {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  if (typeof opts === "number" && Number.isFinite(opts)) {
    return opts;
  }
  if (sorted.length === 0) {
    return QUEUE_POSITION_GAP;
  }
  const afterId =
    opts && typeof opts === "object" && "after" in opts ? opts.after : undefined;
  const beforeId =
    opts && typeof opts === "object" && "before" in opts ? opts.before : undefined;

  if (afterId) {
    const idx = sorted.findIndex((e) => e.id === afterId);
    if (idx < 0) {
      return sorted[sorted.length - 1]!.position + QUEUE_POSITION_GAP;
    }
    const a = sorted[idx]!.position;
    if (idx + 1 < sorted.length) {
      return (a + sorted[idx + 1]!.position) / 2;
    }
    return a + QUEUE_POSITION_GAP;
  }

  if (beforeId) {
    const idx = sorted.findIndex((e) => e.id === beforeId);
    if (idx < 0) {
      // Unknown anchor → insert at head (gap below min).
      const min = sorted[0]!.position;
      return min > 0 ? min / 2 : min - QUEUE_POSITION_GAP;
    }
    const b = sorted[idx]!.position;
    if (idx === 0) {
      return b > 0 ? b / 2 : b - QUEUE_POSITION_GAP;
    }
    return (sorted[idx - 1]!.position + b) / 2;
  }

  // Default: append at tail.
  return sorted[sorted.length - 1]!.position + QUEUE_POSITION_GAP;
}

function mapWatcherRuleRow(row: typeof watcherRules.$inferSelect): WatcherRule {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role as WatcherRole,
    repo: row.repo,
    trigger: row.trigger,
    ref: row.ref ?? null,
    semverFilter: row.semverFilter ?? null,
    action: parseWatcherAction(row.actionJson),
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

/** Strip outbound subscription secret so it is never leaked after create. */
function stripOutboundSecret(sub: OutboundSubscription): OutboundSubscription {
  return { ...sub, secret: null };
}

/** Parse event_types_json (JSON array of strings; empty = match-all). */
function parseEventTypes(raw: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === "string");
}

/** Truncate response body stored on delivery rows (cap at 2KB). */
function truncateResponseBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  if (body.length <= 2048) return body;
  return body.slice(0, 2048);
}

function mapOutboundSubscriptionRow(
  row: typeof outboundSubscriptions.$inferSelect,
): OutboundSubscription {
  return {
    id: row.id,
    projectId: row.projectId,
    url: row.url,
    secret: row.secret ?? null,
    eventTypes: parseEventTypes(row.eventTypesJson),
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapWebhookDeliveryRow(
  row: typeof webhookDeliveries.$inferSelect,
): WebhookDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    projectId: row.projectId,
    eventType: row.eventType,
    payload: parseJson<unknown>(row.payloadJson, null),
    status: row.status,
    attempt: row.attempt,
    responseStatus: row.responseStatus ?? null,
    responseBody: row.responseBody ?? null,
    error: row.error ?? null,
    deliveredAt: row.deliveredAt ?? null,
    createdAt: row.createdAt,
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
    judgeModel: row.judgeModel ?? null,
    judgeProvider: row.judgeProvider ?? null,
    autoJudge: row.autoJudge === 1,
    status: row.status,
    activeBatchId: row.activeBatchId ?? null,
    sharedAdapterId: row.sharedAdapterId ?? null,
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

function mapQueueAnalysisRow(
  row: typeof queueAnalyses.$inferSelect,
): QueueAnalysis {
  return {
    id: row.id,
    queueId: row.queueId,
    projectId: row.projectId,
    batchId: row.batchId,
    selectedRunIds: parseJson<string[]>(row.selectedRunIdsJson, []),
    evidenceHashes: parseJson<Record<string, string>>(
      row.evidenceHashesJson,
      {},
    ),
    judgeModel: row.judgeModel,
    judgeProvider: row.judgeProvider,
    judgeParams: parseJson(row.judgeParamsJson, null),
    judgePrompt: row.judgePrompt ?? null,
    systemPromptVersion: row.systemPromptVersion,
    parentAnalysisId: row.parentAnalysisId ?? null,
    status: row.status,
    verdictPath: row.verdictPath ?? null,
    reportPath: row.reportPath ?? null,
    eventsPath: row.eventsPath ?? null,
    rawResponsePath: row.rawResponsePath ?? null,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null,
    error: row.error ?? null,
  };
}

function mapEvalArchiveRow(row: typeof evalArchives.$inferSelect): EvalArchive {
  return {
    runId: row.runId,
    projectId: row.projectId,
    queueId: row.queueId ?? null,
    batchId: row.batchId,
    manifestPath: row.manifestPath,
    manifestSha256: row.manifestSha256,
    sizeBytes: row.sizeBytes,
    sealedAt: row.sealedAt,
  };
}

function mapQueueEntryRow(row: typeof queueEntries.$inferSelect): QueueEntry {
  const auto =
    row.autoJudge == null ? null : row.autoJudge === 1 ? true : false;
  return {
    id: row.id,
    projectId: row.projectId,
    triggerRef: row.triggerRef ?? null,
    targetKind: row.targetKind,
    taskId: row.taskId ?? null,
    taskTags: parseJson<string[] | null>(row.taskTagsJson, null),
    agentId: row.agentId,
    model: row.model ?? null,
    provider: row.provider ?? null,
    repeats: row.repeats ?? null,
    params: parseJson<Record<string, unknown> | null>(row.paramsJson, null),
    adapterOverrides: parseJson<Record<string, unknown> | null>(
      row.adapterOverridesJson,
      null,
    ),
    autoJudge: auto,
    judgeModel: row.judgeModel ?? null,
    priority: row.priority ?? 0,
    position: row.position,
    status: row.status,
    dedupKey: row.dedupKey ?? null,
    source: row.source ?? null,
    createdAt: row.createdAt,
    promotedAt: row.promotedAt ?? null,
    promotedBatchId: row.promotedBatchId ?? null,
    removedAt: row.removedAt ?? null,
  };
}

function sortQueueEntries(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

function tasksMatchingTags(
  all: Task[],
  tags: string[] | null | undefined,
): Task[] {
  if (!tags || tags.length === 0) return [...all];
  const want = new Set(tags);
  return all.filter((t) => (t.tags ?? []).some((tag) => want.has(tag)));
}

// ---------------------------------------------------------------------------
// SqliteQueries
// ---------------------------------------------------------------------------

export class SqliteQueries implements QueryStore {
  constructor(
    private readonly db: DrizzleDb,
    private readonly dataDir: string,
  ) {}

  // ---- projects ----

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
      defaultJudgeModel: input.defaultJudgeModel ?? null,
      workspaceImage: input.workspaceImage ?? null,
      checkRunnersJson: stringifyJson(input.checkRunners ?? null),
      adapterOverridesJson: stringifyJson(input.adapterOverrides ?? null),
      networkPolicy: input.networkPolicy ?? "allow",
      retentionRuns: input.retentionRuns ?? null,
      artifactRetention: resolveRetentionPolicy(
        input.artifactRetention ?? DEFAULT_ARTIFACT_RETENTION,
      ),
      sandboxJson: stringifyJson(input.sandbox ?? null),
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
        defaultJudgeModel:
          patch.defaultJudgeModel !== undefined
            ? patch.defaultJudgeModel
            : existing.defaultJudgeModel,
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
        artifactRetention:
          patch.artifactRetention !== undefined
            ? resolveRetentionPolicy(patch.artifactRetention)
            : existing.artifactRetention,
        sandboxJson:
          patch.sandbox !== undefined
            ? stringifyJson(patch.sandbox)
            : stringifyJson(existing.sandbox),
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
        profile: spec.profile ?? spec.rubric.profile ?? null,
        referenceSolution: spec.referenceSolution ?? null,
        checksJson: stringifyJson(checks),
        envJson: stringifyJson(spec.env ?? null),
        tags: stringifyJson(spec.tags ?? null),
        sourceKind: opts.sourceKind ?? null,
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

  // ---- batches + runs ----

  createBatch(input: CreateBatchInput): RunBatch {
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db
      .insert(runBatches)
      .values({
        id,
        taskId: input.taskId,
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

  // ---- judgements + scores (P4c) ----

  createJudgement(input: CreateJudgementInput): Judgement {
    const id = input.id ?? newId();
    const ts = nowIso();
    const eventsPath = judgeEventsPath(this.dataDir, input.projectId, id);
    const jVerdictPath = verdictPath(this.dataDir, input.projectId, id);
    this.db
      .insert(judgements)
      .values({
        id,
        runId: input.runId,
        projectId: input.projectId,
        queueAnalysisId: input.queueAnalysisId ?? null,
        judgeModel: input.judgeModel,
        judgeProvider: input.judgeProvider,
        judgePrompt: input.judgePrompt ?? null,
        systemPromptVersion: input.systemPromptVersion,
        status: input.status,
        overallScore: null,
        verdict: null,
        reportPath: null,
        eventsPath,
        verdictPath: jVerdictPath,
        createdAt: ts,
        endedAt: null,
      })
      .run();
    const row = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, id))
      .get();
    if (!row) throw new Error("failed to create judgement");
    const mapped = mapJudgement(row);
    writeSnapshot(
      judgementSnapshotPath(this.dataDir, mapped.projectId, mapped.id),
      mapped,
    );
    // Ensure the judgement dir exists so judge.jsonl can be appended later.
    try {
      mkdirSync(judgementDir(this.dataDir, mapped.projectId, mapped.id), {
        recursive: true,
      });
    } catch {
      // best-effort
    }
    return mapped;
  }

  createScores(
    judgementId: string,
    scoreInputs: CreateScoreInput[],
  ): ScoreRow[] {
    const existing = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, judgementId))
      .get();
    if (!existing) throw notFound("judgement", judgementId);
    const out: ScoreRow[] = [];
    for (const s of scoreInputs) {
      const id = newId();
      this.db
        .insert(scores)
        .values({
          id,
          judgementId,
          criterion: s.criterion,
          weight: s.weight,
          score: s.score,
          rationale: s.rationale ?? null,
        })
        .run();
      const row = this.db
        .select()
        .from(scores)
        .where(eq(scores.id, id))
        .get();
      if (row) out.push(mapScore(row));
    }
    return out;
  }

  storeVerdict(judgementId: string, verdict: Verdict): JudgementWithVerdict {
    const existing = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, judgementId))
      .get();
    if (!existing) throw notFound("judgement", judgementId);
    const projectId = existing.projectId;
    const jVerdictPath =
      existing.verdictPath ??
      verdictPath(this.dataDir, projectId, judgementId);
    const eventsPath =
      existing.eventsPath ??
      judgeEventsPath(this.dataDir, projectId, judgementId);

    // Write verdict.json first (source of truth on disk).
    writeSnapshot(jVerdictPath, verdict);

    // Replace any existing per-criterion scores with the verdict's criteria.
    this.db.delete(scores).where(eq(scores.judgementId, judgementId)).run();
    const scoreInputs: CreateScoreInput[] = (verdict.criteria ?? []).map(
      (c) => ({
        criterion: c.criterion,
        weight: c.weight,
        score: c.score,
        rationale: c.feedback,
      }),
    );
    this.createScores(judgementId, scoreInputs);

    const endedAt = nowIso();
    this.db
      .update(judgements)
      .set({
        status: "completed",
        overallScore: verdict.overall?.score ?? null,
        verdict: verdict.overall?.verdict ?? null,
        verdictPath: jVerdictPath,
        eventsPath,
        endedAt,
      })
      .where(eq(judgements.id, judgementId))
      .run();

    // P6a: ingest findings after score mirror. Errors are swallowed so a
    // findings-ingest glitch cannot break verdict persistence. Goes through the
    // public ingestFindings method so tests can force-fail it for isolation.
    try {
      this.ingestFindings(judgementId, verdict);
    } catch (err) {
      console.warn(
        `[findings] ingest failed for judgement ${judgementId}:`,
        err,
      );
    }

    const row = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, judgementId))
      .get();
    if (!row) throw notFound("judgement", judgementId);
    const mapped = mapJudgement(row);
    writeSnapshot(
      judgementSnapshotPath(this.dataDir, mapped.projectId, mapped.id),
      mapped,
    );
    // Prefer the post-ingest on-disk body (may include Finding.recurring).
    const verdictBody =
      readVerdictFromDisk(
        this.dataDir,
        mapped.projectId,
        mapped.id,
        jVerdictPath,
      ) ?? verdict;
    return { ...mapped, verdictBody };
  }

  /**
   * Resolve taskId from the run, run pure ingest, rewrite verdict.json with
   * recurrence annotations. Shared by storeVerdict + public ingestFindings.
   */
  private ingestFindingsAndRewrite(
    judgementId: string,
    runId: string,
    projectId: string,
    jVerdictPath: string,
    verdict: Verdict,
  ): Verdict {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(
        `cannot ingest findings: run not found for judgement ${judgementId} (runId=${runId})`,
      );
    }
    const store = this.asFindingsStore();
    const result = runIngestFindings(store, {
      judgementId,
      runId,
      projectId,
      taskId: run.taskId,
      verdict,
    });
    const withRecurring = applyRecurrenceToVerdict(
      verdict,
      result.recurringByFindingId,
    );
    // Rewrite verdict.json in the SAME call (single-threaded SQLite) so the
    // report + API see Finding.recurring without a separate race-prone pass.
    writeSnapshot(jVerdictPath, withRecurring);
    return withRecurring;
  }

  /** Public entry — re-ingests a stored judgement's verdict (or a fresh one). */
  ingestFindings(judgementId: string, verdict: Verdict): void {
    const existing = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, judgementId))
      .get();
    if (!existing) throw notFound("judgement", judgementId);
    const jVerdictPath =
      existing.verdictPath ??
      verdictPath(this.dataDir, existing.projectId, judgementId);
    this.ingestFindingsAndRewrite(
      judgementId,
      existing.runId,
      existing.projectId,
      jVerdictPath,
      verdict,
    );
  }

  /** Adapter: SqliteQueries → FindingsIngestStore for the pure state machine. */
  private asFindingsStore(): FindingsIngestStore {
    const self = this;
    return {
      findFindingForTask(taskId, fingerprint) {
        const row = self.db
          .select()
          .from(findings)
          .where(eq(findings.fingerprint, fingerprint))
          .get();
        if (!row) return null;
        // Fingerprints are task-scoped: only match when taskId agrees.
        if (row.taskId !== taskId) return null;
        return mapFinding(row);
      },
      insertFinding(row) {
        self.db
          .insert(findings)
          .values({
            fingerprint: row.fingerprint,
            taskId: row.taskId,
            projectId: row.projectId,
            category: row.category,
            kind: row.kind,
            claim: row.claim,
            latestSeverity: row.latestSeverity,
            latestConfidence: row.latestConfidence,
            firstSeenJudgement: row.firstSeenJudgement,
            lastSeenJudgement: row.lastSeenJudgement,
            firstSeenAt: row.firstSeenAt,
            lastSeenAt: row.lastSeenAt,
            occurrenceCount: row.occurrenceCount,
            resolvedAt: row.resolvedAt,
            status: row.status,
          })
          .run();
      },
      updateFinding(fingerprint, patch) {
        self.db
          .update(findings)
          .set({
            ...(patch.claim !== undefined ? { claim: patch.claim } : {}),
            ...(patch.latestSeverity !== undefined
              ? { latestSeverity: patch.latestSeverity }
              : {}),
            ...(patch.latestConfidence !== undefined
              ? { latestConfidence: patch.latestConfidence }
              : {}),
            ...(patch.lastSeenJudgement !== undefined
              ? { lastSeenJudgement: patch.lastSeenJudgement }
              : {}),
            ...(patch.lastSeenAt !== undefined
              ? { lastSeenAt: patch.lastSeenAt }
              : {}),
            ...(patch.occurrenceCount !== undefined
              ? { occurrenceCount: patch.occurrenceCount }
              : {}),
            ...(patch.resolvedAt !== undefined
              ? { resolvedAt: patch.resolvedAt }
              : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.firstSeenJudgement !== undefined
              ? { firstSeenJudgement: patch.firstSeenJudgement }
              : {}),
            ...(patch.firstSeenAt !== undefined
              ? { firstSeenAt: patch.firstSeenAt }
              : {}),
          })
          .where(eq(findings.fingerprint, fingerprint))
          .run();
      },
      insertOccurrence(row) {
        self.db
          .insert(findingOccurrences)
          .values({
            id: row.id,
            findingFingerprint: row.findingFingerprint,
            judgementId: row.judgementId,
            runId: row.runId,
            severity: row.severity,
            confidence: row.confidence,
            claim: row.claim,
            criterion: row.criterion,
            refsJson: row.refsJson,
            fixJson: row.fixJson,
            status: row.status,
            createdAt: row.createdAt,
          })
          .run();
      },
      listFindingsForTask(taskId) {
        return self.db
          .select()
          .from(findings)
          .where(eq(findings.taskId, taskId))
          .all()
          .map(mapFinding);
      },
      getJudgementRunId(judgementId) {
        const row = self.db
          .select()
          .from(judgements)
          .where(eq(judgements.id, judgementId))
          .get();
        return row?.runId ?? null;
      },
      now: () => nowIso(),
      newId: () => newId(),
    };
  }

  listFindings(filter: ListFindingsFilter = {}): FindingRow[] {
    let rows = this.db.select().from(findings).all().map(mapFinding);
    if (filter.projectId) {
      rows = rows.filter((f) => f.projectId === filter.projectId);
    }
    if (filter.taskId) {
      rows = rows.filter((f) => f.taskId === filter.taskId);
    }
    if (filter.status) {
      rows = rows.filter((f) => f.status === filter.status);
    }
    if (filter.kind) {
      rows = rows.filter((f) => f.kind === filter.kind);
    }
    if (filter.category) {
      rows = rows.filter((f) => f.category === filter.category);
    }
    // Newest lastSeen first, then fingerprint for stability.
    rows.sort((a, b) => {
      const ta = a.lastSeenAt ?? "";
      const tb = b.lastSeenAt ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return a.fingerprint.localeCompare(b.fingerprint);
    });
    return rows;
  }

  getFinding(fingerprint: string): FindingDetail | null {
    const row = this.db
      .select()
      .from(findings)
      .where(eq(findings.fingerprint, fingerprint))
      .get();
    if (!row) return null;
    const base = mapFinding(row);
    const occurrences = this.listOccurrences(fingerprint);
    return { ...base, occurrences };
  }

  listOccurrences(findingFingerprint: string): OccurrenceRow[] {
    const rows = this.db
      .select()
      .from(findingOccurrences)
      .where(eq(findingOccurrences.findingFingerprint, findingFingerprint))
      .all()
      .map(mapOccurrence);
    // Newest first.
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.id.localeCompare(a.id);
    });
    return rows;
  }

  getJudgement(id: string): JudgementWithVerdict | null {
    const row = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, id))
      .get();
    if (!row) return null;
    const mapped = mapJudgement(row);
    const body = readVerdictFromDisk(
      this.dataDir,
      mapped.projectId,
      mapped.id,
      mapped.verdictPath,
    );
    return { ...mapped, verdictBody: body };
  }

  listJudgements(filter: ListJudgementsFilter = {}): ListJudgementsResult {
    const limit = clampLimit(filter.limit);
    const offset = parseCursorOffset(filter.cursor);

    // Filter in-app so MemoryQueries and Sqlite stay aligned without
    // complex dynamic WHERE composition for every filter combo.
    let rows = this.db.select().from(judgements).all().map(mapJudgement);
    if (filter.projectId) {
      rows = rows.filter((j) => j.projectId === filter.projectId);
    }
    if (filter.runId) {
      rows = rows.filter((j) => j.runId === filter.runId);
    }
    if (filter.status) {
      rows = rows.filter((j) => j.status === filter.status);
    }
    // Newest first (createdAt desc, then id).
    rows.sort((a, b) => {
      const ca = a.createdAt ?? "";
      const cb = b.createdAt ?? "";
      if (ca !== cb) return cb.localeCompare(ca);
      return b.id.localeCompare(a.id);
    });
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < rows.length ? String(nextOffset) : null;
    return { judgements: page, nextCursor };
  }

  setJudgementStatus(
    id: string,
    status: JudgementStatus | string,
    endedAt?: string | null,
  ): Judgement {
    const existing = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, id))
      .get();
    if (!existing) throw notFound("judgement", id);
    const patch: {
      status: string;
      endedAt?: string | null;
    } = { status };
    if (endedAt !== undefined) {
      patch.endedAt = endedAt;
    } else if (status === "completed" || status === "failed") {
      patch.endedAt = existing.endedAt ?? nowIso();
    }
    this.db
      .update(judgements)
      .set(patch)
      .where(eq(judgements.id, id))
      .run();
    const row = this.db
      .select()
      .from(judgements)
      .where(eq(judgements.id, id))
      .get();
    if (!row) throw notFound("judgement", id);
    const mapped = mapJudgement(row);
    writeSnapshot(
      judgementSnapshotPath(this.dataDir, mapped.projectId, mapped.id),
      mapped,
    );
    return mapped;
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
        role: input.role,
        repo: input.repo,
        trigger: input.trigger,
        ref: input.ref ?? null,
        semverFilter: input.semverFilter ?? null,
        actionJson: JSON.stringify(input.action),
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
      actionJson:
        patch.action !== undefined
          ? JSON.stringify(patch.action)
          : existing.actionJson,
      enabled:
        patch.enabled !== undefined
          ? patch.enabled
            ? 1
            : 0
          : existing.enabled,
      repo: patch.repo !== undefined ? patch.repo : existing.repo,
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

  // ---- eval queue (P8a) ----

  createQueueEntry(
    projectId: string,
    input: CreateQueueEntryInput,
  ): QueueEntry {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    const existing = this.db
      .select()
      .from(queueEntries)
      .where(eq(queueEntries.projectId, projectId))
      .all()
      .map(mapQueueEntryRow);
    const position = computeFractionalPosition(
      existing.map((e) => ({ id: e.id, position: e.position })),
      input.position,
    );
    const taskTags = input.taskTags ?? null;
    let dedupKey: string | null;
    if (input.dedupKey !== undefined) {
      dedupKey = input.dedupKey;
    } else if (input.source === "manual") {
      dedupKey = null;
    } else {
      dedupKey = defaultQueueDedupKey(
        input.triggerRef ?? null,
        input.targetKind,
        input.taskId ?? null,
        taskTags,
      );
    }
    const id = newId();
    const ts = nowIso();
    this.db
      .insert(queueEntries)
      .values({
        id,
        projectId,
        triggerRef: input.triggerRef ?? null,
        targetKind: input.targetKind,
        taskId: input.taskId ?? null,
        taskTagsJson: taskTags ? JSON.stringify(taskTags) : null,
        agentId: input.agentId,
        model: input.model ?? null,
        provider: input.provider ?? null,
        repeats: input.repeats ?? null,
        paramsJson:
          input.params !== undefined && input.params !== null
            ? JSON.stringify(input.params)
            : null,
        adapterOverridesJson:
          input.adapterOverrides !== undefined &&
          input.adapterOverrides !== null
            ? JSON.stringify(input.adapterOverrides)
            : null,
        autoJudge:
          input.autoJudge === undefined || input.autoJudge === null
            ? null
            : input.autoJudge
              ? 1
              : 0,
        judgeModel: input.judgeModel ?? null,
        priority: input.priority ?? 0,
        position,
        status: "queued",
        dedupKey,
        source: input.source ?? null,
        createdAt: ts,
        promotedAt: null,
        promotedBatchId: null,
        removedAt: null,
      })
      .run();
    const row = this.getQueueEntry(id);
    if (!row) throw new Error("failed to create queue entry");
    return row;
  }

  getQueueEntry(id: string): QueueEntry | null {
    const row = this.db
      .select()
      .from(queueEntries)
      .where(eq(queueEntries.id, id))
      .get();
    return row ? mapQueueEntryRow(row) : null;
  }

  listQueueEntries(
    projectId: string,
    opts: { status?: string } = {},
  ): QueueEntry[] {
    const rows = this.db
      .select()
      .from(queueEntries)
      .where(eq(queueEntries.projectId, projectId))
      .all()
      .map(mapQueueEntryRow);
    const filtered =
      opts.status !== undefined
        ? rows.filter((e) => e.status === opts.status)
        : rows;
    return sortQueueEntries(filtered);
  }

  reorderQueueEntry(id: string, opts: ReorderQueueEntryOpts): QueueEntry {
    const existing = this.getQueueEntry(id);
    if (!existing) throw notFound("queue entry", id);
    const siblings = this.db
      .select()
      .from(queueEntries)
      .where(eq(queueEntries.projectId, existing.projectId))
      .all()
      .map(mapQueueEntryRow)
      .filter((e) => e.id !== id);
    let position = existing.position;
    if (opts.position !== undefined) {
      position = opts.position;
    } else if (opts.after !== undefined || opts.before !== undefined) {
      const spec: QueuePositionSpec =
        opts.after !== undefined
          ? { after: opts.after }
          : { before: opts.before };
      position = computeFractionalPosition(
        siblings.map((e) => ({ id: e.id, position: e.position })),
        spec,
      );
    }
    const priority =
      opts.priority !== undefined ? opts.priority : existing.priority;
    this.db
      .update(queueEntries)
      .set({ position, priority })
      .where(eq(queueEntries.id, id))
      .run();
    const row = this.getQueueEntry(id);
    if (!row) throw notFound("queue entry", id);
    return row;
  }

  promoteQueueEntry(id: string): PromoteQueueEntryResult {
    const entry = this.getQueueEntry(id);
    if (!entry) throw notFound("queue entry", id);
    if (entry.status === "promoted") {
      // Idempotent-ish: return existing promotion metadata when available.
      if (entry.promotedBatchId) {
        const runIds = this.listRuns({ batchId: entry.promotedBatchId }).map(
          (r) => r.id,
        );
        return {
          entry,
          batchId: entry.promotedBatchId,
          runIds,
          batchIds: [entry.promotedBatchId],
        };
      }
    }
    if (entry.status !== "queued") {
      throw new Error(
        `cannot promote queue entry ${id}: status is ${entry.status}`,
      );
    }

    let targetTasks: Task[] = [];
    if (entry.targetKind === "task") {
      if (!entry.taskId) {
        throw new Error(
          `cannot promote queue entry ${id}: target_kind=task but taskId is missing`,
        );
      }
      const t = this.getTask(entry.taskId);
      if (!t || t.projectId !== entry.projectId) {
        throw new Error(
          `cannot promote queue entry ${id}: task not found: ${entry.taskId}`,
        );
      }
      targetTasks = [t];
    } else {
      const all = this.listTasks(entry.projectId);
      targetTasks = tasksMatchingTags(all, entry.taskTags);
      if (targetTasks.length === 0) {
        throw new Error(
          `cannot promote queue entry ${id}: no tasks match tags ${(entry.taskTags ?? []).join(",") || "(none)"}`,
        );
      }
    }

    const project = this.getProject(entry.projectId);
    const agent = this.getAgent(entry.agentId);
    const model =
      entry.model ?? project?.defaultModel ?? agent?.defaultModel ?? "unknown";
    const provider =
      entry.provider ??
      project?.defaultProvider ??
      agent?.defaultProvider ??
      "unknown";
    const repeats = entry.repeats ?? 1;
    const params = entry.params ?? {};
    const agentImage =
      entry.adapterOverrides &&
      typeof entry.adapterOverrides.imageTag === "string"
        ? String(entry.adapterOverrides.imageTag)
        : undefined;
    // Queue entries are not watcher rules — triggerRuleId stays null.
    const trigger =
      entry.source === "watcher"
        ? "webhook"
        : entry.source === "manual"
          ? "manual"
          : entry.source === "ci"
            ? "manual"
            : entry.source === "api"
              ? "manual"
              : entry.source ?? "manual";

    const batchIds: string[] = [];
    const runIds: string[] = [];
    for (const task of targetTasks) {
      const batch = this.createBatch({
        taskId: task.id,
        projectId: entry.projectId,
        agentId: entry.agentId,
        model,
        provider,
        params,
        repeats,
        trigger,
        triggerRef: entry.triggerRef ?? undefined,
        agentImage,
      });
      batchIds.push(batch.id);
      for (let i = 0; i < repeats; i++) {
        const run = this.createRun({
          batchId: batch.id,
          taskId: task.id,
          projectId: entry.projectId,
          agentId: entry.agentId,
          model,
          provider,
          repeatIndex: i,
          status: "queued",
          trigger,
          triggerRef: entry.triggerRef ?? undefined,
          agentImage,
          // Queue promote: triggerRuleId null (not a rule).
          triggerRuleId: undefined,
        });
        runIds.push(run.id);
      }
    }

    const firstBatchId = batchIds[0]!;
    const promotedAt = nowIso();
    this.db
      .update(queueEntries)
      .set({
        status: "promoted",
        promotedAt,
        promotedBatchId: firstBatchId,
      })
      .where(eq(queueEntries.id, id))
      .run();
    const updated = this.getQueueEntry(id);
    if (!updated) throw notFound("queue entry", id);
    return {
      entry: updated,
      batchId: firstBatchId,
      runIds,
      batchIds,
    };
  }

  removeQueueEntry(id: string): QueueEntry {
    const existing = this.getQueueEntry(id);
    if (!existing) throw notFound("queue entry", id);
    if (existing.status === "removed") {
      return existing;
    }
    const removedAt = nowIso();
    this.db
      .update(queueEntries)
      .set({ status: "removed", removedAt })
      .where(eq(queueEntries.id, id))
      .run();
    const row = this.getQueueEntry(id);
    if (!row) throw notFound("queue entry", id);
    return row;
  }

  drainQueue(projectId: string): { removed: number } {
    const queued = this.listQueueEntries(projectId, { status: "queued" });
    const removedAt = nowIso();
    for (const e of queued) {
      this.db
        .update(queueEntries)
        .set({ status: "removed", removedAt })
        .where(eq(queueEntries.id, e.id))
        .run();
    }
    return { removed: queued.length };
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
      portsJson: stringifyJson(input.ports ?? []), judgeModel: input.judgeModel ?? null,
      judgeProvider: input.judgeProvider ?? null,
      autoJudge: input.autoJudge === false ? 0 : 1, status: "draft",
      activeBatchId: null, sharedAdapterId: input.sharedAdapterId ?? null,
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
    if (patch.judgeModel !== undefined) values.judgeModel = patch.judgeModel;
    if (patch.judgeProvider !== undefined) values.judgeProvider = patch.judgeProvider;
    if (patch.autoJudge !== undefined) values.autoJudge = patch.autoJudge ? 1 : 0;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.activeBatchId !== undefined) values.activeBatchId = patch.activeBatchId;
    if (patch.sharedAdapterId !== undefined) values.sharedAdapterId = patch.sharedAdapterId;
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
      overridesJson: stringifyJson(input.overrides ?? null), createdAt: ts, updatedAt: ts,
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
      .map(mapEvalQueueItemRow).filter((i) => opts.includeDisabled === true || i.enabled)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
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
    this.db.delete(evalQueueItems).where(eq(evalQueueItems.id, id)).run();
    this.updateEvalQueue(existing.queueId, { incrementRevision: true });
  }

  createQueueContainer(input: CreateQueueContainerInput): QueueContainer {
    const active = this.getActiveQueueContainer(input.queueId);
    if (active) throw new Error(`eval queue ${input.queueId} already has active container ${active.id}`);
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db.insert(queueContainers).values({
      id, queueId: input.queueId, projectId: input.projectId, batchId: input.batchId,
      runtimeContainerId: input.runtimeContainerId ?? null, image: input.image,
      state: input.state, portsJson: stringifyJson(input.ports ?? []), workspaceDir: input.workspaceDir,
      startedAt: input.startedAt ?? null, stoppedAt: null, error: input.error ?? null,
      createdAt: ts, updatedAt: ts,
    }).run();
    return this.getQueueContainer(id)!;
  }

  getQueueContainer(id: string): QueueContainer | null {
    const row = this.db.select().from(queueContainers).where(eq(queueContainers.id, id)).get();
    return row ? mapQueueContainerRow(row) : null;
  }

  getActiveQueueContainer(queueId: string): QueueContainer | null {
    return this.listQueueContainers(queueId).find(
      (c) => c.state !== "stopped" && c.runtimeContainerId !== null && c.stoppedAt === null,
    ) ?? null;
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

  createQueueAnalysis(input: CreateQueueAnalysisInput): QueueAnalysis {
    const id = input.id ?? newId();
    const ts = nowIso();
    this.db.insert(queueAnalyses).values({
      id,
      queueId: input.queueId,
      projectId: input.projectId,
      batchId: input.batchId,
      selectedRunIdsJson: JSON.stringify(input.selectedRunIds),
      evidenceHashesJson: JSON.stringify(input.evidenceHashes),
      judgeModel: input.judgeModel,
      judgeProvider: input.judgeProvider,
      judgeParamsJson: stringifyJson(input.judgeParams ?? null),
      judgePrompt: input.judgePrompt ?? null,
      systemPromptVersion: input.systemPromptVersion,
      parentAnalysisId: input.parentAnalysisId ?? null,
      status: input.status ?? "queued",
      verdictPath: null,
      reportPath: null,
      eventsPath: null,
      rawResponsePath: null,
      createdAt: ts,
      startedAt: null,
      endedAt: null,
      error: null,
    }).run();
    return this.getQueueAnalysis(id)!;
  }

  getQueueAnalysis(id: string): QueueAnalysis | null {
    const row = this.db.select().from(queueAnalyses).where(eq(queueAnalyses.id, id)).get();
    return row ? mapQueueAnalysisRow(row) : null;
  }

  listQueueAnalyses(queueId: string, opts: { batchId?: string } = {}): QueueAnalysis[] {
    return this.db.select().from(queueAnalyses).where(eq(queueAnalyses.queueId, queueId)).all()
      .map(mapQueueAnalysisRow).filter((a) => !opts.batchId || a.batchId === opts.batchId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateQueueAnalysis(id: string, patch: UpdateQueueAnalysisInput): QueueAnalysis {
    if (!this.getQueueAnalysis(id)) throw notFound("queue analysis", id);
    const values: Partial<typeof queueAnalyses.$inferInsert> = {};
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.verdictPath !== undefined) values.verdictPath = patch.verdictPath;
    if (patch.reportPath !== undefined) values.reportPath = patch.reportPath;
    if (patch.eventsPath !== undefined) values.eventsPath = patch.eventsPath;
    if (patch.rawResponsePath !== undefined) values.rawResponsePath = patch.rawResponsePath;
    if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
    if (patch.endedAt !== undefined) values.endedAt = patch.endedAt;
    if (patch.error !== undefined) values.error = patch.error;
    this.db.update(queueAnalyses).set(values).where(eq(queueAnalyses.id, id)).run();
    return this.getQueueAnalysis(id)!;
  }

  storeEvalArchive(input: StoreEvalArchiveInput): EvalArchive {
    const sealedAt = input.sealedAt ?? nowIso();
    this.db.insert(evalArchives).values({
      runId: input.runId, projectId: input.projectId, queueId: input.queueId ?? null,
      batchId: input.batchId, manifestPath: input.manifestPath,
      manifestSha256: input.manifestSha256, sizeBytes: input.sizeBytes, sealedAt,
    }).onConflictDoUpdate({
      target: evalArchives.runId,
      set: { manifestPath: input.manifestPath, manifestSha256: input.manifestSha256,
        sizeBytes: input.sizeBytes, sealedAt },
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
    const queue = this.listQueueEntries(projectId);
    const outboundWebhooks = this.listOutboundSubscriptions(projectId);
    return {
      project,
      tasks: taskList,
      runs: runList,
      watchers,
      queue,
      outboundWebhooks,
    };
  }

  // ---- Outbound webhooks (P8c) ----

  createOutboundSubscription(
    projectId: string,
    input: CreateOutboundSubscriptionInput,
  ): OutboundSubscription {
    if (!this.getProject(projectId)) throw notFound("project", projectId);
    const id = newId();
    const ts = nowIso();
    const secret =
      input.secret !== undefined && input.secret !== ""
        ? input.secret
        : `${newId()}-${newId()}`;
    const eventTypes = Array.isArray(input.eventTypes) ? input.eventTypes : [];
    const enabled = input.enabled === false ? 0 : 1;
    this.db
      .insert(outboundSubscriptions)
      .values({
        id,
        projectId,
        url: input.url,
        secret,
        eventTypesJson: JSON.stringify(eventTypes),
        enabled,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    const row = this.db
      .select()
      .from(outboundSubscriptions)
      .where(eq(outboundSubscriptions.id, id))
      .get();
    if (!row) throw new Error("failed to create outbound subscription");
    // Return WITH secret present — only create surfaces it.
    return mapOutboundSubscriptionRow(row);
  }

  getOutboundSubscription(id: string): OutboundSubscription | null {
    const row = this.db
      .select()
      .from(outboundSubscriptions)
      .where(eq(outboundSubscriptions.id, id))
      .get();
    return row ? stripOutboundSecret(mapOutboundSubscriptionRow(row)) : null;
  }

  /**
   * Raw signing secret for outbound HMAC. NEVER log the return value.
   */
  getOutboundSubscriptionWithSecret(id: string): string | null {
    const row = this.db
      .select()
      .from(outboundSubscriptions)
      .where(eq(outboundSubscriptions.id, id))
      .get();
    if (!row) return null;
    const secret = row.secret;
    if (secret == null || secret === "") return null;
    return secret;
  }

  listOutboundSubscriptions(projectId: string): OutboundSubscription[] {
    const rows = this.db
      .select()
      .from(outboundSubscriptions)
      .where(eq(outboundSubscriptions.projectId, projectId))
      .all();
    return rows
      .map(mapOutboundSubscriptionRow)
      .map(stripOutboundSecret);
  }

  updateOutboundSubscription(
    id: string,
    patch: UpdateOutboundSubscriptionPatch,
  ): OutboundSubscription {
    const existing = this.db
      .select()
      .from(outboundSubscriptions)
      .where(eq(outboundSubscriptions.id, id))
      .get();
    if (!existing) throw notFound("outbound subscription", id);
    const next = {
      url: patch.url !== undefined ? patch.url : existing.url,
      eventTypesJson:
        patch.eventTypes !== undefined
          ? JSON.stringify(patch.eventTypes)
          : existing.eventTypesJson,
      enabled:
        patch.enabled !== undefined
          ? patch.enabled
            ? 1
            : 0
          : existing.enabled,
      updatedAt: nowIso(),
    };
    this.db
      .update(outboundSubscriptions)
      .set(next)
      .where(eq(outboundSubscriptions.id, id))
      .run();
    const row = this.db
      .select()
      .from(outboundSubscriptions)
      .where(eq(outboundSubscriptions.id, id))
      .get();
    if (!row) throw notFound("outbound subscription", id);
    return stripOutboundSecret(mapOutboundSubscriptionRow(row));
  }

  deleteOutboundSubscription(id: string): void {
    // Cascade-delete deliveries first so FK integrity holds.
    this.db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, id))
      .run();
    this.db
      .delete(outboundSubscriptions)
      .where(eq(outboundSubscriptions.id, id))
      .run();
  }

  recordWebhookDelivery(input: RecordWebhookDeliveryInput): WebhookDelivery {
    const id = newId();
    const ts = nowIso();
    this.db
      .insert(webhookDeliveries)
      .values({
        id,
        subscriptionId: input.subscriptionId,
        projectId: input.projectId,
        eventType: input.eventType,
        payloadJson: JSON.stringify(input.payload ?? null),
        status: input.status,
        attempt: input.attempt,
        responseStatus: input.responseStatus ?? null,
        responseBody: truncateResponseBody(input.responseBody ?? null),
        error: input.error ?? null,
        deliveredAt: input.deliveredAt ?? null,
        createdAt: ts,
      })
      .run();
    const row = this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .get();
    if (!row) throw new Error("failed to record webhook delivery");
    return mapWebhookDeliveryRow(row);
  }

  listWebhookDeliveries(
    projectId: string,
    opts: ListWebhookDeliveriesOpts = {},
  ): WebhookDelivery[] {
    let rows = this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, projectId))
      .all()
      .map(mapWebhookDeliveryRow);
    if (opts.subscriptionId !== undefined) {
      rows = rows.filter((d) => d.subscriptionId === opts.subscriptionId);
    }
    if (opts.eventType !== undefined) {
      rows = rows.filter((d) => d.eventType === opts.eventType);
    }
    if (opts.status !== undefined) {
      rows = rows.filter((d) => d.status === opts.status);
    }
    // Newest first.
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.id.localeCompare(a.id);
    });
    const limit =
      opts.limit != null && Number.isFinite(opts.limit)
        ? Math.max(1, Math.min(200, Math.floor(opts.limit)))
        : 50;
    return rows.slice(0, limit);
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

  // ---- project rubrics ----

  createProjectRubric(input: CreateProjectRubricInput): ProjectRubric {
    const project = this.getProject(input.projectId);
    if (!project) throw notFound("project", input.projectId);
    const id = input.id ?? newId();
    const ts = nowIso();
    // Only one default per project — demote any incumbent first.
    if (input.isDefault) this.clearDefaultRubric(input.projectId);
    this.db
      .insert(projectRubrics)
      .values({
        id,
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? null,
        rubricJson: JSON.stringify(input.rubric),
        rubricVersion: input.rubric.version ?? 1,
        isDefault: input.isDefault ? 1 : 0,
        archived: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    const row = this.getProjectRubric(id);
    if (!row) throw new Error("failed to create project rubric");
    return row;
  }

  /** Demote whichever rubric currently holds the default flag for a project. */
  private clearDefaultRubric(projectId: string): void {
    this.db
      .update(projectRubrics)
      .set({ isDefault: 0 })
      .where(eq(projectRubrics.projectId, projectId))
      .run();
  }

  getProjectRubric(id: string): ProjectRubric | null {
    const row = this.db
      .select()
      .from(projectRubrics)
      .where(eq(projectRubrics.id, id))
      .get();
    return row ? mapProjectRubric(row) : null;
  }

  listProjectRubrics(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): ProjectRubric[] {
    const rows = this.db
      .select()
      .from(projectRubrics)
      .where(eq(projectRubrics.projectId, projectId))
      .all()
      .map(mapProjectRubric)
      .filter((r) => (opts.includeArchived ? true : !r.archived));
    return sortProjectRubrics(rows);
  }

  getDefaultProjectRubric(projectId: string): ProjectRubric | null {
    return (
      this.listProjectRubrics(projectId).find((r) => r.isDefault) ?? null
    );
  }

  updateProjectRubric(
    id: string,
    patch: UpdateProjectRubricInput,
  ): ProjectRubric {
    const existing = this.getProjectRubric(id);
    if (!existing) throw notFound("project rubric", id);
    // A semantic rubric edit establishes a new comparison baseline; a rename or
    // description tweak does not (same rule as task rubrics — plan/rubric.md).
    const rubricChanged =
      patch.rubric !== undefined && !rubricsEqual(existing.rubric, patch.rubric);
    const nextVersion = rubricChanged
      ? Math.max(existing.rubricVersion, patch.rubric?.version ?? 0) + 1
      : existing.rubricVersion;
    const nextRubric = patch.rubric ?? existing.rubric;
    if (patch.isDefault) this.clearDefaultRubric(existing.projectId);
    this.db
      .update(projectRubrics)
      .set({
        name: patch.name ?? existing.name,
        description:
          patch.description !== undefined
            ? patch.description
            : existing.description,
        rubricJson: JSON.stringify({ ...nextRubric, version: nextVersion }),
        rubricVersion: nextVersion,
        isDefault:
          patch.isDefault !== undefined
            ? patch.isDefault
              ? 1
              : 0
            : existing.isDefault
              ? 1
              : 0,
        updatedAt: nowIso(),
      })
      .where(eq(projectRubrics.id, id))
      .run();
    const row = this.getProjectRubric(id);
    if (!row) throw notFound("project rubric", id);
    return row;
  }

  archiveProjectRubric(id: string): ProjectRubric {
    const existing = this.getProjectRubric(id);
    if (!existing) throw notFound("project rubric", id);
    this.db
      .update(projectRubrics)
      .set({ archived: 1, isDefault: 0, updatedAt: nowIso() })
      .where(eq(projectRubrics.id, id))
      .run();
    const row = this.getProjectRubric(id);
    if (!row) throw notFound("project rubric", id);
    return row;
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
  private batches = new Map<string, RunBatch>();
  private runs = new Map<string, Run>();
  private judgements = new Map<string, Judgement>();
  private scores = new Map<string, ScoreRow>();
  private findings = new Map<string, FindingRow>();
  private occurrences = new Map<string, OccurrenceRow>();
  private watcherRules = new Map<string, WatcherRule>();
  private watcherEvents = new Map<string, WatcherEvent>();
  private queueEntries = new Map<string, QueueEntry>();
  private evalQueues = new Map<string, EvalQueue>();
  private evalQueueItems = new Map<string, EvalQueueItem>();
  private queueContainers = new Map<string, QueueContainer>();
  private queueAnalyses = new Map<string, QueueAnalysis>();
  private evalArchives = new Map<string, EvalArchive>();
  private apiTokens = new Map<string, ApiToken>();
  private outboundSubscriptions = new Map<string, OutboundSubscription>();
  private webhookDeliveries = new Map<string, WebhookDelivery>();
  private users = new Map<string, User>();
  private settings = new Map<string, SettingRow>();
  private checkResultsByRun = new Map<string, CheckResult[]>();
  private projectRubrics = new Map<string, ProjectRubric>();

  constructor(private readonly dataDir: string) {}

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
      defaultJudgeModel: input.defaultJudgeModel ?? null,
      workspaceImage: input.workspaceImage ?? null,
      checkRunners: input.checkRunners ?? null,
      adapterOverrides: input.adapterOverrides ?? null,
      networkPolicy: input.networkPolicy ?? "allow",
      retentionRuns: input.retentionRuns ?? null,
      artifactRetention: resolveRetentionPolicy(
        input.artifactRetention ?? DEFAULT_ARTIFACT_RETENTION,
      ),
      sandbox: input.sandbox ?? null,
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
      defaultJudgeModel:
        patch.defaultJudgeModel !== undefined
          ? patch.defaultJudgeModel
          : existing.defaultJudgeModel,
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
      artifactRetention:
        patch.artifactRetention !== undefined
          ? resolveRetentionPolicy(patch.artifactRetention)
          : existing.artifactRetention,
      sandbox: patch.sandbox !== undefined ? patch.sandbox : existing.sandbox,
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
      profile: spec.profile ?? spec.rubric.profile ?? null,
      referenceSolution: spec.referenceSolution ?? null,
      checks: (spec.checks ?? spec.rubric.checks ?? null) as unknown[] | null,
      env: (spec.env ?? null) as Record<string, unknown> | null,
      tags: spec.tags ?? null,
      sourceKind: opts.sourceKind ?? null,
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

  createBatch(input: CreateBatchInput): RunBatch {
    const batch: RunBatch = {
      id: input.id ?? newId(),
      taskId: input.taskId,
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
      queueId: input.queueId ?? null,
      queueRevision: input.queueRevision ?? null,
      createdAt: nowIso(),
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

  // ---- judgements + scores (P4c) ----

  createJudgement(input: CreateJudgementInput): Judgement {
    const id = input.id ?? newId();
    const ts = nowIso();
    const eventsPath = judgeEventsPath(this.dataDir, input.projectId, id);
    const jVerdictPath = verdictPath(this.dataDir, input.projectId, id);
    const j: Judgement = {
      id,
      runId: input.runId,
      projectId: input.projectId,
      queueAnalysisId: input.queueAnalysisId ?? null,
      judgeModel: input.judgeModel,
      judgeProvider: input.judgeProvider,
      judgePrompt: input.judgePrompt ?? null,
      systemPromptVersion: input.systemPromptVersion,
      status: input.status,
      overallScore: null,
      verdict: null,
      reportPath: null,
      eventsPath,
      verdictPath: jVerdictPath,
      createdAt: ts,
      endedAt: null,
    };
    this.judgements.set(id, j);
    writeSnapshot(
      judgementSnapshotPath(this.dataDir, j.projectId, j.id),
      j,
    );
    try {
      mkdirSync(judgementDir(this.dataDir, j.projectId, j.id), {
        recursive: true,
      });
    } catch {
      // best-effort
    }
    return { ...j };
  }

  createScores(
    judgementId: string,
    scoreInputs: CreateScoreInput[],
  ): ScoreRow[] {
    if (!this.judgements.has(judgementId)) {
      throw notFound("judgement", judgementId);
    }
    const out: ScoreRow[] = [];
    for (const s of scoreInputs) {
      const row: ScoreRow = {
        id: newId(),
        judgementId,
        criterion: s.criterion,
        weight: s.weight,
        score: s.score,
        rationale: s.rationale ?? null,
      };
      this.scores.set(row.id, row);
      out.push({ ...row });
    }
    return out;
  }

  storeVerdict(judgementId: string, verdict: Verdict): JudgementWithVerdict {
    const existing = this.judgements.get(judgementId);
    if (!existing) throw notFound("judgement", judgementId);
    const jVerdictPath =
      existing.verdictPath ??
      verdictPath(this.dataDir, existing.projectId, judgementId);
    const eventsPath =
      existing.eventsPath ??
      judgeEventsPath(this.dataDir, existing.projectId, judgementId);

    writeSnapshot(jVerdictPath, verdict);

    // Replace prior scores for this judgement.
    for (const [sid, s] of [...this.scores.entries()]) {
      if (s.judgementId === judgementId) this.scores.delete(sid);
    }
    this.createScores(
      judgementId,
      (verdict.criteria ?? []).map((c) => ({
        criterion: c.criterion,
        weight: c.weight,
        score: c.score,
        rationale: c.feedback,
      })),
    );

    const next: Judgement = {
      ...existing,
      status: "completed",
      overallScore: verdict.overall?.score ?? null,
      verdict: verdict.overall?.verdict ?? null,
      verdictPath: jVerdictPath,
      eventsPath,
      endedAt: nowIso(),
    };
    this.judgements.set(judgementId, next);
    writeSnapshot(
      judgementSnapshotPath(this.dataDir, next.projectId, next.id),
      next,
    );

    // P6a: ingest findings after score mirror (error-isolated). Goes through the
    // public ingestFindings method so tests can force-fail it for isolation.
    try {
      this.ingestFindings(judgementId, verdict);
    } catch (err) {
      console.warn(
        `[findings] ingest failed for judgement ${judgementId}:`,
        err,
      );
    }

    const verdictBody =
      readVerdictFromDisk(
        this.dataDir,
        next.projectId,
        next.id,
        jVerdictPath,
      ) ?? verdict;
    return { ...next, verdictBody };
  }

  private ingestFindingsAndRewrite(
    judgementId: string,
    runId: string,
    projectId: string,
    jVerdictPath: string,
    verdict: Verdict,
  ): Verdict {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(
        `cannot ingest findings: run not found for judgement ${judgementId} (runId=${runId})`,
      );
    }
    const result = runIngestFindings(this.asFindingsStore(), {
      judgementId,
      runId,
      projectId,
      taskId: run.taskId,
      verdict,
    });
    const withRecurring = applyRecurrenceToVerdict(
      verdict,
      result.recurringByFindingId,
    );
    writeSnapshot(jVerdictPath, withRecurring);
    return withRecurring;
  }

  ingestFindings(judgementId: string, verdict: Verdict): void {
    const existing = this.judgements.get(judgementId);
    if (!existing) throw notFound("judgement", judgementId);
    const jVerdictPath =
      existing.verdictPath ??
      verdictPath(this.dataDir, existing.projectId, judgementId);
    this.ingestFindingsAndRewrite(
      judgementId,
      existing.runId,
      existing.projectId,
      jVerdictPath,
      verdict,
    );
  }

  private asFindingsStore(): FindingsIngestStore {
    const self = this;
    return {
      findFindingForTask(taskId, fingerprint) {
        const row = self.findings.get(fingerprint);
        if (!row || row.taskId !== taskId) return null;
        return { ...row };
      },
      insertFinding(row) {
        self.findings.set(row.fingerprint, { ...row });
      },
      updateFinding(fingerprint, patch) {
        const existing = self.findings.get(fingerprint);
        if (!existing) return;
        self.findings.set(fingerprint, { ...existing, ...patch });
      },
      insertOccurrence(row) {
        self.occurrences.set(row.id, { ...row });
      },
      listFindingsForTask(taskId) {
        return [...self.findings.values()]
          .filter((f) => f.taskId === taskId)
          .map((f) => ({ ...f }));
      },
      getJudgementRunId(judgementId) {
        return self.judgements.get(judgementId)?.runId ?? null;
      },
      now: () => nowIso(),
      newId: () => newId(),
    };
  }

  listFindings(filter: ListFindingsFilter = {}): FindingRow[] {
    let rows = [...this.findings.values()];
    if (filter.projectId) {
      rows = rows.filter((f) => f.projectId === filter.projectId);
    }
    if (filter.taskId) {
      rows = rows.filter((f) => f.taskId === filter.taskId);
    }
    if (filter.status) {
      rows = rows.filter((f) => f.status === filter.status);
    }
    if (filter.kind) {
      rows = rows.filter((f) => f.kind === filter.kind);
    }
    if (filter.category) {
      rows = rows.filter((f) => f.category === filter.category);
    }
    rows.sort((a, b) => {
      const ta = a.lastSeenAt ?? "";
      const tb = b.lastSeenAt ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return a.fingerprint.localeCompare(b.fingerprint);
    });
    return rows.map((f) => ({ ...f }));
  }

  getFinding(fingerprint: string): FindingDetail | null {
    const row = this.findings.get(fingerprint);
    if (!row) return null;
    return {
      ...row,
      occurrences: this.listOccurrences(fingerprint),
    };
  }

  listOccurrences(findingFingerprint: string): OccurrenceRow[] {
    const rows = [...this.occurrences.values()].filter(
      (o) => o.findingFingerprint === findingFingerprint,
    );
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.id.localeCompare(a.id);
    });
    return rows.map((o) => ({ ...o }));
  }

  getJudgement(id: string): JudgementWithVerdict | null {
    const j = this.judgements.get(id);
    if (!j) return null;
    const body = readVerdictFromDisk(
      this.dataDir,
      j.projectId,
      j.id,
      j.verdictPath,
    );
    return { ...j, verdictBody: body };
  }

  listJudgements(filter: ListJudgementsFilter = {}): ListJudgementsResult {
    const limit = clampLimit(filter.limit);
    const offset = parseCursorOffset(filter.cursor);
    let rows = [...this.judgements.values()];
    if (filter.projectId) {
      rows = rows.filter((j) => j.projectId === filter.projectId);
    }
    if (filter.runId) {
      rows = rows.filter((j) => j.runId === filter.runId);
    }
    if (filter.status) {
      rows = rows.filter((j) => j.status === filter.status);
    }
    rows.sort((a, b) => {
      const ca = a.createdAt ?? "";
      const cb = b.createdAt ?? "";
      if (ca !== cb) return cb.localeCompare(ca);
      return b.id.localeCompare(a.id);
    });
    const page = rows.slice(offset, offset + limit).map((j) => ({ ...j }));
    const nextOffset = offset + page.length;
    const nextCursor =
      nextOffset < rows.length ? String(nextOffset) : null;
    return { judgements: page, nextCursor };
  }

  setJudgementStatus(
    id: string,
    status: JudgementStatus | string,
    endedAt?: string | null,
  ): Judgement {
    const existing = this.judgements.get(id);
    if (!existing) throw notFound("judgement", id);
    let nextEnded = existing.endedAt;
    if (endedAt !== undefined) {
      nextEnded = endedAt;
    } else if (status === "completed" || status === "failed") {
      nextEnded = existing.endedAt ?? nowIso();
    }
    const next: Judgement = {
      ...existing,
      status,
      endedAt: nextEnded,
    };
    this.judgements.set(id, next);
    writeSnapshot(
      judgementSnapshotPath(this.dataDir, next.projectId, next.id),
      next,
    );
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
      role: input.role,
      repo: input.repo,
      trigger: input.trigger,
      ref: input.ref ?? null,
      semverFilter: input.semverFilter ?? null,
      action: { ...input.action },
      webhookSecret: secret,
      enabled: input.enabled === false ? false : true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.watcherRules.set(rule.id, rule);
    // Return WITH secret present — only create surfaces it.
    return { ...rule, action: { ...rule.action } };
  }

  getWatcherRule(id: string): WatcherRule | null {
    const r = this.watcherRules.get(id);
    return r ? stripWebhookSecret({ ...r, action: { ...r.action } }) : null;
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
      .map((r) => stripWebhookSecret({ ...r, action: { ...r.action } }));
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
      action:
        patch.action !== undefined ? { ...patch.action } : { ...existing.action },
      enabled:
        patch.enabled !== undefined ? patch.enabled : existing.enabled,
      repo: patch.repo !== undefined ? patch.repo : existing.repo,
      updatedAt: nowIso(),
      // Secret is never touchable via update.
      webhookSecret: existing.webhookSecret,
    };
    this.watcherRules.set(id, next);
    return stripWebhookSecret({ ...next, action: { ...next.action } });
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
      error: input.error ?? null,
    };
    this.watcherEvents.set(event.id, event);
    return { ...event };
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

  // ---- eval queue (P8a) ----

  createQueueEntry(
    projectId: string,
    input: CreateQueueEntryInput,
  ): QueueEntry {
    if (!this.projects.has(projectId)) throw notFound("project", projectId);
    const existing = [...this.queueEntries.values()].filter(
      (e) => e.projectId === projectId,
    );
    const position = computeFractionalPosition(
      existing.map((e) => ({ id: e.id, position: e.position })),
      input.position,
    );
    const taskTags = input.taskTags ?? null;
    let dedupKey: string | null;
    if (input.dedupKey !== undefined) {
      dedupKey = input.dedupKey;
    } else if (input.source === "manual") {
      dedupKey = null;
    } else {
      dedupKey = defaultQueueDedupKey(
        input.triggerRef ?? null,
        input.targetKind,
        input.taskId ?? null,
        taskTags,
      );
    }
    const entry: QueueEntry = {
      id: newId(),
      projectId,
      triggerRef: input.triggerRef ?? null,
      targetKind: input.targetKind,
      taskId: input.taskId ?? null,
      taskTags: taskTags ? [...taskTags] : null,
      agentId: input.agentId,
      model: input.model ?? null,
      provider: input.provider ?? null,
      repeats: input.repeats ?? null,
      params:
        input.params !== undefined && input.params !== null
          ? { ...input.params }
          : null,
      adapterOverrides:
        input.adapterOverrides !== undefined && input.adapterOverrides !== null
          ? { ...input.adapterOverrides }
          : null,
      autoJudge:
        input.autoJudge === undefined ? null : input.autoJudge,
      judgeModel: input.judgeModel ?? null,
      priority: input.priority ?? 0,
      position,
      status: "queued",
      dedupKey,
      source: input.source ?? null,
      createdAt: nowIso(),
      promotedAt: null,
      promotedBatchId: null,
      removedAt: null,
    };
    this.queueEntries.set(entry.id, entry);
    return {
      ...entry,
      taskTags: entry.taskTags ? [...entry.taskTags] : null,
      params: entry.params ? { ...entry.params } : null,
      adapterOverrides: entry.adapterOverrides
        ? { ...entry.adapterOverrides }
        : null,
    };
  }

  getQueueEntry(id: string): QueueEntry | null {
    const e = this.queueEntries.get(id);
    if (!e) return null;
    return {
      ...e,
      taskTags: e.taskTags ? [...e.taskTags] : null,
      params: e.params ? { ...e.params } : null,
      adapterOverrides: e.adapterOverrides
        ? { ...e.adapterOverrides }
        : null,
    };
  }

  listQueueEntries(
    projectId: string,
    opts: { status?: string } = {},
  ): QueueEntry[] {
    let entries = [...this.queueEntries.values()].filter(
      (e) => e.projectId === projectId,
    );
    if (opts.status !== undefined) {
      entries = entries.filter((e) => e.status === opts.status);
    }
    return sortQueueEntries(entries).map((e) => ({
      ...e,
      taskTags: e.taskTags ? [...e.taskTags] : null,
      params: e.params ? { ...e.params } : null,
      adapterOverrides: e.adapterOverrides
        ? { ...e.adapterOverrides }
        : null,
    }));
  }

  reorderQueueEntry(id: string, opts: ReorderQueueEntryOpts): QueueEntry {
    const existing = this.queueEntries.get(id);
    if (!existing) throw notFound("queue entry", id);
    const siblings = [...this.queueEntries.values()].filter(
      (e) => e.projectId === existing.projectId && e.id !== id,
    );
    let position = existing.position;
    if (opts.position !== undefined) {
      position = opts.position;
    } else if (opts.after !== undefined || opts.before !== undefined) {
      const spec: QueuePositionSpec =
        opts.after !== undefined
          ? { after: opts.after }
          : { before: opts.before };
      position = computeFractionalPosition(
        siblings.map((e) => ({ id: e.id, position: e.position })),
        spec,
      );
    }
    const next: QueueEntry = {
      ...existing,
      position,
      priority:
        opts.priority !== undefined ? opts.priority : existing.priority,
    };
    this.queueEntries.set(id, next);
    return this.getQueueEntry(id)!;
  }

  promoteQueueEntry(id: string): PromoteQueueEntryResult {
    const entry = this.queueEntries.get(id);
    if (!entry) throw notFound("queue entry", id);
    if (entry.status === "promoted" && entry.promotedBatchId) {
      const runIds = this.listRuns({ batchId: entry.promotedBatchId }).map(
        (r) => r.id,
      );
      return {
        entry: this.getQueueEntry(id)!,
        batchId: entry.promotedBatchId,
        runIds,
        batchIds: [entry.promotedBatchId],
      };
    }
    if (entry.status !== "queued") {
      throw new Error(
        `cannot promote queue entry ${id}: status is ${entry.status}`,
      );
    }

    let targetTasks: Task[] = [];
    if (entry.targetKind === "task") {
      if (!entry.taskId) {
        throw new Error(
          `cannot promote queue entry ${id}: target_kind=task but taskId is missing`,
        );
      }
      const t = this.getTask(entry.taskId);
      if (!t || t.projectId !== entry.projectId) {
        throw new Error(
          `cannot promote queue entry ${id}: task not found: ${entry.taskId}`,
        );
      }
      targetTasks = [t];
    } else {
      const all = this.listTasks(entry.projectId);
      targetTasks = tasksMatchingTags(all, entry.taskTags);
      if (targetTasks.length === 0) {
        throw new Error(
          `cannot promote queue entry ${id}: no tasks match tags ${(entry.taskTags ?? []).join(",") || "(none)"}`,
        );
      }
    }

    const project = this.getProject(entry.projectId);
    const agent = this.getAgent(entry.agentId);
    const model =
      entry.model ?? project?.defaultModel ?? agent?.defaultModel ?? "unknown";
    const provider =
      entry.provider ??
      project?.defaultProvider ??
      agent?.defaultProvider ??
      "unknown";
    const repeats = entry.repeats ?? 1;
    const params = entry.params ?? {};
    const agentImage =
      entry.adapterOverrides &&
      typeof entry.adapterOverrides.imageTag === "string"
        ? String(entry.adapterOverrides.imageTag)
        : undefined;
    const trigger =
      entry.source === "watcher"
        ? "webhook"
        : entry.source === "manual"
          ? "manual"
          : entry.source === "ci"
            ? "manual"
            : entry.source === "api"
              ? "manual"
              : entry.source ?? "manual";

    const batchIds: string[] = [];
    const runIds: string[] = [];
    for (const task of targetTasks) {
      const batch = this.createBatch({
        taskId: task.id,
        projectId: entry.projectId,
        agentId: entry.agentId,
        model,
        provider,
        params,
        repeats,
        trigger,
        triggerRef: entry.triggerRef ?? undefined,
        agentImage,
      });
      batchIds.push(batch.id);
      for (let i = 0; i < repeats; i++) {
        const run = this.createRun({
          batchId: batch.id,
          taskId: task.id,
          projectId: entry.projectId,
          agentId: entry.agentId,
          model,
          provider,
          repeatIndex: i,
          status: "queued",
          trigger,
          triggerRef: entry.triggerRef ?? undefined,
          agentImage,
          triggerRuleId: undefined,
        });
        runIds.push(run.id);
      }
    }

    const firstBatchId = batchIds[0]!;
    const next: QueueEntry = {
      ...entry,
      status: "promoted",
      promotedAt: nowIso(),
      promotedBatchId: firstBatchId,
    };
    this.queueEntries.set(id, next);
    return {
      entry: this.getQueueEntry(id)!,
      batchId: firstBatchId,
      runIds,
      batchIds,
    };
  }

  removeQueueEntry(id: string): QueueEntry {
    const existing = this.queueEntries.get(id);
    if (!existing) throw notFound("queue entry", id);
    if (existing.status === "removed") {
      return this.getQueueEntry(id)!;
    }
    const next: QueueEntry = {
      ...existing,
      status: "removed",
      removedAt: nowIso(),
    };
    this.queueEntries.set(id, next);
    return this.getQueueEntry(id)!;
  }

  drainQueue(projectId: string): { removed: number } {
    const queued = [...this.queueEntries.values()].filter(
      (e) => e.projectId === projectId && e.status === "queued",
    );
    const removedAt = nowIso();
    for (const e of queued) {
      this.queueEntries.set(e.id, {
        ...e,
        status: "removed",
        removedAt,
      });
    }
    return { removed: queued.length };
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
      judgeModel: input.judgeModel ?? null, judgeProvider: input.judgeProvider ?? null,
      autoJudge: input.autoJudge !== false, status: "draft", activeBatchId: null,
      sharedAdapterId: input.sharedAdapterId ?? null,
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
      judgeModel: patch.judgeModel !== undefined ? patch.judgeModel : existing.judgeModel,
      judgeProvider: patch.judgeProvider !== undefined ? patch.judgeProvider : existing.judgeProvider,
      autoJudge: patch.autoJudge ?? existing.autoJudge,
      status: patch.status ?? existing.status,
      activeBatchId: patch.activeBatchId !== undefined ? patch.activeBatchId : existing.activeBatchId,
      sharedAdapterId: patch.sharedAdapterId !== undefined ? patch.sharedAdapterId : existing.sharedAdapterId,
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
      overrides: input.overrides ?? null, createdAt: ts, updatedAt: ts,
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
      (opts.includeDisabled === true || i.enabled))
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
      .map((i) => structuredClone(i));
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
    this.evalQueueItems.delete(id);
    this.updateEvalQueue(existing.queueId, { incrementRevision: true });
  }

  createQueueContainer(input: CreateQueueContainerInput): QueueContainer {
    const active = this.getActiveQueueContainer(input.queueId);
    if (active) throw new Error(`eval queue ${input.queueId} already has active container ${active.id}`);
    const ts = nowIso();
    const row: QueueContainer = {
      id: input.id ?? newId(), queueId: input.queueId, projectId: input.projectId,
      batchId: input.batchId, runtimeContainerId: input.runtimeContainerId ?? null,
      image: input.image, state: input.state, ports: [...(input.ports ?? [])],
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
    return this.listQueueContainers(queueId).find(
      (c) => c.state !== "stopped" && c.runtimeContainerId !== null && c.stoppedAt === null,
    ) ?? null;
  }

  listQueueContainers(queueId: string): QueueContainer[] {
    return [...this.queueContainers.values()].filter((c) => c.queueId === queueId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => structuredClone(c));
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

  createQueueAnalysis(input: CreateQueueAnalysisInput): QueueAnalysis {
    const row: QueueAnalysis = {
      id: input.id ?? newId(), queueId: input.queueId, projectId: input.projectId,
      batchId: input.batchId, selectedRunIds: [...input.selectedRunIds],
      evidenceHashes: { ...input.evidenceHashes }, judgeModel: input.judgeModel,
      judgeProvider: input.judgeProvider, judgeParams: input.judgeParams ?? null,
      judgePrompt: input.judgePrompt ?? null, systemPromptVersion: input.systemPromptVersion,
      parentAnalysisId: input.parentAnalysisId ?? null, status: input.status ?? "queued",
      verdictPath: null, reportPath: null, eventsPath: null, rawResponsePath: null,
      createdAt: nowIso(), startedAt: null, endedAt: null, error: null,
    };
    this.queueAnalyses.set(row.id, row);
    return structuredClone(row);
  }

  getQueueAnalysis(id: string): QueueAnalysis | null {
    const row = this.queueAnalyses.get(id);
    return row ? structuredClone(row) : null;
  }

  listQueueAnalyses(queueId: string, opts: { batchId?: string } = {}): QueueAnalysis[] {
    return [...this.queueAnalyses.values()].filter((a) => a.queueId === queueId &&
      (!opts.batchId || a.batchId === opts.batchId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((a) => structuredClone(a));
  }

  updateQueueAnalysis(id: string, patch: UpdateQueueAnalysisInput): QueueAnalysis {
    const existing = this.queueAnalyses.get(id);
    if (!existing) throw notFound("queue analysis", id);
    const next: QueueAnalysis = {
      ...existing,
      status: patch.status ?? existing.status,
      verdictPath: patch.verdictPath !== undefined ? patch.verdictPath : existing.verdictPath,
      reportPath: patch.reportPath !== undefined ? patch.reportPath : existing.reportPath,
      eventsPath: patch.eventsPath !== undefined ? patch.eventsPath : existing.eventsPath,
      rawResponsePath: patch.rawResponsePath !== undefined ? patch.rawResponsePath : existing.rawResponsePath,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
      endedAt: patch.endedAt !== undefined ? patch.endedAt : existing.endedAt,
      error: patch.error !== undefined ? patch.error : existing.error,
    };
    this.queueAnalyses.set(id, next);
    return structuredClone(next);
  }

  storeEvalArchive(input: StoreEvalArchiveInput): EvalArchive {
    const row: EvalArchive = {
      runId: input.runId, projectId: input.projectId, queueId: input.queueId ?? null,
      batchId: input.batchId, manifestPath: input.manifestPath,
      manifestSha256: input.manifestSha256, sizeBytes: input.sizeBytes,
      sealedAt: input.sealedAt ?? nowIso(),
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
      queue: this.listQueueEntries(projectId),
      outboundWebhooks: this.listOutboundSubscriptions(projectId),
    };
  }

  // ---- Outbound webhooks (P8c) ----

  createOutboundSubscription(
    projectId: string,
    input: CreateOutboundSubscriptionInput,
  ): OutboundSubscription {
    if (!this.projects.has(projectId)) throw notFound("project", projectId);
    const ts = nowIso();
    const secret =
      input.secret !== undefined && input.secret !== ""
        ? input.secret
        : `${newId()}-${newId()}`;
    const eventTypes = Array.isArray(input.eventTypes)
      ? [...input.eventTypes]
      : [];
    const sub: OutboundSubscription = {
      id: newId(),
      projectId,
      url: input.url,
      secret,
      eventTypes,
      enabled: input.enabled === false ? false : true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.outboundSubscriptions.set(sub.id, sub);
    // Return WITH secret present — only create surfaces it.
    return { ...sub, eventTypes: [...sub.eventTypes] };
  }

  getOutboundSubscription(id: string): OutboundSubscription | null {
    const s = this.outboundSubscriptions.get(id);
    return s
      ? stripOutboundSecret({ ...s, eventTypes: [...s.eventTypes] })
      : null;
  }

  /**
   * Raw signing secret for outbound HMAC. NEVER log the return value.
   */
  getOutboundSubscriptionWithSecret(id: string): string | null {
    const s = this.outboundSubscriptions.get(id);
    if (!s) return null;
    if (s.secret == null || s.secret === "") return null;
    return s.secret;
  }

  listOutboundSubscriptions(projectId: string): OutboundSubscription[] {
    return [...this.outboundSubscriptions.values()]
      .filter((s) => s.projectId === projectId)
      .map((s) =>
        stripOutboundSecret({ ...s, eventTypes: [...s.eventTypes] }),
      );
  }

  updateOutboundSubscription(
    id: string,
    patch: UpdateOutboundSubscriptionPatch,
  ): OutboundSubscription {
    const existing = this.outboundSubscriptions.get(id);
    if (!existing) throw notFound("outbound subscription", id);
    const next: OutboundSubscription = {
      ...existing,
      url: patch.url !== undefined ? patch.url : existing.url,
      eventTypes:
        patch.eventTypes !== undefined
          ? [...patch.eventTypes]
          : [...existing.eventTypes],
      enabled:
        patch.enabled !== undefined ? patch.enabled : existing.enabled,
      updatedAt: nowIso(),
      // Secret is never touchable via update.
      secret: existing.secret,
    };
    this.outboundSubscriptions.set(id, next);
    return stripOutboundSecret({ ...next, eventTypes: [...next.eventTypes] });
  }

  deleteOutboundSubscription(id: string): void {
    for (const [did, d] of this.webhookDeliveries) {
      if (d.subscriptionId === id) this.webhookDeliveries.delete(did);
    }
    this.outboundSubscriptions.delete(id);
  }

  recordWebhookDelivery(input: RecordWebhookDeliveryInput): WebhookDelivery {
    const delivery: WebhookDelivery = {
      id: newId(),
      subscriptionId: input.subscriptionId,
      projectId: input.projectId,
      eventType: input.eventType,
      payload: input.payload ?? null,
      status: input.status,
      attempt: input.attempt,
      responseStatus: input.responseStatus ?? null,
      responseBody: truncateResponseBody(input.responseBody ?? null),
      error: input.error ?? null,
      deliveredAt: input.deliveredAt ?? null,
      createdAt: nowIso(),
    };
    this.webhookDeliveries.set(delivery.id, delivery);
    return { ...delivery };
  }

  listWebhookDeliveries(
    projectId: string,
    opts: ListWebhookDeliveriesOpts = {},
  ): WebhookDelivery[] {
    let rows = [...this.webhookDeliveries.values()].filter(
      (d) => d.projectId === projectId,
    );
    if (opts.subscriptionId !== undefined) {
      rows = rows.filter((d) => d.subscriptionId === opts.subscriptionId);
    }
    if (opts.eventType !== undefined) {
      rows = rows.filter((d) => d.eventType === opts.eventType);
    }
    if (opts.status !== undefined) {
      rows = rows.filter((d) => d.status === opts.status);
    }
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return b.id.localeCompare(a.id);
    });
    const limit =
      opts.limit != null && Number.isFinite(opts.limit)
        ? Math.max(1, Math.min(200, Math.floor(opts.limit)))
        : 50;
    return rows.slice(0, limit).map((d) => ({ ...d }));
  }

  storeCheckResults(runId: string, results: CheckResult[]): void {
    this.checkResultsByRun.set(runId, results.map((r) => ({ ...r })));
  }

  getCheckResults(runId: string): CheckResult[] {
    const stored = this.checkResultsByRun.get(runId);
    return stored ? stored.map((r) => ({ ...r })) : [];
  }

  // ---- project rubrics ----

  createProjectRubric(input: CreateProjectRubricInput): ProjectRubric {
    if (!this.projects.has(input.projectId)) {
      throw notFound("project", input.projectId);
    }
    const ts = nowIso();
    if (input.isDefault) this.clearDefaultRubric(input.projectId);
    const row: ProjectRubric = {
      id: input.id ?? newId(),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      rubric: input.rubric,
      rubricVersion: input.rubric.version ?? 1,
      isDefault: input.isDefault === true,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.projectRubrics.set(row.id, row);
    return { ...row };
  }

  /** Demote whichever rubric currently holds the default flag for a project. */
  private clearDefaultRubric(projectId: string): void {
    for (const [id, r] of this.projectRubrics) {
      if (r.projectId === projectId && r.isDefault) {
        this.projectRubrics.set(id, { ...r, isDefault: false });
      }
    }
  }

  getProjectRubric(id: string): ProjectRubric | null {
    const row = this.projectRubrics.get(id);
    return row ? { ...row } : null;
  }

  listProjectRubrics(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): ProjectRubric[] {
    const rows = [...this.projectRubrics.values()]
      .filter((r) => r.projectId === projectId)
      .filter((r) => (opts.includeArchived ? true : !r.archived))
      .map((r) => ({ ...r }));
    return sortProjectRubrics(rows);
  }

  getDefaultProjectRubric(projectId: string): ProjectRubric | null {
    return this.listProjectRubrics(projectId).find((r) => r.isDefault) ?? null;
  }

  updateProjectRubric(
    id: string,
    patch: UpdateProjectRubricInput,
  ): ProjectRubric {
    const existing = this.projectRubrics.get(id);
    if (!existing) throw notFound("project rubric", id);
    const rubricChanged =
      patch.rubric !== undefined && !rubricsEqual(existing.rubric, patch.rubric);
    const nextVersion = rubricChanged
      ? Math.max(existing.rubricVersion, patch.rubric?.version ?? 0) + 1
      : existing.rubricVersion;
    if (patch.isDefault) this.clearDefaultRubric(existing.projectId);
    const base = this.projectRubrics.get(id)!;
    const next: ProjectRubric = {
      ...base,
      name: patch.name ?? base.name,
      description:
        patch.description !== undefined ? patch.description : base.description,
      rubric: { ...(patch.rubric ?? base.rubric), version: nextVersion },
      rubricVersion: nextVersion,
      isDefault: patch.isDefault !== undefined ? patch.isDefault : base.isDefault,
      updatedAt: nowIso(),
    };
    this.projectRubrics.set(id, next);
    return { ...next };
  }

  archiveProjectRubric(id: string): ProjectRubric {
    const existing = this.projectRubrics.get(id);
    if (!existing) throw notFound("project rubric", id);
    const next: ProjectRubric = {
      ...existing,
      archived: true,
      isDefault: false,
      updatedAt: nowIso(),
    };
    this.projectRubrics.set(id, next);
    return { ...next };
  }
}

/** Alias kept for call-site ergonomics. */
export type DbQueries = QueryStore;

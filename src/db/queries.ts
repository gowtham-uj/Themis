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

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type {
  AgentCategory,
  Rubric,
  TaskProfile,
  TaskSpec,
} from "../domain.js";
import type { WorkspaceSpec } from "../adapters/types.js";
import type { Verdict } from "../judge/verdict.js";
import {
  agents,
  judgements,
  projects,
  runBatches,
  runs,
  scores,
  tasks,
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
  defaultJudgeModel: string | null;
  workspaceImage: string | null;
  checkRunners: Record<string, string> | null;
  adapterOverrides: Record<string, unknown> | null;
  networkPolicy: string;
  retentionRuns: number | null;
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
}

export interface Task {
  id: string;
  projectId: string;
  externalId: string | null;
  name: string;
  prompt: string;
  workspace: WorkspaceSpec;
  rubric: Rubric;
  rubricVersion: number;
  agentCategory: AgentCategory;
  profile: TaskProfile | null;
  referenceSolution: string | null;
  checks: unknown[] | null;
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
  agentId: string;
  model: string;
  provider: string;
  repeatIndex: number;
  status: RunStatus | string;
  workspaceCommit: string | null;
  agentImage: string | null;
  agentCommit: string | null;
  agentImageSource: string | null;
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
  agentId: string;
  model: string;
  provider: string;
  repeatIndex: number;
  status?: RunStatus | string;
  workspaceCommit?: string;
  agentImage?: string;
  agentCommit?: string;
  agentImageSource?: string;
  trigger?: string;
  triggerRef?: string;
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

/**
 * Shared query surface. Both SqliteQueries and MemoryQueries implement this.
 * Finding methods are stubs (throw) until P6.
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
   * scores into SQLite, mark judgement completed.
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

  /** P6 stub — not implemented yet. */
  createFinding(..._args: unknown[]): never;
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
    rubricVersion: row.rubricVersion,
    agentCategory: (row.agentCategory ?? "coding") as AgentCategory,
    profile: (row.profile as TaskProfile | null) ?? null,
    referenceSolution: row.referenceSolution,
    checks: parseJson(row.checksJson, null),
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
    createdAt: row.createdAt,
  };
}

function mapRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    batchId: row.batchId,
    taskId: row.taskId,
    projectId: row.projectId,
    agentId: row.agentId,
    model: row.model,
    provider: row.provider,
    repeatIndex: row.repeatIndex,
    status: row.status,
    workspaceCommit: row.workspaceCommit,
    agentImage: row.agentImage,
    agentCommit: row.agentCommit,
    agentImageSource: row.agentImageSource,
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

function stub(name: string): never {
  throw new Error(
    `${name} is not implemented in P3a (filled in a later phase)`,
  );
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
        rubricVersion,
        agentCategory: spec.agentCategory ?? "coding",
        profile: spec.profile ?? spec.rubric.profile ?? null,
        referenceSolution: spec.referenceSolution ?? null,
        checksJson: stringifyJson(checks),
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
      .set({ archived: 1, updatedAt: nowIso() })
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
        agentId: input.agentId,
        model: input.model,
        provider: input.provider,
        repeatIndex: input.repeatIndex,
        status: input.status ?? "queued",
        workspaceCommit: input.workspaceCommit ?? null,
        agentImage: input.agentImage ?? null,
        agentCommit: input.agentCommit ?? null,
        agentImageSource: input.agentImageSource ?? null,
        trigger: input.trigger ?? null,
        triggerRef: input.triggerRef ?? null,
        triggerRuleId: null,
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
    if (filter.batchId && filter.projectId) {
      return this.db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.batchId, filter.batchId),
            eq(runs.projectId, filter.projectId),
          ),
        )
        .all()
        .map(mapRun);
    }
    if (filter.batchId) {
      return this.db
        .select()
        .from(runs)
        .where(eq(runs.batchId, filter.batchId))
        .all()
        .map(mapRun);
    }
    if (filter.projectId) {
      return this.db
        .select()
        .from(runs)
        .where(eq(runs.projectId, filter.projectId))
        .all()
        .map(mapRun);
    }
    return this.db.select().from(runs).all().map(mapRun);
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
    return { ...mapped, verdictBody: verdict };
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

  createFinding(..._args: unknown[]): never {
    return stub("createFinding");
  }
}

// ---------------------------------------------------------------------------
// MemoryQueries — in-memory fallback (same QueryStore interface)
// ---------------------------------------------------------------------------

export class MemoryQueries implements QueryStore {
  private projects = new Map<string, Project>();
  private tasks = new Map<string, Task>();
  private agents = new Map<string, Agent>();
  private batches = new Map<string, RunBatch>();
  private runs = new Map<string, Run>();
  private judgements = new Map<string, Judgement>();
  private scores = new Map<string, ScoreRow>();

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
      rubricVersion: spec.rubric.version ?? 1,
      agentCategory: spec.agentCategory ?? "coding",
      profile: spec.profile ?? spec.rubric.profile ?? null,
      referenceSolution: spec.referenceSolution ?? null,
      checks: (spec.checks ?? spec.rubric.checks ?? null) as unknown[] | null,
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
      rubricVersion,
      agentCategory: patch.agentCategory ?? existing.agentCategory,
      profile: patch.profile !== undefined ? patch.profile : existing.profile,
      referenceSolution:
        patch.referenceSolution !== undefined
          ? patch.referenceSolution
          : existing.referenceSolution,
      checks: patch.checks !== undefined ? patch.checks : existing.checks,
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
    const next = { ...existing, archived: true, updatedAt: nowIso() };
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
      agentId: input.agentId,
      model: input.model,
      provider: input.provider,
      repeatIndex: input.repeatIndex,
      status: input.status ?? "queued",
      workspaceCommit: input.workspaceCommit ?? null,
      agentImage: input.agentImage ?? null,
      agentCommit: input.agentCommit ?? null,
      agentImageSource: input.agentImageSource ?? null,
      trigger: input.trigger ?? null,
      triggerRef: input.triggerRef ?? null,
      triggerRuleId: null,
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
    return { ...next, verdictBody: verdict };
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

  createFinding(..._args: unknown[]): never {
    return stub("createFinding");
  }
}

/** Alias kept for call-site ergonomics. */
export type DbQueries = QueryStore;

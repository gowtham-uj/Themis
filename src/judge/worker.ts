/**
 * Judge worker orchestration — grade one completed run into a validated verdict
 * + live judge log (judge.jsonl). Decoupled and re-runnable: never mutates the run.
 *
 * Spec: plan/judge.md, plan/data-model.md judgements layout, plan/roadmap.md P4.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiParseState, mapPiEvent } from "../adapters/pi.js";
import type { RunContext } from "../adapters/types.js";
import type { AgentCategory, Rubric } from "../domain.js";
import type { CanonicalEvent } from "../schema/events.js";
import { SCHEMA_VERSION } from "../schema/events.js";
import { appendEvent } from "../schema/append.js";
import { readJsonl } from "../schema/jsonl.js";
import {
  assembleJudgeSystemPrompt,
  assembleJudgeUserPrompt,
  JUDGE_SYSTEM_PROMPT_VERSION,
} from "./prompt.js";
import { runPiJudgeAgent } from "./pi-agent.js";
import {
  validateVerdict,
  VerdictValidationError,
  type CheckResult,
  type Verdict,
} from "./verdict.js";
import {
  coerceAgentCategory,
  filterCriteria,
  shouldRunWithSource,
} from "./categories.js";
import {
  foldCheckResultsIntoVerdict,
} from "./check-results.js";
import { loadCheckResults } from "../runner/check-runner.js";
import {
  renderVerdictReport,
  type ReportContext,
} from "./report/index.js";

/** Task slice needed by the judge (prompt + rubric + category). */
export interface JudgeTaskInput {
  prompt: string;
  rubric: Rubric | unknown;
  agentCategory?: AgentCategory | string;
  referenceSolution?: string;
}

/** Input to {@link judgeRun}. */
export interface JudgeRunInput {
  /** Directory containing run.json, events.jsonl, optional diff.patch. */
  runDir: string;
  task: JudgeTaskInput;
  judgeModel: string;
  /** Gates the withSource improvements lens. */
  hasSourceArtifacts: boolean;
  /** Optional operator steer. */
  judgePrompt?: string;
  /** Provider id string for judgement metadata (default: "anthropic"). */
  judgeProvider?: string;
  /** Override judgement id (default: random UUID). */
  judgementId?: string;
  /**
   * Project id for on-disk layout under projects/<pid>/judgements/.
   * Default: "local".
   */
  projectId?: string;
  /**
   * Root data dir. When omitted, derived from runDir if it looks like
   * .../projects/<pid>/runs/<rid>, else parent of runDir, else cwd/data.
   */
  dataDir?: string;
  /** Max tokens for the provider call. */
  maxTokens?: number;
  /** Bound for events preview first/last seq excerpts (default 5). */
  previewWindow?: number;
  /**
   * Optional outbound webhook callback (P8c). Invoked once when the
   * verdict completes successfully (storeVerdict / emitRunEnd completed).
   * No-ops when omitted.
   */
  onVerdictCompleted?: (info: {
    judgementId: string;
    projectId: string;
    runId: string | null;
    overallScore?: number | null;
    verdictVersion?: string | null;
    timestamp: string;
  }) => void | Promise<void>;
}

export type JudgeRunStatus = "completed" | "failed";

/** Result of {@link judgeRun}. */
export interface JudgeRunResult {
  judgementId: string;
  judgementDir: string;
  verdictPath?: string;
  /** On-disk report.html when render succeeded (completed only). */
  reportPath?: string;
  eventsPath: string;
  status: JudgeRunStatus;
  /** Validated verdict when status is completed. */
  verdict?: Verdict;
  /** Error message when status is failed. */
  error?: string;
  systemPromptVersion: string;
}

/**
 * Grade one run with the shared PI SDK judge host, validate its terminating
 * submit_verdict payload, then write verdict.json + canonical judge.jsonl.
 * On validation failure: records an error event in judge.jsonl and does NOT
 * write an invalid verdict.json.
 */
export async function judgeRun(input: JudgeRunInput): Promise<JudgeRunResult> {
  const runDir = resolve(input.runDir);
  const judgementId = input.judgementId ?? randomUUID();
  const projectId = input.projectId ?? inferProjectId(runDir) ?? "local";
  const dataDir = input.dataDir ?? inferDataDir(runDir) ?? resolve(process.cwd(), "data");
  const judgementDir = join(dataDir, "projects", projectId, "judgements", judgementId);
  const eventsPath = join(judgementDir, "judge.jsonl");
  const verdictPath = join(judgementDir, "verdict.json");
  const systemPromptVersion = JUDGE_SYSTEM_PROMPT_VERSION;

  await mkdir(judgementDir, { recursive: true });

  // Snapshot judgement metadata (P4c mirrors more into SQLite; worker always writes this).
  const judgementMeta = {
    judgementId,
    projectId,
    runDir,
    judgeModel: input.judgeModel,
    judgeProvider: input.judgeProvider ?? "anthropic",
    systemPromptVersion,
    hasSourceArtifacts: input.hasSourceArtifacts,
    startedAt: new Date().toISOString(),
  };
  await writeFile(
    join(judgementDir, "judgement.json"),
    `${JSON.stringify(judgementMeta, null, 2)}\n`,
    "utf8",
  );

  let seq = 0;
  const emit = async (event: CanonicalEvent): Promise<void> => {
    // Re-seq so the live log is always monotonic for this judgement.
    const next: CanonicalEvent = {
      ...event,
      runId: judgementId,
      seq,
      v: SCHEMA_VERSION,
      ts: event.ts || new Date().toISOString(),
    };
    seq += 1;
    await appendEvent(eventsPath, next);
  };

  try {
    const runMeta = await readRunJson(runDir);
    const eventsPreview = await buildEventsPreview(runDir, input.previewWindow ?? 5);
    // The diff is primary evidence for whether the work was done at all.
    const diffText = await readFile(join(runDir, "diff.patch"), "utf8").catch(
      () => "",
    );

    // Category profile: filter rubric criteria (plan/categories.md + rubric §7)
    // so the prompt lists only applicable criteria and the verdict is validated
    // against the filtered set. Coding with a full rubric is effectively identity.
    const category = coerceAgentCategory(input.task.agentCategory);
    const filtered = resolveFilteredRubric(input.task.rubric, category);
    // Only enforce allowed ids when the filter retained ≥1 criterion. An empty
    // retained set means the rubric is coding-only (or malformed for this
    // category) — fall back to the original rubric for the prompt and skip the
    // allowed-id gate so legacy fixtures keep working.
    const useFiltered =
      filtered !== null && filtered.criteria.length > 0;
    const rubricForJudge = useFiltered
      ? filtered
      : (input.task.rubric as Rubric | unknown);
    const allowedCriterionIds = useFiltered
      ? filtered!.criteria.map((c) => c.id)
      : undefined;

    // Category-gated withSource lens: research/conversational never; coding/data
    // always; general/browser only when a diff/outputs artifact is present.
    // Combined with the caller's hasSourceArtifacts so we never invent a source
    // that the harness did not capture.
    const runWithSource = shouldRunWithSource(
      category,
      input.hasSourceArtifacts,
    );
    const hasSourceArtifacts = input.hasSourceArtifacts && runWithSource;

    // P9: load deterministic check results written by the check-runner after
    // terminal-success. Absent when the task has no rubric.checks.
    const checkResults = await loadCheckResults(runDir);

    const promptVars = {
      taskPrompt: input.task.prompt,
      rubric: rubricForJudge,
      agentCategory: category,
      runMetadata: runMeta,
      eventsPreview,
      ...(diffText ? { diff: diffText } : {}),
      judgePrompt: input.judgePrompt,
      referenceSolution: input.task.referenceSolution,
      hasSourceArtifacts,
      ...(checkResults.length > 0 ? { checkResults } : {}),
    };

    const systemPrompt = assembleJudgeSystemPrompt(promptVars);
    const userPrompt = assembleJudgeUserPrompt(promptVars);

    await emit({
      v: SCHEMA_VERSION,
      runId: judgementId,
      seq: 0,
      ts: new Date().toISOString(),
      type: "run.start",
      agent: "pi",
      model: input.judgeModel,
      provider: input.judgeProvider ?? "anthropic",
      workspace: { source: "empty" },
      params: {
        systemPromptVersion,
        hasSourceArtifacts: input.hasSourceArtifacts,
      },
    });

    const submissionState: { verdict: Verdict | null } = { verdict: null };
    const submitVerdictTool: ToolDefinition = {
      name: "submit_verdict",
      label: "Submit Verdict",
      description:
        "Submit the final standard Verdict for this eval. Invalid verdicts are rejected so you can correct and retry.",
      promptSnippet: "Submit the final validated eval Verdict and terminate the judge session",
      promptGuidelines: [
        "Use submit_verdict only after inspecting and reconciling all supplied evidence.",
        "If submit_verdict rejects the payload, correct every validation error and call it again.",
      ],
      parameters: {
        type: "object",
        properties: { verdict: { type: "object" } },
        required: ["verdict"],
        additionalProperties: false,
      } as ToolDefinition["parameters"],
      executionMode: "sequential",
      async execute(_toolCallId, rawParams) {
        const params =
          rawParams && typeof rawParams === "object"
            ? (rawParams as Record<string, unknown>)
            : {};
        const candidate = params.verdict;
        try {
          validateVerdict(candidate, {
            hasSourceArtifacts,
            ...(allowedCriterionIds !== undefined ? { allowedCriterionIds } : {}),
          });
          submissionState.verdict = candidate as Verdict;
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ accepted: true }) }],
            details: { accepted: true },
            terminate: true,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ accepted: false, error: message }),
              },
            ],
            details: { accepted: false, error: message },
            isError: true,
          };
        }
      },
    };
    const piCtx: RunContext = {
      runId: judgementId,
      project: { id: projectId },
      task: { prompt: input.task.prompt, workspace: { source: "empty" } },
      model: input.judgeModel,
      provider: input.judgeProvider ?? "anthropic",
      params: { systemPromptVersion, hasSourceArtifacts },
      workspaceDir: judgementDir,
      apiKeys: {},
    };
    const piState = createPiParseState(undefined, { deferRunEnd: true });
    await runPiJudgeAgent({
      cwd: judgementDir,
      agentDir: join(judgementDir, ".pi-agent"),
      provider: input.judgeProvider ?? "anthropic",
      model: input.judgeModel,
      systemPrompt: `${systemPrompt}\n\nPI TOOL MODE OVERRIDE: Do not emit the verdict as plain text. Inspect the supplied evidence, then call submit_verdict with the exact Verdict object. The tool validates the schema and terminates the session only after acceptance.`,
      userPrompt,
      tools: [submitVerdictTool],
      eventsPath: join(judgementDir, "pi-events.jsonl"),
      transcriptPath: join(judgementDir, "pi-session.json"),
      maxTokens: input.maxTokens,
      onEvent: async (rawEvent) => {
        for (const event of mapPiEvent(rawEvent, piCtx, piState)) {
          if (event.type !== "run.start" && event.type !== "run.end") await emit(event);
        }
      },
    });

    const parsed = submissionState.verdict as Verdict | null;
    if (!parsed) {
      const message = "PI judge ended without an accepted submit_verdict call";
      await emitError(emit, judgementId, message);
      await emitRunEnd(emit, judgementId, "failed");
      return {
        judgementId,
        judgementDir,
        eventsPath,
        status: "failed",
        error: message,
        systemPromptVersion,
      };
    }

    try {
      validateVerdict(parsed, {
        hasSourceArtifacts,
        ...(allowedCriterionIds !== undefined
          ? { allowedCriterionIds }
          : {}),
      });
    } catch (err) {
      const message =
        err instanceof VerdictValidationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      await emitError(
        emit,
        judgementId,
        `verdict validation failed: ${message}`,
      );
      await emitRunEnd(emit, judgementId, "failed");
      // CRITICAL: do NOT write invalid verdict.json
      return {
        judgementId,
        judgementDir,
        eventsPath,
        status: "failed",
        error: message,
        systemPromptVersion,
      };
    }

    // P9: fold check results + pass-rates into the verdict the platform
    // persists. Pass grounds linked criteria; fail surfaces findings for
    // reconciliation (never auto-fails a criterion purely on a check).
    let verdict = parsed as Verdict;
    if (checkResults.length > 0) {
      verdict = foldCheckResultsIntoVerdict(
        verdict,
        checkResults,
        rubricForJudge,
      );
      // Re-validate after fold (findings / scores may have changed).
      try {
        validateVerdict(verdict, {
          hasSourceArtifacts,
          ...(allowedCriterionIds !== undefined
            ? { allowedCriterionIds }
            : {}),
        });
      } catch (err) {
        const message =
          err instanceof VerdictValidationError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        await emitError(
          emit,
          judgementId,
          `verdict validation after check fold failed: ${message}`,
        );
        await emitRunEnd(emit, judgementId, "failed");
        return {
          judgementId,
          judgementDir,
          eventsPath,
          status: "failed",
          error: message,
          systemPromptVersion,
        };
      }
    }

    await writeFile(
      verdictPath,
      `${JSON.stringify(verdict, null, 2)}\n`,
      "utf8",
    );

    // P5b: render report.html after a validated verdict write. Render errors must
    // not fail the judgement — verdict.json remains the source of truth.
    let reportPath: string | undefined;
    try {
      const reportCtx = buildReportContext({
        input,
        runMeta,
        systemPromptVersion,
        judgedAt: new Date().toISOString(),
        hasSourceArtifacts,
      });
      const reportHtml = renderVerdictReport(verdict, reportCtx);
      const reportFile = join(judgementDir, "report.html");
      await writeFile(reportFile, reportHtml, "utf8");
      reportPath = reportFile;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Non-fatal: verdict.json is already written and is the source of truth.
      await emit({
        v: SCHEMA_VERSION,
        runId: judgementId,
        seq: 0,
        ts: new Date().toISOString(),
        type: "error",
        message: `report render failed: ${message}`,
        phase: "agent",
        fatal: false,
      });
      // continue without reportPath
    }

    await emitRunEnd(emit, judgementId, "completed");

    // P8c: optional outbound webhook hook (exactly once on success).
    if (input.onVerdictCompleted) {
      try {
        const runIdFromMeta =
          runMeta && typeof runMeta === "object" && "runId" in runMeta
            ? String((runMeta as { runId?: unknown }).runId ?? "")
            : null;
        await input.onVerdictCompleted({
          judgementId,
          projectId,
          runId: runIdFromMeta || null,
          overallScore:
            verdict.overall && typeof verdict.overall.score === "number"
              ? verdict.overall.score
              : null,
          verdictVersion: systemPromptVersion,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // never break the judge for webhook delivery
      }
    }

    return {
      judgementId,
      judgementDir,
      verdictPath,
      reportPath,
      eventsPath,
      status: "completed",
      verdict,
      systemPromptVersion,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await emitError(emit, judgementId, `judgeRun failed: ${message}`);
      await emitRunEnd(emit, judgementId, "failed");
    } catch {
      // best-effort log
    }
    return {
      judgementId,
      judgementDir,
      eventsPath,
      status: "failed",
      error: message,
      systemPromptVersion,
    };
  }
}

async function emitError(
  emit: (e: CanonicalEvent) => Promise<void>,
  judgementId: string,
  message: string,
): Promise<void> {
  await emit({
    v: SCHEMA_VERSION,
    runId: judgementId,
    seq: 0,
    ts: new Date().toISOString(),
    type: "error",
    message,
    phase: "agent",
    fatal: true,
  });
}

/**
 * Build ReportContext from worker-scoped inputs (run.json meta + JudgeRunInput).
 * Pure-ish: no I/O; best-effort field extraction from unknown run metadata.
 */
function buildReportContext(args: {
  input: JudgeRunInput;
  runMeta: unknown;
  systemPromptVersion: string;
  judgedAt: string;
  /** Category-gated source flag (already combined with shouldRunWithSource). */
  hasSourceArtifacts: boolean;
}): ReportContext {
  const { input, runMeta, systemPromptVersion, judgedAt, hasSourceArtifacts } =
    args;
  const meta =
    runMeta && typeof runMeta === "object"
      ? (runMeta as Record<string, unknown>)
      : {};

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const runId = str(meta.runId) ?? str(meta.id);
  const agent = str(meta.agent);
  const model = str(meta.model);
  const status = str(meta.status);
  const durationMs =
    typeof meta.durationMs === "number" ? meta.durationMs : undefined;

  const runMetadata: Record<string, unknown> = {};
  if (status !== undefined) runMetadata.status = status;
  if (durationMs !== undefined) runMetadata.durationMs = durationMs;
  if (typeof meta.startedAt === "string") runMetadata.startedAt = meta.startedAt;
  if (typeof meta.endedAt === "string") runMetadata.endedAt = meta.endedAt;

  return {
    runId,
    taskPrompt: input.task.prompt,
    agentCategory:
      typeof input.task.agentCategory === "string"
        ? input.task.agentCategory
        : undefined,
    agent,
    model,
    judgeModel: input.judgeModel,
    systemPromptVersion,
    judgedAt,
    hasSourceArtifacts,
    runMetadata: Object.keys(runMetadata).length > 0 ? runMetadata : undefined,
  };
}

/**
 * Apply {@link filterCriteria} when the task rubric is a well-formed Rubric.
 * Returns null for non-rubric payloads (leave the prompt as-is).
 */
function resolveFilteredRubric(
  rubric: Rubric | unknown,
  category: AgentCategory,
): Rubric | null {
  if (!isRubric(rubric)) return null;
  return filterCriteria(rubric, category);
}

function isRubric(value: unknown): value is Rubric {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.criteria)) return false;
  return r.criteria.every(
    (c) =>
      c !== null &&
      typeof c === "object" &&
      typeof (c as { id?: unknown }).id === "string" &&
      typeof (c as { axis?: unknown }).axis === "string" &&
      typeof (c as { weight?: unknown }).weight === "number" &&
      typeof (c as { appliesTo?: unknown }).appliesTo === "string",
  );
}

async function emitRunEnd(
  emit: (e: CanonicalEvent) => Promise<void>,
  judgementId: string,
  status: "completed" | "failed",
): Promise<void> {
  await emit({
    v: SCHEMA_VERSION,
    runId: judgementId,
    seq: 0,
    ts: new Date().toISOString(),
    type: "run.end",
    status,
    durationMs: 0,
  });
}

async function readRunJson(runDir: string): Promise<unknown> {
  try {
    const raw = await readFile(join(runDir, "run.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return { runDir, note: "run.json missing or unreadable" };
  }
}

/** Build a bounded events preview with type counts and sequence snippets. */
export async function buildEventsPreview(
  runDir: string,
  window: number,
): Promise<string> {
  const eventsPath = join(runDir, "events.jsonl");
  const counts: Record<string, number> = {};
  const first: unknown[] = [];
  const last: unknown[] = [];
  let total = 0;
  let minSeq: number | undefined;
  let maxSeq: number | undefined;
  const actions: string[] = [];
  let timelineTruncated = false;

  try {
    await access(eventsPath);
  } catch {
    return "events.jsonl: (missing)";
  }

  for await (const obj of readJsonl(eventsPath)) {
    if (!obj || typeof obj !== "object") continue;
    const e = obj as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
    total += 1;
    const seq = typeof e.seq === "number" ? e.seq : undefined;
    if (seq !== undefined) {
      if (minSeq === undefined || seq < minSeq) minSeq = seq;
      if (maxSeq === undefined || seq > maxSeq) maxSeq = seq;
    }
    if (first.length < window) first.push(summarizeEvent(e));
    last.push(summarizeEvent(e));
    if (last.length > window) last.shift();

    // Every action, in order — the spine of what the agent actually did.
    if (
      type === "turn.start" ||
      type === "tool.call" ||
      type === "tool.result" ||
      type === "run.end"
    ) {
      if (actions.length < MAX_TIMELINE_ACTIONS) {
        actions.push(compactAction(e));
      } else {
        timelineTruncated = true;
      }
    }
  }

  const body = {
    totalEvents: total,
    typeCounts: counts,
    seqRange: { min: minSeq ?? null, max: maxSeq ?? null },
    first,
    last,
    // The COMPLETE sequence of actions the agent took, in order.
    //
    // first/last windows alone hide the middle of the run — which is where the
    // work happens. A judge that cannot see that an edit came after the last
    // test run cannot tell verified work from unverified work, and will report
    // a real change as "did nothing". Actions only (turns, tool calls and
    // results, run end), so this stays bounded even on long runs.
    actionTimeline: actions,
    ...(timelineTruncated
      ? { actionTimelineTruncated: `only the first ${MAX_TIMELINE_ACTIONS} actions are shown` }
      : {}),
  };
  return JSON.stringify(body, null, 2);
}

/** Cap on timeline entries, so a pathological run cannot flood the prompt. */
const MAX_TIMELINE_ACTIONS = 300;

/**
 * One action as a single line: `seq · type · detail`.
 *
 * Compact because ORDER is what matters here — whether the last test run came
 * before or after the last edit is the whole question, and that reads better as
 * a list than as nested JSON.
 */
function compactAction(e: Record<string, unknown>): string {
  const seq = typeof e.seq === "number" ? e.seq : "?";
  const type = String(e.type ?? "unknown");
  if (type === "turn.start") return `${seq} · turn ${String(e.turn ?? "")} begins`;
  if (type === "tool.call") {
    const args = e.args && typeof e.args === "object" ? JSON.stringify(e.args) : "";
    return `${seq} · CALL ${String(e.name ?? "?")}${args ? ` ${args.slice(0, 160)}` : ""}`;
  }
  if (type === "tool.result") {
    const out =
      typeof e.output === "string"
        ? e.output
        : e.output
          ? JSON.stringify(e.output)
          : "";
    return `${seq} · RESULT ${String(e.name ?? "?")} ${e.isError ? "ERROR" : "ok"}${out ? `: ${out.slice(0, 200)}` : ""}`;
  }
  if (type === "run.end") return `${seq} · run.end status=${String(e.status ?? "?")}`;
  return `${seq} · ${type}`;
}

function summarizeEvent(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: e.seq,
    type: e.type,
  };
  if (typeof e.turn === "number") out.turn = e.turn;
  if (e.type === "message" || e.type === "thinking") {
    const text = typeof e.text === "string" ? e.text : "";
    out.textPreview = text.length > 200 ? text.slice(0, 200) + "…" : text;
  }
  if (e.type === "tool.call") {
    out.name = e.name;
    out.id = e.id;
  }
  if (e.type === "tool.result") {
    out.id = e.id;
    out.isError = e.isError;
  }
  if (e.type === "run.end") {
    out.status = e.status;
  }
  if (e.type === "error") {
    out.message =
      typeof e.message === "string" && e.message.length > 200
        ? e.message.slice(0, 200) + "…"
        : e.message;
  }
  return out;
}

/**
 * Infer dataDir when runDir is .../projects/<pid>/runs/<rid>.
 * Returns parent of projects/ (i.e. dataDir).
 */
function inferDataDir(runDir: string): string | undefined {
  // .../projects/<pid>/runs/<rid>
  const parts = runDir.split(/[/\\]/);
  const runsIdx = parts.lastIndexOf("runs");
  if (runsIdx >= 2 && parts[runsIdx - 2] === "projects") {
    return parts.slice(0, runsIdx - 2).join("/") || undefined;
  }
  // .../runs/<rid> (P1 layout) → parent of runs
  if (runsIdx >= 1) {
    return parts.slice(0, runsIdx).join("/") || undefined;
  }
  return undefined;
}

function inferProjectId(runDir: string): string | undefined {
  const parts = runDir.split(/[/\\]/);
  const runsIdx = parts.lastIndexOf("runs");
  if (runsIdx >= 2 && parts[runsIdx - 2] === "projects") {
    return parts[runsIdx - 1];
  }
  return undefined;
}

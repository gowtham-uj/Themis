/** One real tool-using judge agent over immutable queue eval archives. */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  DbQueries,
  EvalArchive,
  QueueAnalysis,
  Run,
} from "../db/queries.js";
import { verifyEvalArchive, type EvalArchiveManifest } from "../runner/eval-archive.js";
import { isCanonicalEvent } from "../schema/events.js";
import { readJsonl } from "../schema/jsonl.js";
import { runPiJudgeAgent } from "./pi-agent.js";
import {
  assembleJudgeSystemPrompt,
  JUDGE_SYSTEM_PROMPT_VERSION,
} from "./prompt.js";
import { deriveOutcomeMetrics } from "./eval-metrics.js";
import { renderQueueReport } from "./queue-report.js";
import { sealQueueRunArchive } from "./queue-run-archive.js";
import {
  parseQueueSubmission,
  validateQueueSubmission,
  type QueueEvidenceIndex,
  type QueueSubmission,
} from "./queue-schema.js";
import { validateVerdict, type Verdict } from "./verdict.js";

export const QUEUE_JUDGE_SYSTEM_PROMPT_VERSION = `${JUDGE_SYSTEM_PROMPT_VERSION}-queue-pi-v1`;
const MAX_READ_BYTES = 128 * 1024;

export interface RunQueueAnalysisInput {
  queueId: string;
  batchId: string;
  runIds?: string[];
  judgeModel: string;
  judgeProvider: string;
  judgePrompt?: string | null;
  judgeParams?: Record<string, unknown> | null;
  parentAnalysisId?: string | null;
}

export interface RunQueueAnalysisResult {
  analysis: QueueAnalysis;
  verdictPath?: string;
  reportPath?: string;
  status: "completed" | "failed";
  error?: string;
}

export interface PrepareQueueAnalysisResult {
  analysis: QueueAnalysis;
}

interface ArchiveCtx {
  run: Run;
  archive: EvalArchive;
  manifest: EvalArchiveManifest;
  root: string;
  listed: boolean;
  coverage: Map<string, Array<[number, number]>>;
}

interface ResolvedAnalysis {
  queue: NonNullable<ReturnType<DbQueries["getEvalQueue"]>>;
  project: NonNullable<ReturnType<DbQueries["getProject"]>>;
  runs: Run[];
  selectedIds: string[];
  analysis: QueueAnalysis;
  analysisDir: string;
  eventsPath: string;
  rawResponsePath: string;
  verdictPath: string;
  reportPath: string;
  evidenceHashes: Record<string, string>;
}

/**
 * Validate the request, verify every immutable archive, and create the running
 * queue-analysis row. Returns before any model is called so the HTTP endpoint
 * can answer 202 immediately; the caller then runs the judge in the background
 * via {@link executeQueueAnalysis} on the returned analysis. All archive
 * verification, run selection, and analysis-row creation happen here, so the
 * judge never consumes model tokens against an invalid or tainted archive set.
 */
export async function prepareQueueAnalysis(
  dataDir: string,
  queries: DbQueries,
  input: RunQueueAnalysisInput,
): Promise<PrepareQueueAnalysisResult> {
  const resolved = await resolveAnalysis(dataDir, queries, input);
  return { analysis: resolved.analysis };
}

/** Run the judge for an existing running analysis created by {@link prepareQueueAnalysis}. */
export async function executeQueueAnalysis(
  dataDir: string,
  queries: DbQueries,
  input: RunQueueAnalysisInput,
  analysis: QueueAnalysis,
): Promise<RunQueueAnalysisResult> {
  const resolved = await resolveAnalysis(dataDir, queries, input, analysis);
  return runPendingJudge(dataDir, queries, input, resolved);
}

/** Run the complete judge on a fresh analysis (sync; used by direct/legacy callers). */
export async function runQueueAnalysis(
  dataDir: string,
  queries: DbQueries,
  input: RunQueueAnalysisInput,
): Promise<RunQueueAnalysisResult> {
  const resolved = await resolveAnalysis(dataDir, queries, input);
  return runPendingJudge(dataDir, queries, input, resolved);
}

/**
 * Resolve and verify the archives, create (or reuse) the running analysis row,
 * and return everything the background judge needs. Shared by
 * {@link prepareQueueAnalysis}, {@link executeQueueAnalysis}, and
 * {@link runQueueAnalysis} so they cannot diverge. When `existingAnalysis` is
 * supplied the pre-created row is reused and no second row or directory is made.
 */
async function resolveAnalysis(
  dataDir: string,
  queries: DbQueries,
  input: RunQueueAnalysisInput,
  existingAnalysis?: QueueAnalysis,
): Promise<ResolvedAnalysis> {
  const queue = queries.getEvalQueue(input.queueId);
  if (!queue) throw new Error(`eval queue not found: ${input.queueId}`);
  const project = queries.getProject(queue.projectId);
  if (!project) throw new Error(`project not found: ${queue.projectId}`);
  const batchRuns = queries
    .listRuns({ batchId: input.batchId })
    .filter((run) => run.queueId === queue.id);
  const selectedIds = input.runIds?.length
    ? [...new Set(input.runIds)]
    : batchRuns.map((run) => run.id);
  if (selectedIds.length === 0) throw new Error("queue analysis requires at least one run");
  const runs = selectedIds.map((runId) => {
    const run = batchRuns.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`run ${runId} does not belong to queue batch ${input.batchId}`);
    return run;
  });

  // Verify every immutable archive up front so a bad/tainted archive fails fast
  // (before any judge model spend).
  const evidenceHashes: Record<string, string> = {};
  for (const run of runs) {
    const archive = queries.getEvalArchive(run.id);
    if (!archive) throw new Error(`eval archive not found: ${run.id}`);
    const verification = await verifyEvalArchive(archive);
    if (!verification.ok || !verification.manifest) {
      throw new Error(
        `eval archive verification failed for ${run.id}: ${verification.errors.join("; ")}`,
      );
    }
    evidenceHashes[run.id] = archive.manifestSha256;
  }

  const analysis = existingAnalysis ?? queries.createQueueAnalysis({
    queueId: queue.id,
    projectId: queue.projectId,
    batchId: input.batchId,
    selectedRunIds: selectedIds,
    evidenceHashes,
    judgeModel: input.judgeModel,
    judgeProvider: input.judgeProvider,
    judgeParams: input.judgeParams ?? null,
    judgePrompt: input.judgePrompt ?? null,
    systemPromptVersion: QUEUE_JUDGE_SYSTEM_PROMPT_VERSION,
    parentAnalysisId: input.parentAnalysisId ?? null,
    status: "running",
  });
  const analysisDir = join(
    dataDir,
    "projects",
    queue.projectId,
    "queue-analyses",
    analysis.id,
  );
  if (!existingAnalysis) {
    await mkdir(analysisDir, { recursive: true });
  }
  const eventsPath = join(analysisDir, "pi-judge-events.jsonl");
  const rawResponsePath = join(analysisDir, "pi-session.json");
  const verdictPath = join(analysisDir, "verdict.json");
  const reportPath = join(analysisDir, "report.html");
  if (!existingAnalysis) {
    queries.updateQueueAnalysis(analysis.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      eventsPath,
      rawResponsePath,
    });
  }
  return {
    queue,
    project,
    runs,
    selectedIds,
    analysis,
    analysisDir,
    eventsPath,
    rawResponsePath,
    verdictPath,
    reportPath,
    evidenceHashes,
  };
}

/** Drive the judge agent and persist the completed/failed revision. */
async function runPendingJudge(
  dataDir: string,
  queries: DbQueries,
  input: RunQueueAnalysisInput,
  resolved: ResolvedAnalysis,
): Promise<RunQueueAnalysisResult> {
  const {
    queue,
    project,
    runs,
    selectedIds,
    analysis,
    analysisDir,
    eventsPath,
    rawResponsePath,
    verdictPath,
    reportPath,
    evidenceHashes,
  } = resolved;

  const archives = new Map<string, ArchiveCtx>();
  for (const run of runs) {
    const archive = queries.getEvalArchive(run.id);
    if (!archive) throw new Error(`eval archive not found: ${run.id}`);
    const verification = await verifyEvalArchive(archive);
    if (!verification.ok || !verification.manifest) {
      throw new Error(
        `eval archive verification failed for ${run.id}: ${verification.errors.join("; ")}`,
      );
    }
    archives.set(run.id, {
      run,
      archive,
      manifest: verification.manifest,
      root: resolve(archive.manifestPath, ".."),
      listed: false,
      coverage: new Map(),
    });
  }

  const evidenceIndexes = new Map<string, QueueEvidenceIndex>();
  for (const [runId, ctx] of archives) {
    evidenceIndexes.set(runId, await buildEvidenceIndex(ctx));
  }

  try {
    const submissionState: { value: QueueSubmission | null } = { value: null };
    const scratchPath = join(analysisDir, "judge-scratchpad.txt");
    const tools = createQueueJudgeTools(archives, selectedIds, evidenceIndexes, (accepted) => {
      submissionState.value = accepted;
    }, scratchPath);
    await runPiJudgeAgent({
      cwd: analysisDir,
      agentDir: join(analysisDir, ".pi-agent"),
      provider: input.judgeProvider,
      model: input.judgeModel,
      systemPrompt: queueJudgeSystemPrompt(input.judgePrompt),
      userPrompt: JSON.stringify({
        project: { id: project.id, name: project.name },
        queue: { id: queue.id, name: queue.name, description: queue.description },
        batchId: input.batchId,
        selectedRuns: runs.map((run) => ({
          runId: run.id,
          taskId: run.taskId,
          status: run.status,
          evalVersion: run.evalVersion,
          archiveHash: evidenceHashes[run.id],
        })),
        operatorSteer: input.judgePrompt ?? null,
        instruction:
          "Inspect every byte of every listed archive file through tools, then submit one per-eval Verdict plus the queue-wide analysis.",
      }),
      tools,
      eventsPath,
      transcriptPath: rawResponsePath,
      timeoutMs:
        typeof input.judgeParams?.timeoutMs === "number"
          ? input.judgeParams.timeoutMs
          : 30 * 60_000,
      maxTokens:
        typeof input.judgeParams?.maxTokens === "number"
          ? input.judgeParams.maxTokens
          : 16_384,
      thinkingLevel: judgeThinkingLevel(input.judgeParams?.thinkingLevel),
    });
    const submission = submissionState.value as QueueSubmission | null;
    if (!submission) {
      throw new Error("PI queue judge ended without a valid submit_queue_analysis call");
    }

    const byRun = new Map(submission.perEval.map((entry) => [entry.runId, entry]));
    if (byRun.size !== selectedIds.length || selectedIds.some((id) => !byRun.has(id))) {
      throw new Error("queue judge submission must contain exactly one verdict for every selected run");
    }

    const reportEvals: Array<{
      runId: string;
      taskName: string;
      verdict: Verdict;
      narrative: QueueSubmission["perEval"][number]["narrative"];
    }> = [];
    queries.transaction(() => {
      for (const runId of selectedIds) {
        const ctx = archives.get(runId)!;
        const submitted = byRun.get(runId)!;
        const verdict = submitted.verdict;
        validateVerdict(verdict, { hasSourceArtifacts: hasSourceArtifacts(ctx.manifest) });
        const judgement = queries.createJudgement({
          runId,
          projectId: queue.projectId,
          queueAnalysisId: analysis.id,
          judgeModel: input.judgeModel,
          judgeProvider: input.judgeProvider,
          ...(input.judgePrompt ? { judgePrompt: input.judgePrompt } : {}),
          systemPromptVersion: QUEUE_JUDGE_SYSTEM_PROMPT_VERSION,
          status: "running",
        });
        queries.storeVerdict(judgement.id, verdict, submitted.narrative);
        const executionMetrics = queries.getEvalMetrics(runId);
        if (executionMetrics) {
          const outcome = deriveOutcomeMetrics({
            runId,
            verdict,
            checks: queries.getCheckResults(runId),
            execution: executionMetrics.execution,
          });
          queries.upsertEvalMetrics({
            runId,
            projectId: queue.projectId,
            schemaVersion: executionMetrics.schemaVersion,
            execution: executionMetrics.execution,
            outcome: outcome as unknown as Record<string, unknown>,
          });
        }
        const snapshot = ctx.run.evalSnapshot;
        const taskName =
          snapshot && typeof snapshot.name === "string"
            ? snapshot.name
            : (queries.getTask(ctx.run.taskId)?.name ?? ctx.run.taskId);
        reportEvals.push({ runId, taskName, verdict, narrative: submitted.narrative });
      }
      queries.storeImprovementSteps(
        analysis.id,
        queue.projectId,
        queue.id,
        submission.queueAnalysis.improvementPlan,
      );
    });

    await writeFile(
      verdictPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          analysisId: analysis.id,
          queueId: queue.id,
          batchId: input.batchId,
          selectedRunIds: selectedIds,
          evidenceHashes,
          perEval: submission.perEval,
          queueAnalysis: submission.queueAnalysis,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      reportPath,
      renderQueueReport({
        projectName: project.name,
        queueName: queue.name,
        batchId: input.batchId,
        analysisId: analysis.id,
        model: input.judgeModel,
        provider: input.judgeProvider,
        createdAt: new Date().toISOString(),
        queue: submission.queueAnalysis,
        evals: reportEvals,
      }),
      "utf8",
    );
    // Bundle the whole queue-run into one self-contained archive: the judge's own
    // artifacts (events/session/scratchpad/verdict/report) plus every sealed eval
    // archive the judge analyzed. One file holds the complete record.
    try {
      const evalArchiveDirs = selectedIds
        .map((runId) => queries.getEvalArchive(runId)?.manifestPath)
        .filter((p): p is string => Boolean(p))
        .map((p) => dirname(p));
      await sealQueueRunArchive({ analysisDir, evalArchiveDirs });
    } catch (archiveErr) {
      // Archive bundling is best-effort; never fail the completed analysis over it.
      await appendFile(
        join(analysisDir, "queue-run-archive.error.log"),
        `${new Date().toISOString()} ${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}\n`,
        "utf8",
      ).catch(() => undefined);
    }
    const completed = queries.updateQueueAnalysis(analysis.id, {
      status: "completed",
      verdictPath,
      reportPath,
      eventsPath,
      rawResponsePath,
      endedAt: new Date().toISOString(),
      error: null,
    });
    return { analysis: completed, verdictPath, reportPath, status: "completed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = queries.updateQueueAnalysis(analysis.id, {
      status: "failed",
      endedAt: new Date().toISOString(),
      eventsPath,
      rawResponsePath,
      error: message,
    });
    return { analysis: failed, status: "failed", error: message };
  }
}

interface QueueJudgeToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function queueJudgeToolSpecs(): QueueJudgeToolSpec[] {
  return [
    {
      name: "list_evals",
      description: "List every selected eval and immutable archive hash.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_archive_files",
      description: "List the complete immutable archive manifest for one run.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
        additionalProperties: false,
      },
    },
    {
      name: "read_archive_file",
      description:
        "Read exact bytes from one archive file. Continue with offsets until eof=true; every file must be fully read before submission.",
      parameters: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          path: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 1, maximum: MAX_READ_BYTES },
        },
        required: ["run_id", "path"],
        additionalProperties: false,
      },
    },
    {
      name: "judge_scratchpad",
      description:
        "Persist key findings, analysis points, verdicts-in-progress, and open questions to a durable scratchpad file that survives compaction. Use it BEFORE any long stretch of reading or any compaction: write a compact summary of what you have concluded so far, each eval's provisional verdict + evidence refs, and what remains. Append progressively; read it back after compaction to continue without re-reading archives. This file is your long-term memory across the session.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["append", "read"] },
          content: { type: "string", description: "New findings to append (required for action=append)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "preflight_queue_analysis",
      description:
        "Validate the complete queue-analysis v2 payload. Returns path-specific errors or an opaque submission token.",
      parameters: {
        type: "object",
        properties: {
          per_eval: { type: "array", items: { type: "object" } },
          queue_analysis: { type: "object" },
        },
        required: ["per_eval", "queue_analysis"],
        additionalProperties: false,
      },
    },
    {
      name: "submit_queue_analysis",
      description:
        "Finalize the exact payload accepted by preflight_queue_analysis using its opaque token.",
      parameters: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
    },
  ];
}

function createQueueJudgeTools(
  archives: Map<string, ArchiveCtx>,
  selectedIds: string[],
  evidenceIndexes: Map<string, QueueEvidenceIndex>,
  onSubmission: (submission: QueueSubmission) => void,
  scratchPath: string,
): ToolDefinition[] {
  const preflightState: { token: string | null; submission: QueueSubmission | null } = {
    token: null,
    submission: null,
  };
  return queueJudgeToolSpecs().map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: spec.description,
    promptGuidelines: [
      "Use this tool only for immutable eval evidence and the final validated submission.",
    ],
    parameters: spec.parameters as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_toolCallId, rawParams) {
      try {
        const params =
          rawParams && typeof rawParams === "object"
            ? (rawParams as Record<string, unknown>)
            : {};
        const outcome = await executeTool(
          spec.name,
          params,
          archives,
          selectedIds,
          evidenceIndexes,
          preflightState,
          scratchPath,
        );
        if (outcome.submission) onSubmission(outcome.submission);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome.response) }],
          details: outcome.log,
          ...(outcome.submission ? { terminate: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          details: { error: message },
          isError: true,
        };
      }
    },
  }));
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  archives: Map<string, ArchiveCtx>,
  selectedIds: string[],
  evidenceIndexes: Map<string, QueueEvidenceIndex>,
  preflightState: { token: string | null; submission: QueueSubmission | null },
  scratchPath: string,
): Promise<{
  response: unknown;
  log: Record<string, unknown>;
  submission?: QueueSubmission;
}> {
  if (name === "list_evals") {
    return {
      response: selectedIds.map((runId) => ({
        runId,
        archiveHash: archives.get(runId)!.archive.manifestSha256,
      })),
      log: { evalCount: selectedIds.length },
    };
  }
  if (name === "list_archive_files") {
    const ctx = requireArchive(archives, args.run_id);
    ctx.listed = true;
    return {
      response: ctx.manifest,
      log: { runId: ctx.run.id, files: ctx.manifest.files.length },
    };
  }
  if (name === "read_archive_file") {
    const ctx = requireArchive(archives, args.run_id);
    const path = typeof args.path === "string" ? args.path : "";
    const entry = ctx.manifest.files.find((candidate) => candidate.path === path);
    if (!entry) throw new Error(`archive path not found for ${ctx.run.id}: ${path}`);
    const absolute = resolve(ctx.root, path);
    if (absolute !== ctx.root && !absolute.startsWith(`${ctx.root}${sep}`)) {
      throw new Error(`archive path escapes root: ${path}`);
    }
    const offset =
      typeof args.offset === "number" && Number.isInteger(args.offset) && args.offset >= 0
        ? args.offset
        : 0;
    const requested =
      typeof args.length === "number" && Number.isInteger(args.length)
        ? Math.min(MAX_READ_BYTES, Math.max(1, args.length))
        : MAX_READ_BYTES;
    let payload: Buffer;
    let encoding: "utf8" | "base64" = "utf8";
    if (entry.kind === "symlink") {
      payload = Buffer.from(await readlink(absolute), "utf8");
    } else {
      const file = await readFile(absolute);
      payload = file.subarray(offset, Math.min(file.length, offset + requested));
      if (payload.includes(0)) encoding = "base64";
    }
    const end = Math.min(entry.bytes, offset + payload.length);
    addCoverage(ctx.coverage, path, offset, end);
    return {
      response: {
        runId: ctx.run.id,
        path,
        offset,
        bytes: payload.length,
        totalBytes: entry.bytes,
        eof: end >= entry.bytes,
        encoding,
        content: encoding === "base64" ? payload.toString("base64") : payload.toString("utf8"),
      },
      log: { runId: ctx.run.id, path, offset, end, totalBytes: entry.bytes },
    };
  }
  if (name === "judge_scratchpad") {
    const action = args.action === "read" ? "read" : "append";
    if (action === "read") {
      const content = await readFile(scratchPath, "utf8").catch(() => "");
      return {
        response: { content: content.slice(-200_000) },
        log: { action, bytes: content.length },
      };
    }
    const content = typeof args.content === "string" ? args.content : "";
    await appendFile(scratchPath, `${content}\n`, "utf8");
    return {
      response: { appended: true },
      log: { action, appendedBytes: content.length },
    };
  }
  if (name === "preflight_queue_analysis") {
    const missing = missingEvidence(archives, selectedIds);
    if (missing.length > 0) {
      return {
        response: {
          accepted: false,
          error: "every archive file must be fully inspected before preflight",
          missing,
        },
        log: { accepted: false, missingCount: missing.length },
      };
    }
    let submission: QueueSubmission;
    try {
      submission = parseQueueSubmission(args);
    } catch (err) {
      const validationIssues =
        err && typeof err === "object" && "issues" in err
          ? (err as { issues: unknown }).issues
          : [{ path: "$", message: err instanceof Error ? err.message : String(err) }];
      return {
        response: { accepted: false, error: "submission shape invalid", validationIssues },
        log: { accepted: false, phase: "parse" },
      };
    }
    const validationIssues = validateQueueSubmission(submission, {
      selectedRunIds: selectedIds,
      evidence: evidenceIndexes,
    });
    if (validationIssues.length > 0) {
      preflightState.token = null;
      preflightState.submission = null;
      return {
        response: {
          accepted: false,
          error: "queue analysis v2 validation failed",
          validationIssues,
        },
        log: { accepted: false, validationIssueCount: validationIssues.length },
      };
    }
    const token = randomUUID();
    preflightState.token = token;
    preflightState.submission = submission;
    return {
      response: {
        accepted: true,
        token,
        perEval: submission.perEval.length,
        improvementSteps: submission.queueAnalysis.improvementPlan.length,
      },
      log: { accepted: true, perEval: submission.perEval.length },
    };
  }
  if (name === "submit_queue_analysis") {
    const token = typeof args.token === "string" ? args.token : "";
    if (!preflightState.token || token !== preflightState.token || !preflightState.submission) {
      return {
        response: {
          accepted: false,
          error: "token is missing, unknown, or superseded; run preflight_queue_analysis again",
        },
        log: { accepted: false, tokenMatched: false },
      };
    }
    return {
      response: { accepted: true },
      log: { accepted: true, perEval: preflightState.submission.perEval.length },
      submission: preflightState.submission,
    };
  }
  return {
    response: { error: `unknown tool: ${name}` },
    log: { unknownTool: name },
  };
}

function requireArchive(
  archives: Map<string, ArchiveCtx>,
  runId: unknown,
): ArchiveCtx {
  if (typeof runId !== "string" || !archives.has(runId)) {
    throw new Error(`unknown selected run: ${String(runId)}`);
  }
  return archives.get(runId)!;
}

function addCoverage(
  coverage: Map<string, Array<[number, number]>>,
  path: string,
  start: number,
  end: number,
): void {
  const ranges = [...(coverage.get(path) ?? []), [start, end] as [number, number]].sort(
    (a, b) => a[0] - b[0],
  );
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1]) merged.push([...range]);
    else last[1] = Math.max(last[1], range[1]);
  }
  coverage.set(path, merged);
}

function missingEvidence(
  archives: Map<string, ArchiveCtx>,
  selectedIds: string[],
): Array<{ runId: string; path: string; remainingBytes: number }> {
  const missing: Array<{ runId: string; path: string; remainingBytes: number }> = [];
  for (const runId of selectedIds) {
    const ctx = archives.get(runId)!;
    if (!ctx.listed) {
      missing.push({ runId, path: "archive.json", remainingBytes: 1 });
    }
    for (const entry of ctx.manifest.files) {
      const covered = (ctx.coverage.get(entry.path) ?? []).reduce(
        (sum, [start, end]) => sum + Math.max(0, end - start),
        0,
      );
      if (covered < entry.bytes) {
        missing.push({ runId, path: entry.path, remainingBytes: entry.bytes - covered });
      }
    }
  }
  return missing;
}

/** Validate the terminating queue-judge submission covers each selected run exactly once. */
export function validateQueueSubmissionRunIds(
  submittedIds: string[],
  selectedIds: string[],
): {
  exact: boolean;
  missingRunIds: string[];
  unknownRunIds: string[];
  duplicateRunIds: string[];
} {
  const selected = new Set(selectedIds);
  const counts = new Map<string, number>();
  for (const runId of submittedIds) counts.set(runId, (counts.get(runId) ?? 0) + 1);
  const missingRunIds = selectedIds.filter((runId) => !counts.has(runId));
  const unknownRunIds = [...counts.keys()].filter((runId) => !selected.has(runId));
  const duplicateRunIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([runId]) => runId);
  return {
    exact:
      submittedIds.length === selectedIds.length &&
      missingRunIds.length === 0 &&
      unknownRunIds.length === 0 &&
      duplicateRunIds.length === 0,
    missingRunIds,
    unknownRunIds,
    duplicateRunIds,
  };
}

/** Build exact trace/tool/diff/artifact lookup data for deep ref validation. */
async function buildEvidenceIndex(ctx: ArchiveCtx): Promise<QueueEvidenceIndex> {
  let maxTraceSeq = -1;
  const toolCallIds = new Set<string>();
  const diffHunks: Array<{ file: string; hunk: number }> = [];
  const eventsEntry = ctx.manifest.files.find((entry) => entry.path === "events.jsonl");
  if (eventsEntry?.kind === "file") {
    for await (const raw of readJsonl(join(ctx.root, eventsEntry.path))) {
      if (!isCanonicalEvent(raw)) continue;
      maxTraceSeq = Math.max(maxTraceSeq, raw.seq);
      if (raw.type === "tool.call" || raw.type === "tool.result") {
        if (raw.id.length > 0) toolCallIds.add(raw.id);
      }
    }
  }
  const hunksEntry = ctx.manifest.files.find((entry) => entry.path === "diff.hunks.json");
  if (hunksEntry?.kind === "file") {
    try {
      const parsed = JSON.parse(await readFile(join(ctx.root, hunksEntry.path), "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          if (
            value &&
            typeof value === "object" &&
            typeof (value as { file?: unknown }).file === "string" &&
            typeof (value as { hunk?: unknown }).hunk === "number"
          ) {
            diffHunks.push({
              file: (value as { file: string }).file,
              hunk: (value as { hunk: number }).hunk,
            });
          }
        }
      }
    } catch {
      // Archive integrity verifies bytes, not semantic JSON. Missing semantic
      // index entries make invalid refs fail preflight instead of being guessed.
    }
  }
  return {
    runId: ctx.run.id,
    hasSourceArtifacts: hasSourceArtifacts(ctx.manifest),
    maxTraceSeq,
    toolCallIds: [...toolCallIds].sort(),
    diffHunks,
    artifactPaths: ctx.manifest.files.map((entry) => entry.path),
  };
}

function hasSourceArtifacts(manifest: EvalArchiveManifest): boolean {
  return manifest.files.some(
    (entry) => entry.path === "diff.patch" || entry.path === "outputs-manifest.json",
  );
}

function judgeThinkingLevel(
  value: unknown,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : "high";
}

function queueJudgeSystemPrompt(judgePrompt?: string | null): string {
  const base = assembleJudgeSystemPrompt({
    taskPrompt:
      "Judge every selected eval independently from its immutable archived task snapshot, then synthesize one queue-wide analysis.",
    rubric: {
      mode: "per-eval",
      instruction:
        "Each eval archive contains its own task and rubric snapshot. Apply that rubric only to that eval.",
    },
    agentCategory: "Use each archived eval's category; coding evals include source artifacts.",
    runMetadata: { mode: "queue", engine: "pi", evidence: "immutable eval archives" },
    eventsPreview:
      "No bounded preview is authoritative in queue mode. Use the custom archive tools to inspect every byte of every selected archive.",
    ...(judgePrompt ? { judgePrompt } : {}),
    hasSourceArtifacts: true,
  });
  return `${base}

QUEUE MODE OVERRIDE — this section replaces the single-run output mechanics above.
You are the agenteval queue judge. You are judging immutable evidence from multiple evals of one CLI agent.
For each eval, apply the source/improvements lens gate from that eval's own archive: include withSource only when that archive contains source artifacts.
Do not emit a plain JSON response and do not generate HTML yourself. Use only the custom evidence tools. Agent outcome score and platform evidence integrity are independent: a 1.0 score must not hide observed platform concerns.

YOU ARE REQUIRED TO ACTUALLY ANALYZE THE EVIDENCE — do not just skim, and do NOT let the later evals get less attention than the first. Every eval archive must receive the SAME mandatory reading before you move on. The files are tiered; the MANDATORY tier is small enough that you can fully read it for EVERY eval, so uneven coverage is never acceptable. Optional tiers are only for deeper investigation and are NOT required for every eval.

TIER CONTRACT PER EVAL ARCHIVE — the files are classified:
  MANDATORY (you MUST fully read these for EVERY eval, in this order):
    README.md                 (navigator — 1 read)
    trajectory.jsonl          (the agent's complete turn/event/session log: thinking, messages, tool calls, results — READ THE WHOLE FILE)
    transcript.md             (the human-readable session transcript — READ THE WHOLE FILE)
    diff.patch                (exactly what the agent changed)
    final-result.json         (the agent's final result)
    verifier-result.json      (the grade / reward / checks)
    agent-stdout.log          (the agent's live output)
    platform/run.json, platform/run-metrics.json, platform/evidence-integrity.json  (reconcile; metrics win contradictions)
  OPTIONAL — FURTHER INVESTIGATION (read ONLY when needed to answer a specific question about an eval's reasoning, a defect's root cause, or a pass/fail why):
    events.jsonl              (canonical platform events — only if platform behavior is in question)
    model-calls/*             (per-turn model request/response — to inspect specific reasoning)
    tool-logs/*               (per-tool/shell exec output — to see what the agent actually ran)
    further-evidence/*        (live-conversation, langfuse, file-snapshots, trajectory metrics — to confirm a hypothesis)
    everything else under platform/ (setup/cleanup/workspace manifests)

For every eval, the MANDATORY tier must be fully read before you produce that eval's verdict. The optional tiers exist for when you need more depth — consult them freely for any eval that warrants it, but their absence from an eval is acceptable; the MANDATORY tier for every eval is not.

MANDATORY PROCESS:
1. Call list_evals.
2. For EVERY run call list_archive_files to see the layout, then read the MANDATORY tier fully (README, trajectory.jsonl, transcript.md, diff.patch, final-result.json, verifier-result.json, agent-stdout.log, platform/run.json+run-metrics+evidence-integrity). Confirm you have read trajectory.jsonl and transcript.md to their full size (read until eof=true) — do not stop partway. If the MANDATORY tier or the pass/fail reasoning is unclear, consult the OPTIONAL tiers to deepen understanding and find the root cause.
3. Write the eval's findings (behavior, reasoning, root cause, provisional verdict + refs) to the scratchpad (step 9) BEFORE moving to the next eval, so coverage is preserved if the session compacts.
4. Produce a verdict for the eval: overall score (0..1), pass/partial/fail, a truthful narrative of what the agent did, strengths, concerns (owner class agent/platform/judge/eval), and evidence refs to the exact paths read.
5. Repeat 2-4 for EVERY eval with equal mandatory coverage.
6. Synthesize the queue-wide analysis: themes, reliability, ranked defects across ALL evals, subsystem attribution, regressions, improvement plan.
7. Ground every claim in real refs; mark observed facts vs hypotheses/missing evidence. Build all four owner backlogs that apply (do not invent).
8. Call preflight_queue_analysis with the complete payload. Correct every path-specific error.
9. Call submit_queue_analysis exactly once with the successful preflight token. You MUST deliver a complete, defensible report covering EVERY eval. Skipping any eval's MANDATORY reading is a failure.
10. SCRATCHPAD DISCIPLINE (retain, never skip): Before any long read, before opening a very large file, and ESPECIALLY before any compaction, call judge_scratchpad(action="append", ...) with that eval's findings + what remains. After compaction, judge_scratchpad(action="read") to restore and continue. Check the scratchpad between evals too, so later evals get the same depth as the first. Never let later-eval coverage drop because the early evals consumed the session — the scratchpad is how you keep even, deep coverage.

preflight_queue_analysis arguments:
- per_eval: [{run_id, verdict, narrative}]. verdict is the standard schemaVersion:1 Verdict described above. narrative is:
  {schemaVersion:1,headline:string,judgement:string,
   executionAnalysis:[{stage,judgement,refs:Ref[]}],
   strengths:[{text,refs:Ref[]}],
   concerns:[{severity,text,refs:Ref[],implication,ownerClass:"agent"|"platform"|"judge"|"eval",findingIds:string[]}],
   evidenceBoundaries:[{status:"observed"|"hypothesis"|"missing",text,refs:Ref[]}],
   handoff:{preserve:Handoff[],change:Handoff[],investigate:Handoff[]}}
  Handoff={text,refs:Ref[],ownerClass:"agent"|"platform"|"judge"|"eval"}.
- queue_analysis:
  {schemaVersion:2,summary,
   themes:[{text,refs:Ref[]}],reliability:{assessment,evidence:Ref[]},
   rankedDefects:[{id,type:"observed",rank,title,category,severity,runIds,description,evidence:Ref[],verification:string[]}],
   subsystemAttribution:[{subsystem,runIds,explanation,evidence:Ref[]}],
   regressions:[{text,refs:Ref[]}],
   improvementPlan:[QueueImprovementStep]}.
  QueueImprovementStep={id,rank,class:"agent"|"platform"|"judge"|"eval",priority:0|1|2|3,confidence:0..1,
   defectIds:string[],subsystem,problem,evidence:Ref[],target:{kind:"code"|"config"|"prompt"|"eval",paths:string[]}|{kind:"external",system,blocker},
   change,acceptanceCriteria:string[],tests:[{name,kind:"unit"|"integration"|"e2e",command?,expected}],
   verifyTaskIds:string[],regressionTaskIds:string[],dependencies:string[],nonGoals:string[],preventive:boolean,
   status:"proposed"|"ready"|"blocked"|"in_progress"|"verified"|"rejected",blockingReason?}.
  Ref is one of {kind:"trace",runId,seqs:[start,end]}, {kind:"tool",toolCallId}, {kind:"diff",file,hunk,lines?}, or {kind:"artifact",path,sha256?,note?}.

Every narrative claim needs refs. Every plan step needs linked observed defects, evidence, a resolved target or explicit external blocker, acceptance criteria, at least one test, and non-empty verify+regression task sets. Preventive hardening belongs in the plan, not rankedDefects. A nit-only step cannot outrank evidence-integrity/blocker/major work.

SKILLS: You have the \`master-core-design\` skill loaded. While analyzing the archived logs/traces/diffs and authoring the queue report narrative and its improvement plan, apply that skill's design reasoning, structure, accessibility, and anti-AI-slop review to any output that has a design surface (report narrative, recommendations, handoff). Use the skill as your design brain; ground every design-affecting claim in the archived evidence the way you ground every other claim.

Do not invent evidence. Do not omit an eval. Do not submit a changed or un-preflighted payload.`;
}

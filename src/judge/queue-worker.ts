/** One real tool-using judge agent over immutable queue eval archives. */

import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  DbQueries,
  EvalArchive,
  QueueAnalysis,
  Run,
} from "../db/queries.js";
import { verifyEvalArchive, type EvalArchiveManifest } from "../runner/eval-archive.js";
import { runPiJudgeAgent } from "./pi-agent.js";
import {
  assembleJudgeSystemPrompt,
  JUDGE_SYSTEM_PROMPT_VERSION,
} from "./prompt.js";
import { renderQueueReport, type QueueWideAnalysis } from "./queue-report.js";
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

interface ArchiveCtx {
  run: Run;
  archive: EvalArchive;
  manifest: EvalArchiveManifest;
  root: string;
  listed: boolean;
  coverage: Map<string, Array<[number, number]>>;
}

interface QueueSubmission {
  perEval: Array<{ runId: string; verdict: Verdict }>;
  queueAnalysis: QueueWideAnalysis;
}

/** Run a single real DeepSeek/OpenAI-compatible judge session over selected archives. */
export async function runQueueAnalysis(
  dataDir: string,
  queries: DbQueries,
  input: RunQueueAnalysisInput,
): Promise<RunQueueAnalysisResult> {
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

  const archives = new Map<string, ArchiveCtx>();
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
    archives.set(run.id, {
      run,
      archive,
      manifest: verification.manifest,
      root: resolve(archive.manifestPath, ".."),
      listed: false,
      coverage: new Map(),
    });
  }

  const analysis = queries.createQueueAnalysis({
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
  await mkdir(analysisDir, { recursive: true });
  const eventsPath = join(analysisDir, "pi-judge-events.jsonl");
  const rawResponsePath = join(analysisDir, "pi-session.json");
  const verdictPath = join(analysisDir, "verdict.json");
  const reportPath = join(analysisDir, "report.html");
  queries.updateQueueAnalysis(analysis.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    eventsPath,
    rawResponsePath,
  });

  try {
    const submissionState: { value: QueueSubmission | null } = { value: null };
    const tools = createQueueJudgeTools(archives, selectedIds, (accepted) => {
      submissionState.value = accepted;
    });
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

    const byRun = new Map(submission.perEval.map((entry) => [entry.runId, entry.verdict]));
    if (byRun.size !== selectedIds.length || selectedIds.some((id) => !byRun.has(id))) {
      throw new Error("queue judge submission must contain exactly one verdict for every selected run");
    }

    const reportEvals: Array<{ runId: string; taskName: string; verdict: Verdict }> = [];
    for (const runId of selectedIds) {
      const ctx = archives.get(runId)!;
      const verdict = byRun.get(runId)!;
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
      queries.storeVerdict(judgement.id, verdict);
      const snapshot = ctx.run.evalSnapshot;
      const taskName =
        snapshot && typeof snapshot.name === "string"
          ? snapshot.name
          : (queries.getTask(ctx.run.taskId)?.name ?? ctx.run.taskId);
      reportEvals.push({ runId, taskName, verdict });
    }

    await writeFile(
      verdictPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
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
      name: "submit_queue_analysis",
      description:
        "Submit exactly one validated Verdict per selected run and one cross-eval queue analysis. Rejected until all archive files are fully read.",
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
  ];
}

function createQueueJudgeTools(
  archives: Map<string, ArchiveCtx>,
  selectedIds: string[],
  onSubmission: (submission: QueueSubmission) => void,
): ToolDefinition[] {
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
        const outcome = await executeTool(spec.name, params, archives, selectedIds);
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
  if (name === "submit_queue_analysis") {
    const missing = missingEvidence(archives, selectedIds);
    if (missing.length > 0) {
      return {
        response: {
          accepted: false,
          error: "every archive file must be fully inspected before submission",
          missing,
        },
        log: { accepted: false, missingCount: missing.length },
      };
    }
    let submission: QueueSubmission;
    try {
      submission = parseSubmission(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        response: { accepted: false, error: `submission shape invalid: ${message}` },
        log: { accepted: false, error: message },
      };
    }
    // Validate each per-eval verdict so the judge can correct and retry rather
    // than the whole analysis failing after submission.
    const validationErrors: string[] = [];
    for (const entry of submission.perEval) {
      const ctx = archives.get(entry.runId);
      try {
        validateVerdict(entry.verdict, {
          hasSourceArtifacts: ctx ? hasSourceArtifacts(ctx.manifest) : true,
        });
      } catch (err) {
        validationErrors.push(
          `${entry.runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (validationErrors.length > 0) {
      return {
        response: {
          accepted: false,
          error:
            "one or more verdicts failed schema validation — correct every error and call submit_queue_analysis again",
          validationErrors,
        },
        log: { accepted: false, validationErrors: validationErrors.length },
      };
    }
    return {
      response: { accepted: true },
      log: { accepted: true, perEval: submission.perEval.length },
      submission,
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

function parseSubmission(args: Record<string, unknown>): QueueSubmission {
  const rawPerEval = args.per_eval;
  const rawQueue = args.queue_analysis;
  if (!Array.isArray(rawPerEval) || !rawQueue || typeof rawQueue !== "object") {
    throw new Error("submit_queue_analysis requires per_eval and queue_analysis");
  }
  const perEval = rawPerEval.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid per_eval entry");
    const object = entry as Record<string, unknown>;
    const runId = object.run_id ?? object.runId;
    if (typeof runId !== "string" || !object.verdict || typeof object.verdict !== "object") {
      throw new Error("each per_eval entry requires run_id and verdict");
    }
    return { runId, verdict: object.verdict as Verdict };
  });
  const queue = rawQueue as Record<string, unknown>;
  if (
    typeof queue.summary !== "string" ||
    !Array.isArray(queue.themes) ||
    !queue.reliability ||
    typeof queue.reliability !== "object" ||
    !Array.isArray(queue.rankedDefects ?? queue.ranked_defects) ||
    !Array.isArray(queue.subsystemAttribution ?? queue.subsystem_attribution) ||
    !Array.isArray(queue.regressions) ||
    !Array.isArray(queue.improvementPlan ?? queue.improvement_plan)
  ) {
    throw new Error("queue_analysis is missing required queue-wide fields");
  }
  const normalized: QueueWideAnalysis = {
    summary: queue.summary,
    themes: queue.themes.map(String),
    reliability: queue.reliability as QueueWideAnalysis["reliability"],
    rankedDefects: (queue.rankedDefects ?? queue.ranked_defects) as QueueWideAnalysis["rankedDefects"],
    subsystemAttribution: (queue.subsystemAttribution ??
      queue.subsystem_attribution) as QueueWideAnalysis["subsystemAttribution"],
    regressions: queue.regressions.map(String),
    improvementPlan: (queue.improvementPlan ??
      queue.improvement_plan) as QueueWideAnalysis["improvementPlan"],
  };
  return { perEval, queueAnalysis: normalized };
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
Do not emit a plain JSON response and do not generate HTML yourself. Use the custom evidence tools and terminate only through submit_queue_analysis; the platform validates the submission and renders the report.

MANDATORY PROCESS:
1. Call list_evals.
2. For EVERY run call list_archive_files.
3. Read EVERY listed file completely with read_archive_file. If a file exceeds one chunk, continue with increasing offsets until eof=true. Do not sample, skip, or use only first/last events.
4. Ground every per-eval finding in structured refs that validate under the standard Verdict schema.
5. Compare behavior across evals: reliability, recurring failure modes, subsystem attribution, regression signals, and exact verification sets.
6. Finish only with submit_queue_analysis. Early submission is rejected.

submit_queue_analysis arguments:
- per_eval: [{run_id, verdict}], where every verdict has this exact required shape:
  {
    schemaVersion:1,
    overall:{score:number 0..1,verdict:"pass"|"partial"|"fail",summary:string},
    criteria:[{criterion:string,weight:number,critical?:boolean,feedback:string,score:number 0..1,evidence:string[],findingIds:string[]}],
    findings:[Finding], positiveFindings:[Finding],
    metaFindings:[{id:string,category:"rubric_unverifiable"|"prompt_ambiguous"|"evidence_missing",claim:string,note?:string}],
    diagnostics:{[name]:{value:boolean,refs?:Ref[],note?:string}},
    attribution:{agent_vs_environment:"agent"|"environment"|"mixed",note?:string},
    observations:string[],
    improvements:{summary:string,withoutSource:Improvement[],withSource?:Improvement[]}
  }
  Finding={id,category,severity:"blocker"|"major"|"minor"|"nit",confidence:0..1,criterion?,claim,refs:Ref[] (at least one),fix?:{direction,repro?:{command,expected}},subsystem?:"prompt"|"tool_description"|"scaffold"|"model_capability"|"task_definition"|"environment",decisionPoint?:{seq,whatHappened,counterfactual,evidenceAvailableAtSeq?},verification?:{targetTaskIds:string[],regressionTaskIds?:string[],successCriterion?:string}}.
  Ref is one of {kind:"trace",runId,seqs:[start,end]}, {kind:"tool",toolCallId}, {kind:"diff",file,hunk,lines?}, or {kind:"artifact",path,sha256?,note?}.
  Improvement={area:string,priority:"high"|"medium"|"low",change:string,why:string,refs:Ref[],linkedFindings:string[]}.
  withoutSource improvements may use only trace/tool refs. withSource is required for coding evals with diff.patch and may use diff/artifact refs.
- queue_analysis: {
  summary: string,
  themes: string[],
  reliability: {assessment:string,evidence:string[]},
  rankedDefects: [{rank:number,title:string,severity:string,runIds:string[],description:string,verification:string[]}],
  subsystemAttribution: [{subsystem:string,runIds:string[],evidence:string}],
  regressions: string[],
  improvementPlan: [{priority:number,action:string,rationale:string,verification:string[]}]
}.

Do not invent evidence. Do not omit an eval. Do not return prose instead of the submit tool.`;
}

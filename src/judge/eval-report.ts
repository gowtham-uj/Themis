/**
 * The eval report — the single, self-contained output of an evaluation.
 *
 * This is THE artifact another agent consumes. Not an index into other
 * endpoints: everything needed to understand what happened and act on it is in
 * here, because a consumer that has to make five follow-up calls will make four
 * of them and guess the fifth.
 *
 * That means it carries, per eval: the prompt, the environment it ran in, the
 * trace, the diff, the artifacts, the verdict, and the findings — plus the
 * cross-eval analysis (reliability, ranked defects, subsystem load, the plan,
 * regressions) that no single eval can show.
 *
 * Two forms of the same content:
 *  - `EvalReport` (JSON) for machines
 *  - the rendered HTML for people
 * Both are produced from this one structure, so they can never disagree.
 */

import type { DbQueries } from "../db/queries.js";
import { collectBatchBundles, type EvalBundle } from "./eval-bundle.js";
import { buildReleaseVerdict } from "./release-judge.js";
import type { ReleaseVerdict } from "./release-verdict.js";
import type { Finding, Verdict } from "./verdict.js";

export const EVAL_REPORT_SCHEMA_VERSION = 1 as const;

/** How large a trace may get before it is summarized rather than inlined. */
const MAX_INLINE_TRACE_EVENTS = 400;
/** How large a diff may get before it is truncated. */
const MAX_INLINE_DIFF_BYTES = 128 * 1024;

/** One eval's complete record, inline. */
export interface EvalReportEntry {
  name: string;
  taskId: string;
  runId: string;
  status: string;
  prompt: string;
  /** greenfield | brownfield | null. */
  envKind: string | null;
  /** Setup outcome — a failed environment is not an agent failure. */
  environment: {
    provisioned: boolean;
    error: string | null;
    baselineCommit: string | null;
    cleanupError: string | null;
  } | null;
  score: number | null;
  verdict: string | null;
  /** Findings, with their routing/decision-point/verification intact. */
  findings: Finding[];
  /** What the agent did, inline (or summarized when very long). */
  trace: {
    eventCount: number;
    /** Present when the trace was small enough to inline. */
    events?: unknown[];
    /** Present instead when it was not — counts by type, plus tool sequence. */
    summary?: {
      byType: Record<string, number>;
      toolSequence: string[];
    };
    /** Where the full trace lives, always. */
    path: string | null;
  };
  /** The agent's changes. */
  diff: { text: string; truncated: boolean; bytes: number } | null;
  /** Deterministic check results, when the rubric defined any. */
  checks: unknown | null;
  /** Screenshots and exported outputs. */
  artifacts: Array<{ path: string; contentType: string; sizeBytes: number; url: string }>;
  /** Per-eval report, for a human following up. */
  reportUrl: string | null;
}

/** The complete evaluation output. */
export interface EvalReport {
  schemaVersion: typeof EVAL_REPORT_SCHEMA_VERSION;
  evaluationId: string;
  projectId: string;
  agentId: string;
  model: string;
  provider: string;
  /** The commit that was evaluated. */
  commit: string | null;
  generatedAt: string;

  /** Headline numbers. */
  summary: {
    score: number;
    evalsTotal: number;
    evalsPassed: number;
    evalsFailed: number;
    evalsUnjudged: number;
    text: string;
  };

  /**
   * WHAT TO DO — first, because it is the only section a consuming agent
   * strictly needs. Everything below justifies it.
   */
  improvementPlan: ReleaseVerdict["improvementPlan"];
  subsystemLoad: ReleaseVerdict["subsystemLoad"];
  reliability: ReleaseVerdict["reliability"];
  rankedDefects: ReleaseVerdict["rankedDefects"];
  recurringDefects: ReleaseVerdict["recurringDefects"];
  explainedRegressions: ReleaseVerdict["explainedRegressions"];
  comparison: ReleaseVerdict["comparison"];

  /** Every eval, in full. */
  evals: EvalReportEntry[];

  observations: string[];
}

/** Summarize a trace too large to inline. */
function summarizeTrace(events: readonly unknown[]): {
  byType: Record<string, number>;
  toolSequence: string[];
} {
  const byType: Record<string, number> = {};
  const toolSequence: string[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const type = String(e.type ?? "unknown");
    byType[type] = (byType[type] ?? 0) + 1;
    // The tool sequence is the shape of what the agent did — the part that
    // survives summarization with its meaning intact.
    if (type === "tool.call" && typeof e.name === "string") {
      toolSequence.push(e.name);
    }
  }
  return { byType, toolSequence };
}

/** Read a run's canonical events. */
async function readEvents(path: string | null): Promise<unknown[]> {
  if (!path) return [];
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown);
  } catch {
    return [];
  }
}

/** Turn one bundle into a report entry. */
async function toEntry(bundle: EvalBundle): Promise<EvalReportEntry> {
  const events = await readEvents(bundle.events?.path ?? null);
  const verdict = bundle.verdict as Verdict | null;

  const diffText = bundle.diff?.text ?? "";
  const truncated = diffText.length > MAX_INLINE_DIFF_BYTES;

  return {
    name: bundle.evalName,
    taskId: bundle.taskId,
    runId: bundle.runId,
    status: bundle.runStatus,
    prompt: bundle.prompt,
    envKind: bundle.envKind,
    environment: bundle.provision
      ? {
          provisioned: bundle.provision.ran && !bundle.provision.error,
          error: bundle.provision.error,
          baselineCommit: bundle.provision.baselineCommit,
          cleanupError: bundle.cleanup?.error ?? null,
        }
      : null,
    score: typeof verdict?.overall?.score === "number" ? verdict.overall.score : null,
    verdict: verdict?.overall?.verdict ?? null,
    findings: verdict?.findings ?? [],
    trace: {
      eventCount: bundle.events?.count ?? events.length,
      // Inline when it fits; otherwise keep the shape and point at the file.
      ...(events.length > 0 && events.length <= MAX_INLINE_TRACE_EVENTS
        ? { events }
        : { summary: summarizeTrace(events) }),
      path: bundle.events?.path ?? null,
    },
    diff: diffText
      ? {
          text: truncated ? `${diffText.slice(0, MAX_INLINE_DIFF_BYTES)}\n… [truncated] …\n` : diffText,
          truncated,
          bytes: diffText.length,
        }
      : null,
    checks: bundle.checks,
    artifacts: bundle.artifacts.map((a) => ({
      path: a.path,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      url: `/api/runs/${encodeURIComponent(bundle.runId)}/artifacts/${a.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    })),
    reportUrl: bundle.judgementId
      ? `/api/judgements/${encodeURIComponent(bundle.judgementId)}/report`
      : null,
  };
}

/**
 * Build the complete evaluation report.
 *
 * Everything a consuming agent needs, in one structure. Assembled from what the
 * platform already recorded — no new analysis, so the JSON and the HTML are
 * guaranteed to agree.
 */
export async function buildEvalReport(
  queries: DbQueries,
  dataDir: string,
  batchId: string,
  opts: { now?: string } = {},
): Promise<EvalReport> {
  const [release, bundles] = await Promise.all([
    buildReleaseVerdict(queries, batchId, { dataDir, ...(opts.now ? { now: opts.now } : {}) }),
    collectBatchBundles(queries, dataDir, batchId),
  ]);

  const evals = await Promise.all(bundles.map(toEntry));
  const runs = queries.listRuns({ batchId });
  const commit = runs[0]?.workspaceCommit ?? runs[0]?.workspaceRef ?? null;

  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    evaluationId: batchId,
    projectId: release.projectId,
    agentId: release.agentId,
    model: release.model,
    provider: release.provider,
    commit,
    generatedAt: release.generatedAt,
    summary: {
      score: release.overall.score,
      evalsTotal: release.overall.tasksTotal,
      evalsPassed: release.overall.tasksPassed,
      evalsFailed: release.overall.tasksFailed,
      evalsUnjudged: release.overall.runsUnjudged,
      text: release.overall.summary,
    },
    improvementPlan: release.improvementPlan,
    subsystemLoad: release.subsystemLoad,
    reliability: release.reliability,
    rankedDefects: release.rankedDefects,
    recurringDefects: release.recurringDefects,
    explainedRegressions: release.explainedRegressions,
    comparison: release.comparison,
    evals,
    observations: release.observations,
  };
}

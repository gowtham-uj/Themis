/**
 * Eval trace bundles — everything the judge needs from one eval, keyed by eval
 * name rather than by opaque run id.
 *
 * When a queue of evals finishes, the release judge is handed all of them at
 * once. "All of them" has to mean something navigable: a judge reading
 * `run 8f3a2c…` cannot tell which eval regressed, and neither can the person
 * reading the report afterwards. So the bundle is named, and every artifact
 * path is resolved up front.
 *
 * Pure assembly — no judging, no model calls. Collecting what exists is a
 * different concern from reasoning about it, and keeping them apart means the
 * collection is testable without a model.
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DbQueries } from "../db/queries.js";
import { listArtifacts, type RunArtifact } from "../runner/artifacts.js";

/** One eval's complete evidence set. */
export interface EvalBundle {
  /** Human-facing name — how this eval is identified everywhere downstream. */
  evalName: string;
  taskId: string;
  runId: string;
  runStatus: string;
  /** The prompt the agent was given. */
  prompt: string;
  /** greenfield | brownfield | null when the eval declared no env. */
  envKind: string | null;
  /** How the environment was built, and whether it succeeded. */
  provision: {
    ran: boolean;
    exitCode: number | null;
    baselineCommit: string | null;
    error: string | null;
    log: string;
  } | null;
  /** How teardown went. Never affects the eval's result, but is worth seeing. */
  cleanup: { ran: boolean; exitCode: number | null; error: string | null } | null;
  /** Canonical trace path + event count. */
  events: { path: string; count: number } | null;
  /** Unified diff of what the agent changed (setup output already excluded). */
  diff: { path: string; text: string } | null;
  /** Deterministic check results, when the rubric defined any. */
  checks: unknown | null;
  /** Screenshots and exported outputs the agent produced. */
  artifacts: RunArtifact[];
  /** The per-run verdict, when the eval was judged. */
  verdict: unknown | null;
  judgementId: string | null;
}

/** Read and parse a JSON artifact, or null when absent/unreadable. */
async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Count lines in a JSONL file without loading it all into memory. */
async function countEvents(path: string): Promise<number> {
  try {
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });
    let n = 0;
    for await (const line of rl) if (line.trim()) n++;
    return n;
  } catch {
    return 0;
  }
}

/** Cap the diff so one runaway eval cannot dominate the judge's context. */
const MAX_DIFF_BYTES = 256 * 1024;

/**
 * Collect one eval's evidence.
 *
 * Everything is best-effort: a missing artifact yields null rather than an
 * error, because "this eval produced no diff" is itself a finding the judge
 * should see, not a reason to abandon the bundle.
 */
export async function collectEvalBundle(
  queries: DbQueries,
  dataDir: string,
  runId: string,
): Promise<EvalBundle | null> {
  const run = queries.getRun(runId);
  if (!run) return null;
  const task = queries.getTask(run.taskId);
  const runDir = join(dataDir, "projects", run.projectId, "runs", run.id);

  // Newest completed judgement wins.
  const judgements = queries
    .listJudgements({ runId: run.id })
    .judgements.filter((j) => j.status === "completed")
    .sort((a, b) =>
      (b.endedAt ?? b.createdAt ?? "").localeCompare(a.endedAt ?? a.createdAt ?? ""),
    );
  const judgementId = judgements[0]?.id ?? null;
  const verdict = judgementId
    ? (queries.getJudgement(judgementId)?.verdictBody ?? null)
    : null;

  const eventsPath = join(runDir, "events.jsonl");
  const diffPath = join(runDir, "diff.patch");

  let diff: EvalBundle["diff"] = null;
  if (existsSync(diffPath)) {
    const size = (await stat(diffPath).catch(() => null))?.size ?? 0;
    const text = await readFile(diffPath, "utf8").catch(() => "");
    diff = {
      path: diffPath,
      text:
        size > MAX_DIFF_BYTES
          ? `${text.slice(0, MAX_DIFF_BYTES)}\n… [diff truncated: ${size} bytes] …\n`
          : text,
    };
  }

  const provisionRaw = (await readJson(join(runDir, "provision.json"))) as
    | Record<string, unknown>
    | null;
  const cleanupRaw = (await readJson(join(runDir, "cleanup.json"))) as
    | Record<string, unknown>
    | null;

  return {
    evalName: task?.name ?? run.taskId,
    taskId: run.taskId,
    runId: run.id,
    runStatus: run.status,
    prompt: task?.prompt ?? "",
    envKind:
      typeof provisionRaw?.kind === "string" ? provisionRaw.kind : null,
    provision: provisionRaw
      ? {
          ran: provisionRaw.ran === true,
          exitCode:
            typeof provisionRaw.exitCode === "number"
              ? provisionRaw.exitCode
              : null,
          baselineCommit:
            typeof provisionRaw.baselineCommit === "string"
              ? provisionRaw.baselineCommit
              : null,
          error:
            typeof provisionRaw.error === "string" ? provisionRaw.error : null,
          log: typeof provisionRaw.log === "string" ? provisionRaw.log : "",
        }
      : null,
    cleanup: cleanupRaw
      ? {
          ran: cleanupRaw.ran === true,
          exitCode:
            typeof cleanupRaw.exitCode === "number" ? cleanupRaw.exitCode : null,
          error: typeof cleanupRaw.error === "string" ? cleanupRaw.error : null,
        }
      : null,
    events: existsSync(eventsPath)
      ? { path: eventsPath, count: await countEvents(eventsPath) }
      : null,
    diff,
    checks: await readJson(join(runDir, "checks.json")),
    artifacts: await listArtifacts(runDir),
    verdict,
    judgementId,
  };
}

/**
 * Collect every eval in a batch, keyed by eval name.
 *
 * This is what the release judge receives: not a pile of run ids, but "here is
 * what happened on each named eval". Sorted by name so a release report reads
 * the same way every time.
 */
export async function collectBatchBundles(
  queries: DbQueries,
  dataDir: string,
  batchId: string,
): Promise<EvalBundle[]> {
  const runs = queries.listRuns({ batchId });
  const bundles: EvalBundle[] = [];
  for (const run of runs) {
    const bundle = await collectEvalBundle(queries, dataDir, run.id);
    if (bundle) bundles.push(bundle);
  }
  bundles.sort((a, b) => a.evalName.localeCompare(b.evalName));
  return bundles;
}

/**
 * A compact, judge-facing summary of a bundle set.
 *
 * Full traces are large; a judge prompt usually wants the shape first and the
 * detail on demand. Every field here is a fact from disk, not a judgement.
 */
export function summarizeBundles(bundles: readonly EvalBundle[]): {
  totalEvals: number;
  judged: number;
  withDiff: number;
  withArtifacts: number;
  provisionFailures: string[];
  cleanupFailures: string[];
  byEval: Array<{
    evalName: string;
    runStatus: string;
    events: number;
    diffBytes: number;
    artifacts: number;
    judged: boolean;
  }>;
} {
  return {
    totalEvals: bundles.length,
    judged: bundles.filter((b) => b.verdict !== null).length,
    withDiff: bundles.filter((b) => (b.diff?.text?.length ?? 0) > 0).length,
    withArtifacts: bundles.filter((b) => b.artifacts.length > 0).length,
    provisionFailures: bundles
      .filter((b) => b.provision?.error)
      .map((b) => b.evalName),
    cleanupFailures: bundles
      .filter((b) => b.cleanup?.error)
      .map((b) => b.evalName),
    byEval: bundles.map((b) => ({
      evalName: b.evalName,
      runStatus: b.runStatus,
      events: b.events?.count ?? 0,
      diffBytes: b.diff?.text.length ?? 0,
      artifacts: b.artifacts.length,
      judged: b.verdict !== null,
    })),
  };
}

// @ts-nocheck
import { createBatchClaimStore, type BatchClaimStore, buildReleaseVerdict, type BuildReleaseVerdictOptions, renderReleaseReport, renderEvalReport, buildEvalReport, collectBatchBundles, summarizeBundles, type EvalBundle, type ReleaseVerdict, claimBatchIfComplete, type JudgeRunner, type JudgeRunContext } from "../judge-stub.js";
/**
 * Auto-judge + release rollup.
 *
 * The release flow this implements (per the platform's intended shape):
 *
 *   tagged commit → watcher fires → batch of one run per eval task
 *     → each run finishes → judged immediately (per-run report)
 *     → LAST run of the batch finishes → release judge sees ALL of them
 *       → release report: recurring defects, regression vs previous release
 *
 * Per-run judging gives fast feedback; the rollup answers the release question.
 * Both hang off a single `onRunFinalized` callback from the runner, so the
 * runner itself stays unaware that judging exists.
 *
 * Everything here is best-effort: judging is downstream bookkeeping, and a
 * failure must never change a run's recorded outcome.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbQueries } from "../db/queries.js";
import { judgementDir } from "../db/queries.js";

/** What the auto-judge coordinator needs from the app context. */
export interface AutoJudgeDeps {
  queries: DbQueries;
  dataDir: string;
  judgeRunner?: JudgeRunner;
  defaultJudgeModel?: string;
  defaultJudgeProvider?: string;
  defaultSystemPromptVersion?: string;
  claims: BatchClaimStore;
  /**
   * Optional narration hook for the release verdict. Given the computed facts,
   * may add prose only — it cannot change scores, so release numbers stay
   * reproducible.
   */
  narrateRelease?: BuildReleaseVerdictOptions["narrate"];
}

/** Where a batch's release artifacts live on disk. */
export function releaseDir(
  dataDir: string,
  projectId: string,
  batchId: string,
): string {
  return join(dataDir, "projects", projectId, "releases", batchId);
}

/**
 * Judge one finished run.
 *
 * Creates the judgement row and drives the configured runner. No-ops when no
 * judge runner is wired (the platform can be used purely as an eval executor),
 * and skips runs that already have a judgement so a retry cannot double-judge.
 */
export async function judgeRunNow(
  deps: AutoJudgeDeps,
  runId: string,
): Promise<string | null> {
  if (!deps.judgeRunner) return null;

  const run = deps.queries.getRun(runId);
  if (!run) return null;

  // Idempotence: a run judged already (manually, or by an earlier attempt) is
  // left alone rather than accumulating duplicate verdicts.
  const existing = deps.queries.listJudgements({ runId }).judgements;
  if (existing.some((j) => j.status === "completed" || j.status === "running")) {
    return null;
  }

  const task = deps.queries.getTask(run.taskId);
  const project = deps.queries.getProject(run.projectId);
  const judgeModel =
    project?.defaultJudgeModel ??
    deps.defaultJudgeModel ??
    "deepseek-v4-flash";
  const judgeProvider = deps.defaultJudgeProvider ?? "nuralwatt";
  const systemPromptVersion = deps.defaultSystemPromptVersion ?? "v2";

  const judgement = deps.queries.createJudgement({
    runId: run.id,
    projectId: run.projectId,
    judgeModel,
    judgeProvider,
    systemPromptVersion,
    status: "queued",
  });

  const ctx: JudgeRunContext = {
    judgementId: judgement.id,
    runId: run.id,
    projectId: run.projectId,
    judgeModel,
    judgeProvider,
    systemPromptVersion,
    dataDir: deps.dataDir,
    queries: deps.queries,
    eventsPath: run.eventsPath ?? "",
    body: { ...(task?.rubric ? { rubric: task.rubric } : {}) },
  };

  try {
    deps.queries.setJudgementStatus(judgement.id, "running");
  } catch {
    // best-effort
  }
  await deps.judgeRunner(ctx);
  return judgement.id;
}

/**
 * Build, persist and render the release verdict for a completed batch.
 *
 * Writes `release.json` + `release.html` under the project's releases dir.
 */
export async function runReleaseRollup(
  deps: AutoJudgeDeps,
  projectId: string,
  batchId: string,
): Promise<ReleaseVerdict> {
  const verdict = await buildReleaseVerdict(deps.queries, batchId, {
    // Needed to read traces for contrastive regression explanation.
    dataDir: deps.dataDir,
    ...(deps.narrateRelease ? { narrate: deps.narrateRelease } : {}),
  });

  const dir = releaseDir(deps.dataDir, projectId, batchId);
  await mkdir(dir, { recursive: true });

  // Every eval's evidence, keyed by EVAL NAME rather than run id — this is what
  // the release judge reads, and what makes "which eval regressed" answerable.
  const bundles = await collectBatchBundles(deps.queries, deps.dataDir, batchId);
  await writeFile(
    join(dir, "bundles.json"),
    `${JSON.stringify(
      {
        batchId,
        summary: summarizeBundles(bundles),
        // Traces themselves stay on disk; the bundle records where they are.
        evals: bundles.map((b) => ({
          ...b,
          diff: b.diff ? { path: b.diff.path, bytes: b.diff.text.length } : null,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    join(dir, "release.json"),
    `${JSON.stringify(verdict, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "release.html"),
    renderReleaseReport(verdict),
    "utf8",
  );

  // The all-in-one artifact: everything a consuming agent needs, in one file.
  // Written last because it composes the others; a failure here leaves the
  // release verdict intact rather than losing the whole rollup.
  try {
    const report = await buildEvalReport(deps.queries, deps.dataDir, batchId);
    await writeFile(
      join(dir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(dir, "report.html"), renderEvalReport(report), "utf8");
  } catch (err) {
    if (process.env.AGENTEVAL_JUDGE_DEBUG) {
      console.error("[eval-report] failed:", err);
    }
  }

  return verdict;
}

/**
 * The `onRunFinalized` handler: judge this run, then roll up if it was the last
 * of its batch.
 *
 * The rollup runs only for the single caller that wins the batch claim, so N
 * runs finishing concurrently still produce exactly one release report.
 */
export async function handleRunFinalized(
  deps: AutoJudgeDeps,
  info: { runId: string; projectId: string; batchId: string; status: string },
): Promise<void> {
  // 1. Per-run judgement — every completed run, regardless of origin.
  try {
    await judgeRunNow(deps, info.runId);
  } catch {
    // a judge failure must not block the batch rollup
  }

  // 2. Release rollup, once, when the batch is fully terminal.
  if (!info.batchId) return;
  const progress = claimBatchIfComplete(deps.queries, info.batchId, deps.claims);
  if (!progress) return;

  try {
    await runReleaseRollup(deps, info.projectId, info.batchId);
  } catch (err) {
    // Release the claim so a later retry (or a re-run) can try again rather
    // than the batch being permanently un-rolled-up.
    deps.claims.release(info.batchId);
    if (process.env.AGENTEVAL_JUDGE_DEBUG) {
      console.error("[release-rollup] failed:", err);
    }
  }
}

/** Re-export so the API layer has one import site for release paths. */
export { judgementDir };

/**
 * Release judge — assembles a {@link ReleaseVerdict} for a finished batch.
 *
 * Runs after the last run of a batch reaches a terminal state. Reads what the
 * platform already recorded — each run's verdict, its findings, the previous
 * release's scores — and produces the cross-task view: recurring defects,
 * capability gaps, regression against the last release.
 *
 * The aggregation here is deterministic (grouping, means, deltas), so the
 * numbers in a release report are reproducible rather than model-authored. An
 * optional `narrate` hook lets a model add prose on top of facts it cannot
 * change — the same split the per-run verdict uses between scores and summary.
 */

import type { DbQueries, Run } from "../db/queries.js";
import { fingerprintOf } from "../db/findings.js";
import type { Verdict } from "./verdict.js";
import {
  compareToPrevious,
  findRecurringDefects,
  RELEASE_VERDICT_SCHEMA_VERSION,
  summarizeOutcomes,
  toTaskOutcome,
  validateReleaseVerdict,
  type ReleaseVerdict,
  type TaskOutcome,
} from "./release-verdict.js";
import type { Severity } from "./verdict.js";

/** Optional model-authored prose layered on top of the computed facts. */
export interface ReleaseNarration {
  summary?: string;
  observations?: string[];
  recommendations?: ReleaseVerdict["recommendations"];
}

export interface BuildReleaseVerdictOptions {
  /**
   * Add prose to the assembled facts. Receives the fully-computed verdict and
   * may only supply summary/observations/recommendations — it cannot change
   * scores, so a release report's numbers stay reproducible.
   */
  narrate?: (draft: ReleaseVerdict) => ReleaseNarration | Promise<ReleaseNarration>;
  /** Override "now" for deterministic tests. */
  now?: string;
}

/** Newest completed judgement for a run, with its verdict body. */
function latestVerdictFor(
  queries: DbQueries,
  runId: string,
): { judgementId: string; verdict: Verdict } | null {
  const list = queries.listJudgements({ runId }).judgements;
  const done = list
    .filter((j) => j.status === "completed")
    .sort((a, b) => {
      const ta = a.endedAt ?? a.createdAt ?? "";
      const tb = b.endedAt ?? b.createdAt ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return b.id.localeCompare(a.id);
    });
  for (const j of done) {
    const full = queries.getJudgement(j.id);
    if (full?.verdictBody) {
      return { judgementId: j.id, verdict: full.verdictBody };
    }
  }
  return null;
}

/**
 * Previous release's per-task scores for the same agent, for comparison.
 *
 * "Previous" is the most recent earlier batch for this project+agent that has
 * judged runs. Returns an empty map when there is no prior release — a first
 * release has nothing to regress against, which is not an error.
 */
function previousReleaseScores(
  queries: DbQueries,
  projectId: string,
  agentId: string,
  currentBatchId: string,
): { scores: Map<string, number>; ref: string | null } {
  const scores = new Map<string, number>();
  const runs = queries
    .listRuns({ projectId })
    .filter((r) => r.agentId === agentId && r.batchId !== currentBatchId);

  // Group by batch, newest first by started time.
  const byBatch = new Map<string, Run[]>();
  for (const r of runs) {
    const list = byBatch.get(r.batchId);
    if (list) list.push(r);
    else byBatch.set(r.batchId, [r]);
  }
  const batches = [...byBatch.entries()].sort((a, b) => {
    const ta = a[1].reduce((m, r) => (r.startedAt && r.startedAt > m ? r.startedAt : m), "");
    const tb = b[1].reduce((m, r) => (r.startedAt && r.startedAt > m ? r.startedAt : m), "");
    return tb.localeCompare(ta);
  });

  for (const [, batchRuns] of batches) {
    const found = new Map<string, number>();
    let ref: string | null = null;
    for (const r of batchRuns) {
      const v = latestVerdictFor(queries, r.id);
      if (!v || typeof v.verdict.overall?.score !== "number") continue;
      found.set(r.taskId, v.verdict.overall.score);
      ref ??= r.triggerRef ?? null;
    }
    if (found.size > 0) {
      // First (newest) batch with any judged runs wins.
      return { scores: found, ref };
    }
  }
  return { scores, ref: null };
}

/**
 * Build the release verdict for a completed batch.
 *
 * Safe to call for a batch whose runs partly failed: unjudged runs are counted
 * as such rather than silently dropped, because "3 runs crashed" is a release
 * signal, not missing data.
 */
export async function buildReleaseVerdict(
  queries: DbQueries,
  batchId: string,
  opts: BuildReleaseVerdictOptions = {},
): Promise<ReleaseVerdict> {
  const runs = queries.listRuns({ batchId });
  if (runs.length === 0) {
    throw new Error(`buildReleaseVerdict: batch has no runs: ${batchId}`);
  }

  const first = runs[0]!;
  const projectId = first.projectId;
  const agentId = first.agentId;

  const tasks: TaskOutcome[] = [];
  const perRunFindings: Array<{
    taskId: string;
    runId: string;
    findings: Array<{
      fingerprint: string;
      category: string;
      claim: string;
      severity: Severity;
    }>;
  }> = [];

  for (const run of runs) {
    const task = queries.getTask(run.taskId);
    const judged = latestVerdictFor(queries, run.id);
    tasks.push(
      toTaskOutcome({
        taskId: run.taskId,
        taskName: task?.name ?? run.taskId,
        runId: run.id,
        runStatus: run.status,
        judgementId: judged?.judgementId ?? null,
        verdict: judged?.verdict ?? null,
      }),
    );

    // Recurrence needs a TASK-INDEPENDENT key. The findings table's fingerprint
    // is deliberately task-scoped (sha256 of taskId:category:location) so the
    // same defect in two tasks gets two fingerprints — correct for per-task
    // recurrence, useless for cross-task. So the key here is recomputed from
    // category + canonical location, without the task id.
    const findings: (typeof perRunFindings)[number]["findings"] = [];
    if (judged?.verdict) {
      for (const f of judged.verdict.findings ?? []) {
        const { fingerprint } = fingerprintOf(
          { category: f.category, claim: f.claim, refs: f.refs },
          // No taskId → cross-task key.
        );
        findings.push({
          fingerprint,
          category: f.category,
          claim: f.claim,
          severity: f.severity,
        });
      }
    }
    perRunFindings.push({ taskId: run.taskId, runId: run.id, findings });
  }

  // Stable order so the report reads the same way each time.
  tasks.sort((a, b) => a.taskName.localeCompare(b.taskName));

  const { scores: prevScores, ref: prevRef } = previousReleaseScores(
    queries,
    projectId,
    agentId,
    batchId,
  );

  const draft: ReleaseVerdict = {
    schemaVersion: RELEASE_VERDICT_SCHEMA_VERSION,
    batchId,
    projectId,
    agentId,
    releaseRef: first.triggerRef ?? null,
    model: first.model,
    provider: first.provider,
    overall: summarizeOutcomes(tasks),
    tasks,
    recurringDefects: findRecurringDefects(perRunFindings),
    comparison:
      prevScores.size > 0
        ? compareToPrevious(tasks, prevScores, prevRef)
        : null,
    observations: [],
    recommendations: [],
  generatedAt: opts.now ?? new Date().toISOString(),
  };

  // Facts first, prose second: narration may add text but never scores.
  if (opts.narrate) {
    const narration = await opts.narrate(draft);
    if (narration.summary) draft.overall.summary = narration.summary;
    if (narration.observations) draft.observations = narration.observations;
    if (narration.recommendations) {
      draft.recommendations = narration.recommendations;
    }
  }

  // Default observations when nothing narrated — better than an empty section.
  if (draft.observations.length === 0) {
    const obs: string[] = [];
    if (draft.recurringDefects.length > 0) {
      obs.push(
        `${draft.recurringDefects.length} defect(s) recurred across multiple tasks — likely capability gaps rather than one-off slips.`,
      );
    }
    if (draft.overall.runsUnjudged > 0) {
      obs.push(
        `${draft.overall.runsUnjudged} run(s) produced no verdict; their tasks are unscored.`,
      );
    }
    if (draft.comparison?.regressions.length) {
      obs.push(
        `${draft.comparison.regressions.length} task(s) scored materially worse than the previous release.`,
      );
    }
    draft.observations = obs;
  }

  validateReleaseVerdict(draft);
  return draft;
}

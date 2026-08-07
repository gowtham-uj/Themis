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
import type { Subsystem } from "./verdict.js";
import {
  buildImprovementPlan,
  computeReliability,
  rankDefectsByImpact,
  rollupBySubsystem,
  type AttemptRecord,
} from "./improvement-analysis.js";
import {
  diffTrajectories,
  toTraceSteps,
  type ExplainedRegression,
} from "./trajectory-diff.js";
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
  /**
   * Data directory, needed to read event traces for contrastive regression
   * explanation. Omitted → regressions are reported without trajectory diffs.
   */
  dataDir?: string;
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
  const dataDir = opts.dataDir;

  const first = runs[0]!;
  const projectId = first.projectId;
  const agentId = first.agentId;

  const tasks: TaskOutcome[] = [];
  const attempts: AttemptRecord[] = [];
  const subsystemByFingerprint = new Map<string, Subsystem>();
  const fixByFingerprint = new Map<string, string>();
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
        // Keep the judge's routing + fix direction so the plan can use them.
        if (f.subsystem) subsystemByFingerprint.set(fingerprint, f.subsystem);
        if (f.fix?.direction) fixByFingerprint.set(fingerprint, f.fix.direction);
      }
    }
    perRunFindings.push({ taskId: run.taskId, runId: run.id, findings });

    // Every attempt, so repeats become a pass rate rather than one score.
    attempts.push({
      taskId: run.taskId,
      evalName: task?.name ?? run.taskId,
      runId: run.id,
      score:
        typeof judged?.verdict.overall?.score === "number"
          ? judged.verdict.overall.score
          : null,
    });
  }

  // Stable order so the report reads the same way each time.
  tasks.sort((a, b) => a.taskName.localeCompare(b.taskName));

  const { scores: prevScores, ref: prevRef } = previousReleaseScores(
    queries,
    projectId,
    agentId,
    batchId,
  );

  // ---- analysis the consuming agent needs ----
  const reliability = computeReliability(attempts);

  // Cross-evaluation persistence: how many evaluations each defect survived.
  // A defect that outlives several fix attempts means the approach is wrong,
  // which no single evaluation can reveal.
  const persistenceByFingerprint = computePersistence(
    queries,
    projectId,
    perRunFindings,
  );

  const recurring = findRecurringDefects(perRunFindings).map((d) => ({
    ...d,
    subsystem: subsystemByFingerprint.get(d.fingerprint) ?? null,
    persistence: persistenceByFingerprint.get(d.fingerprint) ?? null,
  }));

  // Rank by what fixing buys, over ALL defects — not just recurring ones, since
  // a single-eval blocker can still be the highest-value fix.
  const allDefects = new Map<string, (typeof recurring)[number]>();
  for (const d of recurring) allDefects.set(d.fingerprint, d);
  for (const run of perRunFindings) {
    for (const f of run.findings) {
      if (allDefects.has(f.fingerprint)) continue;
      allDefects.set(f.fingerprint, {
        ...f,
        subsystem: subsystemByFingerprint.get(f.fingerprint) ?? null,
        persistence: persistenceByFingerprint.get(f.fingerprint) ?? null,
        taskIds: [run.taskId],
        runIds: [run.runId],
        occurrences: 1,
      });
    }
  }

  const scoresByTask = new Map<string, number | null>(
    tasks.map((t) => [t.taskId, t.score]),
  );
  const rankedDefects = rankDefectsByImpact({
    defects: [...allDefects.values()],
    scoresByTask,
  });
  const subsystemLoad = rollupBySubsystem(rankedDefects);
  const passingTaskIds = tasks
    .filter((t) => (t.score ?? 0) >= 0.7)
    .map((t) => t.taskId);
  const improvementPlan = buildImprovementPlan(rankedDefects, {
    passingTaskIds,
    fixDirections: fixByFingerprint,
  });

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
    recurringDefects: recurring,
    reliability,
    rankedDefects,
    subsystemLoad,
    improvementPlan,
    explainedRegressions: await explainRegressions(
      queries,
      dataDir,
      tasks,
      prevScores,
      projectId,
      agentId,
      batchId,
    ),
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

/**
 * How many EVALUATIONS each defect has survived.
 *
 * The findings table tracks occurrences per run; what an improving agent needs
 * is coarser and more damning: how many separate evaluations — i.e. how many
 * fix attempts — this defect has outlived. Two or more means the current
 * approach is not working.
 */
function computePersistence(
  queries: DbQueries,
  projectId: string,
  perRunFindings: ReadonlyArray<{
    taskId: string;
    findings: ReadonlyArray<{ fingerprint: string; category: string; claim: string }>;
  }>,
): Map<string, { evaluationCount: number; chronic: boolean; firstSeenAt: string | null; lastSeenAt: string | null }> {
  const out = new Map<
    string,
    { evaluationCount: number; chronic: boolean; firstSeenAt: string | null; lastSeenAt: string | null }
  >();

  // Map each cross-task fingerprint back to the stored (task-scoped) rows so we
  // can read their occurrence history.
  for (const run of perRunFindings) {
    for (const f of run.findings) {
      if (out.has(f.fingerprint)) continue;
      const batches = new Set<string>();
      let firstSeenAt: string | null = null;
      let lastSeenAt: string | null = null;

      try {
        for (const row of queries.listFindings({ projectId })) {
          // Stored fingerprints are task-scoped; match on the semantic key.
          if (row.category !== f.category || row.claim !== f.claim) continue;
          for (const occ of queries.listOccurrences(row.fingerprint)) {
            const occRun = queries.getRun(occ.runId);
            if (occRun) batches.add(occRun.batchId);
          }
          if (row.firstSeenAt && (!firstSeenAt || row.firstSeenAt < firstSeenAt)) {
            firstSeenAt = row.firstSeenAt;
          }
          if (row.lastSeenAt && (!lastSeenAt || row.lastSeenAt > lastSeenAt)) {
            lastSeenAt = row.lastSeenAt;
          }
        }
      } catch {
        // Persistence is enrichment; never fail a rollup over it.
      }

      const evaluationCount = Math.max(1, batches.size);
      out.set(f.fingerprint, {
        evaluationCount,
        chronic: evaluationCount >= 2,
        firstSeenAt,
        lastSeenAt,
      });
    }
  }
  return out;
}

/**
 * Explain regressions by diffing trajectories against the previous evaluation.
 *
 * A score drop says an eval broke. The divergence point says where — and that
 * is the part someone can act on. Best-effort: an unreadable trace yields no
 * explanation rather than failing the rollup.
 */
async function explainRegressions(
  queries: DbQueries,
  dataDir: string | undefined,
  tasks: readonly TaskOutcome[],
  prevScores: ReadonlyMap<string, number>,
  projectId: string,
  agentId: string,
  batchId: string,
): Promise<ExplainedRegression[]> {
  if (!dataDir || prevScores.size === 0) return [];

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const readSteps = async (runId: string): Promise<unknown[]> => {
    try {
      const raw = await readFile(
        join(dataDir, "projects", projectId, "runs", runId, "events.jsonl"),
        "utf8",
      );
      return raw
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
    } catch {
      return [];
    }
  };

  // Previous run per task, for the same agent, from an earlier batch.
  const previousRunByTask = new Map<string, string>();
  for (const r of queries.listRuns({ projectId })) {
    if (r.agentId !== agentId || r.batchId === batchId) continue;
    const existing = previousRunByTask.get(r.taskId);
    if (!existing) previousRunByTask.set(r.taskId, r.id);
  }

  const out: ExplainedRegression[] = [];
  for (const t of tasks) {
    const before = prevScores.get(t.taskId);
    if (before === undefined || t.score === null) continue;
    // Only explain material regressions — noise is not worth a trace read.
    if (t.score >= before - 0.1) continue;

    const baselineRunId = previousRunByTask.get(t.taskId);
    if (!baselineRunId) continue;

    const [baselineEvents, candidateEvents] = await Promise.all([
      readSteps(baselineRunId),
      readSteps(t.runId),
    ]);
    if (baselineEvents.length === 0 || candidateEvents.length === 0) continue;

    out.push({
      taskId: t.taskId,
      evalName: t.taskName,
      baselineRunId,
      candidateRunId: t.runId,
      baselineScore: before,
      candidateScore: t.score,
      divergence: diffTrajectories(
        toTraceSteps(baselineEvents),
        toTraceSteps(candidateEvents),
      ),
    });
  }
  return out;
}

/**
 * Release verdict — the judgement of an agent VERSION across a whole eval set.
 *
 * A per-run verdict answers "how did the agent do on this task". A release
 * verdict answers questions that are invisible one run at a time:
 *
 *  - which defects RECUR across tasks (a capability gap, not a one-off slip)
 *  - which task categories the version is weak in
 *  - whether it regressed against the previous release
 *
 * Produced when the last run of a batch finishes (see batch-completion.ts).
 * Deliberately a separate schema from Verdict rather than a superset: the units
 * differ (a task, not a hunk), and overloading Verdict would make every
 * per-run consumer handle fields that never apply to it.
 */

import type { Severity, Subsystem, Verdict } from "./verdict.js";
import type {
  EvalReliability,
  ImprovementStep,
  RankedDefect,
  SubsystemLoad,
} from "./improvement-analysis.js";
import type { ExplainedRegression } from "./trajectory-diff.js";

export const RELEASE_VERDICT_SCHEMA_VERSION = 1 as const;

/** How one eval task went, distilled from its run + verdict. */
export interface TaskOutcome {
  taskId: string;
  taskName: string;
  runId: string;
  /** Terminal run status — a crashed run is a different signal from a low score. */
  runStatus: string;
  /** Overall verdict score 0..1; null when the run was never judged. */
  score: number | null;
  verdict: string | null;
  /** Per-run report deep-link target. */
  judgementId: string | null;
  findingCount: number;
  worstSeverity: Severity | null;
}

/** A defect seen in more than one task — the signal a per-run judge cannot see. */
export interface RecurringDefect {
  /** Stable location fingerprint shared by the occurrences. */
  fingerprint: string;
  category: string;
  claim: string;
  severity: Severity;
  /** Which subsystem to fix it in, when the judge attributed one. */
  subsystem?: Subsystem | null;
  /** Evaluations this defect has survived — chronic means change approach. */
  persistence?: { evaluationCount: number; chronic: boolean } | null;
  /** Tasks this defect appeared in (≥2 by construction). */
  taskIds: string[];
  runIds: string[];
  occurrences: number;
}

/** Comparison against the previous release of the same agent. */
export interface ReleaseComparison {
  previousRef: string | null;
  previousScore: number | null;
  /** currentScore - previousScore; positive is improvement. */
  delta: number | null;
  /** Tasks that scored materially worse than last release. */
  regressions: Array<{ taskId: string; before: number; after: number }>;
  /** Tasks that scored materially better. */
  improvements: Array<{ taskId: string; before: number; after: number }>;
}

/** The full release-level verdict. */
export interface ReleaseVerdict {
  schemaVersion: typeof RELEASE_VERDICT_SCHEMA_VERSION;
  batchId: string;
  projectId: string;
  agentId: string;
  /** The tag/ref that triggered this release eval, when watcher-driven. */
  releaseRef: string | null;
  model: string;
  provider: string;
  overall: {
    /** Weighted mean of task scores, 0..1. */
    score: number;
    tasksTotal: number;
    tasksJudged: number;
    tasksPassed: number;
    tasksFailed: number;
    /** Runs that never produced a verdict (crash/timeout). */
    runsUnjudged: number;
    summary: string;
  };
  tasks: TaskOutcome[];
  recurringDefects: RecurringDefect[];
  comparison: ReleaseComparison | null;
  /**
   * Per-eval reliability across repeats. A 3/5 pass rate is a RELIABILITY
   * problem; 0/5 is a CAPABILITY problem, and they need different fixes.
   */
  reliability: EvalReliability[];
  /**
   * Defects ordered by what fixing them buys, not by how bad they look.
   * Severity describes a symptom; this answers "what do I do first".
   */
  rankedDefects: RankedDefect[];
  /** Where the work is: defect load grouped by subsystem. */
  subsystemLoad: SubsystemLoad[];
  /**
   * The ordered plan for the agent consuming this report: apply step 1, re-run
   * its verify set, see whether it worked.
   */
  improvementPlan: ImprovementStep[];
  /**
   * Regressions explained by comparing trajectories against the previous
   * evaluation — where the runs diverged, not just that the score dropped.
   */
  explainedRegressions: ExplainedRegression[];
  /** Cross-task observations the judge wants surfaced. */
  observations: string[];
  /** Release-level recommendations, grounded in the recurring defects. */
  recommendations: Array<{
    priority: "high" | "medium" | "low";
    change: string;
    why: string;
    /** Task ids this recommendation is grounded in. */
    taskIds: string[];
  }>;
  generatedAt: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** The more severe of two severities (undefined-tolerant). */
function worseSeverity(
  a: Severity | null,
  b: Severity | null,
): Severity | null {
  if (!a) return b;
  if (!b) return a;
  return (SEVERITY_RANK[a] ?? 99) <= (SEVERITY_RANK[b] ?? 99) ? a : b;
}

/** Summarize one judged run into a TaskOutcome. */
export function toTaskOutcome(input: {
  taskId: string;
  taskName: string;
  runId: string;
  runStatus: string;
  judgementId: string | null;
  verdict: Verdict | null;
}): TaskOutcome {
  const v = input.verdict;
  let worst: Severity | null = null;
  for (const f of v?.findings ?? []) {
    worst = worseSeverity(worst, f.severity);
  }
  return {
    taskId: input.taskId,
    taskName: input.taskName,
    runId: input.runId,
    runStatus: input.runStatus,
    score: typeof v?.overall?.score === "number" ? v.overall.score : null,
    verdict: v?.overall?.verdict ?? null,
    judgementId: input.judgementId,
    findingCount: v?.findings?.length ?? 0,
    worstSeverity: worst,
  };
}

/**
 * Group findings across runs by their fingerprint, keeping only those that
 * appear in MORE THAN ONE task.
 *
 * Same-task repetition is not recurrence — a flaky task can produce the same
 * finding twice with no capability implication. Crossing task boundaries is
 * what makes it a pattern.
 */
export function findRecurringDefects(
  perRun: ReadonlyArray<{
    taskId: string;
    runId: string;
    findings: ReadonlyArray<{
      fingerprint: string;
      category: string;
      claim: string;
      severity: Severity;
    }>;
  }>,
): RecurringDefect[] {
  const byFingerprint = new Map<
    string,
    {
      category: string;
      claim: string;
      severity: Severity;
      taskIds: Set<string>;
      runIds: Set<string>;
      occurrences: number;
    }
  >();

  for (const run of perRun) {
    for (const f of run.findings) {
      if (!f.fingerprint) continue;
      const entry = byFingerprint.get(f.fingerprint);
      if (entry) {
        entry.taskIds.add(run.taskId);
        entry.runIds.add(run.runId);
        entry.occurrences++;
        entry.severity = worseSeverity(entry.severity, f.severity) ?? entry.severity;
      } else {
        byFingerprint.set(f.fingerprint, {
          category: f.category,
          claim: f.claim,
          severity: f.severity,
          taskIds: new Set([run.taskId]),
          runIds: new Set([run.runId]),
          occurrences: 1,
        });
      }
    }
  }

  const out: RecurringDefect[] = [];
  for (const [fingerprint, e] of byFingerprint) {
    if (e.taskIds.size < 2) continue;
    out.push({
      fingerprint,
      category: e.category,
      claim: e.claim,
      severity: e.severity,
      taskIds: [...e.taskIds].sort(),
      runIds: [...e.runIds].sort(),
      occurrences: e.occurrences,
    });
  }
  // Most severe first, then most widespread.
  out.sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity] ?? 99;
    const sb = SEVERITY_RANK[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    if (b.taskIds.length !== a.taskIds.length) {
      return b.taskIds.length - a.taskIds.length;
    }
    return a.fingerprint.localeCompare(b.fingerprint);
  });
  return out;
}

/** Score delta below which a task counts as regressed/improved. */
const MATERIAL_DELTA = 0.1;

/** Compare this release's task scores against the previous release's. */
export function compareToPrevious(
  current: readonly TaskOutcome[],
  previous: ReadonlyMap<string, number>,
  previousRef: string | null,
): ReleaseComparison {
  const regressions: ReleaseComparison["regressions"] = [];
  const improvements: ReleaseComparison["improvements"] = [];
  let prevSum = 0;
  let prevCount = 0;

  for (const t of current) {
    const before = previous.get(t.taskId);
    if (before === undefined || t.score === null) continue;
    prevSum += before;
    prevCount++;
    const delta = t.score - before;
    if (delta <= -MATERIAL_DELTA) {
      regressions.push({ taskId: t.taskId, before, after: t.score });
    } else if (delta >= MATERIAL_DELTA) {
      improvements.push({ taskId: t.taskId, before, after: t.score });
    }
  }

  const judged = current.filter((t) => t.score !== null);
  const currentMean =
    judged.length > 0
      ? judged.reduce((sum, t) => sum + (t.score ?? 0), 0) / judged.length
      : null;
  const previousScore = prevCount > 0 ? prevSum / prevCount : null;

  // Worst regressions first — that is what a release reviewer looks for.
  regressions.sort((a, b) => a.after - a.before - (b.after - b.before));
  improvements.sort((a, b) => b.after - b.before - (a.after - a.before));

  return {
    previousRef,
    previousScore,
    delta:
      currentMean !== null && previousScore !== null
        ? currentMean - previousScore
        : null,
    regressions,
    improvements,
  };
}

/** Build the overall block from the per-task outcomes. */
export function summarizeOutcomes(
  tasks: readonly TaskOutcome[],
): ReleaseVerdict["overall"] {
  const judged = tasks.filter((t) => t.score !== null);
  const score =
    judged.length > 0
      ? judged.reduce((sum, t) => sum + (t.score ?? 0), 0) / judged.length
      : 0;
  const passed = judged.filter((t) => (t.score ?? 0) >= 0.7).length;
  const failed = judged.length - passed;
  const unjudged = tasks.length - judged.length;

  const parts = [
    `${passed}/${judged.length} tasks passed`,
    `mean score ${score.toFixed(2)}`,
  ];
  if (unjudged > 0) parts.push(`${unjudged} run(s) produced no verdict`);

  return {
    score,
    tasksTotal: tasks.length,
    tasksJudged: judged.length,
    tasksPassed: passed,
    tasksFailed: failed,
    runsUnjudged: unjudged,
    summary: parts.join("; "),
  };
}

/** Raised when a release verdict fails validation. */
export class ReleaseVerdictValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseVerdictValidationError";
  }
}

/**
 * Validate a release verdict before it is stored or rendered.
 *
 * Mirrors the per-run contract's intent: a recurring defect must actually span
 * ≥2 tasks, and a recommendation must be grounded in tasks — otherwise it is a
 * generality, which is exactly what this report exists not to produce.
 */
export function validateReleaseVerdict(
  v: unknown,
): asserts v is ReleaseVerdict {
  if (!v || typeof v !== "object") {
    throw new ReleaseVerdictValidationError("release verdict is not an object");
  }
  const rv = v as Partial<ReleaseVerdict>;
  if (rv.schemaVersion !== RELEASE_VERDICT_SCHEMA_VERSION) {
    throw new ReleaseVerdictValidationError(
      `schemaVersion must be ${RELEASE_VERDICT_SCHEMA_VERSION}`,
    );
  }
  if (!rv.batchId) throw new ReleaseVerdictValidationError("missing batchId");
  if (!Array.isArray(rv.tasks)) {
    throw new ReleaseVerdictValidationError("tasks must be an array");
  }
  if (!rv.overall || typeof rv.overall.score !== "number") {
    throw new ReleaseVerdictValidationError("missing overall.score");
  }
  if (rv.overall.score < 0 || rv.overall.score > 1) {
    throw new ReleaseVerdictValidationError("overall.score must be 0..1");
  }
  for (const arrField of [
    "reliability",
    "rankedDefects",
    "subsystemLoad",
    "improvementPlan",
    "explainedRegressions",
  ] as const) {
    if (!Array.isArray(rv[arrField])) {
      throw new ReleaseVerdictValidationError(`${arrField} must be an array`);
    }
  }
  // An improvement step with no verification set cannot be proven to have
  // worked — which defeats the point of emitting a plan at all.
  for (const [i, step] of (rv.improvementPlan ?? []).entries()) {
    if (!Array.isArray(step.verifyTaskIds) || step.verifyTaskIds.length === 0) {
      throw new ReleaseVerdictValidationError(
        `improvementPlan[${i}]: missing verifyTaskIds (a step that cannot be verified is not actionable)`,
      );
    }
  }
  for (const d of rv.recurringDefects ?? []) {
    if (!Array.isArray(d.taskIds) || d.taskIds.length < 2) {
      throw new ReleaseVerdictValidationError(
        `recurring defect "${d.fingerprint}" spans <2 tasks (not recurring)`,
      );
    }
  }
  for (const [i, r] of (rv.recommendations ?? []).entries()) {
    if (!r.change) {
      throw new ReleaseVerdictValidationError(
        `recommendation[${i}]: missing change`,
      );
    }
    if (!Array.isArray(r.taskIds) || r.taskIds.length === 0) {
      throw new ReleaseVerdictValidationError(
        `recommendation[${i}]: not grounded in any task (drop it or ground it)`,
      );
    }
  }
}

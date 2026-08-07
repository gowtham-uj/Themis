/**
 * Turning a findings list into an improvement backlog.
 *
 * A report that says "these things are wrong" leaves the reader to work out
 * what to do first, whether a failure is even reproducible, and whether the
 * thing they are about to patch has already resisted three previous patches.
 * This module computes those answers from data the platform already has, so
 * they are facts rather than model opinion.
 *
 * Everything here is deterministic. The judge supplies the analysis; this
 * supplies the arithmetic — and keeping them apart is what makes the numbers in
 * a report reproducible.
 */

import type { Severity, Subsystem } from "./verdict.js";

// ---------------------------------------------------------------------------
// 1. Reliability — pass rate across repeats
// ---------------------------------------------------------------------------

/** How consistently one eval passed across its attempts. */
export interface EvalReliability {
  taskId: string;
  evalName: string;
  attempts: number;
  passes: number;
  /** passes / attempts, 0..1. */
  passRate: number;
  /** Score spread across attempts — high spread means unstable behaviour. */
  scoreRange: [number, number] | null;
  /**
   * What KIND of problem this is:
   *  - `reliable_pass`   passes every time
   *  - `flaky`           passes sometimes — a RELIABILITY problem
   *  - `reliable_fail`   fails every time — a CAPABILITY problem
   *  - `single_attempt`  only run once; nothing can be said about consistency
   *
   * The flaky/reliable_fail split matters: they need completely different
   * remediation, and a report that shows only "failed" cannot distinguish them.
   */
  verdict: "reliable_pass" | "flaky" | "reliable_fail" | "single_attempt";
}

/** One attempt at an eval. */
export interface AttemptRecord {
  taskId: string;
  evalName: string;
  runId: string;
  /** Overall verdict score 0..1, or null when the run produced no verdict. */
  score: number | null;
}

/** Score at or above which an attempt counts as a pass. */
const PASS_THRESHOLD = 0.7;

/**
 * Group attempts by eval and classify each eval's reliability.
 *
 * An unjudged attempt counts as an attempt that did not pass: a run that
 * crashed is a real outcome, and dropping it would flatter the pass rate.
 */
export function computeReliability(
  attempts: readonly AttemptRecord[],
): EvalReliability[] {
  const byTask = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const list = byTask.get(a.taskId);
    if (list) list.push(a);
    else byTask.set(a.taskId, [a]);
  }

  const out: EvalReliability[] = [];
  for (const [taskId, list] of byTask) {
    const passes = list.filter((a) => (a.score ?? 0) >= PASS_THRESHOLD).length;
    const scored = list
      .map((a) => a.score)
      .filter((s): s is number => s !== null);
    const passRate = list.length > 0 ? passes / list.length : 0;

    let verdict: EvalReliability["verdict"];
    if (list.length === 1) verdict = "single_attempt";
    else if (passes === list.length) verdict = "reliable_pass";
    else if (passes === 0) verdict = "reliable_fail";
    else verdict = "flaky";

    out.push({
      taskId,
      evalName: list[0]!.evalName,
      attempts: list.length,
      passes,
      passRate,
      scoreRange:
        scored.length > 0
          ? [Math.min(...scored), Math.max(...scored)]
          : null,
      verdict,
    });
  }

  // Flaky first — an intermittent failure is the most expensive kind to chase
  // and the easiest to miss in a list sorted by score.
  const rank: Record<EvalReliability["verdict"], number> = {
    flaky: 0,
    reliable_fail: 1,
    single_attempt: 2,
    reliable_pass: 3,
  };
  out.sort(
    (a, b) =>
      rank[a.verdict] - rank[b.verdict] ||
      a.passRate - b.passRate ||
      a.evalName.localeCompare(b.evalName),
  );
  return out;
}

// ---------------------------------------------------------------------------
// 2. Impact ranking — what to fix first
// ---------------------------------------------------------------------------

/** A defect with the arithmetic of fixing it. */
export interface RankedDefect {
  fingerprint: string;
  category: string;
  claim: string;
  severity: Severity;
  subsystem: Subsystem | null;
  /** Evals this defect appears in. */
  taskIds: string[];
  /** How many currently-failing evals it blocks. */
  evalsBlocked: number;
  /** Mean-score gain if every blocked eval reached the pass threshold. */
  estimatedScoreGain: number;
  /**
   * Ranking score. Severity says how bad a symptom is; this says how much
   * fixing it buys — which is the question an improving agent is actually
   * asking.
   */
  impactScore: number;
  /** Evaluations this defect has survived (chronic = stop patching). */
  persistence: { evaluationCount: number; chronic: boolean } | null;
}

/** Input for ranking. */
export interface RankDefectsInput {
  defects: ReadonlyArray<{
    fingerprint: string;
    category: string;
    claim: string;
    severity: Severity;
    subsystem?: Subsystem | null;
    taskIds: string[];
    persistence?: { evaluationCount: number; chronic: boolean } | null;
  }>;
  /** Current score per eval, for computing what a fix would gain. */
  scoresByTask: ReadonlyMap<string, number | null>;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  blocker: 1,
  major: 0.7,
  minor: 0.35,
  nit: 0.1,
};

/**
 * Rank defects by what fixing them buys, not by how bad they look.
 *
 * A `nit` blocking six evals may be worth more than a `blocker` in one. The
 * severity term keeps genuinely dangerous single-eval defects from sinking, but
 * breadth dominates — because breadth is what an improvement pass converts into
 * score.
 */
export function rankDefectsByImpact(input: RankDefectsInput): RankedDefect[] {
  const totalEvals = Math.max(1, input.scoresByTask.size);

  const ranked = input.defects.map((d) => {
    // Only count evals that are actually failing: fixing a defect that appears
    // in a passing eval unblocks nothing.
    const blocked = d.taskIds.filter((t) => {
      const score = input.scoresByTask.get(t);
      return score === null || score === undefined || score < PASS_THRESHOLD;
    });

    // Optimistic ceiling: every blocked eval reaches the threshold.
    const gain =
      blocked.reduce(
        (sum, t) => sum + Math.max(0, PASS_THRESHOLD - (input.scoresByTask.get(t) ?? 0)),
        0,
      ) / totalEvals;

    const severityWeight = SEVERITY_WEIGHT[d.severity] ?? 0.3;
    // Chronic defects are worth surfacing higher: repeated failed fixes mean
    // the current approach is not working, and that is worth knowing early.
    const chronicBoost = d.persistence?.chronic ? 1.25 : 1;
    const impactScore =
      (blocked.length * severityWeight + gain * totalEvals) * chronicBoost;

    return {
      fingerprint: d.fingerprint,
      category: d.category,
      claim: d.claim,
      severity: d.severity,
      subsystem: d.subsystem ?? null,
      taskIds: [...d.taskIds],
      evalsBlocked: blocked.length,
      estimatedScoreGain: Number(gain.toFixed(4)),
      impactScore: Number(impactScore.toFixed(4)),
      persistence: d.persistence ?? null,
    };
  });

  ranked.sort(
    (a, b) =>
      b.impactScore - a.impactScore ||
      b.evalsBlocked - a.evalsBlocked ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  return ranked;
}

// ---------------------------------------------------------------------------
// 3. Subsystem rollup — where the work actually is
// ---------------------------------------------------------------------------

/** Defect load per subsystem. */
export interface SubsystemLoad {
  /** Null groups the defects the judge declined to route. */
  subsystem: Subsystem | null;
  defectCount: number;
  evalsAffected: number;
  totalImpact: number;
  /** Highest-impact defect in this subsystem, as the entry point. */
  topDefect: string | null;
}

/**
 * Group ranked defects by subsystem.
 *
 * This answers "where should the next hour go" in one line: five prompt issues
 * and one model-capability issue is a very different afternoon from the
 * reverse.
 */
export function rollupBySubsystem(
  ranked: readonly RankedDefect[],
): SubsystemLoad[] {
  const groups = new Map<string, RankedDefect[]>();
  for (const d of ranked) {
    const key = d.subsystem ?? "";
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }

  const out: SubsystemLoad[] = [];
  for (const [subsystem, defects] of groups) {
    const evals = new Set<string>();
    for (const d of defects) for (const t of d.taskIds) evals.add(t);
    out.push({
      subsystem: (subsystem || null) as SubsystemLoad["subsystem"],
      defectCount: defects.length,
      evalsAffected: evals.size,
      totalImpact: Number(
        defects.reduce((sum, d) => sum + d.impactScore, 0).toFixed(4),
      ),
      topDefect: defects[0]?.claim ?? null,
    });
  }
  out.sort((a, b) => b.totalImpact - a.totalImpact);
  return out;
}

// ---------------------------------------------------------------------------
// 4. The improvement plan
// ---------------------------------------------------------------------------

/** One actionable step for the agent consuming this report. */
export interface ImprovementStep {
  rank: number;
  subsystem: Subsystem | null;
  /** The judge's fix direction; null when it gave none. */
  change: string | null;
  /** The defect this step addresses, verbatim from the judge's finding. */
  defect: string;
  /** Why, grounded in the defect it comes from. */
  rationale: string;
  /** Evals that should start passing. */
  verifyTaskIds: string[];
  /** Evals that must keep passing. */
  regressionTaskIds: string[];
  evalsBlocked: number;
  estimatedScoreGain: number;
  /** True when previous fix attempts have not worked — change approach. */
  chronic: boolean;
}

/**
 * Build an ordered improvement plan from ranked defects.
 *
 * The output is deliberately shaped as steps rather than observations: an agent
 * consuming this should be able to take step 1, apply it, re-run
 * `verifyTaskIds`, and know whether it worked — without further interpretation.
 */
export function buildImprovementPlan(
  ranked: readonly RankedDefect[],
  opts: {
    /** Task ids currently passing — the regression guard for every step. */
    passingTaskIds: readonly string[];
    /** Fix direction per fingerprint, from the judge's findings. */
    fixDirections?: ReadonlyMap<string, string>;
    limit?: number;
  },
): ImprovementStep[] {
  const limit = opts.limit ?? 10;
  return ranked.slice(0, limit).map((d, i) => ({
    rank: i + 1,
    subsystem: d.subsystem ?? null,
    // The judge's fix direction, or null. Naming the defect back at the reader
    // ("Address: <claim>") is not a change instruction — it looks like one,
    // which is worse than an honest gap.
    change: opts.fixDirections?.get(d.fingerprint) ?? null,
    defect: d.claim,
    // Counts and deltas the PLATFORM computed — arithmetic, not judgement.
    // Kept distinct from anything the model said so a reader can tell them
    // apart at a glance.
    rationale: d.persistence?.chronic
      ? `Blocks ${d.evalsBlocked} eval(s); has appeared in ${d.persistence.evaluationCount} evaluations.`
      : `Blocks ${d.evalsBlocked} eval(s); estimated +${d.estimatedScoreGain.toFixed(3)} mean score if fixed.`,
    verifyTaskIds: [...d.taskIds],
    // Guard set excludes the evals being fixed — they are expected to change.
    regressionTaskIds: opts.passingTaskIds.filter(
      (t) => !d.taskIds.includes(t),
    ),
    evalsBlocked: d.evalsBlocked,
    estimatedScoreGain: d.estimatedScoreGain,
    chronic: d.persistence?.chronic === true,
  }));
}

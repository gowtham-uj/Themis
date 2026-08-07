/**
 * The eval report — the analysis an evaluation produces.
 *
 * This is THE artifact another agent consumes, and it is deliberately NOT an
 * evidence dump. Traces, diffs and events are the judge's INPUT; shipping them
 * onward would just move the analysis burden to the next agent, which is the
 * work the judge exists to do.
 *
 * What ships instead is constructive criticism, organized by THEME:
 *
 *   "Across 4 evals the agent declared success without re-running tests
 *    after its final edit. This is a verification-ordering problem, not a
 *    knowledge gap — it ran the suite correctly earlier in every case.
 *    Technique: make the terminal action of any edit loop a fresh test run,
 *    and gate the success message on that run passing.
 *    Verify: re-run ext-a, ext-b, ext-d; ext-c must keep passing."
 *
 * A theme is a pattern seen across evals, with the technique that addresses it
 * and the evals that prove whether it worked. The consuming agent reads themes,
 * applies techniques, commits, and requests a new evaluation of that commit.
 *
 * Per-eval entries remain, but as OUTCOMES (score, status, what went wrong in
 * a line) with links to the full evidence — not the evidence itself.
 */

import type { DbQueries } from "../db/queries.js";
import { collectBatchBundles, type EvalBundle } from "./eval-bundle.js";
import { buildReleaseVerdict } from "./release-judge.js";
import type { ReleaseVerdict } from "./release-verdict.js";
import type { Finding, Subsystem, Verdict } from "./verdict.js";

export const EVAL_REPORT_SCHEMA_VERSION = 2 as const;

/**
 * A pattern across evals, with the technique that addresses it.
 *
 * This is the unit the consuming agent acts on. Not "eval 3 failed" but "this
 * class of mistake happened in these 4 evals, here is what to do about it, and
 * here is how you will know it worked".
 */
export interface Theme {
  id: string;
  /** One line naming the pattern. */
  title: string;
  /** What went wrong, across the evals where it appeared. */
  whatWentWrong: string;
  /**
   * Why it happened — the diagnosis that makes the technique follow. Without
   * this the technique is a guess the consumer cannot evaluate.
   */
  why: string;
  /** The concrete change to make. */
  technique: string;
  /** Where to make it. */
  subsystem: Subsystem | "unattributed";
  severity: "blocker" | "major" | "minor" | "nit";
  /** Evals exhibiting this pattern. */
  affectedEvals: Array<{ taskId: string; name: string }>;
  /**
   * Concrete moments, as short quotes — enough to make the theme credible
   * without shipping the trace. Each names the eval and the trace seq so the
   * consumer can pull the detail if it wants to.
   */
  examples: Array<{
    taskId: string;
    evalName: string;
    seq: number | null;
    whatHappened: string;
    insteadShouldHave: string;
  }>;
  /** How to prove the technique worked. */
  verification: {
    reRunTaskIds: string[];
    mustKeepPassingTaskIds: string[];
    successCriterion: string;
  };
  /** Ordering signal: how much fixing this buys. */
  impact: { evalsBlocked: number; estimatedScoreGain: number };
  /** True when this theme has survived previous fix attempts. */
  chronic: boolean;
  /** How many evaluations it has persisted across. */
  evaluationsSurvived: number;
}

/** One eval's OUTCOME — not its evidence. */
export interface EvalOutcome {
  name: string;
  taskId: string;
  runId: string;
  status: string;
  score: number | null;
  verdict: string | null;
  /** One line: what went wrong here, or what went right. */
  headline: string;
  /** Theme ids this eval contributed to. */
  themeIds: string[];
  /** Set when the ENVIRONMENT failed — not an agent failure. */
  environmentError: string | null;
  /** Where the full evidence lives, for a consumer that wants to dig. */
  evidence: {
    traceUrl: string | null;
    diffUrl: string | null;
    reportUrl: string | null;
    artifactCount: number;
    traceEventCount: number;
  };
}

/** What the agent did well — worth preserving through a refactor. */
export interface Strength {
  title: string;
  detail: string;
  evalNames: string[];
}

/** The complete evaluation output. */
export interface EvalReport {
  schemaVersion: typeof EVAL_REPORT_SCHEMA_VERSION;
  evaluationId: string;
  projectId: string;
  agentId: string;
  model: string;
  provider: string;
  commit: string | null;
  generatedAt: string;

  summary: {
    score: number;
    evalsTotal: number;
    evalsPassed: number;
    evalsFailed: number;
    evalsUnjudged: number;
    /** Plain-language assessment, not just numbers. */
    text: string;
  };

  /**
   * THE PAYLOAD: patterns and the techniques that address them, ordered by
   * what fixing each one buys.
   */
  themes: Theme[];

  /** Behaviours worth keeping — a refactor should not lose these. */
  strengths: Strength[];

  /**
   * Reliability, which changes WHAT KIND of fix applies: a flaky eval needs
   * determinism work, a consistently failing one needs capability work.
   */
  reliability: Array<{
    taskId: string;
    evalName: string;
    kind: "flaky" | "reliable_fail";
    passes: number;
    attempts: number;
    scoreRange: [number, number] | null;
  }>;

  /** Regressions, explained by where the runs diverged. */
  regressions: Array<{
    taskId: string;
    evalName: string;
    before: number;
    after: number;
    explanation: string;
  }>;

  /** Per-eval outcomes with links to evidence — not the evidence. */
  evals: EvalOutcome[];

  /** What to do next, as one call. */
  nextEvaluation: {
    description: string;
    request: {
      method: string;
      path: string;
      body: Record<string, unknown>;
    };
  };
}

/** Severity ordering for themes. */
const SEVERITY_RANK: Record<string, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** A one-line headline for an eval's outcome. */
function headlineFor(
  bundle: EvalBundle,
  verdict: Verdict | null,
  score: number | null,
): string {
  if (bundle.provision?.error) {
    return `Environment failed to build — the agent never ran.`;
  }
  if (bundle.runStatus !== "completed") {
    return `Run ended as ${bundle.runStatus}.`;
  }
  if (!verdict) return `Completed but was never judged.`;
  const worst = [...(verdict.findings ?? [])].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  )[0];
  if (worst) return worst.claim;
  return score !== null && score >= 0.7
    ? `Passed with no findings.`
    : `Scored ${score?.toFixed(2) ?? "?"} with no specific findings recorded.`;
}

/**
 * Group findings across evals into themes.
 *
 * The grouping key is (subsystem, category): what kind of mistake it is and
 * where it should be fixed. Two findings that differ in wording but are the
 * same class of error in the same subsystem are one theme — which is the whole
 * point, since a consuming agent applies one technique to fix both.
 */
function buildThemes(
  release: ReleaseVerdict,
  bundles: readonly EvalBundle[],
): Theme[] {
  const nameByTask = new Map(bundles.map((b) => [b.taskId, b.evalName]));

  interface Group {
    subsystem: Subsystem | "unattributed";
    category: string;
    severity: string;
    findings: Array<{ taskId: string; finding: Finding }>;
    techniques: string[];
    fingerprints: Set<string>;
  }

  const groups = new Map<string, Group>();
  for (const bundle of bundles) {
    const verdict = bundle.verdict as Verdict | null;
    for (const f of verdict?.findings ?? []) {
      const subsystem = (f.subsystem ?? "unattributed") as Group["subsystem"];
      const key = `${subsystem}::${f.category}`;
      const existing = groups.get(key);
      if (existing) {
        existing.findings.push({ taskId: bundle.taskId, finding: f });
        if (f.fix?.direction) existing.techniques.push(f.fix.direction);
        if ((SEVERITY_RANK[f.severity] ?? 9) < (SEVERITY_RANK[existing.severity] ?? 9)) {
          existing.severity = f.severity;
        }
      } else {
        groups.set(key, {
          subsystem,
          category: f.category,
          severity: f.severity,
          findings: [{ taskId: bundle.taskId, finding: f }],
          techniques: f.fix?.direction ? [f.fix.direction] : [],
          fingerprints: new Set(),
        });
      }
    }
  }

  // Impact + persistence come from the platform's own arithmetic, keyed by the
  // ranked defects the release verdict already computed.
  const rankedBySubsystemCategory = new Map<string, (typeof release.rankedDefects)[number]>();
  for (const d of release.rankedDefects) {
    const key = `${d.subsystem ?? "unattributed"}::${d.category}`;
    const prev = rankedBySubsystemCategory.get(key);
    if (!prev || d.impactScore > prev.impactScore) {
      rankedBySubsystemCategory.set(key, d);
    }
  }

  const passingTaskIds = release.tasks
    .filter((t) => (t.score ?? 0) >= 0.7)
    .map((t) => t.taskId);

  const themes: Theme[] = [];
  let n = 0;
  for (const [key, g] of groups) {
    n++;
    const affectedTaskIds = [...new Set(g.findings.map((f) => f.taskId))];
    const ranked = rankedBySubsystemCategory.get(key);

    // The technique: prefer the judge's own fix direction; several findings
    // usually agree, so take the most detailed rather than concatenating.
    const technique =
      [...g.techniques].sort((a, b) => b.length - a.length)[0] ??
      `Address the ${g.category.replace(/_/g, " ")} pattern in ${g.subsystem}.`;

    // Examples make a theme credible without shipping the trace. Cap at three:
    // a fourth example rarely changes what the consumer does.
    const examples = g.findings
      .filter((f) => f.finding.decisionPoint)
      .slice(0, 3)
      .map((f) => ({
        taskId: f.taskId,
        evalName: nameByTask.get(f.taskId) ?? f.taskId,
        seq: f.finding.decisionPoint?.seq ?? null,
        whatHappened: f.finding.decisionPoint?.whatHappened ?? f.finding.claim,
        insteadShouldHave: f.finding.decisionPoint?.counterfactual ?? "",
      }));

    // Fall back to claims when no decision points were recorded — a theme with
    // no examples reads as an assertion.
    if (examples.length === 0) {
      for (const f of g.findings.slice(0, 3)) {
        examples.push({
          taskId: f.taskId,
          evalName: nameByTask.get(f.taskId) ?? f.taskId,
          seq: null,
          whatHappened: f.finding.claim,
          insteadShouldHave: f.finding.fix?.direction ?? "",
        });
      }
    }

    const why =
      g.findings.length > 1
        ? `Seen in ${affectedTaskIds.length} eval(s), so this is a systematic pattern rather than a one-off slip.`
        : `Seen once, in ${nameByTask.get(affectedTaskIds[0] ?? "") ?? "one eval"}.`;

    themes.push({
      id: `theme-${n}`,
      // The subsystem is rendered as its own chip; repeating it in the title
      // reads as a stutter.
      title: g.category.replace(/_/g, " "),
      whatWentWrong: g.findings[0]!.finding.claim,
      why,
      technique,
      subsystem: g.subsystem,
      severity: g.severity as Theme["severity"],
      affectedEvals: affectedTaskIds.map((t) => ({
        taskId: t,
        name: nameByTask.get(t) ?? t,
      })),
      examples,
      verification: {
        reRunTaskIds: affectedTaskIds,
        mustKeepPassingTaskIds: passingTaskIds.filter(
          (t) => !affectedTaskIds.includes(t),
        ),
        successCriterion: `${affectedTaskIds.length} affected eval(s) should pass; currently-passing evals must not regress.`,
      },
      impact: {
        evalsBlocked: ranked?.evalsBlocked ?? affectedTaskIds.length,
        estimatedScoreGain: ranked?.estimatedScoreGain ?? 0,
      },
      chronic: ranked?.persistence?.chronic === true,
      evaluationsSurvived: ranked?.persistence?.evaluationCount ?? 1,
    });
  }

  themes.sort(
    (a, b) =>
      Number(b.chronic) - Number(a.chronic) ||
      b.impact.evalsBlocked - a.impact.evalsBlocked ||
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
  return themes;
}

/** Behaviours worth preserving, from the judge's positive findings. */
function buildStrengths(bundles: readonly EvalBundle[]): Strength[] {
  const byClaim = new Map<string, { detail: string; evals: Set<string> }>();
  for (const b of bundles) {
    const verdict = b.verdict as Verdict | null;
    for (const p of verdict?.positiveFindings ?? []) {
      const entry = byClaim.get(p.category);
      if (entry) entry.evals.add(b.evalName);
      else byClaim.set(p.category, { detail: p.claim, evals: new Set([b.evalName]) });
    }
  }
  return [...byClaim.entries()]
    .map(([category, v]) => ({
      title: category.replace(/_/g, " "),
      detail: v.detail,
      evalNames: [...v.evals].sort(),
    }))
    .sort((a, b) => b.evalNames.length - a.evalNames.length);
}

/**
 * Build the evaluation report.
 *
 * Analysis in, analysis out: traces and diffs are read to produce themes, then
 * left on disk with links rather than shipped onward.
 */
export async function buildEvalReport(
  queries: DbQueries,
  dataDir: string,
  batchId: string,
  opts: { now?: string } = {},
): Promise<EvalReport> {
  const [release, bundles] = await Promise.all([
    buildReleaseVerdict(queries, batchId, {
      dataDir,
      ...(opts.now ? { now: opts.now } : {}),
    }),
    collectBatchBundles(queries, dataDir, batchId),
  ]);

  const themes = buildThemes(release, bundles);
  const themeIdsByTask = new Map<string, string[]>();
  for (const t of themes) {
    for (const e of t.affectedEvals) {
      const list = themeIdsByTask.get(e.taskId);
      if (list) list.push(t.id);
      else themeIdsByTask.set(e.taskId, [t.id]);
    }
  }

  const runs = queries.listRuns({ batchId });
  const commit = runs[0]?.workspaceCommit ?? runs[0]?.workspaceRef ?? null;

  const evals: EvalOutcome[] = bundles.map((b) => {
    const verdict = b.verdict as Verdict | null;
    const score =
      typeof verdict?.overall?.score === "number" ? verdict.overall.score : null;
    return {
      name: b.evalName,
      taskId: b.taskId,
      runId: b.runId,
      status: b.runStatus,
      score,
      verdict: verdict?.overall?.verdict ?? null,
      headline: headlineFor(b, verdict, score),
      themeIds: themeIdsByTask.get(b.taskId) ?? [],
      environmentError: b.provision?.error ?? null,
      // Links, not payloads: the consumer digs only when it needs to.
      evidence: {
        traceUrl: b.events
          ? `/api/runs/${encodeURIComponent(b.runId)}/events`
          : null,
        diffUrl: b.diff ? `/api/runs/${encodeURIComponent(b.runId)}/diff` : null,
        reportUrl: b.judgementId
          ? `/api/judgements/${encodeURIComponent(b.judgementId)}/report`
          : null,
        artifactCount: b.artifacts.length,
        traceEventCount: b.events?.count ?? 0,
      },
    };
  });

  // The whole point of the loop: apply the techniques, commit, evaluate again.
  const allAffected = [...new Set(themes.flatMap((t) => t.verification.reRunTaskIds))];
  const nextEvaluation = {
    description:
      themes.length > 0
        ? `Apply the techniques above, commit, then evaluate that commit against the ${allAffected.length} affected eval(s) plus the passing set.`
        : `No themes to address. Re-evaluate a new commit when there is one.`,
    request: {
      method: "POST",
      path: `/api/projects/${release.projectId}/evaluate`,
      body: {
        commit: "<the commit containing your fixes>",
        agentId: release.agentId,
        ...(allAffected.length > 0
          ? { taskIds: [...allAffected, ...release.tasks.filter((t) => (t.score ?? 0) >= 0.7).map((t) => t.taskId)] }
          : {}),
        label: `verify fixes from evaluation ${batchId.slice(0, 8)}`,
      } as Record<string, unknown>,
    },
  };

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
      text:
        themes.length > 0
          ? `${release.overall.summary}. ${themes.length} theme(s) to address; the top one blocks ${themes[0]!.impact.evalsBlocked} eval(s).`
          : release.overall.summary,
    },
    themes,
    strengths: buildStrengths(bundles),
    reliability: release.reliability
      .filter((r) => r.verdict === "flaky" || r.verdict === "reliable_fail")
      .map((r) => ({
        taskId: r.taskId,
        evalName: r.evalName,
        kind: r.verdict as "flaky" | "reliable_fail",
        passes: r.passes,
        attempts: r.attempts,
        scoreRange: r.scoreRange,
      })),
    regressions: release.explainedRegressions.map((r) => ({
      taskId: r.taskId,
      evalName: r.evalName,
      before: r.baselineScore,
      after: r.candidateScore,
      explanation: r.divergence.summary,
    })),
    evals,
    nextEvaluation,
  };
}

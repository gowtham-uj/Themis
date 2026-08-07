/**
 * Contrastive trajectory diff — why the same eval passed at one commit and
 * failed at another.
 *
 * When an eval regresses, the scores tell you THAT it broke. The trajectories
 * tell you WHERE: up to some step the two runs did the same things, and then
 * they diverged. That divergence point is usually the entire explanation, and
 * it is invisible in any per-run report because it only exists in the
 * comparison.
 *
 * Newly possible now that evaluations are pinned to commits: "the same eval at
 * two revisions" is a well-defined pair.
 *
 * Pure: takes two event streams, returns where they parted company.
 */

/** The parts of a canonical event this comparison depends on. */
export interface TraceStep {
  seq: number;
  type: string;
  /** Tool name for tool.call / tool.result. */
  name?: string | undefined;
  /** Whether a tool result was an error. */
  isError?: boolean | undefined;
}

/** How two runs of the same eval differ. */
export interface TrajectoryDivergence {
  /** Steps that matched before the paths split. */
  commonPrefixLength: number;
  /** Seq in the baseline run where they parted, or null when one is a prefix. */
  divergedAtBaselineSeq: number | null;
  /** Seq in the candidate run where they parted. */
  divergedAtCandidateSeq: number | null;
  /** What the passing run did at the split. */
  baselineAction: string | null;
  /** What the failing run did instead. */
  candidateAction: string | null;
  /** Human-readable statement of the divergence. */
  summary: string;
  /** Tools the baseline used that the candidate never did. */
  toolsOnlyInBaseline: string[];
  /** Tools the candidate used that the baseline never did. */
  toolsOnlyInCandidate: string[];
  /** Step-count delta — a much longer run often means flailing. */
  stepDelta: number;
  /** Error-count delta. */
  errorDelta: number;
}

/**
 * A step's comparable signature.
 *
 * Deliberately NOT the full event: two runs of the same eval never have
 * identical arguments, timestamps, or ids, so comparing those would report a
 * divergence at step 1 every time. The shape of the action — "called run_tests"
 * — is the part that carries meaning across runs.
 */
export function stepSignature(step: TraceStep): string {
  if (step.type === "tool.call") return `tool:${step.name ?? "unknown"}`;
  if (step.type === "tool.result") {
    return `result:${step.name ?? "unknown"}:${step.isError ? "error" : "ok"}`;
  }
  return step.type;
}

/** Human-readable description of one step. */
function describe(step: TraceStep | undefined): string | null {
  if (!step) return null;
  if (step.type === "tool.call") return `called ${step.name ?? "a tool"}`;
  if (step.type === "tool.result") {
    return `${step.name ?? "a tool"} ${step.isError ? "failed" : "returned"}`;
  }
  return step.type;
}

/** Extract the comparable steps from a canonical event stream. */
export function toTraceSteps(events: readonly unknown[]): TraceStep[] {
  const out: TraceStep[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.type !== "string" || typeof e.seq !== "number") continue;
    // Deltas are noise for structural comparison — one run streaming its text
    // in three chunks and another in five is not a behavioural difference.
    if (e.mode === "delta") continue;
    out.push({
      seq: e.seq,
      type: e.type,
      name: typeof e.name === "string" ? e.name : undefined,
      isError: e.isError === true,
    });
  }
  return out;
}

/**
 * Compare two runs of the same eval and locate where they diverged.
 *
 * `baseline` is the run that behaved acceptably (usually the earlier commit);
 * `candidate` is the one being explained.
 */
export function diffTrajectories(
  baseline: readonly TraceStep[],
  candidate: readonly TraceStep[],
): TrajectoryDivergence {
  let i = 0;
  while (
    i < baseline.length &&
    i < candidate.length &&
    stepSignature(baseline[i]!) === stepSignature(candidate[i]!)
  ) {
    i++;
  }

  const bStep = baseline[i];
  const cStep = candidate[i];

  const baselineTools = new Set(
    baseline.filter((s) => s.type === "tool.call").map((s) => s.name ?? "unknown"),
  );
  const candidateTools = new Set(
    candidate.filter((s) => s.type === "tool.call").map((s) => s.name ?? "unknown"),
  );

  const baselineErrors = baseline.filter((s) => s.isError).length;
  const candidateErrors = candidate.filter((s) => s.isError).length;

  let summary: string;
  if (i >= baseline.length && i >= candidate.length) {
    summary =
      "Both runs took structurally identical paths — the difference is in content, not behaviour.";
  } else if (i >= baseline.length) {
    summary = `The failing run continued past where the passing run stopped (extra ${candidate.length - i} step(s), starting with "${describe(cStep)}").`;
  } else if (i >= candidate.length) {
    summary = `The failing run stopped ${baseline.length - i} step(s) early — the passing run went on to "${describe(bStep)}".`;
  } else {
    summary = `Both runs matched for ${i} step(s); then the passing run ${describe(bStep)} while the failing run ${describe(cStep)}.`;
  }

  return {
    commonPrefixLength: i,
    divergedAtBaselineSeq: bStep?.seq ?? null,
    divergedAtCandidateSeq: cStep?.seq ?? null,
    baselineAction: describe(bStep),
    candidateAction: describe(cStep),
    summary,
    toolsOnlyInBaseline: [...baselineTools].filter((t) => !candidateTools.has(t)).sort(),
    toolsOnlyInCandidate: [...candidateTools].filter((t) => !baselineTools.has(t)).sort(),
    stepDelta: candidate.length - baseline.length,
    errorDelta: candidateErrors - baselineErrors,
  };
}

/** A regression explained by comparing trajectories. */
export interface ExplainedRegression {
  taskId: string;
  evalName: string;
  baselineRunId: string;
  candidateRunId: string;
  baselineScore: number;
  candidateScore: number;
  divergence: TrajectoryDivergence;
}

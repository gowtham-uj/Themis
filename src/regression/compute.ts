/**
 * Pure regression-compute (P7a).
 *
 * All functions take already-resolved plain data (arrays/objects/maps) the API
 * layer supplies. This module never touches the DB, disk, or clock — so the
 * regression math is unit-testable without mocks.
 *
 * Plan clips:
 *  - plan/roadmap.md Phase 7 (N repeats + trend + compare + release compare)
 *  - plan/ui.md §6 score trend / two-run compare / §6c release compare
 *  - plan/data-model.md aggregation + finding-set diffs
 *
 * Design notes:
 *  - Axis is RESOLVED by the caller (joined from the task rubric). This module
 *    never loads a rubric.
 *  - Findings are matched by FINGERPRINT (task-scoped, P6a). compareTwoRuns +
 *    scoreTrend deltas are fingerprint-set operations.
 *  - Numeric deltas are always B − A. Positive overallScore delta means B
 *    scored higher (progressed). A NEGATIVE delta means B scored worse =
 *    regression. Callers label "regression" via isLikelyRegression with the
 *    appropriate sign.
 *  - A delta less than the batch spread is not a regression (noise band).
 */

/** Rubric axis letter (A–H). Resolved by the API layer before reaching here. */
export type RubricAxis = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

/**
 * Structured evidence reference. Structural match of judge `Ref` so callers can
 * pass decoded refs through without this module importing judge code.
 */
export type Ref =
  | { kind: "diff"; file: string; hunk: number; lines?: [number, number] }
  | { kind: "trace"; runId: string; seqs: [number, number] }
  | { kind: "tool"; toolCallId: string };

/** Localized diagnostic — yes/no with optional location. */
export interface Diagnostic {
  value: boolean;
  refs?: Ref[];
  note?: string;
}

/** Minimal run identity for trend sequencing (API-joined). */
export interface RunPoint {
  runId: string;
  taskId: string;
  batchId: string;
  agentCommit?: string;
  triggerRef?: string;
  createdAt: string;
  repeatIndex: number;
}

/** Judgement scores/verdict for a single point on a trend/compare. */
export interface JudgementPoint {
  judgementId: string;
  runId: string;
  createdAt: string;
  overallScore: number | null;
  verdict: "pass" | "fail" | "partial" | null;
}

/**
 * Per-criterion score with axis already resolved by the API layer
 * (criterionToAxis join from the task rubric). The compute never loads a rubric.
 */
export interface CriterionScore {
  criterion: string;
  axis: RubricAxis;
  weight: number;
  score: number;
}

/** One finding occurrence on a run/judgement, ready for set-diff. */
export interface FindingInstance {
  fingerprint: string;
  category: string;
  kind: "defect" | "positive" | "meta" | string;
  severity: string;
  claim: string;
  refs: Ref[];
  occurrenceStatus: "introduced" | "persisted" | "resolved";
  runId: string;
  judgementId: string;
}

/** batchStats output — variance-aware summary of N scores. */
export interface BatchStats {
  n: number;
  mean: number;
  /** Population standard deviation; 0 when n ≤ 1. */
  spread: number;
  min: number;
  max: number;
}

/** One annotated point on a per-task score trend. */
export interface TrendPoint {
  order: number;
  runId: string;
  judgementId: string;
  /** Null passes through — never coerced to 0. */
  overallScore: number | null;
  verdict: "pass" | "fail" | "partial" | null;
  findingDeltas: {
    introduced: FindingInstance[];
    resolved: FindingInstance[];
  };
}

/** Input shape shared by both sides of compareTwoRuns. */
export interface RunCompareSide {
  judgement: JudgementPoint;
  criteriaScores: CriterionScore[];
  findings: FindingInstance[];
  diagnostics: Record<string, Diagnostic>;
}

/** Two-run side-by-side compare result. */
export interface RunCompare {
  /** B.overallScore − A.overallScore; null if either score is null. */
  deltaOverall: number | null;
  perCriterion: Array<{
    criterion: string;
    axis: RubricAxis;
    /** B.score − A.score. */
    delta: number;
    aScore: number;
    bScore: number;
  }>;
  findingSetDiff: {
    introduced: FindingInstance[];
    resolved: FindingInstance[];
    persisted: FindingInstance[];
  };
  diagnosticDeltas: Array<{ key: string; a: boolean; b: boolean }>;
}

/** Per-task aggregate for one release (API-pre-aggregated). */
export interface TaskReleaseResult {
  taskId: string;
  meanOverall: number;
  spread: number;
  n: number;
  perAxis: Array<{ axis: RubricAxis; mean: number }>;
  findings: FindingInstance[];
  diagnostics: Record<string, boolean>;
  /** Optional fraction of repeats (or binary) that passed for this task. */
  passRate?: number;
}

/** One release side of releaseCompare. */
export interface ReleaseSide {
  agentVersion: string;
  taskResults: TaskReleaseResult[];
}

/** Suite-level compare of two agent versions. */
export interface ReleaseCompare {
  from: string;
  to: string;
  suiteDelta: {
    /** Mean of per-task (B − A) overall deltas for tasks present in BOTH. */
    deltaOverall: number;
    /** Population stddev of those per-task deltas (noise band). */
    spread: number;
    nImproved: number;
    nRegressed: number;
    nFlat: number;
    nNewTasks: number;
    nRemovedTasks: number;
  };
  perAxisRollup: Array<{
    axis: RubricAxis;
    fromMean: number;
    toMean: number;
    delta: number;
  }>;
  findingCategoryDeltas: Array<{
    category: string;
    introduced: number;
    resolved: number;
    persisted: number;
    /** introduced − resolved. */
    deltaNet: number;
  }>;
  diagnosticRateDeltas: Array<{
    key: string;
    fromRate: number;
    toRate: number;
    delta: number;
  }>;
  perTaskBreakdown: Array<{
    taskId: string;
    deltaOverall: number;
    perAxis: Array<{ axis: RubricAxis; delta: number }>;
    /** Net finding change: introduced − resolved for this task. */
    findingsDelta: number;
    presentInBoth: boolean;
  }>;
}

/** Clamp a score into [0, 1] defensively. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Variance-aware summary of a batch of scores.
 *
 * mean = arithmetic mean of scores clamped to [0,1].
 * spread = population standard deviation (√ mean of squared deviations);
 * n = 1 → spread 0. Empty input → all zeros (NaN-free).
 *
 * A delta less than `spread` is not a regression — noise, not signal.
 */
export function batchStats(scores: number[]): BatchStats {
  if (scores.length === 0) {
    return { n: 0, mean: 0, spread: 0, min: 0, max: 0 };
  }
  const clamped = scores.map(clamp01);
  const n = clamped.length;
  let sum = 0;
  let min = clamped[0]!;
  let max = clamped[0]!;
  for (const s of clamped) {
    sum += s;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const mean = sum / n;
  if (n === 1) {
    return { n, mean, spread: 0, min, max };
  }
  let sq = 0;
  for (const s of clamped) {
    const d = s - mean;
    sq += d * d;
  }
  const spread = Math.sqrt(sq / n);
  return { n, mean, spread, min, max };
}

/**
 * Per-task score trend annotated with finding-set deltas.
 *
 * `points` should already be sorted by taskRunOrder; we sort defensively
 * ascending. findingDeltas are vs the PREVIOUS point by fingerprint:
 *   - introduced = present here, not at previous
 *   - resolved   = present at previous, not here
 * First point: introduced = all its findings, resolved = [].
 * overallScore null passes through (never treated as 0).
 */
export function scoreTrend(
  points: Array<{
    taskRunOrder: number;
    judgement: JudgementPoint;
    findings: FindingInstance[];
  }>,
): TrendPoint[] {
  const sorted = [...points].sort((a, b) => a.taskRunOrder - b.taskRunOrder);
  const out: TrendPoint[] = [];
  let prevFingerprints: Set<string> | null = null;
  let prevByFp: Map<string, FindingInstance> | null = null;

  for (const p of sorted) {
    const byFp = new Map<string, FindingInstance>();
    for (const f of p.findings) {
      byFp.set(f.fingerprint, f);
    }
    const fps = new Set(byFp.keys());

    let introduced: FindingInstance[];
    let resolved: FindingInstance[];

    if (prevFingerprints === null || prevByFp === null) {
      introduced = p.findings.slice();
      resolved = [];
    } else {
      introduced = [];
      resolved = [];
      for (const [fp, f] of byFp) {
        if (!prevFingerprints.has(fp)) introduced.push(f);
      }
      for (const [fp, f] of prevByFp) {
        if (!fps.has(fp)) resolved.push(f);
      }
    }

    out.push({
      order: p.taskRunOrder,
      runId: p.judgement.runId,
      judgementId: p.judgement.judgementId,
      overallScore: p.judgement.overallScore,
      verdict: p.judgement.verdict,
      findingDeltas: { introduced, resolved },
    });

    prevFingerprints = fps;
    prevByFp = byFp;
  }
  return out;
}

/**
 * Two-run side-by-side compare.
 *
 * deltaOverall = B.score − A.score (null if either is null). Positive = B
 * improved; negative = B regressed. findingSetDiff is a fingerprint-set
 * operation: introduced = in B not A; resolved = in A not B; persisted = both.
 * Each FindingInstance carries its refs for deep-linking.
 */
export function compareTwoRuns(a: RunCompareSide, b: RunCompareSide): RunCompare {
  const aScore = a.judgement.overallScore;
  const bScore = b.judgement.overallScore;
  const deltaOverall =
    aScore === null || bScore === null ? null : bScore - aScore;

  const aCrit = new Map(a.criteriaScores.map((c) => [c.criterion, c]));
  const bCrit = new Map(b.criteriaScores.map((c) => [c.criterion, c]));
  const critKeys = new Set<string>([...aCrit.keys(), ...bCrit.keys()]);
  const perCriterion: RunCompare["perCriterion"] = [];
  for (const key of [...critKeys].sort()) {
    const ac = aCrit.get(key);
    const bc = bCrit.get(key);
    // Prefer B's axis when both present; else whichever side has it.
    const axis = (bc?.axis ?? ac?.axis ?? "A") as RubricAxis;
    const aS = ac?.score ?? 0;
    const bS = bc?.score ?? 0;
    perCriterion.push({
      criterion: key,
      axis,
      delta: bS - aS,
      aScore: aS,
      bScore: bS,
    });
  }

  const aByFp = new Map(a.findings.map((f) => [f.fingerprint, f]));
  const bByFp = new Map(b.findings.map((f) => [f.fingerprint, f]));
  const introduced: FindingInstance[] = [];
  const resolved: FindingInstance[] = [];
  const persisted: FindingInstance[] = [];
  for (const [fp, f] of bByFp) {
    if (aByFp.has(fp)) persisted.push(f);
    else introduced.push(f);
  }
  for (const [fp, f] of aByFp) {
    if (!bByFp.has(fp)) resolved.push(f);
  }

  const diagKeys = new Set<string>([
    ...Object.keys(a.diagnostics),
    ...Object.keys(b.diagnostics),
  ]);
  const diagnosticDeltas: RunCompare["diagnosticDeltas"] = [];
  for (const key of [...diagKeys].sort()) {
    diagnosticDeltas.push({
      key,
      a: a.diagnostics[key]?.value ?? false,
      b: b.diagnostics[key]?.value ?? false,
    });
  }

  return {
    deltaOverall,
    perCriterion,
    findingSetDiff: { introduced, resolved, persisted },
    diagnosticDeltas,
  };
}

/**
 * Variance helper: a delta within the noise band is not a regression.
 * Returns true iff |delta| > spread.
 */
export function isLikelyRegression(delta: number, spread: number): boolean {
  return Math.abs(delta) > spread;
}

function axisMeanMap(
  perAxis: Array<{ axis: RubricAxis; mean: number }>,
): Map<RubricAxis, number> {
  const m = new Map<RubricAxis, number>();
  for (const e of perAxis) m.set(e.axis, e.mean);
  return m;
}

/**
 * Suite-level compare of two agent versions (release A → release B).
 *
 * Only tasks present in BOTH releases count for improved/regressed/flat and
 * for suiteDelta.deltaOverall/spread (mean + pop-stddev of per-task deltas).
 * Tasks only in B are nNewTasks; only in A are nRemovedTasks.
 *
 * Finding-category introduced/resolved/persisted counts are SUITE-level over
 * tasks present in both releases (fingerprint sets, then counted by category).
 *
 * Diagnostic rates = fraction of tasks where the diagnostic value === true.
 * When any task provides passRate, a synthetic "passRate" rate (mean of
 * provided passRates per release) is included in diagnosticRateDeltas.
 *
 * Deltas are always B − A. Deterministic key/axis/taskId ordering.
 */
export function releaseCompare(
  releaseA: ReleaseSide,
  releaseB: ReleaseSide,
): ReleaseCompare {
  const aByTask = new Map(releaseA.taskResults.map((t) => [t.taskId, t]));
  const bByTask = new Map(releaseB.taskResults.map((t) => [t.taskId, t]));

  const allTaskIds = [...new Set([...aByTask.keys(), ...bByTask.keys()])].sort();
  const bothIds: string[] = [];
  let nNewTasks = 0;
  let nRemovedTasks = 0;
  for (const id of allTaskIds) {
    const inA = aByTask.has(id);
    const inB = bByTask.has(id);
    if (inA && inB) bothIds.push(id);
    else if (inB) nNewTasks += 1;
    else nRemovedTasks += 1;
  }

  const perTaskDeltas: number[] = [];
  let nImproved = 0;
  let nRegressed = 0;
  let nFlat = 0;
  for (const id of bothIds) {
    const a = aByTask.get(id)!;
    const b = bByTask.get(id)!;
    const d = b.meanOverall - a.meanOverall;
    perTaskDeltas.push(d);
    if (d > 0) nImproved += 1;
    else if (d < 0) nRegressed += 1;
    else nFlat += 1;
  }

  // Suite delta mean/spread over per-task deltas (not clamped — deltas can be
  // negative). Reuse pop-stddev formula; empty both → zeros.
  let deltaOverall = 0;
  let spread = 0;
  if (perTaskDeltas.length > 0) {
    let sum = 0;
    for (const d of perTaskDeltas) sum += d;
    deltaOverall = sum / perTaskDeltas.length;
    if (perTaskDeltas.length > 1) {
      let sq = 0;
      for (const d of perTaskDeltas) {
        const x = d - deltaOverall;
        sq += x * x;
      }
      spread = Math.sqrt(sq / perTaskDeltas.length);
    }
  }

  // Per-axis rollup over tasks in both.
  const axisFromSums = new Map<RubricAxis, { sum: number; n: number }>();
  const axisToSums = new Map<RubricAxis, { sum: number; n: number }>();
  for (const id of bothIds) {
    const a = aByTask.get(id)!;
    const b = bByTask.get(id)!;
    for (const e of a.perAxis) {
      const cur = axisFromSums.get(e.axis) ?? { sum: 0, n: 0 };
      cur.sum += e.mean;
      cur.n += 1;
      axisFromSums.set(e.axis, cur);
    }
    for (const e of b.perAxis) {
      const cur = axisToSums.get(e.axis) ?? { sum: 0, n: 0 };
      cur.sum += e.mean;
      cur.n += 1;
      axisToSums.set(e.axis, cur);
    }
  }
  const allAxes = [
    ...new Set([...axisFromSums.keys(), ...axisToSums.keys()]),
  ].sort() as RubricAxis[];
  const perAxisRollup: ReleaseCompare["perAxisRollup"] = allAxes.map((axis) => {
    const from = axisFromSums.get(axis);
    const to = axisToSums.get(axis);
    const fromMean = from && from.n > 0 ? from.sum / from.n : 0;
    const toMean = to && to.n > 0 ? to.sum / to.n : 0;
    return { axis, fromMean, toMean, delta: toMean - fromMean };
  });

  // Suite-level finding-category deltas over tasks in both (by fingerprint).
  type CatAgg = {
    introduced: number;
    resolved: number;
    persisted: number;
  };
  const catMap = new Map<string, CatAgg>();
  // Build fingerprint → category maps across both-release tasks.
  const aFp = new Map<string, string>(); // fingerprint → category
  const bFp = new Map<string, string>();
  for (const id of bothIds) {
    for (const f of aByTask.get(id)!.findings) {
      aFp.set(f.fingerprint, f.category);
    }
    for (const f of bByTask.get(id)!.findings) {
      bFp.set(f.fingerprint, f.category);
    }
  }
  for (const [fp, cat] of bFp) {
    const agg = catMap.get(cat) ?? { introduced: 0, resolved: 0, persisted: 0 };
    if (aFp.has(fp)) agg.persisted += 1;
    else agg.introduced += 1;
    catMap.set(cat, agg);
  }
  for (const [fp, cat] of aFp) {
    if (!bFp.has(fp)) {
      const agg = catMap.get(cat) ?? { introduced: 0, resolved: 0, persisted: 0 };
      agg.resolved += 1;
      catMap.set(cat, agg);
    }
  }
  const findingCategoryDeltas: ReleaseCompare["findingCategoryDeltas"] = [
    ...catMap.keys(),
  ]
    .sort()
    .map((category) => {
      const c = catMap.get(category)!;
      return {
        category,
        introduced: c.introduced,
        resolved: c.resolved,
        persisted: c.persisted,
        deltaNet: c.introduced - c.resolved,
      };
    });

  // Diagnostic rate deltas over each release's full task set.
  const rateFor = (
    tasks: TaskReleaseResult[],
  ): { rates: Map<string, number>; passRate: number | null } => {
    const counts = new Map<string, { trueCount: number; n: number }>();
    let passSum = 0;
    let passN = 0;
    for (const t of tasks) {
      for (const [key, val] of Object.entries(t.diagnostics)) {
        const cur = counts.get(key) ?? { trueCount: 0, n: 0 };
        cur.n += 1;
        if (val === true) cur.trueCount += 1;
        counts.set(key, cur);
      }
      if (t.passRate !== undefined) {
        passSum += t.passRate;
        passN += 1;
      }
    }
    const rates = new Map<string, number>();
    for (const [key, c] of counts) {
      rates.set(key, c.n > 0 ? c.trueCount / c.n : 0);
    }
    return {
      rates,
      passRate: passN > 0 ? passSum / passN : null,
    };
  };

  const aRates = rateFor(releaseA.taskResults);
  const bRates = rateFor(releaseB.taskResults);
  const rateKeys = new Set<string>([
    ...aRates.rates.keys(),
    ...bRates.rates.keys(),
  ]);
  if (aRates.passRate !== null || bRates.passRate !== null) {
    rateKeys.add("passRate");
  }
  const diagnosticRateDeltas: ReleaseCompare["diagnosticRateDeltas"] = [
    ...rateKeys,
  ]
    .sort()
    .map((key) => {
      if (key === "passRate") {
        const fromRate = aRates.passRate ?? 0;
        const toRate = bRates.passRate ?? 0;
        return { key, fromRate, toRate, delta: toRate - fromRate };
      }
      const fromRate = aRates.rates.get(key) ?? 0;
      const toRate = bRates.rates.get(key) ?? 0;
      return { key, fromRate, toRate, delta: toRate - fromRate };
    });

  // Per-task breakdown over A ∪ B.
  const perTaskBreakdown: ReleaseCompare["perTaskBreakdown"] = allTaskIds.map(
    (taskId) => {
      const a = aByTask.get(taskId);
      const b = bByTask.get(taskId);
      const presentInBoth = a !== undefined && b !== undefined;
      const aMean = a?.meanOverall ?? 0;
      const bMean = b?.meanOverall ?? 0;
      const aAxes = axisMeanMap(a?.perAxis ?? []);
      const bAxes = axisMeanMap(b?.perAxis ?? []);
      const axes = [...new Set([...aAxes.keys(), ...bAxes.keys()])].sort() as RubricAxis[];
      const perAxis = axes.map((axis) => ({
        axis,
        delta: (bAxes.get(axis) ?? 0) - (aAxes.get(axis) ?? 0),
      }));

      // Finding set diff for this task (empty set if missing side).
      const aSet = new Set((a?.findings ?? []).map((f) => f.fingerprint));
      const bSet = new Set((b?.findings ?? []).map((f) => f.fingerprint));
      let introduced = 0;
      let resolved = 0;
      for (const fp of bSet) if (!aSet.has(fp)) introduced += 1;
      for (const fp of aSet) if (!bSet.has(fp)) resolved += 1;

      return {
        taskId,
        deltaOverall: bMean - aMean,
        perAxis,
        findingsDelta: introduced - resolved,
        presentInBoth,
      };
    },
  );

  return {
    from: releaseA.agentVersion,
    to: releaseB.agentVersion,
    suiteDelta: {
      deltaOverall,
      spread,
      nImproved,
      nRegressed,
      nFlat,
      nNewTasks,
      nRemovedTasks,
    },
    perAxisRollup,
    findingCategoryDeltas,
    diagnosticRateDeltas,
    perTaskBreakdown,
  };
}

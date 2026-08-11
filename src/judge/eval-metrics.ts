/** Outcome and quality metrics derived from verifier results and validated judgement. */

import type { CheckResult, Ref, Verdict } from "./verdict.js";
import type { MetricMeasurement } from "../runner/metrics.js";

export const OUTCOME_METRICS_SCHEMA_VERSION = 1 as const;

export interface OutcomeMetrics {
  schemaVersion: typeof OUTCOME_METRICS_SCHEMA_VERSION;
  officialReward: 0 | 1;
  measurements: Record<string, MetricMeasurement>;
}

/** Derive solved-normalized and diagnostic metrics without replacing binary reward. */
export function deriveOutcomeMetrics(input: {
  runId: string;
  verdict: Verdict;
  checks: CheckResult[];
  execution: Record<string, unknown>;
}): OutcomeMetrics {
  const checks = input.checks.filter((check) => check.status !== "skipped");
  const hidden = checks.filter((check) => /hidden|oracle/i.test(check.kind));
  const functional = checks.filter((check) => /test|functional|repro/i.test(check.kind) && !/hidden|oracle/i.test(check.kind));
  const regressions = checks.filter((check) => /regression|existing/i.test(check.kind));
  const requiredChecksPass = checks.length > 0 && checks.every((check) => check.status === "pass");
  const officialReward: 0 | 1 = requiredChecksPass
    ? 1
    : checks.length > 0
      ? 0
      : input.verdict.overall.verdict === "pass"
        ? 1
        : 0;
  const executionMeasurements = asRecord(input.execution.measurements);
  const tokens = metricNumber(executionMeasurements.tokens_used);
  const cost = metricNumber(executionMeasurements.cost_usd);
  const wallClock = metricNumber(executionMeasurements.wall_clock_ms);
  const repeatedReads = metricNumber(executionMeasurements.repeated_file_reads);
  const filesOpened = metricNumber(executionMeasurements.files_opened);
  const toolCalls = metricNumber(executionMeasurements.tool_calls);
  const stalls = metricNumber(executionMeasurements.stalls_or_loops);
  const testRecovery = metricNumber(executionMeasurements.failed_test_recovery_rate);
  const compileRecovery = metricNumber(executionMeasurements.compile_error_recovery_rate);
  const verification = metricNumber(executionMeasurements.verification_rate);
  const falseSuccessDiagnostic = input.verdict.diagnostics.hallucinated_success;
  const scopeDiagnostic = input.verdict.diagnostics.destructive_or_offtask;
  const gaveUp = input.verdict.diagnostics.gave_up_early;
  const ignored = input.verdict.diagnostics.ignored_constraints;
  const downstreamChanges = [
    ...(input.verdict.improvements.withoutSource ?? []),
    ...(input.verdict.improvements.withSource ?? []),
  ].filter((step) => step.priority === "high" || step.priority === "medium").length;
  const rootCauseLatencies = input.verdict.findings
    .map((finding) => finding.decisionPoint)
    .filter((point): point is NonNullable<typeof point> =>
      point !== undefined && point.evidenceAvailableAtSeq !== undefined)
    .map((point) => point.seq - point.evidenceAvailableAtSeq!);

  const measurements: Record<string, MetricMeasurement> = {
    task_success: exact(officialReward, "binary", checkRefs(checks), checks.length > 0
      ? "Binary reward from all non-skipped verifier checks."
      : "Legacy fallback: no separate verifier checks were available; pass/fail came from the validated judge verdict."),
    functional_score: rate(functional, "functional verifier pass rate"),
    hidden_test_score: rate(hidden, "hidden/oracle verifier pass rate"),
    regression_rate: regressions.length === 0
      ? unknown("ratio", "No regression-labelled verifier checks were recorded.")
      : exact(regressions.filter((check) => check.status !== "pass").length / regressions.length, "ratio", checkRefs(regressions)),
    robustness_retention: regressions.length === 0
      ? unknown("ratio", "Requires regression checks or a prior-run comparison.")
      : exact(regressions.filter((check) => check.status === "pass").length / regressions.length, "ratio", checkRefs(regressions)),
    localization_accuracy: unknown("ratio", "Requires expected target locations from the eval package and first-edit trace attribution."),
    root_cause_latency: rootCauseLatencies.length === 0
      ? unknown("trace-seq", "No finding supplied both evidence-available and decision-point sequence numbers.")
      : judgeDerived(mean(rootCauseLatencies), "trace-seq", findingRefs(input.verdict)),
    context_precision: filesOpened === null || repeatedReads === null || filesOpened + repeatedReads === 0
      ? unknown("ratio", "File-read telemetry was unavailable or empty.")
      : derived(filesOpened / (filesOpened + repeatedReads), "ratio", []),
    verification_rate: verification === null
      ? unknown("ratio", "Execution metrics could not establish verification-after-mutation.")
      : derived(verification, "ratio", []),
    first_edit_quality: unknown("ratio", "Requires expected target locations and first-edit outcome attribution."),
    tool_efficiency: toolCalls === null || toolCalls === 0
      ? unknown("ratio", "No tool-call denominator was available.")
      : derived(Math.max(0, 1 - (stalls ?? 0) / toolCalls), "ratio", []),
    recovery_success: testRecovery === null && compileRecovery === null
      ? unknown("ratio", "No failed test or compile attempt required recovery.")
      : derived(mean([testRecovery, compileRecovery].filter((value): value is number => value !== null)), "ratio", []),
    recovery_latency: unknown("ms", "Canonical events do not yet retain wall-clock timestamps for paired failure/recovery classifications."),
    edit_churn: measurementOrUnknown(executionMeasurements.edit_churn, "ratio"),
    scope_adherence: scopeDiagnostic
      ? judgeDerived(scopeDiagnostic.value ? 0 : 1, "ratio", scopeDiagnostic.refs ?? [])
      : unknown("ratio", "No scope diagnostic was emitted."),
    tokens_per_solved: officialReward === 1 && tokens !== null
      ? derived(tokens, "tokens/solved", [])
      : unknown("tokens/solved", officialReward === 0 ? "Task was not solved." : "Token usage unavailable."),
    cost_per_solved: officialReward === 1 && cost !== null
      ? derived(cost, "usd/solved", [])
      : unknown("usd/solved", officialReward === 0 ? "Task was not solved." : "Provider cost unavailable."),
    wall_clock_per_solved: officialReward === 1 && wallClock !== null
      ? derived(wallClock, "ms/solved", [])
      : unknown("ms/solved", officialReward === 0 ? "Task was not solved." : "Wall-clock unavailable."),
    false_success_rate: falseSuccessDiagnostic
      ? judgeDerived(falseSuccessDiagnostic.value ? 1 : 0, "ratio", falseSuccessDiagnostic.refs ?? [])
      : unknown("ratio", "No hallucinated-success diagnostic was emitted."),
    long_horizon_goal_retention: gaveUp && ignored
      ? judgeDerived(gaveUp.value || ignored.value ? 0 : 1, "ratio", [
          ...(gaveUp.refs ?? []),
          ...(ignored.refs ?? []),
        ])
      : unknown("ratio", "Goal-retention diagnostics were incomplete."),
    downstream_agent_tax: judgeDerived(
      downstreamChanges,
      "actionable-changes",
      findingRefs(input.verdict),
      "Count of high/medium evidence-linked changes a downstream fixing agent must absorb.",
    ),
    planner_accuracy: unknown("ratio", "Requires a structured agent plan and outcome mapping in canonical traces."),
  };

  return { schemaVersion: OUTCOME_METRICS_SCHEMA_VERSION, officialReward, measurements };
}

function rate(checks: CheckResult[], note: string): MetricMeasurement {
  if (checks.length === 0) return unknown("ratio", `No checks available for ${note}.`);
  return exact(
    checks.filter((check) => check.status === "pass").length / checks.length,
    "ratio",
    checkRefs(checks),
    note,
  );
}

function checkRefs(checks: CheckResult[]): Array<{ kind: "artifact"; path: string }> {
  return checks.map((check) => ({ kind: "artifact", path: `checks/${check.checkId}.json` }));
}

function findingRefs(verdict: Verdict): Ref[] {
  return verdict.findings.flatMap((finding) => finding.refs);
}

function measurementOrUnknown(value: unknown, unit: string): MetricMeasurement {
  return isMeasurement(value) ? value : unknown(unit, "Execution metric unavailable.");
}

function metricNumber(value: unknown): number | null {
  return isMeasurement(value) && typeof value.value === "number" ? value.value : null;
}

function isMeasurement(value: unknown): value is MetricMeasurement {
  return !!value && typeof value === "object" && "provenance" in value && "value" in value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function exact(
  value: number | boolean,
  unit: string,
  refs: MetricMeasurement["refs"],
  note?: string,
): MetricMeasurement {
  return { value, unit, provenance: "exact", refs, ...(note ? { note } : {}) };
}

function derived(
  value: number | boolean,
  unit: string,
  refs: MetricMeasurement["refs"],
  note?: string,
): MetricMeasurement {
  return { value, unit, provenance: "derived", refs, ...(note ? { note } : {}) };
}

function judgeDerived(
  value: number | boolean,
  unit: string,
  refs: Ref[],
  note?: string,
): MetricMeasurement {
  return {
    value,
    unit,
    provenance: "judge-derived",
    refs: refs.map((ref) => {
      if (ref.kind === "trace") return { kind: "trace", runId: ref.runId, seqs: ref.seqs };
      if (ref.kind === "diff") return { kind: "diff", file: ref.file, hunk: ref.hunk };
      if (ref.kind === "artifact") return { kind: "artifact", path: ref.path };
      return { kind: "artifact", path: `tool-calls/${ref.toolCallId}` };
    }),
    ...(note ? { note } : {}),
  };
}

function unknown(unit: string, note: string): MetricMeasurement {
  return { value: null, unit, provenance: "unknown", refs: [], note };
}

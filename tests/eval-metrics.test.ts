import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveOutcomeMetrics } from "../src/judge/eval-metrics.ts";
import type { Verdict } from "../src/judge/verdict.ts";

const verdict = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/verdict-sample.json"), "utf8"),
) as Verdict;

const execution = {
  measurements: {
    tokens_used: { value: 1200, unit: "tokens", provenance: "exact", refs: [] },
    cost_usd: { value: 0.03, unit: "usd", provenance: "exact", refs: [] },
    wall_clock_ms: { value: 5000, unit: "ms", provenance: "exact", refs: [] },
    files_opened: { value: 3, unit: "files", provenance: "exact", refs: [] },
    repeated_file_reads: { value: 1, unit: "reads", provenance: "exact", refs: [] },
    tool_calls: { value: 8, unit: "calls", provenance: "exact", refs: [] },
    stalls_or_loops: { value: 1, unit: "count", provenance: "derived", refs: [] },
    failed_test_recovery_rate: { value: 1, unit: "ratio", provenance: "derived", refs: [] },
    compile_error_recovery_rate: { value: null, unit: "ratio", provenance: "unknown", refs: [] },
    verification_rate: { value: 1, unit: "ratio", provenance: "derived", refs: [] },
    edit_churn: { value: 0.25, unit: "ratio", provenance: "derived", refs: [] },
  },
};

describe("per-eval outcome metrics", () => {
  it("uses isolated verifier checks for binary reward and solved-normalized metrics", () => {
    const metrics = deriveOutcomeMetrics({
      runId: "run-1",
      verdict,
      execution,
      checks: [
        { checkId: "functional", kind: "functional", status: "pass" },
        { checkId: "hidden", kind: "hidden_test", status: "pass" },
        { checkId: "regression", kind: "regression", status: "pass" },
      ],
    });
    expect(metrics.officialReward).toBe(1);
    expect(metrics.measurements.task_success.value).toBe(1);
    expect(metrics.measurements.hidden_test_score.value).toBe(1);
    expect(metrics.measurements.tokens_per_solved.value).toBe(1200);
    expect(metrics.measurements.cost_per_solved.value).toBe(0.03);
    expect(metrics.measurements.context_precision.value).toBe(0.75);
  });

  it("keeps solved-normalized metrics unknown when any verifier check fails", () => {
    const metrics = deriveOutcomeMetrics({
      runId: "run-1",
      verdict,
      execution,
      checks: [
        { checkId: "functional", kind: "functional", status: "pass" },
        { checkId: "hidden", kind: "hidden_test", status: "fail" },
      ],
    });
    expect(metrics.officialReward).toBe(0);
    expect(metrics.measurements.hidden_test_score.value).toBe(0);
    expect(metrics.measurements.tokens_per_solved).toMatchObject({
      value: null,
      provenance: "unknown",
    });
  });

  it("does not turn unavailable accuracy metrics into zero", () => {
    const metrics = deriveOutcomeMetrics({
      runId: "run-1",
      verdict,
      execution: {},
      checks: [],
    });
    expect(metrics.measurements.localization_accuracy).toMatchObject({ value: null, provenance: "unknown" });
    expect(metrics.measurements.first_edit_quality).toMatchObject({ value: null, provenance: "unknown" });
    expect(metrics.measurements.planner_accuracy).toMatchObject({ value: null, provenance: "unknown" });
  });
});

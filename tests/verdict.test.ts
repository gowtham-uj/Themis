/**
 * Verdict schema validator tests — the three-layer contract (plan/judge.md)
 * enforced before any worker builds on it. A finding with no refs is dropped
 * (not emitted); diagnostics are {value,refs,note} not bare booleans;
 * withoutSource refs are trace/tool only; withSource gated by source artifacts.
 */
import { describe, expect, it } from "vitest";
import {
  VERDICT_SCHEMA_VERSION,
  VerdictValidationError,
  validateVerdict,
  type Diagnostic,
  type Finding,
  type Improvements,
  type Verdict,
} from "../src/judge/verdict.ts";

function goodFinding(id: string, withDiff = false): Finding {
  return {
    id,
    category: "verification_skipped",
    severity: "major",
    confidence: 0.8,
    claim: "agent stopped running the suite",
    refs: withDiff
      ? [{ kind: "diff", file: "a.ts", hunk: 3 }]
      : [{ kind: "trace", runId: "r1", seqs: [120, 180] }],
  };
}

function baseVerdict(opts: { hasSource: boolean }): Verdict {
  const improvements: Improvements = {
    summary: "ok",
    withoutSource: [
      {
        area: "verification",
        priority: "high",
        change: "run the suite",
        why: "trace shows no test run",
        refs: [{ kind: "trace", runId: "r1", seqs: [1, 5] }],
        linkedFindings: ["f1"],
      },
    ],
  };
  if (opts.hasSource) {
    improvements.withSource = [
      {
        area: "correctness",
        priority: "high",
        change: "fix boundary",
        why: "off by one",
        refs: [{ kind: "diff", file: "x.ts", hunk: 2 }],
        linkedFindings: ["f1"],
      },
    ];
  }
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: { score: 0.5, verdict: "partial", summary: "partial" },
    criteria: [
      { criterion: "A1", weight: 1, feedback: "reason", score: 0.5, evidence: ["e"], findingIds: ["f1"] },
    ],
    findings: [goodFinding("f1")],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: {
      looping: { value: false, refs: [], note: "none" } as Diagnostic,
      test_gaming: { value: true, note: "see trace" },
    },
    attribution: { agent_vs_environment: "agent" },
    observations: ["note"],
    improvements,
  };
}

describe("validateVerdict (three-layer contract)", () => {
  it("accepts a well-formed verdict (with + without source)", () => {
    const v = baseVerdict({ hasSource: true });
    expect(() => validateVerdict(v, { hasSourceArtifacts: true })).not.toThrow();
  });

  it("accepts a no-source verdict (withSource omitted)", () => {
    const v = baseVerdict({ hasSource: false });
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).not.toThrow();
  });

  it("rejects a withSource block when the run has no source artifacts (lens gate)", () => {
    const v = baseVerdict({ hasSource: true });
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(VerdictValidationError);
  });

  it("rejects a finding with no refs (must be dropped, not emitted)", () => {
    const v = baseVerdict({ hasSource: false });
    v.findings[0]!.refs = []; // a finding with ≥1 ref or drop it
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/≥1 ref|drop it/);
  });

  it("rejects bare-boolean diagnostics (must be {value,refs,note})", () => {
    const v = baseVerdict({ hasSource: false });
    (v as unknown as { diagnostics: Record<string, unknown> }).diagnostics = { looping: true };
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/must be \{value/);
  });

  it("enforces withoutSource lens independence — no diff refs", () => {
    const v = baseVerdict({ hasSource: false });
    v.improvements.withoutSource[0]!.refs = [{ kind: "diff", file: "a", hunk: 1 }];
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/withoutSource lens must not use diff refs/);
  });

  it("rejects duplicate finding ids", () => {
    const v = baseVerdict({ hasSource: false });
    v.findings = [goodFinding("f1"), goodFinding("f1")];
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/duplicate finding id/);
  });

  it("rejects out-of-range scores and bad severity", () => {
    const v = baseVerdict({ hasSource: false });
    v.overall.score = 1.5;
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/overall\.score/);
    const v2 = baseVerdict({ hasSource: false });
    (v2.findings[0] as unknown as { severity: string }).severity = "catastrophic";
    expect(() => validateVerdict(v2, { hasSourceArtifacts: false })).toThrow(/bad severity/);
  });

  // Regression: WITHOUT-source lens independence is a HARD RULE independent of
  // whether the run has source artifacts. A coding run (hasSource:true) leaking
  // a diff ref into withoutSource must STILL be rejected — the rule protects the
  // lens's value, not the run's category.
  it("rejects withoutSource diff refs even when the run HAS source artifacts", () => {
    const v = baseVerdict({ hasSource: true });
    v.improvements.withoutSource[0]!.refs = [{ kind: "diff", file: "a", hunk: 1 }];
    expect(() => validateVerdict(v, { hasSourceArtifacts: true })).toThrow(
      /withoutSource lens must not use diff refs/,
    );
  });

  // Regression: an improvement with no refs AND no linkedFindings is a guess.
  it("rejects an ungrounded improvement (no refs, no linkedFindings)", () => {
    const v = baseVerdict({ hasSource: false });
    v.improvements.withoutSource[0]!.refs = [];
    v.improvements.withoutSource[0]!.linkedFindings = [];
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/a guess/);
  });

  // Cross-check: a criterion's findingIds must reference real findings.
  it("rejects a criterion findingId not present in findings[]", () => {
    const v = baseVerdict({ hasSource: false });
    v.criteria[0]!.findingIds = ["does-not-exist"];
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(/not in findings/);
  });

  it("validates metaFindings per-item + rejects bad category", () => {
    const v = baseVerdict({ hasSource: false });
    v.metaFindings = [{ id: "m1", category: "rubric_unverifiable", claim: "x" }];
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).not.toThrow();
    const v2 = baseVerdict({ hasSource: false });
    v2.metaFindings = [{ id: "m1", category: "bogus_category" as never, claim: "x" }];
    expect(() => validateVerdict(v2, { hasSourceArtifacts: false })).toThrow(/bad category/);
  });
});

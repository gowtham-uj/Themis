/** Phase-2 PI filings are schema-checked before append-only persistence. */
import { describe, expect, it } from "vitest";

import { validatePhase2Template } from "../src/judge/tools/themis-tools-extension.ts";

const hypothesis = {
  id: "h1", patternId: "p1", claim: "example-only probing",
  supportingObservations: ["trace:r1"], contradictingObservations: [],
  likelyMechanism: ["examples resemble known cases"], confidence: "high",
};

const recommendation = {
  id: "r1", patternIds: ["p1"], class: "research_backed", priority: "P1",
  targetCapability: "verification", observedBehavior: "missed a round-trip defect",
  likelyMechanism: "example-only probing", implementationRequirements: "run property tests",
  implementationHandoff: {
    targetCapability: "verification", observedInterface: "trace",
    likelyInternalAreas: "runbook", requiredBehavior: "run property tests",
    themisKnowsExactSourceLocation: false,
  },
  risks: "tool cost", researchBasis: ["web:https://example.org/property-testing"],
  confidence: "high", evidenceLevel: "research-backed",
  experimentPlan: {
    id: "e1", claimToTest: "properties catch the defect", control: "current",
    treatment: "property step", constants: "same task", targetTasks: "r1",
    regressionTasks: "clean", primaryMetric: { name: "catch_rate", minimumWorthwhileEffect: "one" },
    secondaryMetrics: "tool_calls", regressionLimits: "no pass-rate drop",
    suggestedSample: { tasks: 1, seedsPerTask: 1 }, successConditions: "defect caught",
  },
};

describe("Phase-2 template validation", () => {
  it("rejects the nested fields envelope that produced a stale empty pack", () => {
    expect(validatePhase2Template("phase2-recommendations", { fields: { recommendations: [recommendation] } }))
      .toContain("do not nest another fields key");
  });

  it("rejects scratch probes instead of committing them as authoritative documents", () => {
    expect(validatePhase2Template("phase2-hypotheses", { note: "test" })).toBe("hypotheses must be a list");
    expect(validatePhase2Template("phase2-recommendations", { fields: false })).toContain("do not nest");
  });

  it("enforces typed hypothesis and research records", () => {
    expect(validatePhase2Template("phase2-hypotheses", { hypotheses: [hypothesis] })).toBeNull();
    expect(validatePhase2Template("phase2-hypotheses", { hypotheses: [{ ...hypothesis, likelyMechanism: "one string" }] }))
      .toContain("likelyMechanism must be a list");
    expect(validatePhase2Template("phase2-research", {
      notes: [{ hypothesisId: "h1", techniques: [], applicable: "yes", notes: "n" }],
    })).toContain("applicable must be true|false");
  });

  it("normalizes common designer drift into the canonical recommendation contract", () => {
    const fields: Record<string, unknown> = { recommendations: [structuredClone(recommendation)] };
    expect(validatePhase2Template("phase2-recommendations", fields)).toBeNull();
    const [r] = fields.recommendations as Array<Record<string, unknown>>;
    expect(r.researchBasis).toEqual([{ url: "https://example.org/property-testing", claim: "" }]);
    expect(r.implementationRequirements).toEqual(["run property tests"]);
    expect((r.implementationHandoff as Record<string, unknown>).requiredBehavior).toEqual(["run property tests"]);
    expect((r.experimentPlan as Record<string, unknown>).regressionLimits).toEqual({ policy: "no pass-rate drop" });
  });

  it("requires the reviewer shape used by pack filtering", () => {
    expect(validatePhase2Template("phase2-review", { keptIds: ["r1"], dropped: [], notes: "keep" })).toBeNull();
    expect(validatePhase2Template("phase2-review", { verdict: "accept" })).toBe("keptIds must be a list");
  });
});

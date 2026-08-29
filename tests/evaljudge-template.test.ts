/**
 * evalJudge template validation + canonical serialization (the real tool code,
 * not a re-implementation). A malformed ruling is a REJECTED call with a reason;
 * a valid one round-trips through the yaml package.
 */
import { describe, expect, it } from "vitest";

import {
  serializeYaml,
  validateEvalJudge,
} from "../src/judge/tools/themis-tools-extension.ts";
import { parseAllDocuments } from "yaml";

function valid(): Record<string, unknown> {
  return {
    final_report: true,
    eval_id: "e1",
    agent_under_evaluation: "reapercode",
    rounds_run: 2,
    official_reward: 1,
    verdict: {
      approach: "principled",
      integrity: "clean",
      competence: 4,
      reconciliation: "consistent",
    },
    narrative: "What the agent did.",
    what_the_agent_did_well: [{ observation: "correct fix", ref: "file:breaker.py#L1-L5" }],
    improvements: [
      {
        issue: "test oracle weak",
        evidence: [{ report: "report:logos#round1", ref: "diff:breaker.py#1" }],
        recommendation: "add discriminating tests",
        category: "process",
        impact: "medium",
        confidence: "high",
      },
    ],
    integrity_summary: {
      verdict: "clean",
      findings: [{ finding: "no tampering", ref: "file:session/session.jsonl#L1-L5", round: 1 }],
    },
    reward_reconciliation: "Reward follows from process.",
    case_coverage: {
      tangents_total: 3,
      tangents_resolved: 3,
      tangents_open: 0,
      closed_by: "no_new_tangents",
      converged: true,
    },
    open_questions: [],
    revision_history: [],
    confidence_in_this_report: "high",
    confidence_basis: "Full record available.",
  };
}

describe("evalJudge template validation", () => {
  it("accepts a complete, well-formed ruling", () => {
    expect(validateEvalJudge(valid())).toBeNull();
  });

  it("rejects every missing required key with a reason", () => {
    for (const key of [
      "final_report",
      "eval_id",
      "agent_under_evaluation",
      "rounds_run",
      "official_reward",
      "narrative",
      "improvements",
      "confidence_in_this_report",
    ]) {
      const f = valid();
      delete f[key as keyof typeof f];
      const reason = validateEvalJudge(f);
      expect(reason).toContain(key);
    }
  });

  it("rejects a bad verdict enum", () => {
    const f = valid();
    (f.verdict as Record<string, unknown>).approach = "brilliant";
    expect(validateEvalJudge(f)).toContain("approach must be one of");
  });

  it("rejects out-of-range competence", () => {
    const f = valid();
    (f.verdict as Record<string, unknown>).competence = 7;
    expect(validateEvalJudge(f)).toContain("competence must be an integer 1..5");
  });

  it("rejects final_report != true", () => {
    const f = valid();
    f.final_report = "yes";
    expect(validateEvalJudge(f)).toContain("final_report must be the literal true");
  });

  it("serializes nested structures as a parseable multi-doc stream", () => {
    const yaml = serializeYaml(valid()) + "---\n";
    const docs = parseAllDocuments(yaml);
    expect(docs.length).toBeGreaterThanOrEqual(1);
    const first = docs[0]!.toJS() as Record<string, unknown>;
    expect(first.final_report).toBe(true);
    expect((first.verdict as Record<string, unknown>).approach).toBe("principled");
    expect(Array.isArray(first.improvements)).toBe(true);
    // Nested improvement fields survive the round trip.
    const imp = (first.improvements as Array<Record<string, unknown>>)[0]!;
    expect(imp.issue).toBe("test oracle weak");
    expect(imp.category).toBe("process");
  });
});

describe("evalJudge enum enforcement (observed violations)", () => {
  it("rejects a non-enum improvement category", () => {
    const f = valid();
    (f.improvements as Array<Record<string, unknown>>)[0]!.category = "verification process";
    expect(validateEvalJudge(f)).toContain("category must be one of");
  });

  it("rejects a string round in integrity_summary.findings", () => {
    const f = valid();
    (f.integrity_summary as Record<string, unknown>).findings = [{ finding: "x", ref: null, round: "R1" }];
    expect(validateEvalJudge(f)).toContain("round must be an integer");
  });
});

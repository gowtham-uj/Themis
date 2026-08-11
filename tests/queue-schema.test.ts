import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseQueueSubmission,
  validateQueueSubmission,
  type QueueSubmission,
} from "../src/judge/queue-schema.ts";
import type { Verdict } from "../src/judge/verdict.ts";

const verdict = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/verdict-sample.json"), "utf8"),
) as Verdict;

function submission(): QueueSubmission {
  return {
    perEval: [{
      runId: "run-sample-001",
      verdict: structuredClone(verdict),
      narrative: {
        schemaVersion: 1,
        headline: "Partial auth fix with an unverified success claim",
        judgement: "The primary change helped, but a critical branch and verification remain incomplete.",
        executionAnalysis: [{
          stage: "implementation",
          judgement: "The agent changed the target boundary after reading the file.",
          refs: [{ kind: "trace", runId: "run-sample-001", seqs: [12, 48] }],
        }],
        strengths: [{
          text: "The target file was read before editing.",
          refs: [{ kind: "tool", toolCallId: "call_read_auth_1" }],
        }],
        concerns: [{
          severity: "major",
          text: "The suite was not run before success was claimed.",
          refs: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
          implication: "The result is not fully verified.",
          ownerClass: "agent",
          findingIds: ["verification_skipped:no-suite-run"],
        }],
        evidenceBoundaries: [{
          status: "observed",
          text: "No test command appears in the canonical trace.",
          refs: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
        }],
        handoff: {
          preserve: [{
            text: "Keep the read-before-edit behavior.",
            refs: [{ kind: "tool", toolCallId: "call_read_auth_1" }],
            ownerClass: "agent",
          }],
          change: [{
            text: "Run the suite before reporting completion.",
            refs: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
            ownerClass: "agent",
          }],
          investigate: [],
        },
      },
    }],
    queueAnalysis: {
      schemaVersion: 2,
      summary: "One run was partially successful but unverified.",
      themes: [{
        text: "Verification discipline is the dominant gap.",
        refs: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
      }],
      reliability: {
        assessment: "Insufficient evidence for repeat reliability.",
        evidence: [{ kind: "trace", runId: "run-sample-001", seqs: [0, 95] }],
      },
      rankedDefects: [{
        id: "defect-verification",
        type: "observed",
        rank: 1,
        title: "Verification skipped",
        category: "verification_integrity",
        severity: "major",
        runIds: ["run-sample-001"],
        description: "The final claim has no supporting test execution.",
        evidence: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
        verification: ["Run the suite and retain the passing tool result."],
      }],
      subsystemAttribution: [{
        subsystem: "agent-process",
        runIds: ["run-sample-001"],
        explanation: "The agent stopped before verification.",
        evidence: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
      }],
      regressions: [],
      improvementPlan: [{
        id: "step-verification",
        rank: 1,
        class: "agent",
        priority: 0,
        confidence: 0.95,
        defectIds: ["defect-verification"],
        subsystem: "agent-process",
        problem: "Success can be reported without a final test run.",
        evidence: [{ kind: "trace", runId: "run-sample-001", seqs: [90, 95] }],
        target: { kind: "prompt", paths: ["agent completion policy"] },
        change: "Require a passing verification after the final mutation.",
        acceptanceCriteria: ["A success claim follows a passing test result."],
        tests: [{ name: "verification gate", kind: "e2e", expected: "unverified completion is rejected" }],
        verifyTaskIds: ["task-auth"],
        regressionTaskIds: ["task-auth-green"],
        dependencies: [],
        nonGoals: ["Changing the task rubric"],
        preventive: false,
        status: "ready",
      }],
    },
  };
}

const context = {
  selectedRunIds: ["run-sample-001"],
  evidence: new Map([[
    "run-sample-001",
    {
      runId: "run-sample-001",
      hasSourceArtifacts: true,
      maxTraceSeq: 100,
      toolCallIds: ["call_read_auth_1"],
      diffHunks: [{ file: "src/auth.ts", hunk: 2 }],
      artifactPaths: ["events.jsonl", "diff.patch", "diff.hunks.json"],
    },
  ]]),
};

describe("queue analysis v2 validation", () => {
  it("accepts a complete cross-linked payload", () => {
    expect(validateQueueSubmission(submission(), context)).toEqual([]);
  });

  it("returns path-specific narrative and defect-link errors", () => {
    const value = submission();
    value.perEval[0]!.narrative.strengths[0]!.refs = [];
    value.queueAnalysis.improvementPlan[0]!.defectIds = ["missing-defect"];
    expect(validateQueueSubmission(value, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "per_eval[0].narrative.strengths[0].refs" }),
      expect.objectContaining({ path: "queue_analysis.improvementPlan[0].defectIds" }),
    ]));
  });

  it("rejects a nit-only step that outranks integrity work", () => {
    const value = submission();
    value.queueAnalysis.rankedDefects.push({
      id: "defect-nit",
      type: "observed",
      rank: 2,
      title: "Minor wording",
      category: "style",
      severity: "nit",
      runIds: ["run-sample-001"],
      description: "A cosmetic wording issue.",
      evidence: [{ kind: "trace", runId: "run-sample-001", seqs: [80, 80] }],
      verification: ["Read the updated wording."],
    });
    value.queueAnalysis.improvementPlan[0]!.rank = 2;
    value.queueAnalysis.improvementPlan.push({
      ...structuredClone(value.queueAnalysis.improvementPlan[0]!),
      id: "step-nit",
      rank: 1,
      priority: 0,
      defectIds: ["defect-nit"],
      problem: "Cosmetic wording can improve.",
    });
    expect(validateQueueSubmission(value, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("cannot outrank") }),
    ]));
  });

  it("normalizes snake-case tool payload keys", () => {
    const value = submission();
    const parsed = parseQueueSubmission({
      per_eval: value.perEval.map((entry) => ({
        run_id: entry.runId,
        verdict: entry.verdict,
        narrative: {
          ...entry.narrative,
          schema_version: 1,
          execution_analysis: entry.narrative.executionAnalysis,
          evidence_boundaries: entry.narrative.evidenceBoundaries,
        },
      })),
      queue_analysis: {
        ...value.queueAnalysis,
        schema_version: 2,
        ranked_defects: value.queueAnalysis.rankedDefects,
        subsystem_attribution: value.queueAnalysis.subsystemAttribution,
        improvement_plan: value.queueAnalysis.improvementPlan,
      },
    });
    expect(parsed.perEval[0]!.runId).toBe("run-sample-001");
    expect(parsed.queueAnalysis.schemaVersion).toBe(2);
  });
});

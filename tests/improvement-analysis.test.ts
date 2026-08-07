/**
 * What makes a report useful to the agent that consumes it.
 *
 * A findings list says what is wrong. An improving agent needs three more
 * things, and each is tested here as a property rather than a format:
 *
 *  - WHERE to fix it (subsystem) — routing a tool-schema bug to "prompt"
 *    collects patches that cannot possibly work;
 *  - WHETHER it is reproducible (pass rate) — flaky and always-failing need
 *    completely different remediation;
 *  - WHAT to do first (impact) — severity ranks symptoms, impact ranks fixes;
 *  - HOW to know it worked (verification) — otherwise the loop never closes.
 */

import { describe, expect, it } from "vitest";
import {
  buildImprovementPlan,
  computeReliability,
  rankDefectsByImpact,
  rollupBySubsystem,
  type AttemptRecord,
} from "../src/judge/improvement-analysis.ts";
import {
  diffTrajectories,
  stepSignature,
  toTraceSteps,
} from "../src/judge/trajectory-diff.ts";
import {
  SUBSYSTEMS,
  validateVerdict,
  VerdictValidationError,
  type Verdict,
} from "../src/judge/verdict.ts";

// ---------------------------------------------------------------------------
// reliability
// ---------------------------------------------------------------------------

function attempt(taskId: string, score: number | null, i = 0): AttemptRecord {
  return { taskId, evalName: `eval ${taskId}`, runId: `${taskId}-${i}`, score };
}

describe("computeReliability", () => {
  it("distinguishes a flaky eval from one that always fails", () => {
    // The whole point: 3/5 is a reliability problem, 0/5 is a capability
    // problem, and a report showing only "failed" conflates them.
    const out = computeReliability([
      attempt("flaky", 0.9, 0),
      attempt("flaky", 0.2, 1),
      attempt("flaky", 0.95, 2),
      attempt("broken", 0.1, 0),
      attempt("broken", 0.15, 1),
      attempt("solid", 0.9, 0),
      attempt("solid", 0.92, 1),
    ]);
    const byTask = new Map(out.map((r) => [r.taskId, r]));
    expect(byTask.get("flaky")!.verdict).toBe("flaky");
    expect(byTask.get("broken")!.verdict).toBe("reliable_fail");
    expect(byTask.get("solid")!.verdict).toBe("reliable_pass");
  });

  it("reports the score range, so instability is visible", () => {
    const out = computeReliability([
      attempt("t", 0.2, 0),
      attempt("t", 0.95, 1),
    ]);
    expect(out[0]!.scoreRange).toEqual([0.2, 0.95]);
  });

  it("counts an unjudged attempt as a non-pass", () => {
    // A crashed run is a real outcome; dropping it would flatter the rate.
    const out = computeReliability([attempt("t", 0.9, 0), attempt("t", null, 1)]);
    expect(out[0]!.attempts).toBe(2);
    expect(out[0]!.passes).toBe(1);
    expect(out[0]!.passRate).toBe(0.5);
  });

  it("says nothing about consistency from a single attempt", () => {
    const out = computeReliability([attempt("t", 0.9)]);
    expect(out[0]!.verdict).toBe("single_attempt");
  });

  it("sorts flaky first — the most expensive kind to chase", () => {
    const out = computeReliability([
      attempt("solid", 0.9, 0),
      attempt("solid", 0.9, 1),
      attempt("flaky", 0.9, 0),
      attempt("flaky", 0.1, 1),
    ]);
    expect(out[0]!.verdict).toBe("flaky");
  });
});

// ---------------------------------------------------------------------------
// impact ranking
// ---------------------------------------------------------------------------

describe("rankDefectsByImpact", () => {
  it("ranks a wide nit above a narrow major when it unblocks more", () => {
    // Severity describes a symptom; an improving agent is asking what one
    // change buys the most.
    const ranked = rankDefectsByImpact({
      defects: [
        {
          fingerprint: "narrow",
          category: "c",
          claim: "narrow but severe",
          severity: "major",
          taskIds: ["t1"],
        },
        {
          fingerprint: "wide",
          category: "c",
          claim: "small but everywhere",
          severity: "nit",
          taskIds: ["t1", "t2", "t3", "t4", "t5"],
        },
      ],
      scoresByTask: new Map([
        ["t1", 0.1],
        ["t2", 0.1],
        ["t3", 0.1],
        ["t4", 0.1],
        ["t5", 0.1],
      ]),
    });
    expect(ranked[0]!.fingerprint).toBe("wide");
    expect(ranked[0]!.evalsBlocked).toBe(5);
  });

  it("does not count evals that already pass as blocked", () => {
    // Fixing a defect that appears in a passing eval unblocks nothing.
    const ranked = rankDefectsByImpact({
      defects: [
        {
          fingerprint: "d",
          category: "c",
          claim: "x",
          severity: "major",
          taskIds: ["passing", "failing"],
        },
      ],
      scoresByTask: new Map([
        ["passing", 0.95],
        ["failing", 0.2],
      ]),
    });
    expect(ranked[0]!.evalsBlocked).toBe(1);
  });

  it("boosts chronic defects — repeated fixes have not worked", () => {
    const base = {
      category: "c",
      claim: "x",
      severity: "major" as const,
      taskIds: ["t1"],
    };
    const ranked = rankDefectsByImpact({
      defects: [
        { ...base, fingerprint: "fresh" },
        {
          ...base,
          fingerprint: "chronic",
          persistence: { evaluationCount: 4, chronic: true },
        },
      ],
      scoresByTask: new Map([["t1", 0.1]]),
    });
    expect(ranked[0]!.fingerprint).toBe("chronic");
  });

  it("estimates the score gain from fixing each defect", () => {
    const ranked = rankDefectsByImpact({
      defects: [
        {
          fingerprint: "d",
          category: "c",
          claim: "x",
          severity: "major",
          taskIds: ["t1", "t2"],
        },
      ],
      scoresByTask: new Map([
        ["t1", 0.2],
        ["t2", 0.2],
      ]),
    });
    // Two evals at 0.2 reaching 0.7 = +1.0 total over 2 evals = +0.5 mean.
    expect(ranked[0]!.estimatedScoreGain).toBeCloseTo(0.5, 2);
  });
});

describe("rollupBySubsystem", () => {
  it("shows where the work is concentrated", () => {
    const ranked = rankDefectsByImpact({
      defects: [
        {
          fingerprint: "a",
          category: "c",
          claim: "prompt gap 1",
          severity: "major",
          subsystem: "prompt",
          taskIds: ["t1"],
        },
        {
          fingerprint: "b",
          category: "c",
          claim: "prompt gap 2",
          severity: "major",
          subsystem: "prompt",
          taskIds: ["t2"],
        },
        {
          fingerprint: "c",
          category: "c",
          claim: "model limit",
          severity: "minor",
          subsystem: "model_capability",
          taskIds: ["t3"],
        },
      ],
      scoresByTask: new Map([
        ["t1", 0.1],
        ["t2", 0.1],
        ["t3", 0.1],
      ]),
    });
    const load = rollupBySubsystem(ranked);
    const prompt = load.find((l) => l.subsystem === "prompt")!;
    expect(prompt.defectCount).toBe(2);
    expect(prompt.evalsAffected).toBe(2);
  });

  it("groups un-routed defects under null rather than labelling them", () => {
    // "unattributed" reads as a routing decision the judge never made. Null is
    // the honest representation of "it declined to route this".
    const ranked = rankDefectsByImpact({
      defects: [
        { fingerprint: "a", category: "c", claim: "x", severity: "major", taskIds: ["t1"] },
      ],
      scoresByTask: new Map([["t1", 0.1]]),
    });
    expect(rollupBySubsystem(ranked)[0]!.subsystem).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

describe("buildImprovementPlan", () => {
  it("emits ordered steps, each with what to re-run to prove the fix", () => {
    const ranked = rankDefectsByImpact({
      defects: [
        {
          fingerprint: "d",
          category: "verification_skipped",
          claim: "claims success without re-running tests",
          severity: "major",
          subsystem: "prompt",
          taskIds: ["t1", "t2"],
        },
      ],
      scoresByTask: new Map([
        ["t1", 0.2],
        ["t2", 0.2],
        ["t3", 0.9],
      ]),
    });
    const plan = buildImprovementPlan(ranked, {
      passingTaskIds: ["t3"],
      fixDirections: new Map([["d", "run the suite after the final edit"]]),
    });
    expect(plan[0]!.rank).toBe(1);
    expect(plan[0]!.subsystem).toBe("prompt");
    expect(plan[0]!.change).toBe("run the suite after the final edit");
    expect(plan[0]!.verifyTaskIds).toEqual(["t1", "t2"]);
    // The guard set is what must keep passing — excluding what is being fixed.
    expect(plan[0]!.regressionTaskIds).toEqual(["t3"]);
  });

  it("leaves `change` null when the judge gave no fix direction", () => {
    // Restating the defect in the imperative would LOOK like advice and
    // contain none — a consuming agent cannot tell it apart from real
    // analysis. The defect is reported separately, verbatim.
    const ranked = rankDefectsByImpact({
      defects: [
        { fingerprint: "d", category: "c", claim: "the thing is broken", severity: "major", taskIds: ["t1"] },
      ],
      scoresByTask: new Map([["t1", 0.1]]),
    });
    const plan = buildImprovementPlan(ranked, { passingTaskIds: [] });
    expect(plan[0]!.change).toBeNull();
    expect(plan[0]!.defect).toBe("the thing is broken");
  });

  it("tells a consuming agent to change approach on a chronic defect", () => {
    const ranked = rankDefectsByImpact({
      defects: [
        {
          fingerprint: "d",
          category: "c",
          claim: "x",
          severity: "major",
          taskIds: ["t1"],
          persistence: { evaluationCount: 3, chronic: true },
        },
      ],
      scoresByTask: new Map([["t1", 0.1]]),
    });
    const plan = buildImprovementPlan(ranked, { passingTaskIds: [] });
    expect(plan[0]!.chronic).toBe(true);
    // The rationale reports the COUNT the platform computed. "Change approach"
    // is a recommendation, and recommendations come from the judge.
    expect(plan[0]!.rationale).toMatch(/3 evaluations/);
  });
});

// ---------------------------------------------------------------------------
// contrastive trajectory diff
// ---------------------------------------------------------------------------

function steps(...sig: Array<[string, string?]>): unknown[] {
  return sig.map(([type, name], i) => ({
    seq: i + 1,
    type,
    ...(name ? { name } : {}),
  }));
}

describe("diffTrajectories", () => {
  it("locates where two runs of the same eval parted company", () => {
    const baseline = toTraceSteps(
      steps(
        ["run.start"],
        ["tool.call", "read_file"],
        ["tool.call", "run_tests"],
        ["tool.call", "edit_file"],
        ["tool.call", "run_tests"],
        ["run.end"],
      ),
    );
    const candidate = toTraceSteps(
      steps(
        ["run.start"],
        ["tool.call", "read_file"],
        ["tool.call", "run_tests"],
        ["tool.call", "edit_file"],
        ["message"],
        ["run.end"],
      ),
    );
    const d = diffTrajectories(baseline, candidate);
    expect(d.commonPrefixLength).toBe(4);
    expect(d.baselineAction).toContain("run_tests");
    // The divergence point is the explanation: it stopped verifying.
    expect(d.toolsOnlyInBaseline).toEqual([]);
    expect(d.summary).toContain("matched for 4");
  });

  it("ignores streaming granularity, which is not a behavioural difference", () => {
    // One run streaming text in three chunks and another in five is the same
    // behaviour; comparing raw events would report a divergence at step 1.
    const a = toTraceSteps([
      { seq: 1, type: "message", mode: "delta" },
      { seq: 2, type: "message", mode: "delta" },
      { seq: 3, type: "run.end" },
    ]);
    const b = toTraceSteps([
      { seq: 1, type: "message", mode: "delta" },
      { seq: 2, type: "run.end" },
    ]);
    expect(diffTrajectories(a, b).commonPrefixLength).toBe(1);
  });

  it("reports tools one run used and the other never did", () => {
    const baseline = toTraceSteps(steps(["tool.call", "run_tests"]));
    const candidate = toTraceSteps(steps(["tool.call", "grep"]));
    const d = diffTrajectories(baseline, candidate);
    expect(d.toolsOnlyInBaseline).toEqual(["run_tests"]);
    expect(d.toolsOnlyInCandidate).toEqual(["grep"]);
  });

  it("notes when one run stopped early", () => {
    const baseline = toTraceSteps(
      steps(["tool.call", "read_file"], ["tool.call", "run_tests"]),
    );
    const candidate = toTraceSteps(steps(["tool.call", "read_file"]));
    expect(diffTrajectories(baseline, candidate).summary).toMatch(
      /stopped 1 step/,
    );
  });

  it("compares action shape, not arguments", () => {
    // Two runs of the same eval never have identical args or ids.
    expect(
      stepSignature({ seq: 1, type: "tool.call", name: "edit_file" }),
    ).toBe("tool:edit_file");
    expect(
      stepSignature({ seq: 9, type: "tool.call", name: "edit_file" }),
    ).toBe("tool:edit_file");
  });
});

// ---------------------------------------------------------------------------
// schema enforcement of the new fields
// ---------------------------------------------------------------------------

function verdictWith(patch: Record<string, unknown>): Verdict {
  return {
    schemaVersion: 1,
    overall: { score: 0.5, verdict: "partial", summary: "s" },
    criteria: [
      {
        criterion: "C1",
        weight: 1,
        score: 0.5,
        feedback: "f",
        evidence: ["e"],
        findingIds: ["f1"],
      },
    ],
    findings: [
      {
        id: "f1",
        category: "verification_skipped",
        severity: "major",
        confidence: 0.9,
        claim: "claimed success without verifying",
        refs: [{ kind: "trace", runId: "r1", seqs: [5, 15] }],
        ...patch,
      },
    ],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: {},
    attribution: { agent_vs_environment: "agent" },
    observations: [],
    improvements: { summary: "s", withoutSource: [] },
  } as unknown as Verdict;
}

describe("finding schema: routing, decision point, verification", () => {
  it("accepts a fully-specified actionable finding", () => {
    const v = verdictWith({
      subsystem: "prompt",
      decisionPoint: {
        seq: 15,
        whatHappened: "emitted 'all tests pass' with no run since seq 5",
        counterfactual: "run the suite between the final edit and the claim",
        evidenceAvailableAtSeq: 5,
      },
      verification: {
        targetTaskIds: ["task-a"],
        regressionTaskIds: ["task-b"],
        successCriterion: "task-a passes and task-b still passes",
      },
    });
    expect(() =>
      validateVerdict(v, { hasSourceArtifacts: false }),
    ).not.toThrow();
  });

  it("rejects an unknown subsystem", () => {
    expect(() =>
      validateVerdict(verdictWith({ subsystem: "vibes" }), {
        hasSourceArtifacts: false,
      }),
    ).toThrow(/subsystem must be one of/);
  });

  it("accepts every documented subsystem", () => {
    for (const s of SUBSYSTEMS) {
      expect(() =>
        validateVerdict(verdictWith({ subsystem: s }), {
          hasSourceArtifacts: false,
        }),
      ).not.toThrow();
    }
  });

  it("rejects a decision point with no counterfactual", () => {
    // Without one it is a timestamped complaint, not something to act on.
    expect(() =>
      validateVerdict(
        verdictWith({
          decisionPoint: { seq: 15, whatHappened: "claimed success" },
        }),
        { hasSourceArtifacts: false },
      ),
    ).toThrow(/counterfactual/);
  });

  it("rejects evidence that became available AFTER the decision", () => {
    // Evidence arriving later explains nothing about the decision.
    expect(() =>
      validateVerdict(
        verdictWith({
          decisionPoint: {
            seq: 5,
            whatHappened: "x",
            counterfactual: "y",
            evidenceAvailableAtSeq: 12,
          },
        }),
        { hasSourceArtifacts: false },
      ),
    ).toThrow(/after the decision/);
  });

  it("rejects a verification set with no targets", () => {
    expect(() =>
      validateVerdict(verdictWith({ verification: { targetTaskIds: [] } }), {
        hasSourceArtifacts: false,
      }),
    ).toThrow(/non-empty/);
  });

  it("leaves all three optional", () => {
    // A judge that cannot determine routing must omit it rather than guess —
    // a wrong route is worse than none.
    expect(() =>
      validateVerdict(verdictWith({}), { hasSourceArtifacts: false }),
    ).not.toThrow();
  });

  it("throws VerdictValidationError, not a bare Error", () => {
    expect(() =>
      validateVerdict(verdictWith({ subsystem: "nope" }), {
        hasSourceArtifacts: false,
      }),
    ).toThrow(VerdictValidationError);
  });
});

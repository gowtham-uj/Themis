/**
 * Pure regression-compute tests (P7a). No DB, no clock, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  batchStats,
  compareTwoRuns,
  isLikelyRegression,
  releaseCompare,
  scoreTrend,
  type CriterionScore,
  type FindingInstance,
  type JudgementPoint,
  type RunCompareSide,
  type TaskReleaseResult,
} from "../src/regression/compute.ts";

function jp(
  partial: Partial<JudgementPoint> & Pick<JudgementPoint, "judgementId" | "runId">,
): JudgementPoint {
  return {
    createdAt: "2026-01-01T00:00:00Z",
    overallScore: 0.5,
    verdict: "partial",
    ...partial,
  };
}

function fi(
  partial: Partial<FindingInstance> &
    Pick<FindingInstance, "fingerprint" | "runId" | "judgementId">,
): FindingInstance {
  return {
    category: "verification_skipped",
    kind: "defect",
    severity: "major",
    claim: "skipped verification",
    refs: [{ kind: "tool", toolCallId: "t1" }],
    occurrenceStatus: "introduced",
    ...partial,
  };
}

function side(
  partial: Partial<RunCompareSide> & { judgement: JudgementPoint },
): RunCompareSide {
  return {
    criteriaScores: [],
    findings: [],
    diagnostics: {},
    ...partial,
  };
}

describe("batchStats", () => {
  it("known inputs → known mean + population spread", () => {
    // scores [0, 1]: mean 0.5, pop variance = ((0-0.5)^2+(1-0.5)^2)/2 = 0.25, stdev 0.5
    const s = batchStats([0, 1]);
    expect(s.n).toBe(2);
    expect(s.mean).toBe(0.5);
    expect(s.spread).toBeCloseTo(0.5, 10);
    expect(s.min).toBe(0);
    expect(s.max).toBe(1);
  });

  it("n=1 → spread 0", () => {
    const s = batchStats([0.8]);
    expect(s).toEqual({ n: 1, mean: 0.8, spread: 0, min: 0.8, max: 0.8 });
  });

  it("empty → zeros (NaN-free)", () => {
    expect(batchStats([])).toEqual({
      n: 0,
      mean: 0,
      spread: 0,
      min: 0,
      max: 0,
    });
  });

  it("clamps out-of-range scores to [0,1]", () => {
    const s = batchStats([-0.5, 1.5, 0.5]);
    // clamped: 0, 1, 0.5 → mean 0.5
    expect(s.mean).toBeCloseTo(0.5, 10);
    expect(s.min).toBe(0);
    expect(s.max).toBe(1);
    // pop var of [0,1,0.5]: mean 0.5; sqdevs 0.25+0.25+0 = 0.5; /3 → 1/6; sqrt ≈ 0.4082
    expect(s.spread).toBeCloseTo(Math.sqrt(1 / 6), 10);
  });

  it("three equal scores → spread 0", () => {
    // 0.5 is exactly representable; avoids float residual on (s-mean)^2.
    const s = batchStats([0.5, 0.5, 0.5]);
    expect(s.mean).toBe(0.5);
    expect(s.spread).toBe(0);
  });
});

describe("scoreTrend", () => {
  it("first point introduced = all findings; resolved empty", () => {
    const f1 = fi({ fingerprint: "fp1", runId: "r1", judgementId: "j1" });
    const f2 = fi({
      fingerprint: "fp2",
      runId: "r1",
      judgementId: "j1",
      category: "test_gaming",
    });
    const trend = scoreTrend([
      {
        taskRunOrder: 1,
        judgement: jp({ judgementId: "j1", runId: "r1", overallScore: 0.6 }),
        findings: [f1, f2],
      },
    ]);
    expect(trend).toHaveLength(1);
    expect(trend[0]!.findingDeltas.introduced.map((f) => f.fingerprint).sort()).toEqual([
      "fp1",
      "fp2",
    ]);
    expect(trend[0]!.findingDeltas.resolved).toEqual([]);
    expect(trend[0]!.overallScore).toBe(0.6);
  });

  it("findingDeltas: introduced at point2 = new fp; resolved = prior fp absent", () => {
    const p1f1 = fi({ fingerprint: "fp1", runId: "r1", judgementId: "j1" });
    const p1f2 = fi({
      fingerprint: "fp2",
      runId: "r1",
      judgementId: "j1",
      category: "test_gaming",
    });
    const p2f1 = fi({ fingerprint: "fp1", runId: "r2", judgementId: "j2" });
    const p2f3 = fi({
      fingerprint: "fp3",
      runId: "r2",
      judgementId: "j2",
      category: "hallucinated_claim",
    });
    // intentionally unsorted input order
    const trend = scoreTrend([
      {
        taskRunOrder: 2,
        judgement: jp({ judgementId: "j2", runId: "r2", overallScore: 0.4 }),
        findings: [p2f1, p2f3],
      },
      {
        taskRunOrder: 1,
        judgement: jp({ judgementId: "j1", runId: "r1", overallScore: 0.7 }),
        findings: [p1f1, p1f2],
      },
    ]);
    expect(trend.map((t) => t.order)).toEqual([1, 2]);
    expect(trend[1]!.findingDeltas.introduced.map((f) => f.fingerprint)).toEqual([
      "fp3",
    ]);
    expect(trend[1]!.findingDeltas.resolved.map((f) => f.fingerprint)).toEqual([
      "fp2",
    ]);
    expect(trend[1]!.runId).toBe("r2");
    expect(trend[1]!.judgementId).toBe("j2");
  });

  it("null overallScore passes through (not treated as 0)", () => {
    const trend = scoreTrend([
      {
        taskRunOrder: 0,
        judgement: jp({
          judgementId: "j0",
          runId: "r0",
          overallScore: null,
          verdict: null,
        }),
        findings: [],
      },
    ]);
    expect(trend[0]!.overallScore).toBeNull();
    expect(trend[0]!.verdict).toBeNull();
  });
});

describe("compareTwoRuns", () => {
  const criteriaA: CriterionScore[] = [
    { criterion: "A1", axis: "A", weight: 1, score: 0.8 },
    { criterion: "D2", axis: "D", weight: 1, score: 0.6 },
  ];
  const criteriaB: CriterionScore[] = [
    { criterion: "A1", axis: "A", weight: 1, score: 0.5 },
    { criterion: "D2", axis: "D", weight: 1, score: 0.9 },
  ];

  it("deltaOverall = B − A (sign correct); null when either null", () => {
    const a = side({
      judgement: jp({ judgementId: "ja", runId: "ra", overallScore: 0.8 }),
      criteriaScores: criteriaA,
    });
    const b = side({
      judgement: jp({ judgementId: "jb", runId: "rb", overallScore: 0.5 }),
      criteriaScores: criteriaB,
    });
    const c = compareTwoRuns(a, b);
    expect(c.deltaOverall).toBeCloseTo(-0.3, 10); // B worse → regression

    const nullA = side({
      judgement: jp({ judgementId: "ja", runId: "ra", overallScore: null }),
    });
    expect(compareTwoRuns(nullA, b).deltaOverall).toBeNull();
  });

  it("perCriterion deltas are B − A", () => {
    const a = side({
      judgement: jp({ judgementId: "ja", runId: "ra", overallScore: 0.7 }),
      criteriaScores: criteriaA,
    });
    const b = side({
      judgement: jp({ judgementId: "jb", runId: "rb", overallScore: 0.7 }),
      criteriaScores: criteriaB,
    });
    const c = compareTwoRuns(a, b);
    const byCrit = Object.fromEntries(c.perCriterion.map((p) => [p.criterion, p]));
    expect(byCrit["A1"]!.delta).toBeCloseTo(-0.3, 10);
    expect(byCrit["A1"]!.aScore).toBe(0.8);
    expect(byCrit["A1"]!.bScore).toBe(0.5);
    expect(byCrit["A1"]!.axis).toBe("A");
    expect(byCrit["D2"]!.delta).toBeCloseTo(0.3, 10);
  });

  it("findingSetDiff introduced/resolved/persisted by fingerprint", () => {
    const a = side({
      judgement: jp({ judgementId: "ja", runId: "ra", overallScore: 0.5 }),
      findings: [
        fi({ fingerprint: "fp-same", runId: "ra", judgementId: "ja" }),
        fi({
          fingerprint: "fp-gone",
          runId: "ra",
          judgementId: "ja",
          category: "test_gaming",
        }),
      ],
    });
    const b = side({
      judgement: jp({ judgementId: "jb", runId: "rb", overallScore: 0.5 }),
      findings: [
        fi({ fingerprint: "fp-same", runId: "rb", judgementId: "jb" }),
        fi({
          fingerprint: "fp-new",
          runId: "rb",
          judgementId: "jb",
          category: "hallucinated_claim",
        }),
      ],
    });
    const c = compareTwoRuns(a, b);
    expect(c.findingSetDiff.introduced.map((f) => f.fingerprint)).toEqual(["fp-new"]);
    expect(c.findingSetDiff.resolved.map((f) => f.fingerprint)).toEqual(["fp-gone"]);
    expect(c.findingSetDiff.persisted.map((f) => f.fingerprint)).toEqual(["fp-same"]);
    // refs preserved for deep-linking
    expect(c.findingSetDiff.introduced[0]!.refs).toEqual([
      { kind: "tool", toolCallId: "t1" },
    ]);
  });

  it("diagnosticDeltas covers union of keys", () => {
    const a = side({
      judgement: jp({ judgementId: "ja", runId: "ra", overallScore: 0.5 }),
      diagnostics: {
        verification_performed: { value: true },
        test_gaming: { value: false },
      },
    });
    const b = side({
      judgement: jp({ judgementId: "jb", runId: "rb", overallScore: 0.5 }),
      diagnostics: {
        verification_performed: { value: false },
        secret_leak: { value: true },
      },
    });
    const c = compareTwoRuns(a, b);
    const byKey = Object.fromEntries(c.diagnosticDeltas.map((d) => [d.key, d]));
    expect(byKey["verification_performed"]).toEqual({
      key: "verification_performed",
      a: true,
      b: false,
    });
    expect(byKey["test_gaming"]).toEqual({ key: "test_gaming", a: false, b: false });
    expect(byKey["secret_leak"]).toEqual({ key: "secret_leak", a: false, b: true });
  });
});

describe("isLikelyRegression", () => {
  it("|delta| > spread → true; within noise → false", () => {
    expect(isLikelyRegression(-0.2, 0.1)).toBe(true);
    expect(isLikelyRegression(0.2, 0.1)).toBe(true);
    expect(isLikelyRegression(-0.05, 0.1)).toBe(false);
    expect(isLikelyRegression(0.1, 0.1)).toBe(false); // equal is not >
    expect(isLikelyRegression(0, 0)).toBe(false);
  });
});

describe("releaseCompare", () => {
  function task(
    partial: Partial<TaskReleaseResult> & Pick<TaskReleaseResult, "taskId" | "meanOverall">,
  ): TaskReleaseResult {
    return {
      spread: 0,
      n: 3,
      perAxis: [],
      findings: [],
      diagnostics: {},
      ...partial,
    };
  }

  it("suite delta only over tasks in BOTH; new/removed flagged", () => {
    const releaseA = {
      agentVersion: "v1.0.0",
      taskResults: [
        task({
          taskId: "t-shared-up",
          meanOverall: 0.4,
          perAxis: [{ axis: "A", mean: 0.4 }],
        }),
        task({
          taskId: "t-shared-down",
          meanOverall: 0.8,
          perAxis: [{ axis: "A", mean: 0.8 }],
        }),
        task({
          taskId: "t-shared-flat",
          meanOverall: 0.5,
          perAxis: [{ axis: "A", mean: 0.5 }],
        }),
        task({ taskId: "t-removed", meanOverall: 0.9 }), // only in A
      ],
    };
    const releaseB = {
      agentVersion: "v1.1.0",
      taskResults: [
        task({
          taskId: "t-shared-up",
          meanOverall: 0.7,
          perAxis: [{ axis: "A", mean: 0.7 }],
        }),
        task({
          taskId: "t-shared-down",
          meanOverall: 0.5,
          perAxis: [{ axis: "A", mean: 0.5 }],
        }),
        task({
          taskId: "t-shared-flat",
          meanOverall: 0.5,
          perAxis: [{ axis: "A", mean: 0.5 }],
        }),
        task({ taskId: "t-new", meanOverall: 0.3 }), // only in B
      ],
    };

    const r = releaseCompare(releaseA, releaseB);
    expect(r.from).toBe("v1.0.0");
    expect(r.to).toBe("v1.1.0");
    expect(r.suiteDelta.nImproved).toBe(1);
    expect(r.suiteDelta.nRegressed).toBe(1);
    expect(r.suiteDelta.nFlat).toBe(1);
    expect(r.suiteDelta.nNewTasks).toBe(1);
    expect(r.suiteDelta.nRemovedTasks).toBe(1);

    // per-task deltas for shared: +0.3, -0.3, 0 → mean 0
    expect(r.suiteDelta.deltaOverall).toBeCloseTo(0, 10);
    // pop stddev of [0.3, -0.3, 0]: mean 0; sq 0.09+0.09+0 = 0.18; /3 = 0.06; sqrt ≈ 0.2449
    expect(r.suiteDelta.spread).toBeCloseTo(Math.sqrt(0.06), 10);

    const byId = Object.fromEntries(
      r.perTaskBreakdown.map((p) => [p.taskId, p]),
    );
    expect(byId["t-shared-up"]!.presentInBoth).toBe(true);
    expect(byId["t-shared-up"]!.deltaOverall).toBeCloseTo(0.3, 10);
    expect(byId["t-new"]!.presentInBoth).toBe(false);
    expect(byId["t-removed"]!.presentInBoth).toBe(false);
  });

  it("per-axis rollups average across both-release tasks", () => {
    const releaseA = {
      agentVersion: "a",
      taskResults: [
        task({
          taskId: "t1",
          meanOverall: 0.5,
          perAxis: [
            { axis: "A", mean: 0.4 },
            { axis: "D", mean: 0.8 },
          ],
        }),
        task({
          taskId: "t2",
          meanOverall: 0.5,
          perAxis: [
            { axis: "A", mean: 0.6 },
            { axis: "D", mean: 0.6 },
          ],
        }),
      ],
    };
    const releaseB = {
      agentVersion: "b",
      taskResults: [
        task({
          taskId: "t1",
          meanOverall: 0.5,
          perAxis: [
            { axis: "A", mean: 0.5 },
            { axis: "D", mean: 0.4 },
          ],
        }),
        task({
          taskId: "t2",
          meanOverall: 0.5,
          perAxis: [
            { axis: "A", mean: 0.7 },
            { axis: "D", mean: 0.4 },
          ],
        }),
      ],
    };
    const r = releaseCompare(releaseA, releaseB);
    const byAxis = Object.fromEntries(r.perAxisRollup.map((x) => [x.axis, x]));
    // A: from (0.4+0.6)/2=0.5 → to (0.5+0.7)/2=0.6 → delta +0.1
    expect(byAxis["A"]!.fromMean).toBeCloseTo(0.5, 10);
    expect(byAxis["A"]!.toMean).toBeCloseTo(0.6, 10);
    expect(byAxis["A"]!.delta).toBeCloseTo(0.1, 10);
    // D: from 0.7 → to 0.4 → delta -0.3
    expect(byAxis["D"]!.fromMean).toBeCloseTo(0.7, 10);
    expect(byAxis["D"]!.toMean).toBeCloseTo(0.4, 10);
    expect(byAxis["D"]!.delta).toBeCloseTo(-0.3, 10);
  });

  it("finding-category deltas count across the suite (both-release tasks)", () => {
    const releaseA = {
      agentVersion: "a",
      taskResults: [
        task({
          taskId: "t1",
          meanOverall: 0.5,
          findings: [
            fi({ fingerprint: "t1:vs:1", runId: "r", judgementId: "j", category: "verification_skipped" }),
            fi({ fingerprint: "t1:tg:1", runId: "r", judgementId: "j", category: "test_gaming" }),
          ],
        }),
        task({
          taskId: "t2",
          meanOverall: 0.5,
          findings: [
            fi({ fingerprint: "t2:vs:1", runId: "r", judgementId: "j", category: "verification_skipped" }),
          ],
        }),
        // only-in-A task should NOT contribute to suite finding counts
        task({
          taskId: "t-only-a",
          meanOverall: 0.5,
          findings: [
            fi({ fingerprint: "onlya:vs", runId: "r", judgementId: "j", category: "verification_skipped" }),
          ],
        }),
      ],
    };
    const releaseB = {
      agentVersion: "b",
      taskResults: [
        task({
          taskId: "t1",
          meanOverall: 0.5,
          findings: [
            // vs:1 persisted, tg:1 resolved, new hallucinated
            fi({ fingerprint: "t1:vs:1", runId: "r", judgementId: "j", category: "verification_skipped" }),
            fi({
              fingerprint: "t1:hc:1",
              runId: "r",
              judgementId: "j",
              category: "hallucinated_claim",
            }),
          ],
        }),
        task({
          taskId: "t2",
          meanOverall: 0.5,
          findings: [
            // vs:1 resolved on t2; new vs fingerprint introduced
            fi({ fingerprint: "t2:vs:2", runId: "r", judgementId: "j", category: "verification_skipped" }),
          ],
        }),
      ],
    };
    const r = releaseCompare(releaseA, releaseB);
    const byCat = Object.fromEntries(
      r.findingCategoryDeltas.map((c) => [c.category, c]),
    );
    // verification_skipped: a fps = t1:vs:1, t2:vs:1; b fps = t1:vs:1, t2:vs:2
    // introduced=1 (t2:vs:2), resolved=1 (t2:vs:1), persisted=1 (t1:vs:1), net=0
    expect(byCat["verification_skipped"]).toMatchObject({
      introduced: 1,
      resolved: 1,
      persisted: 1,
      deltaNet: 0,
    });
    // test_gaming: resolved 1
    expect(byCat["test_gaming"]).toMatchObject({
      introduced: 0,
      resolved: 1,
      persisted: 0,
      deltaNet: -1,
    });
    // hallucinated_claim: introduced 1
    expect(byCat["hallucinated_claim"]).toMatchObject({
      introduced: 1,
      resolved: 0,
      persisted: 0,
      deltaNet: 1,
    });

    // per-task findingsDelta for t1: introduced 1, resolved 1 → net 0
    const t1 = r.perTaskBreakdown.find((p) => p.taskId === "t1")!;
    expect(t1.findingsDelta).toBe(0);
  });

  it("diagnostic rate deltas = fraction of tasks where value===true; passRate mean", () => {
    const releaseA = {
      agentVersion: "a",
      taskResults: [
        task({
          taskId: "t1",
          meanOverall: 0.5,
          diagnostics: { verification_performed: true },
          passRate: 1,
        }),
        task({
          taskId: "t2",
          meanOverall: 0.5,
          diagnostics: { verification_performed: true },
          passRate: 0.5,
        }),
      ],
    };
    const releaseB = {
      agentVersion: "b",
      taskResults: [
        task({
          taskId: "t1",
          meanOverall: 0.5,
          diagnostics: { verification_performed: false },
          passRate: 0.5,
        }),
        task({
          taskId: "t2",
          meanOverall: 0.5,
          diagnostics: { verification_performed: true },
          passRate: 0.5,
        }),
      ],
    };
    const r = releaseCompare(releaseA, releaseB);
    const byKey = Object.fromEntries(
      r.diagnosticRateDeltas.map((d) => [d.key, d]),
    );
    // verification_performed: 2/2=1 → 1/2=0.5 → delta -0.5
    expect(byKey["verification_performed"]!.fromRate).toBeCloseTo(1, 10);
    expect(byKey["verification_performed"]!.toRate).toBeCloseTo(0.5, 10);
    expect(byKey["verification_performed"]!.delta).toBeCloseTo(-0.5, 10);
    // passRate mean: (1+0.5)/2=0.75 → (0.5+0.5)/2=0.5 → delta -0.25
    expect(byKey["passRate"]!.fromRate).toBeCloseTo(0.75, 10);
    expect(byKey["passRate"]!.toRate).toBeCloseTo(0.5, 10);
    expect(byKey["passRate"]!.delta).toBeCloseTo(-0.25, 10);
  });
});

describe("determinism", () => {
  it("same inputs → same JSON-serializable output", () => {
    const scores = [0.1, 0.2, 0.9, 0.4];
    expect(JSON.stringify(batchStats(scores))).toBe(
      JSON.stringify(batchStats(scores)),
    );

    const a = side({
      judgement: jp({ judgementId: "ja", runId: "ra", overallScore: 0.6 }),
      criteriaScores: [
        { criterion: "B1", axis: "B", weight: 1, score: 0.4 },
        { criterion: "A1", axis: "A", weight: 1, score: 0.9 },
      ],
      findings: [
        fi({ fingerprint: "z", runId: "ra", judgementId: "ja" }),
        fi({ fingerprint: "a", runId: "ra", judgementId: "ja", category: "x" }),
      ],
      diagnostics: { k2: { value: true }, k1: { value: false } },
    });
    const b = side({
      judgement: jp({ judgementId: "jb", runId: "rb", overallScore: 0.7 }),
      criteriaScores: [
        { criterion: "A1", axis: "A", weight: 1, score: 0.8 },
        { criterion: "B1", axis: "B", weight: 1, score: 0.5 },
      ],
      findings: [
        fi({ fingerprint: "a", runId: "rb", judgementId: "jb", category: "x" }),
        fi({ fingerprint: "m", runId: "rb", judgementId: "jb" }),
      ],
      diagnostics: { k1: { value: true }, k2: { value: true } },
    });
    const c1 = compareTwoRuns(a, b);
    const c2 = compareTwoRuns(a, b);
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
    // deterministic criterion/diagnostic key ordering
    expect(c1.perCriterion.map((p) => p.criterion)).toEqual(["A1", "B1"]);
    expect(c1.diagnosticDeltas.map((d) => d.key)).toEqual(["k1", "k2"]);

    const relA = {
      agentVersion: "v1",
      taskResults: [
        {
          taskId: "t2",
          meanOverall: 0.4,
          spread: 0.1,
          n: 2,
          perAxis: [{ axis: "D" as const, mean: 0.3 }],
          findings: [fi({ fingerprint: "f1", runId: "r", judgementId: "j" })],
          diagnostics: { verification_performed: true },
        },
        {
          taskId: "t1",
          meanOverall: 0.6,
          spread: 0,
          n: 2,
          perAxis: [{ axis: "A" as const, mean: 0.6 }],
          findings: [],
          diagnostics: { verification_performed: false },
        },
      ],
    };
    const relB = {
      agentVersion: "v2",
      taskResults: [
        {
          taskId: "t1",
          meanOverall: 0.7,
          spread: 0,
          n: 2,
          perAxis: [{ axis: "A" as const, mean: 0.7 }],
          findings: [],
          diagnostics: { verification_performed: true },
        },
        {
          taskId: "t2",
          meanOverall: 0.3,
          spread: 0.1,
          n: 2,
          perAxis: [{ axis: "D" as const, mean: 0.2 }],
          findings: [fi({ fingerprint: "f2", runId: "r", judgementId: "j" })],
          diagnostics: { verification_performed: true },
        },
      ],
    };
    expect(JSON.stringify(releaseCompare(relA, relB))).toBe(
      JSON.stringify(releaseCompare(relA, relB)),
    );
  });
});

/**
 * P9 category profile + filterCriteria + renormalize + withSource gate + the
 * verdict reject-a-dropped-criterion gate (plan/categories.md, rubric.md §6/§7).
 *
 * The brief required these verified; the build shipped them untested (verifier
 * flagged the gap). This pins behavior so category filtering stays faithful.
 */
import { describe, expect, it } from "vitest";
import {
  CATEGORY_PROFILES,
  appliesForCategory,
  coerceAgentCategory,
  filterCriteria,
  getCategoryProfile,
  renormalizeWeights,
  shouldRunWithSource,
} from "../src/judge/categories.ts";
import { validateVerdict, type Verdict } from "../src/judge/verdict.ts";
import type {
  AgentCategory,
  AppliesTo,
  Criterion,
  Rubric,
  RubricAxis,
} from "../src/domain.ts";

function criterion(
  id: string,
  axis: RubricAxis,
  appliesTo: AppliesTo,
  weight: number,
): Criterion {
  return {
    id,
    axis,
    label: id,
    weight,
    appliesTo,
    anchors: { full: "f", partial: "p", none: "n" },
  };
}

function fullRubric(): Rubric {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      criterion("A1", "A", "both", 1),
      criterion("B1", "B", "both", 1),
      criterion("C1", "C", "both", 1),
      criterion("D1", "D", "coding", 1), // coding-only (axis D verify-rigor coding is §4)
      criterion("E1", "E", "both", 1),
      criterion("F1", "F", "both", 1),
      criterion("G1", "G", "coding", 1), // code quality — coding only
      criterion("H1", "H", "both", 1),
    ],
  };
}

describe("category profile axes (plan/categories.md §Pre-defined table)", () => {
  const axes = (c: AgentCategory) => new Set(getCategoryProfile(c).axes);

  it("coding = full A–H", () => {
    expect(axes("coding")).toEqual(new Set(["A", "B", "C", "D", "E", "F", "G", "H"]));
  });
  it("research = A,B,C,E,H (no D/G coding)", () => {
    expect(axes("research")).toEqual(new Set(["A", "B", "C", "E", "H"]));
  });
  it("general = A,B,C,D,F", () => {
    expect(axes("general")).toEqual(new Set(["A", "B", "C", "D", "F"]));
  });
  it("browser = A,B,C,E (NOT F — corrected to match spec)", () => {
    // Regression: impl previously kept F + dropped E; spec table says A,C,B,E.
    const b = axes("browser");
    expect(b.has("E")).toBe(true);
    expect(b.has("F")).toBe(false);
    expect(b).toEqual(new Set(["A", "B", "C", "E"]));
  });
  it("data = A,B,D,F,G", () => {
    expect(axes("data")).toEqual(new Set(["A", "B", "D", "F", "G"]));
  });
  it("conversational = A,B,H", () => {
    expect(axes("conversational")).toEqual(new Set(["A", "B", "H"]));
  });
});

describe("appliesForCategory", () => {
  it("both applies to every category", () => {
    for (const c of ["coding", "research", "general", "browser", "data", "conversational"] as AgentCategory[]) {
      expect(appliesForCategory("both", c)).toBe(true);
    }
  });
  it("coding applies only to coding", () => {
    expect(appliesForCategory("coding", "coding")).toBe(true);
    expect(appliesForCategory("coding", "research")).toBe(false);
  });
  it("general applies to every non-coding category", () => {
    expect(appliesForCategory("general", "coding")).toBe(false);
    expect(appliesForCategory("general", "research")).toBe(true);
    expect(appliesForCategory("general", "browser")).toBe(true);
  });
});

describe("renormalizeWeights (rubric.md §7)", () => {
  it("divides each weight by the sum of retained weights", () => {
    const out = renormalizeWeights([
      criterion("a", "A", "both", 1),
      criterion("b", "B", "both", 3),
    ]);
    const sum = out.reduce((acc, c) => acc + c.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect(out[1]!.weight).toBeCloseTo(0.75, 10);
  });
  it("is idempotent when weights already sum to 1", () => {
    const cs = [criterion("a", "A", "both", 0.4), criterion("b", "B", "both", 0.6)];
    const once = renormalizeWeights(cs);
    const twice = renormalizeWeights(once);
    expect(twice[0]!.weight).toBeCloseTo(once[0]!.weight, 10);
  });
  it("returns [] for empty input, no NaN", () => {
    expect(renormalizeWeights([])).toEqual([]);
  });
  it("keeps id + axis intact", () => {
    const out = renormalizeWeights([
      criterion("keep-me", "G", "coding", 5),
    ]);
    expect(out[0]!.id).toBe("keep-me");
    expect(out[0]!.axis).toBe("G");
    expect(out[0]!.weight).toBeCloseTo(1, 10);
  });
});

describe("filterCriteria", () => {
  it("coding is an identity on the criterion SET (all retained)", () => {
    const rubric = fullRubric();
    const filtered = filterCriteria(rubric, "coding");
    const ids = filtered.criteria.map((c) => c.id).sort();
    expect(ids).toEqual(["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1"]);
  });

  it("research drops coding-only axes D + G and coding-appliesTo criteria", () => {
    const filtered = filterCriteria(fullRubric(), "research");
    const ids = new Set(filtered.criteria.map((c) => c.id));
    expect(ids.has("D1")).toBe(false); // axis D not in research profile
    expect(ids.has("G1")).toBe(false); // axis G not in research profile
    expect(ids.has("A1")).toBe(true);
    expect(ids.has("E1")).toBe(true);
    expect(ids.has("H1")).toBe(true);
    const sum = filtered.criteria.reduce((acc, c) => acc + c.weight, 0);
    expect(sum).toBeCloseTo(1, 10); // renormalized
  });

  it("conversational keeps only A,B,H", () => {
    const filtered = filterCriteria(fullRubric(), "conversational");
    const axes = new Set(filtered.criteria.map((c) => c.axis));
    expect(axes).toEqual(new Set(["A", "B", "H"]));
  });

  it("returns a NEW rubric (does not mutate input)", () => {
    const rubric = fullRubric();
    const before = rubric.criteria.map((c) => c.weight);
    filterCriteria(rubric, "research");
    expect(rubric.criteria.map((c) => c.weight)).toEqual(before);
  });

  it("rejects a verdict scoring a dropped criterion id", () => {
    // The judge worker passes allowedCriterionIds to validateVerdict so a model
    // hallucinating a dropped criterion is rejected.
    const filtered = filterCriteria(fullRubric(), "conversational");
    const allowed = filtered.criteria.map((c) => c.id);
    const dropped = new Set(["D1", "G1"]); // not in conversational
    const verdict: Verdict = {
      schemaVersion: 1 as never,
      overall: { score: 0.5, verdict: "partial", summary: "x" },
      criteria: [
        { criterion: allowed[0]!, weight: 0.5, critical: false, score: 0.6, confidence: 0.8, findings: [] },
        // model scored a dropped criterion — must be rejected
        { criterion: "D1", weight: 0.5, critical: false, score: 0.4, confidence: 0.7, findings: [] },
      ],
      findings: [],
      positiveFindings: [],
      metaFindings: [],
      diagnostics: {},
      attribution: { agent_vs_environment: "agent" },
      observations: [],
      improvements: { withoutSource: "x", withSource: null },
    } as unknown as Verdict;
    expect(() =>
      validateVerdict(verdict, { allowedCriterionIds: allowed }),
    ).toThrow(/D1|criterion|allowed/i);
    expect(dropped.size).toBeGreaterThan(0); // sanity
  });
});

describe("shouldRunWithSource (withSource lens gate)", () => {
  it("research + conversational + browser → never", () => {
    expect(shouldRunWithSource("research", true)).toBe(false);
    expect(shouldRunWithSource("conversational", true)).toBe(false);
    expect(shouldRunWithSource("browser", true)).toBe(false); // spec: no
  });
  it("coding + data → always", () => {
    expect(shouldRunWithSource("coding", false)).toBe(true);
    expect(shouldRunWithSource("data", false)).toBe(true);
  });
  it("general → conditional on artifact", () => {
    expect(shouldRunWithSource("general", true)).toBe(true);
    expect(shouldRunWithSource("general", false)).toBe(false);
  });
});

describe("coerceAgentCategory", () => {
  it("accepts known categories, defaults unknown → coding", () => {
    expect(coerceAgentCategory("browser")).toBe("browser");
    expect(coerceAgentCategory("nope")).toBe("coding");
    expect(coerceAgentCategory(undefined)).toBe("coding");
  });
});

describe("CATEGORY_PROFILES completeness", () => {
  it("every category has a profile with a non-empty axis set", () => {
    for (const id of ["coding", "research", "general", "browser", "data", "conversational"] as AgentCategory[]) {
      const p = CATEGORY_PROFILES[id];
      expect(p.id).toBe(id);
      expect(p.axes.length).toBeGreaterThan(0);
    }
  });
});

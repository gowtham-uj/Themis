/**
 * Category profiles — filter rubric criteria by agent category and gate the
 * withSource improvements lens (plan/categories.md + plan/rubric.md §6/§7).
 *
 * Pure functions only: no I/O. The judge worker calls {@link filterCriteria}
 * before assembling the prompt so only applicable criteria are scored.
 */

import type {
  AgentCategory,
  AppliesTo,
  Criterion,
  DiffKind,
  Rubric,
  RubricAxis,
} from "../domain.js";

/**
 * Category profile: which axes apply, whether source artifacts are expected,
 * and what "the diff" means for refs.
 */
export interface CategoryProfile {
  id: AgentCategory;
  label: string;
  /** Axes retained for this category (others drop + weights renormalize). */
  axes: readonly RubricAxis[];
  /**
   * Source-artifact expectation for the withSource lens:
   *  - always: withSource always applicable (coding)
   *  - never: never produce withSource (research / conversational)
   *  - conditional: only when a diff/outputs artifact is present (general / browser)
   *  - partial: always applicable but may target outputs not code (data)
   */
  hasSourceArtifacts: "always" | "never" | "conditional" | "partial";
  /** What "the diff" means for this category. */
  diffKind: DiffKind;
}

/** Pre-defined category profiles (plan/categories.md §Pre-defined). */
export const CATEGORY_PROFILES: Readonly<Record<AgentCategory, CategoryProfile>> =
  {
    coding: {
      id: "coding",
      label: "Coding",
      axes: ["A", "B", "C", "D", "E", "F", "G", "H"],
      hasSourceArtifacts: "always",
      diffKind: "git",
    },
    research: {
      id: "research",
      label: "Research / analysis",
      axes: ["A", "B", "C", "E", "H"],
      hasSourceArtifacts: "never",
      diffKind: "none",
    },
    general: {
      id: "general",
      label: "General agent",
      // A,B,C,F + D where checkable (include D; task may still N/A individual criteria).
      axes: ["A", "B", "C", "D", "F"],
      hasSourceArtifacts: "conditional",
      diffKind: "git",
    },
    browser: {
      id: "browser",
      label: "Browser / computer-use",
      // plan/categories.md §Pre-defined: A(goal), C(tool/result interp.), B, E.
      // (impl previously kept F and dropped E — corrected to match the spec.)
      axes: ["A", "B", "C", "E"],
      // Spec: `withSource` lens = "no" for browser (no source; DOM/actions).
      hasSourceArtifacts: "never",
      diffKind: "none",
    },
    data: {
      id: "data",
      label: "Data / ETL",
      axes: ["A", "B", "D", "F", "G"],
      hasSourceArtifacts: "partial",
      diffKind: "outputs",
    },
    conversational: {
      id: "conversational",
      label: "Conversational",
      axes: ["A", "B", "H"],
      hasSourceArtifacts: "never",
      diffKind: "none",
    },
  };

/** All known agent category ids. */
export const CATEGORY_IDS: readonly AgentCategory[] = [
  "coding",
  "research",
  "general",
  "browser",
  "data",
  "conversational",
] as const;

/**
 * Map `applies_to` → category applicability (plan/rubric.md §2, plan/categories.md):
 *  - `"both"` → every category
 *  - `"coding"` → coding only
 *  - `"general"` → every NON-coding category
 */
export function appliesForCategory(
  appliesTo: AppliesTo,
  category: AgentCategory,
): boolean {
  if (appliesTo === "both") return true;
  if (appliesTo === "coding") return category === "coding";
  if (appliesTo === "general") return category !== "coding";
  return false;
}

/**
 * Renormalize criterion weights so they sum to 1.0 (plan/rubric.md §7).
 *
 * Chosen normalization: `w'ᵢ = wᵢ / Σ w_retained`. This keeps relative
 * importance within the retained set and makes OVERALL = Σ(score × weight)
 * comparable across categories (raw retained weights that sum > 1 would
 * inflate overall). Idempotent when weights already sum to 1 (within float
 * noise). Returns a NEW array of shallow-copied criteria; ids/axes intact.
 */
export function renormalizeWeights(criteria: readonly Criterion[]): Criterion[] {
  if (criteria.length === 0) return [];
  const sum = criteria.reduce((acc, c) => acc + c.weight, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) {
    // Degenerate: keep original weights rather than produce NaN/Inf.
    return criteria.map((c) => ({ ...c, anchors: { ...c.anchors } }));
  }
  return criteria.map((c) => ({
    ...c,
    weight: c.weight / sum,
    anchors: { ...c.anchors },
  }));
}

/**
 * Filter a rubric to criteria applicable for `category`, then renormalize
 * remaining weights (plan/rubric.md §7).
 *
 * A criterion is retained when BOTH:
 *  1. {@link appliesForCategory}(`criterion.appliesTo`, category) is true, AND
 *  2. its `axis` is in the category profile's allowed axes
 *     (e.g. research drops D/G coding-specific axes).
 *
 * Returns a NEW rubric object. Keeps `criteria.id` + `axis` intact. Pure —
 * no I/O. Coding with a full both/coding rubric is an identity on the set of
 * criteria (weights renormalized only if they did not already sum to 1).
 */
export function filterCriteria(rubric: Rubric, category: AgentCategory): Rubric {
  const profile =
    CATEGORY_PROFILES[category] ?? CATEGORY_PROFILES.coding;
  const allowedAxes = new Set<RubricAxis>(profile.axes);

  const retained = rubric.criteria.filter(
    (c) =>
      appliesForCategory(c.appliesTo, category) && allowedAxes.has(c.axis),
  );

  const criteria = renormalizeWeights(retained);

  return {
    ...rubric,
    criteria,
    ...(rubric.checks !== undefined ? { checks: rubric.checks } : {}),
  };
}

/**
 * Whether the judge should produce the `withSource` improvements lens.
 *
 * Gate (plan/categories.md + task brief):
 *  - research / conversational → always false
 *  - coding → always true
 *  - data → true (partial: outputs, not necessarily code)
 *  - general / browser → true only when a diff/outputs artifact is present
 *
 * Callers pass `hasDiffArtifact` from whether the run actually captured a
 * git patch or outputs manifest. The category gate can only further restrict
 * (or force-enable for coding/data), never invent artifacts.
 */
export function shouldRunWithSource(
  category: AgentCategory,
  hasDiffArtifact: boolean,
): boolean {
  switch (category) {
    case "research":
    case "conversational":
    case "browser":
      // Spec: no withSource lens (no source artifacts; research is read-only,
      // conversational has no tools, browser produces DOM/actions not code).
      return false;
    case "coding":
    case "data":
      return true;
    case "general":
      // general keeps an artifact when one is captured (conditional).
      return hasDiffArtifact;
    default:
      return hasDiffArtifact;
  }
}

/**
 * Coerce an unknown category string to a known {@link AgentCategory}.
 * Unknown / missing values default to `"coding"` (platform default).
 */
export function coerceAgentCategory(
  value: AgentCategory | string | undefined | null,
): AgentCategory {
  if (value && (CATEGORY_IDS as readonly string[]).includes(value)) {
    return value as AgentCategory;
  }
  return "coding";
}

/** Look up a profile by category id (defaults to coding). */
export function getCategoryProfile(category: AgentCategory): CategoryProfile {
  return CATEGORY_PROFILES[category] ?? CATEGORY_PROFILES.coding;
}

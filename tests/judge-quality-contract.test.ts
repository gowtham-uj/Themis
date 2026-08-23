/**
 * Contract test for the Themis judge quality harness skeleton (WP-0).
 *
 * Asserts the SHAPE of the contract in `src/judge/quality/types.ts` and
 * `src/judge/quality/rules.ts`: every enum has exactly the specified
 * members, the rule registry contains an entry for every rule id named in
 * the implementation plan's five-tier gate, and the registry is frozen.
 * These tests must pass with only the types + registry present — no
 * checking logic.
 */
import { describe, expect, it } from 'vitest';

import {
  CLOSED_BY_VALUES,
  COMPETENCE_VALUES,
  CONFIDENCE_VALUES,
  IMPACT_VALUES,
  IMPROVEMENT_CATEGORY_VALUES,
  JUDGE_TIER_VALUES,
  RECONCILIATION_VALUES,
  REF_KIND_VALUES,
  VERDICT_APPROACH_VALUES,
  VERDICT_INTEGRITY_VALUES,
  WHY_UNRESOLVED_VALUES,
} from '../src/judge/quality/types.ts';
import type {
  CompetenceScore,
  GroundTruth,
  ReconciliationVerdict,
  VerdictApproach,
  VerdictIntegrity,
} from '../src/judge/quality/types.ts';
import { QUALITY_RULES, type QualityRule } from '../src/judge/quality/rules.ts';

/* --------------------------- contract enums --------------------------- */

describe('evalJudge.yaml contract enums', () => {
  it('verdict.approach has exactly the specified members', () => {
    expect([...VERDICT_APPROACH_VALUES]).toEqual([
      'principled',
      'narrow',
      'symptomatic',
      'insufficient_evidence',
    ]);
  });

  it('verdict.integrity has exactly the specified members', () => {
    expect([...VERDICT_INTEGRITY_VALUES]).toEqual([
      'clean',
      'suspicious',
      'violation',
      'contested',
      'insufficient_evidence',
    ]);
  });

  it('verdict.competence is exactly 1..5', () => {
    expect([...COMPETENCE_VALUES]).toEqual([1, 2, 3, 4, 5]);
  });

  it('verdict.reconciliation has exactly the specified members', () => {
    expect([...RECONCILIATION_VALUES]).toEqual([
      'consistent',
      'passed_for_wrong_reason',
      'failed_despite_sound_work',
      'unexplained',
    ]);
  });

  it('improvements[].category has exactly the specified members', () => {
    expect([...IMPROVEMENT_CATEGORY_VALUES]).toEqual([
      'correctness',
      'approach',
      'process',
      'integrity',
      'efficiency',
      'tooling',
    ]);
  });

  it('improvements[].impact is high|medium|low', () => {
    expect([...IMPACT_VALUES]).toEqual(['high', 'medium', 'low']);
  });

  it('confidence is high|medium|low', () => {
    expect([...CONFIDENCE_VALUES]).toEqual(['high', 'medium', 'low']);
  });

  it('case_coverage.closed_by has exactly the specified members', () => {
    expect([...CLOSED_BY_VALUES]).toEqual([
      'no_new_tangents',
      'triage_exhausted',
      'round_ceiling',
    ]);
  });

  it('open_questions[].why_unresolved has exactly the specified members', () => {
    expect([...WHY_UNRESOLVED_VALUES]).toEqual([
      'unsolvable_from_record',
      'failed_triage',
      'round_ceiling',
    ]);
  });

  it('enum arrays are frozen', () => {
    for (const values of [
      VERDICT_APPROACH_VALUES,
      VERDICT_INTEGRITY_VALUES,
      COMPETENCE_VALUES,
      RECONCILIATION_VALUES,
      IMPROVEMENT_CATEGORY_VALUES,
      IMPACT_VALUES,
      CONFIDENCE_VALUES,
      CLOSED_BY_VALUES,
      WHY_UNRESOLVED_VALUES,
      REF_KIND_VALUES,
      JUDGE_TIER_VALUES,
    ]) {
      expect(Object.isFrozen(values)).toBe(true);
    }
  });
});

/* ------------------------------- ref kinds ----------------------------- */

describe('ref grammar', () => {
  it('covers every ref kind named in the contract', () => {
    expect([...REF_KIND_VALUES]).toEqual([
      'tool_call',
      'diff',
      'file',
      'verifier',
      'report',
      'scratchpad',
      'web',
    ]);
  });
});

/* --------------------------- ground truth shape ------------------------ */

describe('ground-truth fixtures', () => {
  it('acceptable_verdicts are sets, never single values', () => {
    const fixture: GroundTruth = {
      must_find: [{ finding: 'the regex matches .5s', ref: 'file:src/check.ts#L12-L14' }],
      must_not_claim: ['the fix handles negative numbers'],
      acceptable_verdicts: {
        approach: new Set<VerdictApproach>(['narrow', 'symptomatic']),
        integrity: new Set<VerdictIntegrity>(['clean']),
        competence: new Set<CompetenceScore>([3, 4]),
        reconciliation: new Set<ReconciliationVerdict>(['passed_for_wrong_reason']),
      },
      min_confidence: 'low',
      max_confidence: 'high',
    };
    for (const set of Object.values(fixture.acceptable_verdicts)) {
      expect(set).toBeInstanceOf(Set);
    }
    expect(fixture.acceptable_verdicts.approach.has('narrow')).toBe(true);
    expect(fixture.acceptable_verdicts.approach.has('principled')).toBe(false);
  });
});

/* ------------------------------- judge tiers --------------------------- */

describe('judge tiers', () => {
  it('defines exactly the five tiers of the gate', () => {
    expect([...JUDGE_TIER_VALUES]).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

/* ------------------------------ rule registry -------------------------- */

// Every rule id named in plan §3 (Tier A, Tier B, deterministic Tier D).
const EXPECTED_RULE_IDS = [
  // Tier A — structural validity
  'a-yaml-parses',
  'a-required-keys',
  'a-no-invented-keys',
  'a-enums-exact',
  'a-ref-shape-valid',
  'a-no-placeholder-residue',
  'a-no-field-echo',
  'a-canonical-stable',
  // Tier B — groundedness
  'b-refs-resolve',
  'b-web-refs-not-findings',
  'b-corroboration-recomputed',
  'b-adverse-ruling-refed',
  'b-official-reward-exact',
  'b-improvement-evidence-resolves',
  'b-label-discipline',
  'b-refuted-needs-positive-finding',
  'b-coverage-honesty',
  'b-verbatim-assembly',
  // Tier D — deterministic usefulness checks
  'd-actionability',
  'd-anti-genericity',
  'd-template-echo',
  'd-calibration',
  'd-empty-strengths-justified',
  'd-improvement-grounding',
] as const;

describe('rule registry', () => {
  const ids = QUALITY_RULES.map((rule) => rule.id);

  it('contains an entry for every rule id named in the plan', () => {
    for (const id of EXPECTED_RULE_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('contains exactly the rules named in the plan — no more, no less', () => {
    expect(new Set(ids)).toEqual(new Set(EXPECTED_RULE_IDS));
    expect(ids.length).toBe(EXPECTED_RULE_IDS.length);
  });

  it('assigns rule ids uniquely', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has the plan\'s per-tier counts: 8 Tier A, 10 Tier B, 6 Tier D', () => {
    const byTier: Record<string, number> = { A: 0, B: 0, D: 0 };
    for (const rule of QUALITY_RULES) {
      byTier[rule.tier] = (byTier[rule.tier] ?? 0) + 1;
    }
    expect(byTier).toEqual({ A: 8, B: 10, D: 6 });
  });

  it('only contains rules from Tier A, Tier B and deterministic Tier D', () => {
    for (const rule of QUALITY_RULES) {
      expect(['A', 'B', 'D']).toContain(rule.tier);
    }
  });

  it('every entry has exactly the shape { id, tier, title, rationale }', () => {
    for (const rule of QUALITY_RULES) {
      expect(Object.keys(rule).sort()).toEqual(['id', 'rationale', 'tier', 'title']);
      expect(typeof rule.id).toBe('string');
      expect(typeof rule.tier).toBe('string');
      expect(typeof rule.title).toBe('string');
      expect(typeof rule.rationale).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.rationale.length).toBeGreaterThan(0);
    }
  });

  it('entries satisfy the QualityRule type (tier is a RuleTier literal)', () => {
    const check: readonly QualityRule[] = QUALITY_RULES;
    expect(check.length).toBe(QUALITY_RULES.length);
  });

  it('the registry is frozen, including every entry', () => {
    expect(Object.isFrozen(QUALITY_RULES)).toBe(true);
    for (const rule of QUALITY_RULES) {
      expect(Object.isFrozen(rule)).toBe(true);
    }
  });

  it('mutating the registry is rejected', () => {
    expect(() => {
      (QUALITY_RULES as unknown as QualityRule[]).push({
        id: 'x-injected',
        tier: 'A',
        title: 'injected',
        rationale: 'injected',
      });
    }).toThrow(TypeError);
  });
});

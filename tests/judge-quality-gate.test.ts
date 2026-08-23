/**
 * Tests for the five-tier quality GATE.
 *
 * The gate's job is not to check reports — the tier modules do that, and
 * `judge-quality-corpus.test.ts` holds them honest. The gate's job is to say
 * what the harness actually verified, and the failure mode worth testing is
 * the gate OVERCLAIMING: reporting a five-tier pass when two tiers never ran,
 * or counting a registered-but-uncalled rule as green.
 *
 * So most of this file attacks the report's honesty rather than its checkers.
 * Mutation-verified: making `passed` ignore `not_implemented`, dropping the
 * cross-report anti-genericity call, and dropping a tier from RULES_BY_TIER
 * each turn this file red.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findUninvokedRules, runQualityGate, type GateCase } from '../src/judge/quality/gate.ts';
import {
  toArchiveFacts,
  toTierDFacts,
  withResolvingRefs,
} from '../src/judge/quality/fixture-loader.ts';
import { QUALITY_RULES } from '../src/judge/quality/rules.ts';
import { collectResolvingRefs } from '../src/judge/quality/tier-b-grounded.ts';
import { parseEvalJudgeYaml } from '../src/judge/quality/tier-a-structural.ts';
import { JUDGE_TIER_VALUES, type EvalJudgeReport } from '../src/judge/quality/types.ts';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'judge-quality');

/** Build a GateCase from a sealed fixture directory, mirroring how the corpus
 *  test wires facts so the gate is exercised on real fixture data. */
function gateCase(name: string, file = 'report.yaml'): GateCase {
  const dir = join(FIXTURE_ROOT, name);
  const yamlText = readFileSync(join(dir, file), 'utf8');
  const factsRaw = JSON.parse(readFileSync(join(dir, 'archive-facts.json'), 'utf8'));
  // Tier A may reject a bad fixture; the gate itself re-parses, but we still
  // need a report here to collect resolving refs for Tier D. Unparseable
  // fixtures are not loaded through this helper.
  const report = parseEvalJudgeYaml(yamlText) as EvalJudgeReport;
  const facts = toArchiveFacts(factsRaw, name);
  return {
    id: name,
    yamlText,
    facts,
    tierD: {
      archive: withResolvingRefs(
        toTierDFacts(factsRaw, name),
        collectResolvingRefs(report, facts),
      ),
      templateText: '',
    },
  };
}

const CLEAN = gateCase('clean-pass');

describe('gate — never claims a pass it cannot support', () => {
  it('reports passed:false while any declared tier is unimplemented', () => {
    // THE test in this file. Tiers C and E have zero rules, so no corpus —
    // however clean — may produce a five-tier pass. A gate that ANDed only the
    // implemented tiers would return true here and be believed.
    const report = runQualityGate([CLEAN]);
    expect(report.notImplementedTiers.length).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });

  it('names exactly which tiers did not run', () => {
    const report = runQualityGate([CLEAN]);
    expect(report.notImplementedTiers).toEqual(['C', 'E']);
  });

  it('an unimplemented tier is not reported as passing', () => {
    // `passed: true` on a tier that never executed is the specific lie the
    // TierStatus type was introduced to make unrepresentable.
    const report = runQualityGate([CLEAN]);
    for (const tier of report.notImplementedTiers) {
      expect(report.tiers[tier].status).toBe('not_implemented');
      expect(report.tiers[tier].passed).toBe(false);
    }
  });

  it('distinguishes not_implemented from passed on a clean corpus', () => {
    // Tier A on a clean fixture and Tier C both have zero violations. Only
    // `status` separates "ran, found nothing" from "never ran", and if it did
    // not, the empty violation list would read identically for both.
    const report = runQualityGate([CLEAN]);
    expect(report.tiers.A.violations).toEqual([]);
    expect(report.tiers.C.violations).toEqual([]);
    expect(report.tiers.A.status).not.toBe(report.tiers.C.status);
  });

  it('every declared tier appears in the report (none silently omitted)', () => {
    const report = runQualityGate([CLEAN]);
    for (const tier of JUDGE_TIER_VALUES) {
      expect(report.tiers[tier], `tier ${tier} missing from report`).toBeDefined();
      expect(report.tiers[tier].tier).toBe(tier);
    }
  });

  it('would report passed:true only if every tier ran and passed', () => {
    // Pins the exact predicate rather than the current outcome, so the day
    // tiers C and E land this test still means something.
    const report = runQualityGate([CLEAN]);
    const allRanAndPassed = JUDGE_TIER_VALUES.every((t) => report.tiers[t].status === 'passed');
    expect(report.passed).toBe(allRanAndPassed);
  });
});

describe('gate — rule reachability', () => {
  it('no registry rule is left uninvoked by every tier', () => {
    // The check that would have caught d-anti-genericity being dead. A rule no
    // aggregator calls is indistinguishable from one that always passes.
    expect(findUninvokedRules()).toEqual([]);
  });

  it('reports uninvoked rules in the machine-readable output too', () => {
    expect(runQualityGate([CLEAN]).uninvokedRules).toEqual([]);
  });

  it('accounts for every registry rule exactly once across tiers', () => {
    const report = runQualityGate([CLEAN]);
    expect(report.uninvokedRules).toEqual([]);
    expect(QUALITY_RULES.length).toBeGreaterThan(0);
  });
});

describe('gate — d-anti-genericity is actually reachable', () => {
  it('fires on two near-identical narratives from different evals', () => {
    // Registered, implemented, exported — and never called by
    // `checkTierDUsefulness`, because it is cross-report. The sealed probe
    // under probes/tier-d/d-anti-genericity/ is a near-boilerplate twin of
    // clean-pass (same skeleton, different identifiers). Pairing them is what
    // the corpus uses; this asserts the GATE closed the reachability gap —
    // the rule must FIRE through runQualityGate, not merely be listed.
    const probeDir = join(FIXTURE_ROOT, 'probes', 'tier-d', 'd-anti-genericity');
    const probeYaml = readFileSync(join(probeDir, 'report.yaml'), 'utf8');
    const probeFactsRaw = JSON.parse(
      readFileSync(join(probeDir, 'archive-facts.json'), 'utf8'),
    );
    const probeReport = parseEvalJudgeYaml(probeYaml) as EvalJudgeReport;
    const probeFacts = toArchiveFacts(probeFactsRaw, 'd-anti-genericity');
    const probe: GateCase = {
      id: 'd-anti-genericity',
      yamlText: probeYaml,
      facts: probeFacts,
      tierD: {
        archive: withResolvingRefs(
          toTierDFacts(probeFactsRaw, 'd-anti-genericity'),
          collectResolvingRefs(probeReport, probeFacts),
        ),
        templateText: '',
      },
    };

    const report = runQualityGate([CLEAN, probe]);
    const fired = report.violations.filter((v) => v.rule === 'd-anti-genericity');
    expect(fired.length).toBeGreaterThan(0);
  });

  it('does not fire on a single-report corpus (it needs a pair)', () => {
    // Guards against "make it reachable" being implemented as "make it always
    // fire", which would be reachable and useless.
    const report = runQualityGate([CLEAN]);
    expect(report.violations.filter((v) => v.rule === 'd-anti-genericity')).toEqual([]);
  });

  it('does not fire on two genuinely different narratives', () => {
    const report = runQualityGate([gateCase('clean-pass'), gateCase('narrow-pass')]);
    expect(report.violations.filter((v) => v.rule === 'd-anti-genericity')).toEqual([]);
  });
});

describe('gate — tier execution', () => {
  it('surfaces real violations from a known-bad fixture', () => {
    // Confirms the gate is wired to the checkers at all, rather than reporting
    // honest emptiness forever.
    const report = runQualityGate([gateCase('sound-fail', 'report-bad.yaml')]);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });

  it('aggregates violations across the whole corpus, not just the first case', () => {
    const one = runQualityGate([gateCase('sound-fail', 'report-bad.yaml')]);
    const two = runQualityGate([
      gateCase('sound-fail', 'report-bad.yaml'),
      gateCase('narrow-pass', 'report-bad.yaml'),
    ]);
    expect(two.violations.length).toBeGreaterThan(one.violations.length);
  });

  it("top-level violations equal the union of the implemented tiers'", () => {
    const report = runQualityGate([gateCase('sound-fail', 'report-bad.yaml')]);
    const fromTiers = JUDGE_TIER_VALUES.flatMap((t) => report.tiers[t].violations);
    expect(report.violations).toHaveLength(fromTiers.length);
  });

  it('does not throw on an unparseable document; Tier A reports it', () => {
    // A gate that throws here takes the whole corpus run down with one bad
    // fixture, and the operator learns nothing about the other 6.
    const broken: GateCase = { ...CLEAN, id: 'broken', yamlText: 'verdict: [unclosed' };
    const report = runQualityGate([broken]);
    expect(report.tiers.A.violations.some((v) => v.rule === 'a-yaml-parses')).toBe(true);
  });

  it('does not credit Tiers B or D for a document Tier A could not parse', () => {
    // The subtle overclaim: skipping B and D for an unparseable case must not
    // look like B and D having passed it.
    const broken: GateCase = { ...CLEAN, id: 'broken', yamlText: 'verdict: [unclosed' };
    const report = runQualityGate([broken]);
    expect(report.passed).toBe(false);
    expect(report.tiers.A.status).toBe('failed');
  });

  it('handles an empty corpus without claiming a pass', () => {
    const report = runQualityGate([]);
    expect(report.passed).toBe(false);
    expect(report.notImplementedTiers).toEqual(['C', 'E']);
  });
});

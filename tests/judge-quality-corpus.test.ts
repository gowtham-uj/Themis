/**
 * The corpus gate: runs every sealed fixture through every tier of the real
 * harness, using the real on-disk fixture files.
 *
 * This test exists because `judge-quality-tiers.test.ts` constructs ArchiveFacts
 * inline and never opens a fixture. That suite was fully green while the harness
 * threw on all 7 fixtures and only 3 of 24 rules could fire. A unit suite that
 * builds its own inputs proves the checkers work on hand-shaped data; it cannot
 * prove they work on the data the system actually produces.
 *
 * Two things are asserted here that a unit suite structurally cannot:
 *   1. Every fixture decodes and every tier runs end-to-end without throwing.
 *   2. Every rule in the frozen registry fires on at least one fixture — a rule
 *      that never fires is indistinguishable from a rule that is not wired up.
 *
 * The sealed fixtures are whole, realistic cases, and they leave most rules
 * silent: a realistic report simply does not commit fifteen different defects.
 * The probe corpus under `fixtures/judge-quality/probes/` closes that gap from
 * the other side — each probe is a minimal single-defect variant of a good
 * fixture that must fire *its own* rule id. Requiring the rule id (rather than
 * "some violation") is what makes a probe evidence: a probe that merely fails
 * proves nothing about the rule it was written for.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { QUALITY_RULES } from '../src/judge/quality/rules.ts';
import {
  toArchiveFacts,
  toTierDFacts,
  withResolvingRefs,
} from '../src/judge/quality/fixture-loader.ts';
import { checkTierA, parseEvalJudgeYaml } from '../src/judge/quality/tier-a-structural.ts';
import { checkTierB, collectResolvingRefs } from '../src/judge/quality/tier-b-grounded.ts';
import {
  checkAntiGenericity,
  checkTierDUsefulness,
  type CorpusReport,
} from '../src/judge/quality/tier-d-usefulness.ts';
import type { EvalJudgeReport, Violation } from '../src/judge/quality/types.ts';

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'judge-quality');

interface Fixture {
  readonly name: string;
  readonly goodYaml: string;
  readonly badYaml: string;
  readonly factsRaw: unknown;
  readonly groundTruth: Record<string, unknown>;
}

/**
 * Directories under the fixture root that are not sealed fixtures: the
 * adversarial corpus and the probe corpus each have their own shape and their
 * own loader below.
 */
const NON_FIXTURE_DIRS = new Set(['adversarial', 'probes']);

/** Load every sealed fixture directory (the adversarial corpus is separate). */
function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NON_FIXTURE_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(FIXTURE_ROOT, name);
      return {
        name,
        goodYaml: readFileSync(join(dir, 'report.yaml'), 'utf8'),
        badYaml: readFileSync(join(dir, 'report-bad.yaml'), 'utf8'),
        factsRaw: JSON.parse(readFileSync(join(dir, 'archive-facts.json'), 'utf8')),
        groundTruth: parseYaml(readFileSync(join(dir, 'ground-truth.yaml'), 'utf8')) as Record<
          string,
          unknown
        >,
      };
    });
}

const FIXTURES = loadFixtures();

const PROBE_ROOT = join(FIXTURE_ROOT, 'probes');

interface Probe {
  /** `tier-a/a-enums-exact`, used as the test name. */
  readonly name: string;
  /** The rule this probe is evidence for; also its directory name. */
  readonly rule: string;
  readonly yaml: string;
  /** Tier A probes are pure grammar defects and carry no archive. */
  readonly factsRaw: unknown | null;
  readonly templateText: string;
  /**
   * Rules that necessarily co-fire, declared by the probe as data. A probe may
   * declare these only where the co-firing is a property of the rule set — one
   * rule structurally containing another — rather than an untidy fixture.
   */
  readonly alsoFires: readonly string[];
}

/**
 * Rules that cannot fire on a single report because they compare reports to
 * each other. Their probes are graded against the `clean-pass` baseline, which
 * is the second report the comparison needs.
 */
const CROSS_REPORT_RULES = new Set(['d-anti-genericity']);

/** Load the probe corpus: one minimal single-defect report per rule. */
function loadProbes(): Probe[] {
  if (!existsSync(PROBE_ROOT)) return [];
  const probes: Probe[] = [];
  for (const tier of readdirSync(PROBE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const tierDir = join(PROBE_ROOT, tier);
    for (const rule of readdirSync(tierDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      const dir = join(tierDir, rule);
      const factsPath = join(dir, 'archive-facts.json');
      const templatePath = join(dir, 'template.txt');
      const alsoFiresPath = join(dir, 'also-fires.json');
      probes.push({
        name: `${tier}/${rule}`,
        rule,
        yaml: readFileSync(join(dir, 'report.yaml'), 'utf8'),
        factsRaw: existsSync(factsPath)
          ? JSON.parse(readFileSync(factsPath, 'utf8'))
          : null,
        templateText: existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : '',
        alsoFires: existsSync(alsoFiresPath)
          ? (JSON.parse(readFileSync(alsoFiresPath, 'utf8')) as string[])
          : [],
      });
    }
  }
  return probes;
}

const PROBES = loadProbes();

/** Every violation one probe raises, across whichever tiers its inputs support. */
function runProbe(probe: Probe): Violation[] {
  const tierA = checkTierA(probe.yaml);
  if (probe.factsRaw === null) return tierA.violations;
  const report = parseEvalJudgeYaml(probe.yaml) as EvalJudgeReport;
  const facts = toArchiveFacts(probe.factsRaw, probe.name);
  const violations = [
    ...tierA.violations,
    ...checkTierB(report, facts).violations,
    ...checkTierDUsefulness(report, {
      archive: withResolvingRefs(
        toTierDFacts(probe.factsRaw, probe.name),
        collectResolvingRefs(report, facts),
      ),
      templateText: probe.templateText,
    }),
  ];
  if (CROSS_REPORT_RULES.has(probe.rule)) {
    const baseline = parseEvalJudgeYaml(
      readFileSync(join(FIXTURE_ROOT, 'clean-pass', 'report.yaml'), 'utf8'),
    ) as EvalJudgeReport;
    violations.push(
      ...checkAntiGenericity([
        { eval_id: baseline.eval_id, narrative: baseline.narrative },
        { eval_id: report.eval_id, narrative: report.narrative },
      ]),
    );
  }
  return violations;
}

/** Run all tiers over one report, returning every violation raised. */
function runAllTiers(yamlText: string, factsRaw: unknown, fixtureName: string): Violation[] {
  const facts = toArchiveFacts(factsRaw, fixtureName);
  const tierA = checkTierA(yamlText);
  // Tiers B and D need a parsed report; if the YAML is structurally broken the
  // Tier A violations are the whole story.
  let report: EvalJudgeReport;
  try {
    report = parseEvalJudgeYaml(yamlText) as EvalJudgeReport;
  } catch {
    return tierA.violations;
  }
  const tierB = checkTierB(report, facts);
  // Tier D declares its own ArchiveFacts shape, distinct from Tier B's despite
  // the shared name, so it needs its own decode of the same fixture.
  const tierD = checkTierDUsefulness(report, {
    archive: withResolvingRefs(
      toTierDFacts(factsRaw, fixtureName),
      collectResolvingRefs(report, facts),
    ),
    templateText: '',
  });
  return [...tierA.violations, ...tierB.violations, ...tierD];
}

describe('judge quality corpus', () => {
  it('has the sealed fixture set the WP-0 exit gate requires', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(7);
  });

  describe.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    it('decodes and runs every tier without throwing', () => {
      expect(() => runAllTiers(fixture.goodYaml, fixture.factsRaw, fixture.name)).not.toThrow();
      expect(() => runAllTiers(fixture.badYaml, fixture.factsRaw, fixture.name)).not.toThrow();
    });

    it('accepts the good report', () => {
      const violations = runAllTiers(fixture.goodYaml, fixture.factsRaw, fixture.name);
      expect(
        violations,
        `good report raised: ${violations.map((v) => `${v.rule}: ${v.message}`).join('; ')}`,
      ).toEqual([]);
    });

    it('rejects the bad variant', () => {
      const violations = runAllTiers(fixture.badYaml, fixture.factsRaw, fixture.name);
      expect(violations.length, 'bad variant raised no violations').toBeGreaterThan(0);
    });
  });

  describe.each(PROBES.map((p) => [p.name, p] as const))('probe %s', (_name, probe) => {
    it('names a rule in the frozen registry', () => {
      expect(QUALITY_RULES.map((r) => r.id)).toContain(probe.rule);
    });

    it('fires its own rule and only its declared co-fires', () => {
      const fired = [...new Set(runProbe(probe).map((v) => v.rule))].sort();
      const expected = [...new Set([probe.rule, ...probe.alsoFires])].sort();
      expect(
        fired,
        `probe for ${probe.rule} fired ${JSON.stringify(fired)}; a probe that fires a ` +
          `different rule is evidence for that other rule, not for this one`,
      ).toEqual(expected);
    });
  });

  it('fires every rule in the frozen registry on at least one fixture', () => {
    const fired = new Set<string>();
    for (const fixture of FIXTURES) {
      for (const yamlText of [fixture.goodYaml, fixture.badYaml]) {
        for (const violation of runAllTiers(yamlText, fixture.factsRaw, fixture.name)) {
          fired.add(violation.rule);
        }
      }
    }
    // The probes are the other half of the coverage argument: sealed fixtures
    // show the rules behave on realistic cases, probes show each rule can be
    // provoked at all.
    for (const probe of PROBES) {
      for (const violation of runProbe(probe)) fired.add(violation.rule);
    }
    // Anti-genericity is cross-report by construction: it compares narratives
    // across the corpus rather than judging one report, so it is exercised here
    // over every fixture's narrative at once.
    const corpus: CorpusReport[] = FIXTURES.map((f) => {
      const report = parseEvalJudgeYaml(f.goodYaml) as EvalJudgeReport;
      return { eval_id: report.eval_id, narrative: report.narrative };
    });
    for (const violation of checkAntiGenericity(corpus)) fired.add(violation.rule);

    const never = QUALITY_RULES.map((r) => r.id).filter((id) => !fired.has(id));
    expect(
      never,
      `these rules never fired on any fixture, so nothing proves they are wired up: ${never.join(', ')}`,
    ).toEqual([]);
  });
});

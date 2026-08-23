/**
 * Adversarial corpus: each attack fixture must fire its target rule id.
 *
 * These are not sealed "good" fixtures — they are crafted escapes. A harness
 * that only runs the happy-path corpus can be fully green while every attack
 * here still passes, which is the failure mode this file exists to catch.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  toArchiveFacts,
  toTierDFacts,
  withResolvingRefs,
} from '../src/judge/quality/fixture-loader.ts';
import { checkTierA, parseEvalJudgeYaml } from '../src/judge/quality/tier-a-structural.ts';
import { checkTierB, collectResolvingRefs } from '../src/judge/quality/tier-b-grounded.ts';
import { checkTierDUsefulness } from '../src/judge/quality/tier-d-usefulness.ts';
import type { EvalJudgeReport } from '../src/judge/quality/types.ts';

const ROOT = join(import.meta.dirname, 'fixtures', 'judge-quality', 'adversarial');

interface Attack {
  readonly id: string;
  readonly dir: string;
  readonly expectedRules: readonly string[];
}

const ATTACKS: Attack[] = [
  {
    id: 'attack-a1',
    dir: join(ROOT, 'tier-a', 'attack-a1'),
    expectedRules: ['a-no-placeholder-residue'],
  },
  {
    id: 'attack-b1',
    dir: join(ROOT, 'tier-b', 'attack-b1'),
    expectedRules: ['b-corroboration-recomputed'],
  },
  {
    id: 'attack-b2',
    dir: join(ROOT, 'tier-b', 'attack-b2'),
    expectedRules: ['b-verbatim-assembly'],
  },
  {
    id: 'attack-d1',
    dir: join(ROOT, 'tier-d', 'attack-d1'),
    expectedRules: ['d-actionability'],
  },
];

function runAttack(dir: string): string[] {
  const yaml = readFileSync(join(dir, 'report.yaml'), 'utf8');
  const factsPath = join(dir, 'archive-facts.json');
  const tierA = checkTierA(yaml);
  const rules = new Set(tierA.violations.map((v) => v.rule));

  if (!existsSync(factsPath)) {
    return [...rules];
  }

  let report: EvalJudgeReport;
  try {
    report = parseEvalJudgeYaml(yaml) as EvalJudgeReport;
  } catch {
    return [...rules];
  }

  const factsRaw = JSON.parse(readFileSync(factsPath, 'utf8'));
  const facts = toArchiveFacts(factsRaw, dir);
  for (const v of checkTierB(report, facts).violations) rules.add(v.rule);

  const tierD = checkTierDUsefulness(report, {
    archive: withResolvingRefs(toTierDFacts(factsRaw, dir), collectResolvingRefs(report, facts)),
    templateText: '',
  });
  for (const v of tierD) rules.add(v.rule);
  return [...rules];
}

describe('adversarial corpus', () => {
  for (const attack of ATTACKS) {
    it(`${attack.id} fires ${attack.expectedRules.join(', ')}`, () => {
      expect(existsSync(join(attack.dir, 'report.yaml')), `${attack.id} missing report.yaml`).toBe(
        true,
      );
      const fired = runAttack(attack.dir);
      for (const rule of attack.expectedRules) {
        expect(fired, `${attack.id} did not fire ${rule}; got ${JSON.stringify(fired)}`).toContain(
          rule,
        );
      }
    });
  }
});

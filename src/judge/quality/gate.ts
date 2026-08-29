/**
 * Themis judge-quality GATE — the thing that runs the tiers and produces the
 * one machine-readable `quality-report.json`.
 *
 * The design problem this module exists to solve is NOT "run the checkers".
 * The checkers already existed and were already invoked ad hoc by the corpus
 * test. The problem is that `QualityReport` declares five tiers while the
 * registry implements three, and the obvious gate — run A, B, D; report
 * `passed: true` — silently claims a five-tier pass with 40% of the gate never
 * having executed. That is worse than no gate at all: no gate produces no
 * evidence, while a gate like that produces false evidence, and false evidence
 * is what a reader acts on.
 *
 * So two things here are load-bearing and neither is about checking logic:
 *
 *  1. A tier that did not run reports `status: 'not_implemented'`, and that
 *     status forces the top-level `passed` to false. The gate reports what it
 *     VERIFIED, never what it declared.
 *  2. Every registry rule id is reconciled against the ids the aggregators
 *     actually emitted or are known to invoke. A rule no aggregator calls is
 *     indistinguishable from a rule that always passes, so it is named in
 *     `uninvokedRules` instead of being counted as green.
 *
 * `d-anti-genericity` is the concrete case that motivated (2). It is
 * registered, implemented, and exported — and `checkTierDUsefulness` never
 * called it, because it is cross-report (it compares reports to each other) and
 * cannot live in a per-report aggregator. It was therefore dead: registered,
 * never run, and counted as passing. The gate runs it at the corpus level,
 * which is the only level where it is meaningful.
 */

import { QUALITY_RULES } from './rules.js';
import { checkTierA, parseEvalJudgeYaml } from './tier-a-structural.js';
import { type ArchiveFacts, checkTierB } from './tier-b-grounded.js';
import {
  checkAntiGenericity,
  checkTierDUsefulness,
  type CorpusReport,
  type TierDContext,
} from './tier-d-usefulness.js';
import {
  JUDGE_TIER_VALUES,
  type EvalJudgeReport,
  type JudgeTier,
  type QualityReport,
  type TierResult,
  type TierStatus,
  type Violation,
} from './types.js';

/**
 * Rule ids each tier aggregator is responsible for invoking.
 *
 * This is a hand-maintained claim, and it is checked rather than trusted: a
 * rule listed here that never appears in any violation across the whole
 * fixture corpus is not proof of a bug (a corpus can legitimately be clean),
 * but a registry rule listed in NO tier here is reported as uninvoked. The
 * distinction matters — the gate can prove "nothing calls this" statically,
 * and cannot prove "this fired" without a fixture that violates it.
 */
const RULES_BY_TIER: Readonly<Record<JudgeTier, readonly string[]>> = Object.freeze({
  A: [
    'a-yaml-parses',
    'a-required-keys',
    'a-no-invented-keys',
    'a-enums-exact',
    'a-ref-shape-valid',
    'a-no-placeholder-residue',
    'a-no-field-echo',
    'a-canonical-stable',
  ],
  B: [
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
  ],
  // Tier C (behavioral probes) and Tier E (stability) have ZERO rules in the
  // frozen registry. They are declared in JUDGE_TIER_VALUES and therefore in
  // QualityReport, so the gate must account for them explicitly rather than
  // omit them and let the Record lookup produce undefined.
  C: [],
  D: [
    'd-actionability',
    'd-anti-genericity',
    'd-template-echo',
    'd-calibration',
    'd-empty-strengths-justified',
    'd-improvement-grounding',
  ],
  E: [],
});

/** One report plus everything needed to check it. */
export interface GateCase {
  /** Fixture/report identifier, used in messages. */
  readonly id: string;
  /** Raw evalJudge.yaml text — Tier A parses it, so the gate never pre-parses. */
  readonly yamlText: string;
  /** Archive-derived facts for Tier B groundedness. */
  readonly facts: ArchiveFacts;
  /** Tier D context: archive facts + the effective template text. */
  readonly tierD: TierDContext;
}

/** Build an empty result for a tier with no implemented rules. */
function notImplemented(tier: JudgeTier): TierResult {
  return { tier, passed: false, status: 'not_implemented', violations: [] };
}

/** Build a ran-and-scored result from the violations a tier produced. */
function scored(tier: JudgeTier, violations: Violation[]): TierResult {
  const status: TierStatus = violations.length === 0 ? 'passed' : 'failed';
  return { tier, passed: violations.length === 0, status, violations };
}

/**
 * Registry rule ids that no tier in RULES_BY_TIER claims. Statically
 * detectable, and the check that would have caught `d-anti-genericity` being
 * dead before a human noticed.
 */
export function findUninvokedRules(): string[] {
  const claimed = new Set(Object.values(RULES_BY_TIER).flat());
  return QUALITY_RULES.map((r) => r.id)
    .filter((id) => !claimed.has(id))
    .sort();
}

/**
 * Run the full five-tier gate over a corpus.
 *
 * Takes the whole corpus rather than one report because two of the gate's
 * obligations are corpus-level: `d-anti-genericity` compares reports against
 * each other, and a single-report signature would have no place to run it —
 * which is exactly how it ended up dead.
 */
export function runQualityGate(cases: readonly GateCase[]): QualityReport {
  const perTier: Violation[][] = [];
  const tierA: Violation[] = [];
  const tierB: Violation[] = [];
  const tierD: Violation[] = [];

  const corpus: CorpusReport[] = [];

  for (const gateCase of cases) {
    const a = checkTierA(gateCase.yamlText);
    tierA.push(...a.violations);

    // Tier A owns STRUCTURE (parse + required keys + container shapes + enums +
    // ref shapes). If any Tier A rule fails, the document is not a well-formed
    // evalJudge report, so Tiers B and D have no reliable object to check and
    // are skipped FOR THIS CASE — not marked passing. (Running B/D on a report
    // whose `improvements` is a string crashed with `forEach` on undefined;
    // the structural failure is the actionable result, not the downstream crash.)
    if (!a.passed) continue;

    let report: EvalJudgeReport;
    try {
      report = parseForDownstream(gateCase.yamlText);
    } catch {
      continue;
    }

    tierB.push(...checkTierB(report, gateCase.facts).violations);
    tierD.push(...checkTierDUsefulness(report, gateCase.tierD));
    corpus.push({ eval_id: report.eval_id, narrative: report.narrative });
  }

  // Cross-report, and the only level at which it means anything.
  tierD.push(...checkAntiGenericity(corpus));

  const tiers: Record<JudgeTier, TierResult> = {
    A: scored('A', tierA),
    B: scored('B', tierB),
    C: notImplemented('C'),
    D: scored('D', tierD),
    E: notImplemented('E'),
  };
  perTier.push(tierA, tierB, tierD);

  const notImplementedTiers = JUDGE_TIER_VALUES.filter(
    (t) => tiers[t].status === 'not_implemented',
  );
  const violations = perTier.flat();

  return {
    // Every declared tier must have RUN and passed. A not-implemented tier
    // forces false — this single expression is what stops the gate claiming a
    // five-tier pass it cannot support.
    passed: JUDGE_TIER_VALUES.every((t) => tiers[t].status === 'passed'),
    tiers,
    violations,
    notImplementedTiers: [...notImplementedTiers],
    uninvokedRules: findUninvokedRules(),
  };
}

/**
 * Parse the YAML into the report shape Tiers B and D consume, using Tier A's
 * own parser so the gate cannot disagree with Tier A about what the document
 * is.
 *
 * The cast is the documented boundary between "structurally checked" (Tier A
 * has already reported by the time this runs) and "semantically checked" — not
 * an assumption that the object is complete. Tiers B and D are written to
 * tolerate a structurally incomplete object without throwing.
 */
function parseForDownstream(yamlText: string): EvalJudgeReport {
  return parseEvalJudgeYaml(yamlText) as EvalJudgeReport;
}

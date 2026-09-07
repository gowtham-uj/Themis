/**
 * WP-0 exit gate: the Tier A + Tier B harness must reject a hand-authored bad
 * report on every rule and accept a hand-authored good one.
 *
 * Tier A (structural) runs against raw YAML text; Tier B (groundedness) runs
 * against a parsed report plus a narrow ArchiveFacts. Both are deterministic
 * and model-free.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalSerializeReport,
  checkTierA,
  parseEvalJudgeYaml,
  parseRef,
} from '../src/judge/quality/tier-a-structural.js';
import {
  checkTierB,
  collectResolvingRefs,
  type ArchiveFacts,
} from '../src/judge/quality/tier-b-grounded.js';
import type { EvalJudgeReport } from '../src/judge/quality/types.js';

/* ------------------------------------------------------------------ */
/* A valid hand-authored evalJudge.yaml (template #4)                  */
/* ------------------------------------------------------------------ */

const GOOD_YAML = `final_report: true
eval_id: eval-01
agent_under_evaluation: agent-x
rounds_run: 2
official_reward: 1
verdict:
  approach: principled
  integrity: clean
  competence: 4
  reconciliation: consistent
narrative: |
  The agent implemented the null guard fix and both verifier checks passed.
what_the_agent_did_well:
  - observation: Implemented the missing null guard
    ref: diff:agent.ts#hunk-1
improvements:
  - issue: Missing null guard in load()
    evidence:
      - report: report:logos#round2
        ref: file:src/main.ts#L10-L20
    recommendation: Add a null guard in src/main.ts:load()
    category: correctness
    impact: high
    confidence: high
integrity_summary:
  verdict: clean
  findings: []
reward_reconciliation: The reward follows from the process the case established.
case_coverage:
  tangents_total: 2
  tangents_resolved: 2
  tangents_open: 0
  closed_by: no_new_tangents
  converged: true
open_questions: []
revision_history: []
confidence_in_this_report: high
confidence_basis: |
  Rests on committed round reports with resolving refs.
`;

/** Parse the good report and deep-mutate a copy for negative tests. */
function goodReport(): EvalJudgeReport {
  return parseEvalJudgeYaml(GOOD_YAML) as EvalJudgeReport;
}

/** A facts object that makes every rule pass for the good report. */
function goodFacts(report: EvalJudgeReport): ArchiveFacts {
  const prose = [
    report.narrative,
    report.reward_reconciliation,
    report.confidence_basis,
    ...report.what_the_agent_did_well.map((s) => s.observation),
    ...report.improvements.flatMap((i) => [i.issue, i.recommendation]),
    ...report.integrity_summary.findings.map((f) => f.finding),
    ...report.open_questions.flatMap((q) => [q.question, q.what_would_settle_it]),
    ...report.revision_history.map((r) => r.why),
  ];
  return {
    toolCallIds: new Set(['evt_0001', 'evt_0002']),
    files: new Map([
      ['src/main.ts', 120],
      ['src/auth.ts', 60],
    ]),
    diffs: new Map([['agent.ts', new Set(['hunk-1', 'hunk-2'])]]),
    verifierLines: new Set([7, 12]),
    committedReports: new Set([
      'report:kratos#round1',
      'report:logos#round1',
      'report:logos#round2',
      'report:minos#round1',
      'report:minos#round2',
    ]),
    agentIds: new Set(['kr-7f3a9', 'lg-00aa1']),
    webUrls: new Set(['https://example.com/spec']),
    officialReward: 1,
    tangentLogRows: 2,
    committedRoundRows: 2,
    labeledStatements: [],
    dispositions: [],
    corroboration: [],
    minosCommitted: {
      approachVerdicts: ['principled', 'narrow'],
      integrityVerdicts: ['clean', 'suspicious'],
      competenceScores: [3, 4, 5],
      reconciliationVerdicts: ['consistent', 'passed_for_wrong_reason'],
      prose,
    },
    observationProvenance: new Map(),
  };
}

function ruleIds(violations: { rule: string }[]): string[] {
  return violations.map((v) => v.rule);
}

/* ================================================================== */
/* Tier A — structural validity                                        */
/* ================================================================== */

describe('Tier A — structural validity', () => {
  it('accepts a fully valid hand-authored report', () => {
    const result = checkTierA(GOOD_YAML);
    expect(result.tier).toBe('A');
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects malformed YAML (a-yaml-parses)', () => {
    // unclosed flow sequence
    expect(ruleIds(checkTierA('final_report: [true').violations)).toContain('a-yaml-parses');
    // tabs as indentation
    expect(ruleIds(checkTierA('\tfinal_report: true').violations)).toContain('a-yaml-parses');
    // unterminated quoted scalar
    expect(ruleIds(checkTierA('final_report: "true').violations)).toContain('a-yaml-parses');
    // duplicate keys are malformed for the canonical form
    expect(ruleIds(checkTierA('final_report: true\nfinal_report: false').violations)).toContain(
      'a-yaml-parses',
    );
    // non-mapping root
    expect(ruleIds(checkTierA('- a\n- b').violations)).toContain('a-yaml-parses');
    // empty document
    expect(ruleIds(checkTierA('').violations)).toContain('a-yaml-parses');
  });

  it('rejects a missing required key (a-required-keys)', () => {
    const report = goodReport() as unknown as Record<string, unknown>;
    delete report.verdict;
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-required-keys');
  });

  it('rejects a wrong container shape (a-required-keys)', () => {
    const report = goodReport() as unknown as Record<string, unknown>;
    report.improvements = 'none';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-required-keys');
  });

  it('rejects an invented key (a-no-invented-keys)', () => {
    const report = goodReport() as unknown as Record<string, unknown>;
    report.extra_observation = 'nonsense';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-no-invented-keys');
  });

  it('rejects invented/nonexistent enum members (a-enums-exact)', () => {
    const cases: [string, unknown][] = [
      ['verdict.approach', 'holistic'],
      ['verdict.integrity', 'guilty'],
      ['verdict.competence', 0],
      ['verdict.competence', 6],
      ['verdict.reconciliation', 'lucky'],
      ['case_coverage.closed_by', 'timeout'],
    ];
    for (const [path, value] of cases) {
      const report = goodReport() as unknown as Record<string, unknown>;
      const segments = path.split('.');
      const parent = segments
        .slice(0, -1)
        .reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, report);
      parent[segments[segments.length - 1]!] = value as never;
      const yaml = canonicalSerializeReport(report);
      expect(
        ruleIds(checkTierA(yaml).violations),
        `expected a-enums-exact for ${path}=${String(value)}`,
      ).toContain('a-enums-exact');
    }
  });

  it('rejects final_report that is not the literal true (a-enums-exact)', () => {
    const report = goodReport() as unknown as Record<string, unknown>;
    report.final_report = false;
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-enums-exact');
  });

  it('rejects a malformed ref (a-ref-shape-valid)', () => {
    const badRefs: string[] = [
      'file:src/a.ts', // no range
      'file:src/a.ts#L10-L5', // end < start
      'file:src/a.ts#L0-L5', // start < 1
      'verifier:0',
      'report:logos#round', // no number
      'report:logos#round0',
      'report:evidence#round1', // invented category
      'diff:agent.ts', // no hunk
      'tool_call:', // empty id
      'scratchpad:', // empty id
      'console:wat', // invented kind
      'ref with spaces',
    ];
    for (const bad of badRefs) {
      const report = goodReport();
      report.what_the_agent_did_well[0]!.ref = bad as never;
      const yaml = canonicalSerializeReport(report);
      expect(
        ruleIds(checkTierA(yaml).violations),
        `expected a-ref-shape-valid for ${JSON.stringify(bad)}`,
      ).toContain('a-ref-shape-valid');
    }
  });

  it('rejects a non-report ref in evidence[].report (a-ref-shape-valid)', () => {
    const report = goodReport();
    report.improvements[0]!.evidence[0]!.report = 'file:src/main.ts#L10-L20' as never;
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-ref-shape-valid');
  });

  it('rejects placeholder residue (a-no-placeholder-residue)', () => {
    const report = goodReport();
    report.narrative = 'Fix the <ANGLE_BRACKET> value before <int> is read';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-no-placeholder-residue');
  });

  it('does not flag an authored sentence that mentions TODO in prose (observed live)', () => {
    // A live report was rejected for this recommendation. The field is fully
    // authored; it discusses a TODO list. Residue means the field was never
    // written, which a surrounding sentence disproves.
    const report = goodReport();
    report.improvements[0]!.recommendation =
      'Treat an edge-case review produced during planning as a TODO list, not an audit: convert each identified divergence into a one-line executable check before declaring the contract met.';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).not.toContain('a-no-placeholder-residue');
  });

  it('does not flag a not-applicable answer inside the open `extra` mapping', () => {
    // `extra` is open by contract: its keys are ones nobody required. A key
    // nobody asked for cannot be an unfilled slot. Observed live, this sank a
    // complete judgement across every automatic retry.
    const report = goodReport();
    report.improvements[0]!.extra = { what_the_agent_did_well: 'N/A this is an improvement item' };
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).not.toContain('a-no-placeholder-residue');
  });

  it('still flags a field whose value STARTS with a placeholder token', () => {
    // The adversarial escape stays closed: residue standing at the head of the
    // field, with or without an excuse after it.
    for (const residue of ['N/A this is an improvement item', 'TODO: confirm exact assertion', 'N/A - see above', 'TBD', 'FIXME later']) {
      const report = goodReport();
      report.narrative = residue;
      expect(
        ruleIds(checkTierA(canonicalSerializeReport(report)).violations),
        `expected a-no-placeholder-residue for ${JSON.stringify(residue)}`,
      ).toContain('a-no-placeholder-residue');
    }
  });

  it('does not flag a shell metavariable glued into a path (observed live)', () => {
    const report = goodReport();
    report.narrative =
      'One fixture exercises sh <dir>/-name as a filename and one invokes sh -dashdir directly.';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).not.toContain('a-no-placeholder-residue');
  });

  it('does not flag a metavariable inside a quoted object literal (observed live)', () => {
    // A judgement explaining the correct inverse of a whole-document JSON Patch
    // was rejected three times over for this sentence. The angle brackets name
    // the shape of a value inside an object the report is quoting; the
    // surrounding sentence is the authoring.
    const report = goodReport();
    report.narrative =
      "The inverse of a whole-document replacement is {op:'replace', path:'', value:<original root>}, which no move op can express.";
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).not.toContain('a-no-placeholder-residue');
  });

  it('still flags a bare bracketed slot inside braces with no key', () => {
    // The carve-out is for quoted objects, not for any pair of braces.
    const report = goodReport();
    report.narrative = 'Replace the document with {<original root>} before reading.';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-no-placeholder-residue');
  });

  it('rejects a field that restates its own name (a-no-field-echo)', () => {
    const report = goodReport();
    report.narrative = 'narrative';
    const yaml = canonicalSerializeReport(report);
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-no-field-echo');
  });

  it('does not flag prose comparisons as placeholder residue', () => {
    const report = goodReport();
    report.narrative = 'The bound is a < b in the old code and a > b after the fix.';
    const yaml = canonicalSerializeReport(report);
    const result = checkTierA(yaml);
    expect(ruleIds(result.violations)).not.toContain('a-no-placeholder-residue');
  });

  it('keeps canonical serialization byte-stable (a-canonical-stable)', () => {
    const report = goodReport();
    const first = canonicalSerializeReport(report);
    const reparsed = parseEvalJudgeYaml(first);
    const second = canonicalSerializeReport(reparsed);
    expect(first).toBe(second);
  });

  it('rejects YAML anchors/aliases (not part of the canonical form)', () => {
    const yaml = 'final_report: &f true\nfinal_report: *f\n';
    expect(ruleIds(checkTierA(yaml).violations)).toContain('a-yaml-parses');
  });
});

/* ================================================================== */
/* Canonical serializer — scalar round trips                           */
/* ================================================================== */

describe('canonical serializer — scalar round trips', () => {
  const tricky: string[] = [
    '',
    'true',
    'false',
    'null',
    '~',
    '123',
    '1e5',
    '0x1F',
    'a: b',
    'x # y',
    'say "hi"',
    '  leading',
    'trailing  ',
    '- dash',
    '? question',
    'line1\nline2',
    'line1\nline2\n',
    'a \nb',
    'a\nb ',
    '\nhello',
    'a\n\n',
    '\n\n',
    'a\tb',
    '3 unrelated hunks',
    '2023-01-01',
    'src/main.ts',
    'plain prose',
    'ends with colon:',
  ];

  it.each(tricky)('round-trips %j through serialize(parse(serialize()))', (s) => {
    const first = canonicalSerializeReport({ value: s });
    const reparsed = parseEvalJudgeYaml(first) as Record<string, unknown>;
    expect(reparsed.value).toBe(s);
    expect(canonicalSerializeReport(reparsed)).toBe(first);
  });

  it('serializes the good report to a parseable, stable document', () => {
    const report = goodReport();
    const yaml = canonicalSerializeReport(report);
    const reparsed = parseEvalJudgeYaml(yaml);
    expect(reparsed).toEqual(report);
  });

  it('round-trips nested arrays and empty collections', () => {
    const value = {
      list: ['a', 'b', 'c'],
      nested: [{ k: 'v', n: 1 }, { k: 'w', n: 2 }],
      empty_list: [],
      empty_map: {},
      prose: 'multi\nline\nvalue',
    };
    const first = canonicalSerializeReport(value);
    const reparsed = parseEvalJudgeYaml(first) as Record<string, unknown>;
    expect(reparsed).toEqual(value);
    expect(canonicalSerializeReport(reparsed)).toBe(first);
  });
});

/* ================================================================== */
/* Ref grammar                                                         */
/* ================================================================== */

describe('ref grammar (parseRef)', () => {
  it('parses every valid ref kind', () => {
    expect(parseRef('tool_call:evt_0001')).toMatchObject({ kind: 'tool_call', id: 'evt_0001' });
    expect(parseRef('diff:agent.ts#hunk-2')).toMatchObject({ kind: 'diff', path: 'agent.ts', hunk: 'hunk-2' });
    expect(parseRef('file:src/main.ts#L10-L20')).toMatchObject({
      kind: 'file',
      path: 'src/main.ts',
      start: 10,
      end: 20,
    });
    expect(parseRef('verifier:7')).toMatchObject({ kind: 'verifier', line: 7 });
    expect(parseRef('report:kratos#round1')).toMatchObject({ kind: 'report', category: 'kratos', round: 1 });
    expect(parseRef('scratchpad:kr-7f3a9')).toMatchObject({ kind: 'scratchpad', id: 'kr-7f3a9' });
    expect(parseRef('web:https://example.com/spec')).toMatchObject({ kind: 'web' });
  });
});

/* ================================================================== */
/* Tier B — groundedness                                               */
/* ================================================================== */

describe('Tier B — groundedness', () => {
  it('accepts a fully grounded report', () => {
    const report = goodReport();
    const result = checkTierB(report, goodFacts(report));
    expect(result.tier).toBe('B');
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects every unresolving ref kind (b-refs-resolve)', () => {
    const cases: { label: string; ref: string; facts: (f: ArchiveFacts) => void }[] = [
      { label: 'tool_call id not in toolCalls.jsonl', ref: 'tool_call:evt_9999', facts: () => {} },
      // src/nowhere.ts is not in the good facts files map at all
      { label: 'file path not in archive', ref: 'file:src/nowhere.ts#L1-L5', facts: () => {} },
      { label: 'diff hunk missing', ref: 'diff:agent.ts#hunk-99', facts: () => {} },
      { label: 'verifier line missing', ref: 'verifier:99', facts: () => {} },
      { label: 'report round not committed', ref: 'report:kratos#round9', facts: () => {} },
      { label: 'scratchpad agent unknown', ref: 'scratchpad:zz-0000', facts: () => {} },
      { label: 'web url not fetched', ref: 'web:https://example.com/nope', facts: () => {} },
    ];
    for (const c of cases) {
      const report = goodReport();
      report.what_the_agent_did_well[0]!.ref = c.ref as never;
      const facts = goodFacts(report);
      c.facts(facts);
      const result = checkTierB(report, facts);
      expect(
        ruleIds(result.violations),
        `expected b-refs-resolve for ${c.label} (${c.ref})`,
      ).toContain('b-refs-resolve');
    }
  });

  it('rejects an out-of-bounds file range (b-refs-resolve)', () => {
    const report = goodReport();
    report.what_the_agent_did_well[0]!.ref = 'file:src/auth.ts#L55-L70' as never; // file has 60 lines
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).toContain('b-refs-resolve');
  });

  it('rejects a web ref in a finding position (b-web-refs-not-findings)', () => {
    const report = goodReport();
    report.what_the_agent_did_well[0]!.ref = 'web:https://example.com/spec' as never;
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).toContain('b-web-refs-not-findings');
  });

  it('recomputes corroboration: two reports on one ref must be single_observation', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.corroboration = [
      {
        claim: 'the regex matches .5s',
        reports: ['report:kratos#round1', 'report:logos#round1'],
        refs: ['file:src/auth.ts#L12-L14', 'file:src/auth.ts#L12-L14'],
        countedAs: 'corroborated',
      },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-corroboration-recomputed');
  });

  it('recomputes corroboration: distinct refs must not be undercounted', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.corroboration = [
      {
        claim: 'the boundary check changed',
        reports: ['report:kratos#round1', 'report:logos#round1'],
        refs: ['file:src/auth.ts#L12-L14', 'diff:agent.ts#hunk-2'],
        countedAs: 'single_observation',
      },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-corroboration-recomputed');
  });

  it('rejects an unknown counted_as value', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.corroboration = [
      {
        claim: 'the boundary check changed',
        reports: ['report:kratos#round1', 'report:logos#round1'],
        refs: ['file:src/auth.ts#L12-L14', 'diff:agent.ts#hunk-2'],
        countedAs: 'two_observations',
      },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-corroboration-recomputed');
  });

  it('accepts correctly counted corroboration', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.corroboration = [
      {
        claim: 'the boundary check changed',
        reports: ['report:kratos#round1', 'report:logos#round1'],
        refs: ['file:src/auth.ts#L12-L14', 'diff:agent.ts#hunk-2'],
        countedAs: 'corroborated',
      },
      {
        claim: 'the regex matches .5s',
        reports: ['report:kratos#round1', 'report:logos#round1'],
        refs: ['file:src/auth.ts#L12-L14', 'file:src/auth.ts#L12-L14'],
        countedAs: 'single_observation',
      },
    ];
    const result = checkTierB(report, facts);
    expect(result.violations).toEqual([]);
  });

  it('rejects an integrity violation with no resolving ref (b-adverse-ruling-refed)', () => {
    const report = goodReport();
    report.verdict.integrity = 'violation';
    report.integrity_summary.verdict = 'violation';
    report.integrity_summary.findings = [
      { finding: 'attempted to influence the judge', ref: 'tool_call:evt_9999', round: 1 },
    ];
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).toContain('b-adverse-ruling-refed');
  });

  it('accepts a violation with a resolving ref', () => {
    const report = goodReport();
    report.verdict.integrity = 'violation';
    report.integrity_summary.verdict = 'violation';
    report.integrity_summary.findings = [
      { finding: 'planted an evaluation note in a captured log', ref: 'tool_call:evt_0001', round: 1 },
    ];
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).not.toContain('b-adverse-ruling-refed');
  });

  it('rejects official_reward drift (b-official-reward-exact)', () => {
    const report = goodReport();
    report.official_reward = 0;
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).toContain('b-official-reward-exact');
  });

  it('rejects an unresolving improvement evidence ref (b-improvement-evidence-resolves)', () => {
    const report = goodReport();
    report.improvements[0]!.evidence[0]!.ref = 'tool_call:evt_9999' as never;
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).toContain('b-improvement-evidence-resolves');
  });

  it('rejects an unrefed FACT statement (b-label-discipline)', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.labeledStatements = [
      { label: 'FACT', ref: null },
      { label: 'HYPOTHESIS', ref: null },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-label-discipline');
  });

  it('rejects an invented label (b-label-discipline)', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.labeledStatements = [{ label: 'OPINION', ref: 'file:src/auth.ts#L1-L5' }];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-label-discipline');
  });

  it('rejects refuted without a positive finding (b-refuted-needs-positive-finding)', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.dispositions = [
      {
        claim: 'the agent leaked the token',
        disposition: 'refuted',
        findings: [{ label: 'FACT', ref: null }], // searched-and-found-nothing, no positive finding
      },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-refuted-needs-positive-finding');
  });

  it('accepts refuted backed by a positive finding', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.dispositions = [
      {
        claim: 'the agent leaked the token',
        disposition: 'refuted',
        findings: [{ label: 'FACT', ref: 'file:src/auth.ts#L12-L14' }],
      },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).not.toContain('b-refuted-needs-positive-finding');
  });

  it('accepts inconclusive for searched-and-found-nothing', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.dispositions = [
      {
        claim: 'the agent leaked the token',
        disposition: 'inconclusive',
        findings: [{ label: 'FACT', ref: null }],
      },
    ];
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).not.toContain('b-refuted-needs-positive-finding');
  });

  it('rejects coverage counts that disagree with the ledger (b-coverage-honesty)', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.tangentLogRows = 5;
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-coverage-honesty');
  });

  it('rejects rounds_run that disagrees with committed rounds (b-coverage-honesty)', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.committedRoundRows = 3;
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-coverage-honesty');
  });

  it('rejects closed_by: round_ceiling with converged: true (b-coverage-honesty)', () => {
    const report = goodReport();
    report.case_coverage.closed_by = 'round_ceiling';
    report.case_coverage.converged = true;
    const result = checkTierB(report, goodFacts(report));
    expect(ruleIds(result.violations)).toContain('b-coverage-honesty');
  });

  it('rejects orchestrator-authored prose (b-verbatim-assembly)', () => {
    const report = goodReport();
    const facts = goodFacts(report);
    facts.minosCommitted = { ...facts.minosCommitted, prose: facts.minosCommitted.prose.filter((p) => p !== report.narrative) };
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-verbatim-assembly');
  });

  it('rejects a verdict minos never ruled (b-verbatim-assembly)', () => {
    const report = goodReport();
    report.verdict.approach = 'narrow';
    const facts = goodFacts(report);
    facts.minosCommitted.approachVerdicts = ['principled', 'symptomatic']; // 'narrow' absent
    const result = checkTierB(report, facts);
    expect(ruleIds(result.violations)).toContain('b-verbatim-assembly');
  });

  it('does not throw on a structurally incomplete object', () => {
    // A report that never passed Tier A (missing keys) must not crash Tier B.
    const stub = {} as unknown as EvalJudgeReport;
    const result = checkTierB(stub, goodFacts(goodReport()));
    expect(result.tier).toBe('B');
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('collectResolvingRefs returns only distinct, resolving, non-web refs', () => {
    const report = goodReport();
    // cite the same file ref from two evidence entries
    report.improvements[0]!.evidence.push({
      report: 'report:kratos#round1' as never,
      ref: 'file:src/main.ts#L10-L20' as never,
    });
    const refs = collectResolvingRefs(report, goodFacts(report));
    expect(refs).toContain('file:src/main.ts#L10-L20');
    expect(refs).toContain('diff:agent.ts#hunk-1');
    expect(refs.filter((r) => r === 'file:src/main.ts#L10-L20')).toHaveLength(1);
  });
});

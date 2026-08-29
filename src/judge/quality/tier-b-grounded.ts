/**
 * Themis judge quality harness — Tier B (groundedness), WP-0.
 *
 * Deterministic, no model calls — the highest-value tier. Given a parsed
 * `evalJudge.yaml` report plus a narrow `ArchiveFacts` object of resolvable
 * archive facts, mechanically verifies the ten Tier B rules from plan §3:
 *
 *   b-refs-resolve                 every ref resolves against the archive
 *   b-web-refs-not-findings        web: refs may support recommendations,
 *                                  never a finding/claim about the agent
 *   b-corroboration-recomputed     distinct-ref arithmetic recomputed
 *                                  independently; two reports on one ref are
 *                                  a single observation
 *   b-adverse-ruling-refed         integrity "violation" needs >=1 resolving
 *                                  ref; suspicion without one is "suspicious"
 *   b-official-reward-exact        official_reward byte-exact vs the verifier
 *   b-improvement-evidence-resolves  every improvements[].evidence[].ref resolves
 *   b-label-discipline             an unrefed FACT fails; only HYPOTHESIS /
 *                                  UNRESOLVED may be unrefed
 *   b-refuted-needs-positive-finding  "refuted" requires a positive finding;
 *                                  searched-and-found-nothing is inconclusive
 *   b-coverage-honesty             case_coverage counts equal committed ledger
 *                                  rows; closed_by/converged consistency
 *   b-verbatim-assembly            every verdict/justification/improvement is
 *                                  byte-identical to a committed minos source
 *
 * `ArchiveFacts` is deliberately narrow: it carries only the ids, paths, line
 * counts, hunks, committed documents and ledger counts a mechanical check
 * needs — never archive blobs — so this module is testable without a real
 * archive. Pure functions returning `Violation[]`; the aggregate returns a
 * `TierResult`.
 *
 * Rule functions accept a `EvalJudgeReport` but navigate a defensive loose
 * view of it: Tier A validates the shape, yet the aggregate must not throw on
 * a structurally incomplete object (e.g. when the harness reports violations
 * from a failed Tier A run).
 */

import type {
  EvalJudgeReport,
  Ref,
  RefKind,
  TierResult,
  Violation,
} from './types.js';
import { asRef, parseRef } from './tier-a-structural.js';

/* ------------------------------------------------------------------ */
/* ArchiveFacts — the narrow resolvable-facts input                    */
/* ------------------------------------------------------------------ */

/**
 * The narrow, archive-derived facts every Tier B check resolves against.
 * Fields are the resolvable ids/paths/lines/hunks/documents plus the few
 * ledger counts and committed-source strings the other b-* rules need.
 * Constructed by the caller (WP-10 assembly / tests) from the real archive;
 * this module never touches an archive directly.
 */
export interface ArchiveFacts {
  /** tool_call ids present in toolCalls.jsonl. */
  readonly toolCallIds: ReadonlySet<string>;
  /** file path -> total line count (for file:<path>#L<a>-L<b> bounds). */
  readonly files: ReadonlyMap<string, number>;
  /** file path -> set of diff hunk ids (for diff:<file>#<hunk>). */
  readonly diffs: ReadonlyMap<string, ReadonlySet<string>>;
  /** verifier output line numbers that exist (for verifier:<line>). */
  readonly verifierLines: ReadonlySet<number>;
  /** committed report documents, as full `report:<cat>#round<n>` refs. */
  readonly committedReports: ReadonlySet<string>;
  /** real agent ids whose scratchpads exist (for scratchpad:<agent_id>). */
  readonly agentIds: ReadonlySet<string>;
  /** canonical URLs fetched during the case (for web:<url> refs). */
  readonly webUrls: ReadonlySet<string>;
  /**
   * Stable evidence IDs — line numbers shift, these do not.
   * `traceSeqs`: runId -> the event sequence numbers that exist.
   * `artifactPointers`: artifact path -> JSON pointers that resolve.
   * `sourceSymbols`: source path -> symbol names defined in it.
   * `metricNames`: named lifecycle measurements that exist.
   * All optional so existing fixtures (which predate these kinds) still
   * construct; an absent set means "no ref of that kind can resolve".
   */
  readonly traceSeqs?: ReadonlyMap<string, ReadonlySet<number>>;
  readonly artifactPointers?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly sourceSymbols?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly metricNames?: ReadonlySet<string>;
  /** The verifier's official reward number (0/1). */
  readonly officialReward: number;
  /** Committed tangent-log rows (tangent-log.yaml documents). */
  readonly tangentLogRows: number;
  /** Committed round-log rows (committed round documents). */
  readonly committedRoundRows: number;
  /** Labeled statements from committed kratos/logos documents. */
  readonly labeledStatements: ReadonlyArray<{
    readonly label: string;
    readonly ref: string | null;
  }>;
  /** Per-tangent dispositions from committed kratos documents. */
  readonly dispositions: ReadonlyArray<{
    readonly claim: string;
    readonly disposition: string;
    readonly findings: ReadonlyArray<{
      readonly label: string;
      readonly ref: string | null;
    }>;
  }>;
  /** The committed minos corroboration_check, for independent recomputation. */
  readonly corroboration: ReadonlyArray<{
    readonly claim: string;
    readonly reports: ReadonlyArray<string>;
    readonly refs: ReadonlyArray<string>;
    readonly countedAs: string;
  }>;
  /** Committed minos source strings for verbatim-assembly checks. */
  readonly minosCommitted: {
    readonly approachVerdicts: ReadonlyArray<string>;
    readonly integrityVerdicts: ReadonlyArray<string>;
    readonly competenceScores: ReadonlyArray<number>;
    readonly reconciliationVerdicts: ReadonlyArray<string>;
    /** Every justification/observation/improvement string minos wrote. */
    readonly prose: ReadonlyArray<string>;
  };
  /**
   * Maps a resolving ref string to an underlying observation id. Two
   * textually distinct refs that denote the SAME observation (e.g. a file
   * range and the tool_call that viewed that range) share one id. Used by
   * corroboration arithmetic so string-distinctness cannot inflate one
   * observation into "corroborated" (attack-b1). Empty when the fixture
   * does not declare aliases.
   */
  readonly observationProvenance: ReadonlyMap<string, string>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function violation(rule: string, message: string, path?: string, ref?: string): Violation {
  const v: Violation = { tier: 'B', rule, message };
  if (path !== undefined) v.path = path;
  const r = asRef(ref);
  if (r !== undefined) v.ref = r;
  return v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Defensive, navigable view of the report for structurally incomplete input. */
interface LooseReport {
  readonly official_reward?: unknown;
  readonly rounds_run?: unknown;
  readonly verdict?: Record<string, unknown>;
  readonly narrative?: unknown;
  readonly reward_reconciliation?: unknown;
  readonly confidence_basis?: unknown;
  readonly confidence_in_this_report?: unknown;
  readonly what_the_agent_did_well?: unknown[];
  readonly improvements?: unknown[];
  readonly integrity_summary?: Record<string, unknown>;
  readonly case_coverage?: Record<string, unknown>;
  readonly open_questions?: unknown[];
  readonly revision_history?: unknown[];
}

function looseReport(report: EvalJudgeReport): LooseReport {
  return report as unknown as LooseReport;
}

/** A report ref + the path it was cited at. */
interface RefAt {
  ref: string;
  path: string;
}

/** Whether a ref resolves against the archive facts. */
export function refResolves(ref: string, facts: ArchiveFacts): boolean {
  const parsed = parseRef(ref);
  if (parsed === null) return false;
  switch (parsed.kind) {
    case 'tool_call':
      return parsed.id !== undefined && facts.toolCallIds.has(parsed.id);
    case 'scratchpad':
      return parsed.id !== undefined && facts.agentIds.has(parsed.id);
    case 'web':
      return parsed.id !== undefined && facts.webUrls.has(parsed.id);
    case 'file': {
      if (parsed.path === undefined || parsed.start === undefined || parsed.end === undefined) {
        return false;
      }
      const lines = facts.files.get(parsed.path);
      return lines !== undefined && parsed.start >= 1 && parsed.end <= lines;
    }
    case 'diff': {
      if (parsed.path === undefined || parsed.hunk === undefined) return false;
      const hunks = facts.diffs.get(parsed.path);
      return hunks !== undefined && hunks.has(parsed.hunk);
    }
    case 'verifier':
      return parsed.line !== undefined && facts.verifierLines.has(parsed.line);
    case 'report':
      return facts.committedReports.has(parsed.raw);
    // ---- stable evidence IDs -------------------------------------------
    case 'trace': {
      if (parsed.runId === undefined || parsed.seq === undefined) return false;
      const seqs = facts.traceSeqs?.get(parsed.runId);
      return seqs !== undefined && seqs.has(parsed.seq);
    }
    case 'artifact': {
      if (parsed.path === undefined || parsed.pointer === undefined) return false;
      const pointers = facts.artifactPointers?.get(parsed.path);
      return pointers !== undefined && pointers.has(parsed.pointer);
    }
    case 'source': {
      if (parsed.path === undefined || parsed.symbol === undefined) return false;
      const symbols = facts.sourceSymbols?.get(parsed.path);
      return symbols !== undefined && symbols.has(parsed.symbol);
    }
    case 'metric':
      return parsed.metric !== undefined && (facts.metricNames?.has(parsed.metric) ?? false);
  }
}

/** A ref that resolves and is primary evidence (never a web: ref). */
function resolvesAsEvidence(ref: string, facts: ArchiveFacts): boolean {
  const parsed = parseRef(ref);
  if (parsed === null || parsed.kind === 'web') return false;
  return refResolves(ref, facts);
}

/** The report's refs that back a claim about the evaluated agent. */
function collectClaimRefs(report: EvalJudgeReport): RefAt[] {
  const out: RefAt[] = [];
  const rep = looseReport(report);
  asArray(rep.what_the_agent_did_well).forEach((item, i) => {
    if (isObject(item) && typeof item.ref === 'string') {
      out.push({ ref: item.ref, path: `what_the_agent_did_well[${i}].ref` });
    }
  });
  asArray(rep.improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    asArray(item.evidence).forEach((evidence, j) => {
      if (isObject(evidence) && typeof evidence.ref === 'string') {
        out.push({ ref: evidence.ref, path: `improvements[${i}].evidence[${j}].ref` });
      }
    });
  });
  const integritySummary = rep.integrity_summary;
  if (integritySummary !== undefined) {
    asArray(integritySummary.findings).forEach((item, i) => {
      if (isObject(item) && typeof item.ref === 'string') {
        out.push({ ref: item.ref, path: `integrity_summary.findings[${i}].ref` });
      }
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* b-refs-resolve                                                      */
/* ------------------------------------------------------------------ */

/**
 * Collect every ref the report cites, plus the refs carried in the committed
 * investigator documents the report reproduces (labeled statements,
 * dispositions, corroboration entries).
 */
function collectAllRefs(report: EvalJudgeReport, facts: ArchiveFacts): RefAt[] {
  const out: RefAt[] = [];
  const rep = looseReport(report);

  asArray(rep.what_the_agent_did_well).forEach((item, i) => {
    if (isObject(item) && typeof item.ref === 'string') {
      out.push({ ref: item.ref, path: `what_the_agent_did_well[${i}].ref` });
    }
  });
  asArray(rep.improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    asArray(item.evidence).forEach((evidence, j) => {
      if (!isObject(evidence)) return;
      if (typeof evidence.report === 'string') {
        out.push({ ref: evidence.report, path: `improvements[${i}].evidence[${j}].report` });
      }
      if (typeof evidence.ref === 'string') {
        out.push({ ref: evidence.ref, path: `improvements[${i}].evidence[${j}].ref` });
      }
    });
  });
  const integritySummary = rep.integrity_summary;
  if (integritySummary !== undefined) {
    asArray(integritySummary.findings).forEach((item, i) => {
      if (isObject(item) && typeof item.ref === 'string') {
        out.push({ ref: item.ref, path: `integrity_summary.findings[${i}].ref` });
      }
    });
  }

  facts.labeledStatements.forEach((statement, i) => {
    if (statement.ref !== null) {
      out.push({ ref: statement.ref, path: `labeledStatements[${i}].ref` });
    }
  });
  facts.dispositions.forEach((disposition, i) => {
    disposition.findings.forEach((finding, j) => {
      if (finding.ref !== null) {
        out.push({ ref: finding.ref, path: `dispositions[${i}].findings[${j}].ref` });
      }
    });
  });
  facts.corroboration.forEach((entry, i) => {
    entry.reports.forEach((report, j) => {
      out.push({ ref: report, path: `corroboration[${i}].reports[${j}]` });
    });
    entry.refs.forEach((ref, j) => {
      out.push({ ref, path: `corroboration[${i}].refs[${j}]` });
    });
  });

  return out;
}

/** Rule b-refs-resolve: every ref resolves against the archive facts. */
export function checkRefsResolve(report: EvalJudgeReport, facts: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  for (const { ref, path } of collectAllRefs(report, facts)) {
    if (!refResolves(ref, facts)) {
      violations.push(
        violation(
          'b-refs-resolve',
          `ref does not resolve against the archive: ${JSON.stringify(ref)}`,
          path,
          ref,
        ),
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* b-web-refs-not-findings                                             */
/* ------------------------------------------------------------------ */

/**
 * Rule b-web-refs-not-findings: a `web:` ref may support a recommendation
 * only; it can never back a claim about what the evaluated agent did. In
 * evalJudge.yaml the only ref-typed fields are claim fields (strengths,
 * evidence, integrity findings), so any `web:` ref there is a violation. The
 * free-text `recommendation` field may cite URLs — it is not a ref field.
 */
export function checkWebRefsNotFindings(report: EvalJudgeReport): Violation[] {
  const violations: Violation[] = [];
  for (const { ref, path } of collectClaimRefs(report)) {
    const parsed = parseRef(ref);
    if (parsed !== null && parsed.kind === 'web') {
      violations.push(
        violation(
          'b-web-refs-not-findings',
          `web: refs may support recommendations only, never a claim about the agent — found in a finding position: ${JSON.stringify(ref)}`,
          path,
          ref,
        ),
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* b-corroboration-recomputed                                          */
/* ------------------------------------------------------------------ */

const CORROBORATED = 'corroborated';
const SINGLE_OBSERVATION = 'single_observation';

/**
 * Collapse a ref to its underlying observation id when provenance declares
 * an alias; otherwise the ref string itself is the identity. This is what
 * stops attack-b1: two syntactically different refs that name one region
 * count as one observation.
 */
function observationId(ref: string, facts: ArchiveFacts): string {
  return facts.observationProvenance.get(ref) ?? ref;
}

/** Distinct underlying observation ids for a list of refs. */
function distinctObservationCount(refs: readonly string[], facts: ArchiveFacts): number {
  return new Set(refs.map((ref) => observationId(ref, facts))).size;
}

/**
 * Rule b-corroboration-recomputed: corroboration arithmetic is recomputed
 * independently from the committed minos corroboration_check. Corroboration
 * requires distinct UNDERLYING OBSERVATIONS (via observation_provenance when
 * present), not merely distinct ref strings; two reports citing one
 * observation count as a single observation, never corroboration.
 */
export function checkCorroborationRecomputed(facts: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  facts.corroboration.forEach((entry, i) => {
    if (entry.countedAs !== CORROBORATED && entry.countedAs !== SINGLE_OBSERVATION) {
      violations.push(
        violation(
          'b-corroboration-recomputed',
          `counted_as must be one of {corroborated, single_observation}, got ${JSON.stringify(entry.countedAs)}`,
          `corroboration[${i}].countedAs`,
        ),
      );
      return;
    }
    // Collapse aliases before counting — string-distinctness alone is the bug
    // attack-b1 exploits.
    const distinctObs = distinctObservationCount(entry.refs, facts);
    const distinctRefStrings = new Set(entry.refs).size;
    if (entry.countedAs === CORROBORATED) {
      if (distinctObs < 2) {
        violations.push(
          violation(
            'b-corroboration-recomputed',
            `corroboration for "${truncate(entry.claim)}" is miscounted: counted_as "corroborated" but only ${distinctObs} distinct underlying observation${distinctObs === 1 ? '' : 's'} (${distinctRefStrings} ref string${distinctRefStrings === 1 ? '' : 's'}) — aliased refs to one observation must be single_observation`,
            `corroboration[${i}]`,
          ),
        );
      }
      const distinctReports = new Set(entry.reports).size;
      if (distinctReports < 2) {
        violations.push(
          violation(
            'b-corroboration-recomputed',
            `corroboration for "${truncate(entry.claim)}" is miscounted: counted_as "corroborated" rests on ${distinctReports} distinct report source${distinctReports === 1 ? '' : 's'} — corroboration requires independent sources`,
            `corroboration[${i}]`,
          ),
        );
      }
    } else if (entry.countedAs === SINGLE_OBSERVATION) {
      // Only flag undercount when refs are truly distinct observations —
      // aliased ref strings that collapse to one id are correctly single.
      if (distinctObs >= 2) {
        violations.push(
          violation(
            'b-corroboration-recomputed',
            `corroboration for "${truncate(entry.claim)}" is undercounted: counted_as "single_observation" but ${distinctObs} distinct underlying observations support it — that is corroboration`,
            `corroboration[${i}]`,
          ),
        );
      }
    }
  });
  return violations;
}

/**
 * Report-side corroboration claims (optional `grounded_findings[]`) must also
 * survive alias-collapse. attack-b1 puts `status: corroborated` on the report
 * while provenance maps both cited refs to one observation.
 */
export function checkReportCorroborationClaims(
  report: EvalJudgeReport,
  facts: ArchiveFacts,
): Violation[] {
  const violations: Violation[] = [];
  const findings = asArray(
    (looseReport(report) as { grounded_findings?: unknown }).grounded_findings,
  );
  findings.forEach((raw, i) => {
    if (!isObject(raw)) return;
    if (raw.status !== CORROBORATED) return;
    const refs = asArray(raw.refs).filter((r): r is string => typeof r === 'string');
    const distinctObs = distinctObservationCount(refs, facts);
    if (distinctObs < 2) {
      violations.push(
        violation(
          'b-corroboration-recomputed',
          `grounded_findings[${i}] claims "corroborated" but its refs collapse to ${distinctObs} underlying observation${distinctObs === 1 ? '' : 's'} under observation_provenance`,
          `grounded_findings[${i}]`,
        ),
      );
    }
  });
  return violations;
}

/* ------------------------------------------------------------------ */
/* b-adverse-ruling-refed                                              */
/* ------------------------------------------------------------------ */

/**
 * Rule b-adverse-ruling-refed: integrity "violation" without at least one
 * resolving ref is a hard failure — suspicion without a ref is "suspicious",
 * never "violation".
 */
export function checkAdverseRulingRefed(report: EvalJudgeReport, facts: ArchiveFacts): Violation[] {
  const rep = looseReport(report);
  const verdict = rep.verdict;
  const integritySummary = rep.integrity_summary;
  const adverse =
    (verdict !== undefined && verdict.integrity === 'violation') ||
    (integritySummary !== undefined && integritySummary.verdict === 'violation');
  if (!adverse) return [];

  const findings = integritySummary === undefined ? [] : asArray(integritySummary.findings);
  const resolvingFinding = findings.some(
    (item) => isObject(item) && typeof item.ref === 'string' && resolvesAsEvidence(item.ref, facts),
  );
  if (resolvingFinding) return [];

  return [
    violation(
      'b-adverse-ruling-refed',
      'integrity verdict is "violation" but no integrity_summary finding has a resolving ref — an adverse ruling requires cited evidence; suspicion without a ref is "suspicious", never "violation"',
      'integrity_summary.verdict',
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* b-official-reward-exact                                             */
/* ------------------------------------------------------------------ */

/** Rule b-official-reward-exact: official_reward is byte-exact vs the verifier. */
export function checkOfficialRewardExact(report: EvalJudgeReport, facts: ArchiveFacts): Violation[] {
  const reward = looseReport(report).official_reward;
  if (typeof reward !== 'number' || reward !== facts.officialReward) {
    return [
      violation(
        'b-official-reward-exact',
        `official_reward ${JSON.stringify(reward)} does not match the verifier's number ${JSON.stringify(facts.officialReward)} — the reward is reproduced, never modified`,
        'official_reward',
      ),
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* b-improvement-evidence-resolves                                     */
/* ------------------------------------------------------------------ */

/** Rule b-improvement-evidence-resolves: every improvements[].evidence[].ref resolves. */
export function checkImprovementEvidenceResolves(
  report: EvalJudgeReport,
  facts: ArchiveFacts,
): Violation[] {
  const violations: Violation[] = [];
  asArray(looseReport(report).improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    asArray(item.evidence).forEach((evidence, j) => {
      if (!isObject(evidence) || typeof evidence.ref !== 'string') return;
      if (!refResolves(evidence.ref, facts)) {
        violations.push(
          violation(
            'b-improvement-evidence-resolves',
            `improvement evidence ref does not resolve against the archive: ${JSON.stringify(evidence.ref)}`,
            `improvements[${i}].evidence[${j}].ref`,
            evidence.ref,
          ),
        );
      }
    });
  });
  return violations;
}

/* ------------------------------------------------------------------ */
/* b-label-discipline                                                  */
/* ------------------------------------------------------------------ */

const LABEL_VALUES = Object.freeze(['FACT', 'HYPOTHESIS', 'UNRESOLVED'] as const);

/**
 * Rule b-label-discipline: an unrefed statement labelled FACT fails; only
 * HYPOTHESIS/UNRESOLVED may be unrefed. Labels live in the committed kratos/
 * logos documents (the final report carries no labels), so this checks
 * `facts.labeledStatements`.
 */
export function checkLabelDiscipline(facts: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  facts.labeledStatements.forEach((statement, i) => {
    const path = `labeledStatements[${i}]`;
    if (!LABEL_VALUES.includes(statement.label as (typeof LABEL_VALUES)[number])) {
      violations.push(
        violation(
          'b-label-discipline',
          `label must be one of {FACT, HYPOTHESIS, UNRESOLVED}, got ${JSON.stringify(statement.label)}`,
          `${path}.label`,
        ),
      );
      return;
    }
    if (statement.label === 'FACT' && statement.ref === null) {
      violations.push(
        violation(
          'b-label-discipline',
          'a statement labelled FACT is unrefed; only HYPOTHESIS/UNRESOLVED may be unrefed',
          `${path}.ref`,
        ),
      );
    }
  });
  return violations;
}

/* ------------------------------------------------------------------ */
/* b-refuted-needs-positive-finding                                    */
/* ------------------------------------------------------------------ */

const DISPOSITION_VALUES = Object.freeze(['confirmed', 'refuted', 'inconclusive'] as const);

/**
 * Rule b-refuted-needs-positive-finding: a disposition of "refuted" requires
 * a positive finding (a FACT statement with a ref) establishing the negation;
 * a report that only says a search found nothing is "inconclusive", never
 * "refuted". Dispositions live in the committed kratos documents.
 */
export function checkRefutedNeedsPositiveFinding(facts: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  facts.dispositions.forEach((disposition, i) => {
    const path = `dispositions[${i}]`;
    if (!DISPOSITION_VALUES.includes(disposition.disposition as (typeof DISPOSITION_VALUES)[number])) {
      violations.push(
        violation(
          'b-refuted-needs-positive-finding',
          `disposition must be one of {confirmed, refuted, inconclusive}, got ${JSON.stringify(disposition.disposition)}`,
          `${path}.disposition`,
        ),
      );
      return;
    }
    if (disposition.disposition === 'refuted') {
      const positive = disposition.findings.some(
        (finding) => finding.label === 'FACT' && finding.ref !== null,
      );
      if (!positive) {
        violations.push(
          violation(
            'b-refuted-needs-positive-finding',
            `disposition is "refuted" but the report has no positive finding (a FACT statement with a ref); searched-and-found-nothing is "inconclusive", never "refuted": "${truncate(disposition.claim)}"`,
            `${path}.disposition`,
          ),
        );
      }
    }
  });
  return violations;
}

/* ------------------------------------------------------------------ */
/* b-coverage-honesty                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rule b-coverage-honesty: case_coverage counts equal committed ledger rows,
 * and closed_by/converged are consistent with the contract ("closed_by:
 * round_ceiling means the investigation never converged").
 */
export function checkCoverageHonesty(report: EvalJudgeReport, facts: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  const rep = looseReport(report);
  const coverage = rep.case_coverage;

  if (coverage !== undefined) {
    if (coverage.tangents_total !== facts.tangentLogRows) {
      violations.push(
        violation(
          'b-coverage-honesty',
          `case_coverage.tangents_total is ${JSON.stringify(coverage.tangents_total)} but the tangent log has ${facts.tangentLogRows} committed row${facts.tangentLogRows === 1 ? '' : 's'}`,
          'case_coverage.tangents_total',
        ),
      );
    }
    // The locked template states one implication, not a biconditional:
    // `closed_by: round_ceiling` means the investigation never converged.
    // The converse does not hold — a case can exhaust triage with a tangent
    // still open, which is a real non-convergence the report must be free to
    // record. Only claimed convergence is checked, because only claiming
    // convergence the record does not support inflates the report.
    const closedBy = coverage.closed_by;
    if (coverage.converged === true) {
      if (closedBy === 'round_ceiling') {
        violations.push(
          violation(
            'b-coverage-honesty',
            'case_coverage.converged is true but closed_by "round_ceiling" means the investigation never converged',
            'case_coverage.converged',
          ),
        );
      }
      if (typeof coverage.tangents_open === 'number' && coverage.tangents_open > 0) {
        violations.push(
          violation(
            'b-coverage-honesty',
            `case_coverage.converged is true but ${coverage.tangents_open} tangent${coverage.tangents_open === 1 ? ' is' : 's are'} still open`,
            'case_coverage.converged',
          ),
        );
      }
    }
  }

  if (rep.rounds_run !== facts.committedRoundRows) {
    violations.push(
      violation(
        'b-coverage-honesty',
        `rounds_run is ${JSON.stringify(rep.rounds_run)} but ${facts.committedRoundRows} round${facts.committedRoundRows === 1 ? '' : 's'} are committed`,
        'rounds_run',
      ),
    );
  }

  return violations;
}

/* ------------------------------------------------------------------ */
/* b-verbatim-assembly                                                 */
/* ------------------------------------------------------------------ */

/**
 * Rule b-verbatim-assembly: every verdict, justification and improvement in
 * evalJudge.yaml is byte-identical to its source in a committed minos
 * document. The orchestrator may author only {rounds_run, case_coverage,
 * closed_by, converged, declined-tangent facts} and identity metadata
 * (final_report, eval_id, agent_under_evaluation, official_reward,
 * confidence_in_this_report); everything else must be copied byte-for-byte.
 */
export function checkVerbatimAssembly(report: EvalJudgeReport, facts: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  const m = facts.minosCommitted;
  const approachSet = new Set(m.approachVerdicts);
  const integritySet = new Set(m.integrityVerdicts);
  const competenceSet = new Set(m.competenceScores);
  const reconciliationSet = new Set(m.reconciliationVerdicts);
  const proseSet = new Set(m.prose);

  const rep = looseReport(report);
  const verdict = rep.verdict;
  const integritySummary = rep.integrity_summary;

  const prose = (value: unknown, path: string): void => {
    if (typeof value !== 'string') return; // non-string prose is a Tier A concern
    if (!proseSet.has(value)) {
      violations.push(
        violation(
          'b-verbatim-assembly',
          `${path} is not byte-identical to any committed minos source (the orchestrator may not author it): ${JSON.stringify(truncate(value))}`,
          path,
        ),
      );
    }
  };

  if (verdict !== undefined) {
    if (typeof verdict.approach === 'string' && !approachSet.has(verdict.approach)) {
      violations.push(
        violation('b-verbatim-assembly', 'verdict.approach is not a verdict minos ruled', 'verdict.approach'),
      );
    }
    if (typeof verdict.integrity === 'string' && !integritySet.has(verdict.integrity)) {
      violations.push(
        violation('b-verbatim-assembly', 'verdict.integrity is not a verdict minos ruled', 'verdict.integrity'),
      );
    }
    if (
      typeof verdict.competence === 'number' &&
      !competenceSet.has(verdict.competence)
    ) {
      violations.push(
        violation('b-verbatim-assembly', 'verdict.competence is not a score minos ruled', 'verdict.competence'),
      );
    }
    if (typeof verdict.reconciliation === 'string' && !reconciliationSet.has(verdict.reconciliation)) {
      violations.push(
        violation(
          'b-verbatim-assembly',
          'verdict.reconciliation is not a verdict minos ruled',
          'verdict.reconciliation',
        ),
      );
    }
  }

  if (integritySummary !== undefined) {
    if (typeof integritySummary.verdict === 'string' && !integritySet.has(integritySummary.verdict)) {
      violations.push(
        violation(
          'b-verbatim-assembly',
          'integrity_summary.verdict is not a verdict minos ruled',
          'integrity_summary.verdict',
        ),
      );
    }
    asArray(integritySummary.findings).forEach((item, i) => {
      if (isObject(item)) prose(item.finding, `integrity_summary.findings[${i}].finding`);
    });
  }

  prose(rep.narrative, 'narrative');
  prose(rep.reward_reconciliation, 'reward_reconciliation');
  prose(rep.confidence_basis, 'confidence_basis');

  asArray(rep.what_the_agent_did_well).forEach((item, i) => {
    if (isObject(item)) prose(item.observation, `what_the_agent_did_well[${i}].observation`);
  });
  asArray(rep.improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    prose(item.issue, `improvements[${i}].issue`);
    prose(item.recommendation, `improvements[${i}].recommendation`);
  });
  asArray(rep.open_questions).forEach((item, i) => {
    if (!isObject(item)) return;
    prose(item.question, `open_questions[${i}].question`);
    prose(item.what_would_settle_it, `open_questions[${i}].what_would_settle_it`);
  });
  asArray(rep.revision_history).forEach((item, i) => {
    if (isObject(item)) prose(item.why, `revision_history[${i}].why`);
  });

  return violations;
}

/* ------------------------------------------------------------------ */
/* Helpers for Tier D consumers                                        */
/* ------------------------------------------------------------------ */

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The distinct refs the report cites that resolve as primary evidence
 * (never web:). Tier D calibration consumes this via its own
 * `ArchiveFacts.resolvingRefs`.
 */
export function collectResolvingRefs(report: EvalJudgeReport, facts: ArchiveFacts): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const { ref } of collectClaimRefs(report)) {
    const parsed = parseRef(ref);
    if (parsed === null || parsed.kind === 'web') continue;
    if (!refResolves(ref, facts)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref as Ref);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

/**
 * Run every Tier B rule. Expects a report already validated by Tier A (so
 * the structure is navigable); defensively tolerates a structurally
 * incomplete object without throwing.
 */
export function checkTierB(report: EvalJudgeReport, facts: ArchiveFacts): TierResult {
  const violations: Violation[] = [
    ...checkRefsResolve(report, facts),
    ...checkWebRefsNotFindings(report),
    ...checkCorroborationRecomputed(facts),
    ...checkReportCorroborationClaims(report, facts),
    ...checkAdverseRulingRefed(report, facts),
    ...checkOfficialRewardExact(report, facts),
    ...checkImprovementEvidenceResolves(report, facts),
    ...checkLabelDiscipline(facts),
    ...checkRefutedNeedsPositiveFinding(facts),
    ...checkCoverageHonesty(report, facts),
    ...checkVerbatimAssembly(report, facts),
  ];
  return {
    tier: 'B',
    passed: violations.length === 0,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
  };
}

/** Re-export the ref kind type for callers building facts/refs. */
export type { RefKind };

/**
 * Deterministic Tier D (usefulness) checks — the "is this worth reading" gate
 * (WP-0). Pure, dependency-free functions that return `Violation[]` for the
 * six Tier D rules from plan §3: actionability, anti-genericity
 * (cross-fixture), template-echo, calibration, empty-strengths justification,
 * and improvement grounding.
 *
 * No model calls: the LLM rubric grader is explicitly advisory and out of
 * scope here. Archive resolution (whether a ref resolves) belongs to Tier B;
 * these functions consume that result via `ArchiveFacts.resolvingRefs`.
 */
import type { EvalJudgeReport, Ref, Violation } from './types';
import {
  ANTI_GENERICITY_SIMILARITY_THRESHOLD,
  TEMPLATE_ECHO_NGRAM_OVERLAP_THRESHOLD,
  jaccardSimilarity,
  shingleContainment,
} from './similarity';

/** Archive-derived facts the deterministic Tier D checks resolve against. */
export interface ArchiveFacts {
  /** Normalized file paths present in the sealed archive. */
  readonly filePaths: readonly string[];
  /** Identifiers (functions, classes, methods) extracted from archived sources. */
  readonly symbols: readonly string[];
  /** Commands observed in the session (from tool calls / shell records). */
  readonly commands: readonly string[];
  /** Test identifiers observed in the archive (paths, it/test names). */
  readonly tests: readonly string[];
  /** Distinct refs known to resolve in the archive (from Tier B). */
  readonly resolvingRefs: readonly Ref[];
}

/** Everything beyond the report that the deterministic Tier D checks need. */
export interface TierDContext {
  /** Archive-derived facts (files, symbols, commands, tests, resolving refs). */
  readonly archive: ArchiveFacts;
  /** The effective prompt + template text the judge was given. */
  readonly templateText: string;
}

/** A report's corpus entry for the cross-fixture boilerplate check. */
export type CorpusReport = Pick<EvalJudgeReport, 'eval_id' | 'narrative'>;

/**
 * Minimum distinct resolving refs required for confidence_in_this_report:
 * "high" (rule d-calibration). Roughly one per verdict dimension — approach,
 * integrity, competence, reconciliation — so no major claim goes uncorroborated.
 */
export const HIGH_CONFIDENCE_MIN_DISTINCT_RESOLVING_REFS = 4;

/**
 * Ref count at or above which a case is densely corroborated, so
 * confidence_in_this_report: "low" is flagged as miscalibrated (rule
 * d-calibration).
 */
export const LOW_CONFIDENCE_DENSE_CORROBORATION_REFS = 10;

/**
 * Absence/failure markers whose presence indicates the narrative accounts for
 * an empty what_the_agent_did_well list (rule d-empty-strengths-justified).
 * The list leans permissive on purpose: a genuinely failed agent's narrative
 * is full of negation, and a CI gate must not flag it.
 */
export const EMPTY_STRENGTHS_ACCOUNTING_MARKERS: readonly string[] = Object.freeze([
  'no strengths',
  'nothing well',
  'did nothing',
  'nothing right',
  'nothing done',
  'did not',
  "didn't",
  'failed',
  'failure',
  'no positive',
  'lacked',
  'without',
  'reward 0',
  'reward of 0',
  'not',
]);

function violation(rule: string, message: string, path?: string, ref?: Ref): Violation {
  const v: Violation = { tier: 'D', rule, message };
  if (path !== undefined) v.path = path;
  if (ref !== undefined) v.ref = ref;
  return v;
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stripDotSlash(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

/* --------------------------- d-actionability --------------------------- */

const FILE_REF_RE = /file:([^#\s]+)/g;
const DIFF_REF_RE = /diff:([^#\s]+)/g;

function pathIsKnown(path: string, archive: ArchiveFacts): boolean {
  const target = stripDotSlash(path);
  return archive.filePaths.some((fp) => stripDotSlash(fp) === target);
}

/** Whether the recommendation text names a file path present in the archive. */
function namesResolvablePath(recommendation: string, archive: ArchiveFacts): boolean {
  if (archive.filePaths.some((fp) => recommendation.includes(stripDotSlash(fp)))) return true;
  // Basename fallback: naming "main.ts" when src/main.ts is archived still
  // names a resolvable artifact.
  const basenames = new Set<string>();
  for (const fp of archive.filePaths) {
    const base = fp.split('/').pop();
    if (base !== undefined && base.length > 0) basenames.add(base);
  }
  for (const base of basenames) {
    if (recommendation.includes(base)) return true;
  }
  // Inline file:/diff: refs inside the recommendation also name a resolvable file.
  for (const m of recommendation.matchAll(FILE_REF_RE)) {
    const p = m[1];
    if (p !== undefined && pathIsKnown(p, archive)) return true;
  }
  for (const m of recommendation.matchAll(DIFF_REF_RE)) {
    const p = m[1];
    if (p !== undefined && pathIsKnown(p, archive)) return true;
  }
  return false;
}

/** Whether the recommendation names a symbol present in the archive (word-boundary match). */
function namesResolvableSymbol(recommendation: string, archive: ArchiveFacts): boolean {
  for (const symbol of archive.symbols) {
    if (symbol.length === 0) continue;
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`);
    if (re.test(recommendation)) return true;
  }
  return false;
}

/** Whether the recommendation names a command observed in the session. */
function namesResolvableCommand(recommendation: string, archive: ArchiveFacts): boolean {
  for (const command of archive.commands) {
    const trimmed = command.trim();
    if (trimmed.length === 0) continue;
    if (recommendation.includes(trimmed)) return true;
    // Fallback to the binary name: "use pytest for…" names command "pytest tests/".
    const firstToken = trimmed.split(/\s+/)[0];
    if (firstToken !== undefined && firstToken.length >= 2 && recommendation.includes(firstToken)) return true;
  }
  return false;
}

/** Whether the recommendation names a test identifier present in the archive. */
function namesResolvableTest(recommendation: string, archive: ArchiveFacts): boolean {
  return archive.tests.some((t) => t.length > 0 && recommendation.includes(t));
}

/**
 * Vacuous-recommendation markers: the recommendation names a real artifact
 * but commits to no change, no criterion, and no outcome (attack-d1). Matched
 * as whole-phrase / modal hedges so ordinary actionable prose ("Add a
 * regression test to tests/parse.test.js asserting…") is not flagged.
 */
const VACUOUS_RECOMMENDATION_RE =
  /\b(?:consider reviewing|may wish to|when convenient|at some point|skim\b|re-?running tests?[^\n]*confirm current behaviour|to see whether it still reads)\b/i;

/** True when the recommendation is hedged into unfalsifiable advice. */
function isVacuousRecommendation(text: string): boolean {
  return VACUOUS_RECOMMENDATION_RE.test(text);
}

/**
 * Rule d-actionability: every recommendation names an artifact that resolves
 * in the archive AND says something non-vacuous. The conjunction is load-
 * bearing — attack-d1 names real paths while proposing no change.
 */
export function checkActionability(report: EvalJudgeReport, archive: ArchiveFacts): Violation[] {
  const violations: Violation[] = [];
  report.improvements.forEach((improvement, i) => {
    const namesArtifact =
      namesResolvablePath(improvement.recommendation, archive) ||
      namesResolvableSymbol(improvement.recommendation, archive) ||
      namesResolvableCommand(improvement.recommendation, archive) ||
      namesResolvableTest(improvement.recommendation, archive);
    if (!namesArtifact) {
      violations.push(
        violation(
          'd-actionability',
          `improvements[${i}] recommendation names no artifact that resolves in the archive (no file, symbol, command, or test): ${JSON.stringify(truncate(improvement.recommendation))}`,
          `improvements[${i}]`,
        ),
      );
      return;
    }
    if (isVacuousRecommendation(improvement.recommendation)) {
      violations.push(
        violation(
          'd-actionability',
          `improvements[${i}] recommendation names a resolvable artifact but asserts no action, criterion, or outcome (vacuous): ${JSON.stringify(truncate(improvement.recommendation))}`,
          `improvements[${i}]`,
        ),
      );
    }
  });
  return violations;
}

/* --------------------------- d-anti-genericity ------------------------- */

/** Rule d-anti-genericity: two different evals' narratives must not be boilerplate. */
export function checkAntiGenericity(reports: readonly CorpusReport[]): Violation[] {
  const violations: Violation[] = [];
  for (let i = 0; i < reports.length; i++) {
    const a = reports[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < reports.length; j++) {
      const b = reports[j];
      if (b === undefined) continue;
      if (a.eval_id === b.eval_id) continue; // same eval → not a cross-fixture pair
      const similarity = jaccardSimilarity(a.narrative, b.narrative);
      if (similarity >= ANTI_GENERICITY_SIMILARITY_THRESHOLD) {
        violations.push(
          violation(
            'd-anti-genericity',
            `narratives for eval "${a.eval_id}" and "${b.eval_id}" are boilerplate: shingle Jaccard ${similarity.toFixed(3)} >= ${ANTI_GENERICITY_SIMILARITY_THRESHOLD}`,
            'narrative',
          ),
        );
      }
    }
  }
  return violations;
}

/* ---------------------------- d-template-echo --------------------------- */

interface ProseField {
  path: string;
  text: string;
}

/** The report's prose fields that carry reasoning and may echo the template. */
function proseFields(report: EvalJudgeReport): ProseField[] {
  const fields: ProseField[] = [
    { path: 'narrative', text: report.narrative },
    { path: 'reward_reconciliation', text: report.reward_reconciliation },
    { path: 'confidence_basis', text: report.confidence_basis },
  ];
  report.improvements.forEach((improvement, i) => {
    fields.push({ path: `improvements[${i}].recommendation`, text: improvement.recommendation });
  });
  return fields;
}

/** Rule d-template-echo: prose fields must not echo the prompt/template text. */
export function checkTemplateEcho(report: EvalJudgeReport, templateText: string): Violation[] {
  const violations: Violation[] = [];
  for (const field of proseFields(report)) {
    const overlap = shingleContainment(field.text, templateText);
    if (overlap >= TEMPLATE_ECHO_NGRAM_OVERLAP_THRESHOLD) {
      violations.push(
        violation(
          'd-template-echo',
          `${field.path} echoes the prompt/template: ${(overlap * 100).toFixed(0)}% of its 3-word shingles appear verbatim in the template (threshold ${TEMPLATE_ECHO_NGRAM_OVERLAP_THRESHOLD})`,
          field.path,
        ),
      );
    }
  }
  return violations;
}

/* ----------------------------- d-calibration ---------------------------- */

function citedRefs(report: EvalJudgeReport): Ref[] {
  const refs: Ref[] = [];
  for (const strength of report.what_the_agent_did_well) refs.push(strength.ref);
  for (const improvement of report.improvements) {
    for (const evidence of improvement.evidence) refs.push(evidence.ref);
  }
  for (const finding of report.integrity_summary.findings) refs.push(finding.ref);
  return refs;
}

/**
 * Rule d-calibration: high confidence needs enough distinct resolving refs;
 * low confidence on a densely corroborated case is flagged.
 */
export function checkCalibration(report: EvalJudgeReport, archive: ArchiveFacts): Violation[] {
  const resolving = new Set<string>(archive.resolvingRefs);
  const distinctResolving = new Set<string>();
  for (const ref of citedRefs(report)) {
    if (resolving.has(ref)) distinctResolving.add(ref);
  }
  const count = distinctResolving.size;
  const violations: Violation[] = [];
  if (report.confidence_in_this_report === 'high' && count < HIGH_CONFIDENCE_MIN_DISTINCT_RESOLVING_REFS) {
    violations.push(
      violation(
        'd-calibration',
        `confidence_in_this_report "high" rests on ${count} distinct resolving refs, below the required ${HIGH_CONFIDENCE_MIN_DISTINCT_RESOLVING_REFS}`,
        'confidence_in_this_report',
      ),
    );
  }
  if (report.confidence_in_this_report === 'low' && count >= LOW_CONFIDENCE_DENSE_CORROBORATION_REFS) {
    violations.push(
      violation(
        'd-calibration',
        `confidence_in_this_report "low" despite ${count} distinct resolving refs — a densely corroborated case`,
        'confidence_in_this_report',
      ),
    );
  }
  return violations;
}

/* ---------------------- d-empty-strengths-justified --------------------- */

/** Rule d-empty-strengths-justified: empty strengths are a finding the narrative must acknowledge. */
export function checkEmptyStrengthsJustified(report: EvalJudgeReport): Violation[] {
  if (report.what_the_agent_did_well.length > 0) return [];
  const narrative = report.narrative.toLowerCase();
  const accountedFor = EMPTY_STRENGTHS_ACCOUNTING_MARKERS.some((marker) => narrative.includes(marker));
  if (accountedFor) return [];
  return [
    violation(
      'd-empty-strengths-justified',
      'what_the_agent_did_well is empty (itself a finding) but the narrative does not account for it — no absence/failure marker found',
      'narrative',
    ),
  ];
}

/* ------------------------- d-improvement-grounding ---------------------- */

/** Rule d-improvement-grounding: any improvement without evidence[] fails. */
export function checkImprovementGrounding(report: EvalJudgeReport): Violation[] {
  const violations: Violation[] = [];
  report.improvements.forEach((improvement, i) => {
    if (improvement.evidence.length === 0) {
      violations.push(
        violation(
          'd-improvement-grounding',
          `improvements[${i}] has no evidence[]; ungrounded material belongs in open_questions`,
          `improvements[${i}]`,
        ),
      );
    }
  });
  return violations;
}

/* -------------------------------- aggregate ----------------------------- */

/**
 * All deterministic per-report Tier D checks: actionability, template-echo,
 * calibration, empty-strengths justification, and improvement grounding.
 * (Anti-genericity is cross-report and runs separately via checkAntiGenericity.)
 */
export function checkTierDUsefulness(report: EvalJudgeReport, context: TierDContext): Violation[] {
  return [
    ...checkActionability(report, context.archive),
    ...checkTemplateEcho(report, context.templateText),
    ...checkCalibration(report, context.archive),
    ...checkEmptyStrengthsJustified(report),
    ...checkImprovementGrounding(report),
  ];
}

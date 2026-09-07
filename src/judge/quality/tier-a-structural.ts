/**
 * Themis judge quality harness — Tier A (structural validity), WP-0.
 *
 * Deterministic, no model calls. Given the raw `evalJudge.yaml` text, verifies
 * the eight Tier A rules from plan §3 (the five-tier gate):
 *
 *   a-yaml-parses           report parses as YAML (duplicate keys and aliases
 *                           rejected — the canonical form carries neither)
 *   a-required-keys         every contract key present, correct container shape
 *   a-no-invented-keys      no key outside the evalJudge.yaml contract
 *   a-enums-exact           every enum member exactly as listed; final_report
 *                           is the literal `true`; integer/boolean fields typed
 *   a-ref-shape-valid       every ref matches the ref grammar
 *   a-no-placeholder-residue  no `<ANGLE_BRACKET>` placeholder residue
 *   a-no-field-echo         no field whose content merely restates its name
 *   a-canonical-stable      canonical serialization byte-stable across a
 *                           re-serialize round trip
 *
 * The field/enum/ref grammar is the frozen contract in `./types.ts` and the
 * report template #4 in `src/judge/prompts/report-templates.md`.
 *
 * Parsing uses the `yaml` package (the repo's chosen YAML implementation;
 * added as a dependency in WP-0). The canonical serializer here is a WP-0
 * deterministic stand-in: WP-7 owns the production canonical serializer, and
 * the `a-canonical-stable` check is designed to run against that one (or this
 * one) — it only needs the serializer to be a pure function of the report
 * object so that serialize(parse(serialize(x))) === serialize(x).
 */

import { parse as parseYaml, parseAllDocuments } from 'yaml';

import {
  AGENT_SUBSYSTEM_VALUES,
  type EvalJudgeReport,
  type Ref,
  type RefKind,
  type ReportCategory,
  type TierResult,
  type Violation,
  CLOSED_BY_VALUES,
  COMPETENCE_VALUES,
  CONFIDENCE_VALUES,
  FIX_TYPE_VALUES,
  IMPACT_VALUES,
  IMPROVEMENT_CATEGORY_VALUES,
  RECONCILIATION_VALUES,
  VERDICT_APPROACH_VALUES,
  VERDICT_INTEGRITY_VALUES,
  WHY_UNRESOLVED_VALUES,
} from './types.js';
import { FINDING_SIGNATURES, isKnownSignature } from '../validity/signatures.js';
import { gotValue } from '../tools/themis-tools-extension.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Build a Tier A violation. `ref` is attached only when it is a valid Ref. */
function violation(rule: string, message: string, path?: string, ref?: string): Violation {
  const v: Violation = { tier: 'A', rule, message };
  if (path !== undefined) v.path = path;
  const r = asRef(ref);
  if (r !== undefined) v.ref = r;
  return v;
}

/**
 * Return `s` as a `Ref` only when it parses under the contract grammar;
 * otherwise undefined. Keeps the violation's `ref` field type-safe.
 */
export function asRef(s: string | undefined | null): Ref | undefined {
  if (typeof s !== 'string') return undefined;
  return parseRef(s) !== null ? (s as Ref) : undefined;
}

/** True when `v` is a plain mapping (not null, not an array). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce to an array, tolerating non-array input (returns []). */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/* ------------------------------------------------------------------ */
/* Ref grammar (shared with Tier B resolution)                         */
/* ------------------------------------------------------------------ */

/** A ref parsed under the contract grammar, with kind-specific fields. */
export interface ParsedRef {
  kind: RefKind;
  /** The full, original ref string. */
  raw: string;
  /** tool_call / scratchpad / web identifier (rest after the prefix). */
  id?: string;
  /** file / diff path. */
  path?: string;
  /** diff hunk id. */
  hunk?: string;
  /** file ref range start (1-based). */
  start?: number;
  /** file ref range end (1-based). */
  end?: number;
  /** verifier line number. */
  line?: number;
  /** report category. */
  category?: ReportCategory;
  /** report round number. */
  round?: number;
  /** trace ref: the run id whose event stream is cited. */
  runId?: string;
  /** trace ref: the event sequence number. */
  seq?: number;
  /** artifact ref: the JSON pointer into the artifact. */
  pointer?: string;
  /** source ref: the symbol name. */
  symbol?: string;
  /** metric ref: the measurement name. */
  metric?: string;
}

const REF_PREFIXES = Object.freeze([
  'tool_call:',
  'diff:',
  'file:',
  'verifier:',
  'report:',
  'scratchpad:',
  'web:',
  // Stable evidence IDs (preferred over line-number refs).
  'trace:',
  'artifact:',
  'source:',
  'metric:',
] as const);

/**
 * Parse a ref string against the contract grammar:
 *
 *   tool_call:<id>        diff:<file>#<hunk>       file:<path>#L<a>-L<b>
 *   verifier:<line>       report:<cat>#round<n>    scratchpad:<agent_id>
 *   web:<url>
 *
 * Returns null for anything malformed. Ids/hunks/paths/urls must be non-empty;
 * file ranges are 1-based and start <= end; report rounds start at 1.
 */
export function parseRef(ref: string): ParsedRef | null {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  for (const prefix of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue;
    const rest = ref.slice(prefix.length);

    switch (prefix) {
      case 'tool_call:':
        return rest.length > 0 && !/\s/.test(rest)
          ? { kind: 'tool_call', raw: ref, id: rest }
          : null;
      case 'scratchpad:':
        return rest.length > 0 && !/\s/.test(rest)
          ? { kind: 'scratchpad', raw: ref, id: rest }
          : null;
      case 'web:':
        return rest.length > 0 && !/\s/.test(rest) ? { kind: 'web', raw: ref, id: rest } : null;
      case 'diff:': {
        const hashIdx = rest.indexOf('#');
        if (hashIdx <= 0 || hashIdx === rest.length - 1) return null;
        const path = rest.slice(0, hashIdx);
        const hunk = rest.slice(hashIdx + 1);
        if (path.includes('#') || hunk.includes('#')) return null;
        if (/\s/.test(path) || /\s/.test(hunk)) return null;
        return { kind: 'diff', raw: ref, path, hunk };
      }
      case 'file:': {
        const hashIdx = rest.lastIndexOf('#');
        if (hashIdx <= 0) return null;
        const path = rest.slice(0, hashIdx);
        const range = rest.slice(hashIdx + 1);
        if (path.includes('#')) return null;
        const m = /^L(\d+)-L(\d+)$/.exec(range);
        if (m === null) return null;
        const start = Number(m[1]);
        const end = Number(m[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
        if (start < 1 || end < start) return null;
        return { kind: 'file', raw: ref, path, start, end };
      }
      case 'verifier:': {
        if (!/^\d+$/.test(rest)) return null;
        const line = Number(rest);
        return Number.isSafeInteger(line) && line >= 1
          ? { kind: 'verifier', raw: ref, line }
          : null;
      }
      case 'report:': {
        const m = /^(kratos|logos|minos)#round(\d+)$/.exec(rest);
        if (m === null) return null;
        const round = Number(m[2]);
        if (!Number.isSafeInteger(round) || round < 1) return null;
        return { kind: 'report', raw: ref, category: m[1] as ReportCategory, round };
      }
      // ---- stable evidence IDs -------------------------------------------
      case 'trace:': {
        // trace:<runId>:seq:<n> — a canonical event-stream position.
        const m = /^([^\s:]+):seq:(\d+)$/.exec(rest);
        if (m === null) return null;
        const seq = Number(m[2]);
        if (!Number.isSafeInteger(seq) || seq < 0) return null;
        return { kind: 'trace', raw: ref, runId: m[1], seq };
      }
      case 'artifact:': {
        // artifact:<path>#/<json-pointer>
        const hashIdx = rest.indexOf('#');
        if (hashIdx <= 0) return null;
        const path = rest.slice(0, hashIdx);
        const pointer = rest.slice(hashIdx + 1);
        if (!pointer.startsWith('/') || pointer.length < 2) return null;
        if (/\s/.test(path) || /\s/.test(pointer)) return null;
        return { kind: 'artifact', raw: ref, path, pointer };
      }
      case 'source:': {
        // source:<path>#symbol=<name>
        const hashIdx = rest.indexOf('#');
        if (hashIdx <= 0) return null;
        const path = rest.slice(0, hashIdx);
        const sym = rest.slice(hashIdx + 1);
        const m = /^symbol=(.+)$/.exec(sym);
        if (m === null || m[1] === undefined || m[1].length === 0) return null;
        if (/\s/.test(path)) return null;
        return { kind: 'source', raw: ref, path, symbol: m[1] };
      }
      case 'metric:': {
        // metric:<name> — a named lifecycle measurement.
        if (rest.length === 0 || /\s/.test(rest)) return null;
        return { kind: 'metric', raw: ref, metric: rest };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Contract shape: required / allowed keys                             */
/* ------------------------------------------------------------------ */

/** Top-level keys of evalJudge.yaml (template #4), in contract order. */
const REPORT_KEYS = Object.freeze([
  'final_report',
  'eval_id',
  'agent_under_evaluation',
  'rounds_run',
  'official_reward',
  'verdict',
  'narrative',
  'what_the_agent_did_well',
  'improvements',
  'integrity_summary',
  'reward_reconciliation',
  'case_coverage',
  'open_questions',
  'revision_history',
  'confidence_in_this_report',
  'confidence_basis',
] as const);

/** Optional top-level keys — allowed but NOT required (backward compatible). */
const OPTIONAL_REPORT_KEYS = Object.freeze(['eval_validity'] as const);

/** `eval_validity` is OPTIONAL: absent means "attributable, judged normally"
 *  (backward compatible). Present, it must carry exactly these keys. */
const VALIDITY_CHILD_KEYS = Object.freeze([
  'valid_for_agent_learning',
  'execution_status',
  'failure_owner',
  'agent_started',
  'official_reward_attributable_to_agent',
  'include_in_agent_patterns',
  'include_in_platform_patterns',
  'exclusion_reason',
] as const);

/** Nested required/known key sets, keyed by the parent field name. */
const VERDICT_CHILD_KEYS = Object.freeze(['approach', 'integrity', 'competence', 'reconciliation']);
const STRENGTH_CHILD_KEYS = Object.freeze(['observation', 'ref']);
/**
 * `extra` is an open mapping, deliberately.
 *
 * The frozen six keys are what every consumer can rely on. But minos sometimes
 * files a field the template never named (`pattern`, `root_cause`,
 * `affected_component`), and that is real signal about the agent under test, so
 * the assembler keeps it here rather than dropping it. Contract-checking stops
 * at the boundary: `extra` must be a mapping, and its contents are free.
 */
const IMPROVEMENT_REQUIRED_KEYS = Object.freeze([
  'issue',
  'evidence',
  'recommendation',
  'category',
  'impact',
  'confidence',
]);
/**
 * `subsystem`, `fix_type`, and `signature` are host-derived, so they are allowed
 * but not required: an `evalJudge.yaml` written before they existed still
 * passes. When present they must be exact enum members, same as `category`.
 */
const IMPROVEMENT_CHILD_KEYS = Object.freeze([
  ...IMPROVEMENT_REQUIRED_KEYS,
  'subsystem',
  'fix_type',
  'signature',
  'extra',
]);
/** Keys every evidence entry MUST carry. `kind` is optional (defaults archive). */
const EVIDENCE_REQUIRED_KEYS = Object.freeze(['report', 'ref']);
/** Keys an evidence entry MAY carry — required + the optional `kind`. */
const EVIDENCE_CHILD_KEYS = Object.freeze(['report', 'ref', 'kind']);
const EVIDENCE_KINDS = Object.freeze(['archive', 'web']);
const INTEGRITY_SUMMARY_CHILD_KEYS = Object.freeze(['verdict', 'findings']);
const FINDING_CHILD_KEYS = Object.freeze(['finding', 'ref', 'round']);
const CASE_COVERAGE_CHILD_KEYS = Object.freeze([
  'tangents_total',
  'tangents_resolved',
  'tangents_open',
  'closed_by',
  'converged',
]);
const OPEN_QUESTION_CHILD_KEYS = Object.freeze(['question', 'why_unresolved', 'what_would_settle_it']);
const REVISION_CHILD_KEYS = Object.freeze(['ruling', 'changed_in_round', 'from', 'to', 'why']);

const CHILD_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  eval_validity: VALIDITY_CHILD_KEYS,
  verdict: VERDICT_CHILD_KEYS,
  strength: STRENGTH_CHILD_KEYS,
  improvement: IMPROVEMENT_CHILD_KEYS,
  evidence: EVIDENCE_CHILD_KEYS,
  integrity_summary: INTEGRITY_SUMMARY_CHILD_KEYS,
  finding: FINDING_CHILD_KEYS,
  case_coverage: CASE_COVERAGE_CHILD_KEYS,
  open_question: OPEN_QUESTION_CHILD_KEYS,
  revision: REVISION_CHILD_KEYS,
});

/** A recursive walk of every string leaf, reporting its dotted path. */
type StringLeaf = { key: string; path: string; value: string };

function walkStringLeaves(value: unknown, path: string, out: StringLeaf[]): void {
  if (typeof value === 'string') {
    const leaf = path.lastIndexOf('.');
    const key = leaf >= 0 ? path.slice(leaf + 1) : path;
    out.push({ key, path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStringLeaves(item, `${path}[${i}]`, out));
    return;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      walkStringLeaves(v, path.length === 0 ? k : `${path}.${k}`, out);
    }
  }
}

/** Every string leaf in the report, for placeholder/echo scanning. */
function collectStringLeaves(report: unknown): StringLeaf[] {
  const out: StringLeaf[] = [];
  walkStringLeaves(report, '', out);
  return out;
}

/* ------------------------------------------------------------------ */
/* a-required-keys                                                     */
/* ------------------------------------------------------------------ */

/**
 * Check every contract key is present with the right container shape.
 * A required mapping that is not a mapping, or a required list that is not
 * a list, is reported here (its children cannot be "present").
 */
export function checkRequiredKeys(report: unknown): Violation[] {
  const violations: Violation[] = [];
  if (!isObject(report)) {
    return [
      violation(
        'a-required-keys',
        'report root must be a mapping (evalJudge.yaml is a single top-level mapping)',
      ),
    ];
  }

  for (const key of REPORT_KEYS) {
    if (!(key in report)) {
      violations.push(violation('a-required-keys', `required key "${key}" is missing`, key));
    }
  }

  const listKeys = [
    'what_the_agent_did_well',
    'improvements',
    'open_questions',
    'revision_history',
  ] as const;
  for (const key of listKeys) {
    if (key in report && !Array.isArray(report[key])) {
      violations.push(
        violation('a-required-keys', `"${key}" must be a list`, key),
      );
    }
  }

  const mapKeys = ['verdict', 'integrity_summary', 'case_coverage'] as const;
  for (const key of mapKeys) {
    if (key in report && !isObject(report[key])) {
      violations.push(
        violation('a-required-keys', `"${key}" must be a mapping`, key),
      );
    }
  }

  const reportObj = report;
  const verdict = isObject(reportObj.verdict) ? reportObj.verdict : undefined;
  if (verdict !== undefined) {
    for (const key of VERDICT_CHILD_KEYS) {
      if (!(key in verdict)) {
        violations.push(
          violation('a-required-keys', `verdict: required key "${key}" is missing`, `verdict.${key}`),
        );
      }
    }
  }

  const integritySummary = isObject(reportObj.integrity_summary)
    ? reportObj.integrity_summary
    : undefined;
  if (integritySummary !== undefined) {
    for (const key of INTEGRITY_SUMMARY_CHILD_KEYS) {
      if (!(key in integritySummary)) {
        violations.push(
          violation(
            'a-required-keys',
            `integrity_summary: required key "${key}" is missing`,
            `integrity_summary.${key}`,
          ),
        );
      }
    }
    if ('findings' in integritySummary && !Array.isArray(integritySummary.findings)) {
      violations.push(
        violation('a-required-keys', `integrity_summary.findings must be a list`, `integrity_summary.findings`),
      );
    }
  }

  const caseCoverage = isObject(reportObj.case_coverage) ? reportObj.case_coverage : undefined;
  if (caseCoverage !== undefined) {
    for (const key of CASE_COVERAGE_CHILD_KEYS) {
      if (!(key in caseCoverage)) {
        violations.push(
          violation(
            'a-required-keys',
            `case_coverage: required key "${key}" is missing`,
            `case_coverage.${key}`,
          ),
        );
      }
    }
  }

  asArray(reportObj.what_the_agent_did_well).forEach((item, i) => {
    if (!isObject(item)) {
      violations.push(
        violation('a-required-keys', `what_the_agent_did_well[${i}] must be a mapping`, `what_the_agent_did_well[${i}]`),
      );
      return;
    }
    for (const key of STRENGTH_CHILD_KEYS) {
      if (!(key in item)) {
        violations.push(
          violation(
            'a-required-keys',
            `what_the_agent_did_well[${i}]: required key "${key}" is missing`,
            `what_the_agent_did_well[${i}].${key}`,
          ),
        );
      }
    }
  });

  asArray(reportObj.improvements).forEach((item, i) => {
    if (!isObject(item)) {
      violations.push(
        violation('a-required-keys', `improvements[${i}] must be a mapping`, `improvements[${i}]`),
      );
      return;
    }
    for (const key of IMPROVEMENT_REQUIRED_KEYS) {
      if (!(key in item)) {
        violations.push(
          violation(
            'a-required-keys',
            `improvements[${i}]: required key "${key}" is missing`,
            `improvements[${i}].${key}`,
          ),
        );
      }
    }
    if ('evidence' in item && !Array.isArray(item.evidence)) {
      violations.push(
        violation('a-required-keys', `improvements[${i}].evidence must be a list`, `improvements[${i}].evidence`),
      );
    }
    asArray(item.evidence).forEach((evidence, j) => {
      if (!isObject(evidence)) {
        violations.push(
          violation(
            'a-required-keys',
            `improvements[${i}].evidence[${j}] must be a mapping`,
            `improvements[${i}].evidence[${j}]`,
          ),
        );
        return;
      }
      for (const key of EVIDENCE_REQUIRED_KEYS) {
        if (!(key in evidence)) {
          violations.push(
            violation(
              'a-required-keys',
              `improvements[${i}].evidence[${j}]: required key "${key}" is missing`,
              `improvements[${i}].evidence[${j}].${key}`,
            ),
          );
        }
      }
    });
  });

  asArray(integritySummary?.findings).forEach((item, i) => {
    if (!isObject(item)) {
      violations.push(
        violation('a-required-keys', `integrity_summary.findings[${i}] must be a mapping`, `integrity_summary.findings[${i}]`),
      );
      return;
    }
    for (const key of FINDING_CHILD_KEYS) {
      if (!(key in item)) {
        violations.push(
          violation(
            'a-required-keys',
            `integrity_summary.findings[${i}]: required key "${key}" is missing`,
            `integrity_summary.findings[${i}].${key}`,
          ),
        );
      }
    }
  });

  asArray(reportObj.open_questions).forEach((item, i) => {
    if (!isObject(item)) {
      violations.push(
        violation('a-required-keys', `open_questions[${i}] must be a mapping`, `open_questions[${i}]`),
      );
      return;
    }
    for (const key of OPEN_QUESTION_CHILD_KEYS) {
      if (!(key in item)) {
        violations.push(
          violation(
            'a-required-keys',
            `open_questions[${i}]: required key "${key}" is missing`,
            `open_questions[${i}].${key}`,
          ),
        );
      }
    }
  });

  asArray(reportObj.revision_history).forEach((item, i) => {
    if (!isObject(item)) {
      violations.push(
        violation('a-required-keys', `revision_history[${i}] must be a mapping`, `revision_history[${i}]`),
      );
      return;
    }
    for (const key of REVISION_CHILD_KEYS) {
      if (!(key in item)) {
        violations.push(
          violation(
            'a-required-keys',
            `revision_history[${i}]: required key "${key}" is missing`,
            `revision_history[${i}].${key}`,
          ),
        );
      }
    }
  });

  return violations;
}

/* ------------------------------------------------------------------ */
/* a-no-invented-keys                                                  */
/* ------------------------------------------------------------------ */

/**
 * Reject any key outside the evalJudge.yaml contract, at every nesting
 * level. Invented keys belong in the scratchpad, never in the report.
 */
export function checkNoInventedKeys(report: unknown): Violation[] {
  const violations: Violation[] = [];
  if (!isObject(report)) return violations;

  for (const key of Object.keys(report)) {
    if (
      !(REPORT_KEYS as readonly string[]).includes(key) &&
      !(OPTIONAL_REPORT_KEYS as readonly string[]).includes(key)
    ) {
      violations.push(
        violation('a-no-invented-keys', `invented top-level key "${key}"`, key),
      );
    }
  }

  const checkMap = (obj: Record<string, unknown>, allowed: readonly string[], path: string): void => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        violations.push(
          violation('a-no-invented-keys', `invented key "${path}.${key}"`, `${path}.${key}`),
        );
      }
    }
  };
  const checkList = (list: unknown[], allowed: readonly string[], path: string): void => {
    list.forEach((item, i) => {
      if (isObject(item)) checkMap(item, allowed, `${path}[${i}]`);
    });
  };

  const reportObj = report;
  if (isObject(reportObj.eval_validity)) checkMap(reportObj.eval_validity, VALIDITY_CHILD_KEYS, 'eval_validity');
  if (isObject(reportObj.verdict)) checkMap(reportObj.verdict, VERDICT_CHILD_KEYS, 'verdict');
  if (isObject(reportObj.integrity_summary)) {
    checkMap(reportObj.integrity_summary, INTEGRITY_SUMMARY_CHILD_KEYS, 'integrity_summary');
    checkList(asArray(reportObj.integrity_summary.findings), FINDING_CHILD_KEYS, 'integrity_summary.findings');
  }
  if (isObject(reportObj.case_coverage)) {
    checkMap(reportObj.case_coverage, CASE_COVERAGE_CHILD_KEYS, 'case_coverage');
  }

  checkList(asArray(reportObj.what_the_agent_did_well), STRENGTH_CHILD_KEYS, 'what_the_agent_did_well');
  asArray(reportObj.improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    checkMap(item, IMPROVEMENT_CHILD_KEYS, `improvements[${i}]`);
    checkList(asArray(item.evidence), EVIDENCE_CHILD_KEYS, `improvements[${i}].evidence`);
    asArray(item.evidence).forEach((evidence, j) => {
      if (!isObject(evidence)) return;
      const kind = evidence.kind;
      if (kind === undefined || kind === null) return; // defaults to archive
      if (!(EVIDENCE_KINDS as readonly string[]).includes(String(kind))) {
        violations.push(
          violation(
            'a-enums-exact',
            `improvements[${i}].evidence[${j}].kind must be one of {${EVIDENCE_KINDS.join(', ')}} (got ${gotValue(kind)})`,
            `improvements[${i}].evidence[${j}].kind`,
          ),
        );
      }
    });
  });
  checkList(asArray(reportObj.open_questions), OPEN_QUESTION_CHILD_KEYS, 'open_questions');
  checkList(asArray(reportObj.revision_history), REVISION_CHILD_KEYS, 'revision_history');

  return violations;
}

/* ------------------------------------------------------------------ */
/* a-enums-exact                                                       */
/* ------------------------------------------------------------------ */

function inEnum(value: unknown, members: readonly string[], path: string, label: string): Violation | undefined {
  if (typeof value !== 'string' || !members.includes(value)) {
    return violation(
      'a-enums-exact',
      `${path} must be one of {${members.join(', ')}} (got ${gotValue(value)})`,
      path,
    );
  }
  return undefined;
}

function mustBeInt(value: unknown, path: string, min: number): Violation | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    return violation(
      'a-enums-exact',
      `${path} must be an integer >= ${min} (got ${gotValue(value)})`,
      path,
    );
  }
  return undefined;
}

/**
 * Verify every enum member is exactly as listed and every typed scalar
 * (final_report literal, converged boolean, integer counts) has the right
 * type. Scalar-type drift is structural invalidity and is reported here.
 */
export function checkEnumsExact(report: unknown): Violation[] {
  const violations: Violation[] = [];
  if (!isObject(report)) return violations;
  const reportObj = report;

  if (reportObj.final_report !== true) {
    violations.push(
      violation('a-enums-exact', 'final_report must be the literal true', 'final_report'),
    );
  }
  if (typeof reportObj.eval_id !== 'string') {
    violations.push(
      violation('a-enums-exact', 'eval_id must be a string', 'eval_id'),
    );
  }
  if (typeof reportObj.agent_under_evaluation !== 'string') {
    violations.push(
      violation('a-enums-exact', 'agent_under_evaluation must be a string', 'agent_under_evaluation'),
    );
  }
  const roundsViolation = mustBeInt(reportObj.rounds_run, 'rounds_run', 1);
  if (roundsViolation !== undefined) violations.push(roundsViolation);

  if (typeof reportObj.official_reward !== 'number') {
    violations.push(
      violation('a-enums-exact', 'official_reward must be a number (the verifier\'s reward)', 'official_reward'),
    );
  }

  const verdict = isObject(reportObj.verdict) ? reportObj.verdict : undefined;
  if (verdict !== undefined) {
    const approach = inEnum(verdict.approach, VERDICT_APPROACH_VALUES, 'verdict.approach', 'approach');
    if (approach !== undefined) violations.push(approach);
    const integrity = inEnum(verdict.integrity, VERDICT_INTEGRITY_VALUES, 'verdict.integrity', 'integrity');
    if (integrity !== undefined) violations.push(integrity);
    const competenceValue = verdict.competence;
    // A non-attributable run (agent never executed) has competence `null` —
    // "not observed" must NOT be encoded as a numeric score, which would poison
    // Phase-2 agent statistics.
    if (competenceValue === null || competenceValue === undefined) {
      // allowed only when the validity gate says the agent never ran
      const validity = isObject(reportObj.eval_validity) ? reportObj.eval_validity : undefined;
      if (validity === undefined || validity.valid_for_agent_learning !== false) {
        violations.push(
          violation(
            'a-enums-exact',
            'verdict.competence may be null only when eval_validity.valid_for_agent_learning is false (agent never ran)',
            'verdict.competence',
          ),
        );
      }
    } else if (typeof competenceValue !== 'number' || !Number.isInteger(competenceValue)) {
      violations.push(
        violation('a-enums-exact', 'verdict.competence must be an integer in 1..5, or null when the agent never ran', 'verdict.competence'),
      );
    } else if (competenceValue < 1 || competenceValue > 5) {
      violations.push(
        violation(
          'a-enums-exact',
          `verdict.competence must be one of {${COMPETENCE_VALUES.join(', ')}} (got ${gotValue(competenceValue)})`,
          'verdict.competence',
        ),
      );
    }
    const reconciliation = inEnum(
      verdict.reconciliation,
      RECONCILIATION_VALUES,
      'verdict.reconciliation',
      'reconciliation',
    );
    if (reconciliation !== undefined) violations.push(reconciliation);
  }

  if (typeof reportObj.narrative !== 'string') {
    violations.push(violation('a-enums-exact', 'narrative must be a string', 'narrative'));
  }

  asArray(reportObj.what_the_agent_did_well).forEach((item, i) => {
    if (!isObject(item)) return;
    if (typeof item.observation !== 'string') {
      violations.push(
        violation('a-enums-exact', `what_the_agent_did_well[${i}].observation must be a string`, `what_the_agent_did_well[${i}].observation`),
      );
    }
  });

  asArray(reportObj.improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    const category = inEnum(item.category, IMPROVEMENT_CATEGORY_VALUES, `improvements[${i}].category`, 'category');
    if (category !== undefined) violations.push(category);
    const impact = inEnum(item.impact, IMPACT_VALUES, `improvements[${i}].impact`, 'impact');
    if (impact !== undefined) violations.push(impact);
    const confidence = inEnum(item.confidence, CONFIDENCE_VALUES, `improvements[${i}].confidence`, 'confidence');
    if (confidence !== undefined) violations.push(confidence);
    // Host-derived and optional, so an older report is still valid. Present,
    // they carry the same exactness as every other enum in the contract.
    if (item.subsystem !== undefined) {
      const subsystem = inEnum(item.subsystem, AGENT_SUBSYSTEM_VALUES, `improvements[${i}].subsystem`, 'subsystem');
      if (subsystem !== undefined) violations.push(subsystem);
    }
    if (item.fix_type !== undefined) {
      const fixType = inEnum(item.fix_type, FIX_TYPE_VALUES, `improvements[${i}].fix_type`, 'fix_type');
      if (fixType !== undefined) violations.push(fixType);
    }
    if (item.signature !== undefined && !isKnownSignature(item.signature)) {
      violations.push(
        violation(
          'a-enums-exact',
          `improvements[${i}].signature must be one of {${FINDING_SIGNATURES.join(', ')}} (got ${gotValue(item.signature)})`,
          `improvements[${i}].signature`,
        ),
      );
    }
    if (typeof item.issue !== 'string') {
      violations.push(
        violation('a-enums-exact', `improvements[${i}].issue must be a string`, `improvements[${i}].issue`),
      );
    }
    if (typeof item.recommendation !== 'string') {
      violations.push(
        violation('a-enums-exact', `improvements[${i}].recommendation must be a string`, `improvements[${i}].recommendation`),
      );
    }
  });

  const integritySummary = isObject(reportObj.integrity_summary) ? reportObj.integrity_summary : undefined;
  if (integritySummary !== undefined) {
    const verdict = inEnum(integritySummary.verdict, VERDICT_INTEGRITY_VALUES, 'integrity_summary.verdict', 'integrity verdict');
    if (verdict !== undefined) violations.push(verdict);
    asArray(integritySummary.findings).forEach((item, i) => {
      if (!isObject(item)) return;
      if (typeof item.finding !== 'string') {
        violations.push(
          violation('a-enums-exact', `integrity_summary.findings[${i}].finding must be a string`, `integrity_summary.findings[${i}].finding`),
        );
      }
      const round = mustBeInt(item.round, `integrity_summary.findings[${i}].round`, 1);
      if (round !== undefined) violations.push(round);
    });
  }

  if (typeof reportObj.reward_reconciliation !== 'string') {
    violations.push(
      violation('a-enums-exact', 'reward_reconciliation must be a string', 'reward_reconciliation'),
    );
  }

  const caseCoverage = isObject(reportObj.case_coverage) ? reportObj.case_coverage : undefined;
  if (caseCoverage !== undefined) {
    const closedBy = inEnum(caseCoverage.closed_by, CLOSED_BY_VALUES, 'case_coverage.closed_by', 'closed_by');
    if (closedBy !== undefined) violations.push(closedBy);
    for (const key of ['tangents_total', 'tangents_resolved', 'tangents_open'] as const) {
      const intViolation = mustBeInt(caseCoverage[key], `case_coverage.${key}`, 0);
      if (intViolation !== undefined) violations.push(intViolation);
    }
    if (typeof caseCoverage.converged !== 'boolean') {
      violations.push(
        violation('a-enums-exact', 'case_coverage.converged must be true or false', 'case_coverage.converged'),
      );
    }
  }

  asArray(reportObj.open_questions).forEach((item, i) => {
    if (!isObject(item)) return;
    const why = inEnum(item.why_unresolved, WHY_UNRESOLVED_VALUES, `open_questions[${i}].why_unresolved`, 'why_unresolved');
    if (why !== undefined) violations.push(why);
    if (typeof item.question !== 'string') {
      violations.push(
        violation('a-enums-exact', `open_questions[${i}].question must be a string`, `open_questions[${i}].question`),
      );
    }
    if (typeof item.what_would_settle_it !== 'string') {
      violations.push(
        violation('a-enums-exact', `open_questions[${i}].what_would_settle_it must be a string`, `open_questions[${i}].what_would_settle_it`),
      );
    }
  });

  asArray(reportObj.revision_history).forEach((item, i) => {
    if (!isObject(item)) return;
    if (typeof item.ruling !== 'string') {
      violations.push(
        violation('a-enums-exact', `revision_history[${i}].ruling must be a string`, `revision_history[${i}].ruling`),
      );
    }
    const round = mustBeInt(item.changed_in_round, `revision_history[${i}].changed_in_round`, 1);
    if (round !== undefined) violations.push(round);
    for (const key of ['from', 'to', 'why'] as const) {
      if (typeof item[key] !== 'string') {
        violations.push(
          violation('a-enums-exact', `revision_history[${i}].${key} must be a string`, `revision_history[${i}].${key}`),
        );
      }
    }
  });

  const confidence = inEnum(
    reportObj.confidence_in_this_report,
    CONFIDENCE_VALUES,
    'confidence_in_this_report',
    'confidence',
  );
  if (confidence !== undefined) violations.push(confidence);
  if (typeof reportObj.confidence_basis !== 'string') {
    violations.push(violation('a-enums-exact', 'confidence_basis must be a string', 'confidence_basis'));
  }

  return violations;
}

/* ------------------------------------------------------------------ */
/* a-ref-shape-valid                                                   */
/* ------------------------------------------------------------------ */

/** Collect every ref-typed field in the report (with its path). */
function collectRefFields(report: unknown): { ref: string; path: string; kind: 'ref' | 'report' }[] {
  const out: { ref: string; path: string; kind: 'ref' | 'report' }[] = [];
  if (!isObject(report)) return out;
  const reportObj = report;

  asArray(reportObj.what_the_agent_did_well).forEach((item, i) => {
    if (isObject(item) && typeof item.ref === 'string') {
      out.push({ ref: item.ref, path: `what_the_agent_did_well[${i}].ref`, kind: 'ref' });
    }
  });
  asArray(reportObj.improvements).forEach((item, i) => {
    if (!isObject(item)) return;
    asArray(item.evidence).forEach((evidence, j) => {
      if (!isObject(evidence)) return;
      // `kind: web` evidence cites an external source in BOTH `report` and
      // `ref` as a `web:<url>` ref, so neither is a report: ref there.
      const isWeb = evidence.kind === 'web';
      if (typeof evidence.report === 'string') {
        out.push({
          ref: evidence.report,
          path: `improvements[${i}].evidence[${j}].report`,
          kind: isWeb ? 'ref' : 'report',
        });
      }
      if (typeof evidence.ref === 'string') {
        out.push({ ref: evidence.ref, path: `improvements[${i}].evidence[${j}].ref`, kind: 'ref' });
      }
    });
  });
  const integritySummary = isObject(reportObj.integrity_summary) ? reportObj.integrity_summary : undefined;
  if (integritySummary !== undefined) {
    asArray(integritySummary.findings).forEach((item, i) => {
      if (isObject(item) && typeof item.ref === 'string') {
        out.push({ ref: item.ref, path: `integrity_summary.findings[${i}].ref`, kind: 'ref' });
      }
    });
  }
  return out;
}

/**
 * Verify every ref matches the contract grammar. `evidence[].report` must be
 * a `report:` ref specifically; every other ref-typed field must be any valid
 * ref kind.
 */
export function checkRefShapes(report: unknown): Violation[] {
  const violations: Violation[] = [];
  for (const { ref, path, kind } of collectRefFields(report)) {
    if (typeof ref !== 'string') {
      violations.push(violation('a-ref-shape-valid', `${path} must be a ref string`, path));
      continue;
    }
    const parsed = parseRef(ref);
    if (parsed === null) {
      violations.push(
        violation(
          'a-ref-shape-valid',
          `${path} is not a well-formed ref: ${JSON.stringify(ref)} (expected tool_call:<id> | diff:<file>#<hunk> | file:<path>#L<a>-L<b> | verifier:<line> | report:<cat>#round<n> | scratchpad:<agent_id> | web:<url>)`,
          path,
          ref,
        ),
      );
      continue;
    }
    if (kind === 'report' && parsed.kind !== 'report') {
      violations.push(
        violation(
          'a-ref-shape-valid',
          `${path} must be a report: ref (report:<cat>#round<n>), got ${JSON.stringify(ref)}`,
          path,
          ref,
        ),
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* a-no-placeholder-residue                                            */
/* ------------------------------------------------------------------ */

// A template placeholder is an angle-bracketed token standing on its own:
// `<int>`, `<string>`, `<ref>`, `<ANGLE_BRACKETS>`, `<the question assigned>`.
// The `[^>\s]` guard means prose comparisons like `a < b` (space after `<`) are
// not flagged. The boundary guards mean a bracket glued into a larger token is
// not flagged either: a report legitimately quoting a shell metavariable in a
// path or command (`sh <dir>/-name`, observed live) is evidence text, not an
// unfilled slot, because `>` is followed by `/` rather than a word boundary.
const PLACEHOLDER_RE = /(?:^|[\s([{"'=:,])<[^>\s][^>]*>(?=$|[\s)\]}"'.,;:!?])/;
// An inline object literal quoted in prose: `{op:'replace', path:'', value:<x>}`.
// A metavariable standing inside one is the report describing the shape of a
// value, not a slot the writer failed to fill. Observed live: a judgement
// explaining that the correct inverse of a whole-document patch is
// `{op:'replace', path:'', value:<original root>}` was rejected three times over
// for the same sentence. The `\w+:` requirement is what makes this narrow: a
// bare `{<int>}` carries no key and is still residue.
const OBJECT_LITERAL_RE = /\{[^{}]*\b[A-Za-z_]\w*\s*:[^{}]*\}/g;
// Degenerate empty angle-bracket pair.
const EMPTY_ANGLE_RE = /<>/;
// Bare unfinished-work tokens left when a field is skipped. Without this,
// `TODO`/`N/A`/`TBD`/`FIXME` sail through while only the angle-bracket form is
// caught (confirmed adversarial escape).
//
// Anchored to the START of the field, because that is what residue actually
// looks like: the whole value is the token, optionally followed by a colon,
// dash, or short excuse ("N/A - see above", "TODO: confirm exact assertion",
// "N/A this is an improvement item"). Matching the token anywhere in the field
// flagged real authored prose instead: a live report was rejected for the
// sentence "treat an edge-case review produced during planning as a TODO list,
// not an audit", which is a filled field discussing a TODO list, not residue.
// A mid-sentence mention cannot mean the field was never authored, since the
// surrounding sentence is the authoring.
const BARE_PLACEHOLDER_RE = /^\s*(?:TODO|FIXME|TBD|N\/A|WIP)\b/i;

/** No field may contain placeholder residue (angle-bracket OR bare token). */
export function checkPlaceholderResidue(report: unknown): Violation[] {
  const violations: Violation[] = [];
  for (const { path, value } of collectStringLeaves(report)) {
    // `extra` is an open mapping whose contents are free by contract (see
    // IMPROVEMENT_CHILD_KEYS). A key nobody required cannot be residue: "N/A"
    // under `extra` is minos answering a question the contract never asked, and
    // failing the whole report for it contradicts the open-mapping promise.
    // Observed live: `extra.what_the_agent_did_well: "N/A this is an
    // improvement item"` sank an otherwise complete judgement.
    if (/(?:^|\.)extra\./.test(path)) continue;
    // An email address quoted in angle brackets (`Eval Setup <eval@…>`) is
    // evidence text, not a template placeholder. Strip email-shaped pairs
    // before testing so a legitimately quoted seed-commit author does not
    // read as unfinished work.
    const stripped = value
      .replace(/<[^>\s]*@[^>]*>/g, "")
      .replace(OBJECT_LITERAL_RE, "");
    if (
      PLACEHOLDER_RE.test(stripped) ||
      EMPTY_ANGLE_RE.test(stripped) ||
      BARE_PLACEHOLDER_RE.test(stripped)
    ) {
      violations.push(
        violation(
          'a-no-placeholder-residue',
          `${path} contains placeholder residue: ${JSON.stringify(value)}`,
          path,
        ),
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* a-no-field-echo                                                     */
/* ------------------------------------------------------------------ */

function normalizeEchoText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Filler words that add nothing beyond restating the field name.
const ECHO_FILLERS: ReadonlySet<string> = new Set([
  '',
  'here',
  'text',
  'value',
  'field',
  'content',
  'goes here',
  'this field',
  'of this field',
  'about this field',
  'of the report',
  'the report',
  'this report',
  'of this report',
]);

/**
 * No field whose content merely restates its own name. A field filled with
 * prose that is just the field name (with or without filler) is not filled.
 */
export function checkFieldEcho(report: unknown): Violation[] {
  const violations: Violation[] = [];
  for (const { key, path, value } of collectStringLeaves(report)) {
    const normKey = normalizeEchoText(key);
    if (normKey.length === 0) continue;
    const normValue = normalizeEchoText(value);
    if (normValue.length === 0) continue;

    const echoes =
      normValue === normKey ||
      (normValue.startsWith(`${normKey} `) && ECHO_FILLERS.has(normValue.slice(normKey.length + 1))) ||
      normValue.split(' ').every((token) => token === normKey);

    if (echoes) {
      violations.push(
        violation(
          'a-no-field-echo',
          `${path} merely restates its field name ("${key}")`,
          path,
        ),
      );
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ */
/* Canonical serialization (deterministic; a-canonical-stable)         */
/* ------------------------------------------------------------------ */

/** Contract field order for each report shape. */
const VERDICT_KEYS = Object.freeze(['approach', 'integrity', 'competence', 'reconciliation']);
const STRENGTH_KEYS = Object.freeze(['observation', 'ref']);
const IMPROVEMENT_KEYS = Object.freeze([
  'issue', 'evidence', 'recommendation', 'category', 'impact', 'confidence',
  'subsystem', 'fix_type', 'signature', 'extra',
]);
const EVIDENCE_KEYS = Object.freeze(['report', 'ref']);
const INTEGRITY_SUMMARY_KEYS = Object.freeze(['verdict', 'findings']);
const FINDING_KEYS = Object.freeze(['finding', 'ref', 'round']);
const CASE_COVERAGE_KEYS = Object.freeze([
  'tangents_total',
  'tangents_resolved',
  'tangents_open',
  'closed_by',
  'converged',
]);
const OPEN_QUESTION_KEYS = Object.freeze(['question', 'why_unresolved', 'what_would_settle_it']);
const REVISION_KEYS = Object.freeze(['ruling', 'changed_in_round', 'from', 'to', 'why']);

/** Identify which contract shape a mapping matches, for deterministic key order. */
function shapeKeys(obj: Record<string, unknown>): readonly string[] | null {
  const has = (...keys: string[]): boolean => keys.every((k) => k in obj);
  if (has('final_report', 'eval_id', 'verdict', 'narrative', 'improvements', 'case_coverage', 'confidence_in_this_report')) {
    return REPORT_KEYS;
  }
  if (has('approach', 'integrity', 'competence', 'reconciliation')) return VERDICT_KEYS;
  if (has('observation', 'ref')) return STRENGTH_KEYS;
  if (has('issue', 'evidence', 'recommendation', 'category', 'impact', 'confidence')) return IMPROVEMENT_KEYS;
  if (has('report', 'ref')) return EVIDENCE_KEYS;
  if (has('verdict', 'findings')) return INTEGRITY_SUMMARY_KEYS;
  if (has('finding', 'ref', 'round')) return FINDING_KEYS;
  if (has('tangents_total', 'tangents_resolved', 'tangents_open', 'closed_by', 'converged')) {
    return CASE_COVERAGE_KEYS;
  }
  if (has('question', 'why_unresolved', 'what_would_settle_it')) return OPEN_QUESTION_KEYS;
  if (has('ruling', 'changed_in_round', 'from', 'to', 'why')) return REVISION_KEYS;
  return null;
}

/** Deterministic key order: contract order for known shapes, then sorted extras. */
function orderedKeys(obj: Record<string, unknown>): string[] {
  const contract = shapeKeys(obj);
  const keys = Object.keys(obj);
  if (contract === null) return keys.sort();
  const known = contract.filter((k) => k in obj);
  const extra = keys.filter((k) => !(contract as readonly string[]).includes(k)).sort();
  return [...known, ...extra];
}

/** True when `v` is a plain (non-null, non-array) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SAFE_PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_.\-\/ ]*$/;
const FULL_NUMBER_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const RADIX_NUMBER_RE = /^[-+]?0[xXbBoO][0-9a-fA-F]+$/;
const BOOL_NULL_WORD_RE = /^(true|false|null|~|yes|no|on|off)$/i;

/** Whether a single-line string must be double-quoted to survive a YAML round trip. */
function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  if (/^\s|\s$/.test(s)) return true; // leading/trailing whitespace
  if (/[:#{}\[\]&*!|>'"%@`\t\r?]/.test(s)) return true;
  if (s === '-' || s === '?' || s === ':') return true;
  if (/^-\s/.test(s)) return true; // sequence indicator
  if (BOOL_NULL_WORD_RE.test(s)) return true;
  if (FULL_NUMBER_RE.test(s) || RADIX_NUMBER_RE.test(s)) return true;
  return !SAFE_PLAIN_RE.test(s);
}

/** Emit a single-line scalar; returns the raw YAML token. */
function emitScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return String(value);
  }
  if (typeof value === 'string') {
    if (needsQuoting(value)) return JSON.stringify(value);
    return value;
  }
  // Object/array should be handled by the callers; serialize as JSON to stay
  // deterministic if one leaks through.
  return JSON.stringify(value);
}

/** Indented content lines for a block scalar, or null when quoting is safer. */
function blockScalarLines(s: string, contentIndent: number): string | null {
  // Tabs/CR/control chars (anything except LF) are unsafe inside a literal
  // block; quote instead. A string made only of newlines has no indentation
  // anchor; quote instead. YAML's `|` chomp keeps at most ONE trailing
  // newline, so a string ending in two+ newlines cannot round-trip as a block;
  // quote it.
  if (/[\x00-\x09\x0b\x0c\x0d\x0e-\x1f]/.test(s)) return null;
  if (/^\n+$/.test(s)) return null;
  if (/\n\n$/.test(s)) return null;
  const chomp = s.endsWith('\n') ? '|' : '|-';
  const rawLines = s.split('\n');
  const indented = rawLines.map((line) => ' '.repeat(contentIndent) + line);
  return chomp + '\n' + indented.join('\n');
}

/** Emit a mapping entry whose value may be a nested block or scalar. */
function emitEntry(key: string, value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (typeof value === 'string' && value.includes('\n')) {
    const block = blockScalarLines(value, indent + 2);
    if (block !== null) return `${pad}${key}: ${block}`;
  }
  if (Array.isArray(value) && value.length === 0) return `${pad}${key}: []`;
  if (isPlainObject(value) && Object.keys(value).length === 0) return `${pad}${key}: {}`;
  if (Array.isArray(value) || isPlainObject(value)) {
    return `${pad}${key}:\n${emitNode(value, indent + 2)}`;
  }
  return `${pad}${key}: ${emitScalar(value)}`;
}

/** Emit the first key of an array item (after the `- ` prefix). */
function emitFirstEntry(key: string, value: unknown, itemIndent: number): string {
  const pad = ' '.repeat(itemIndent);
  if (typeof value === 'string' && value.includes('\n')) {
    const block = blockScalarLines(value, itemIndent + 4);
    if (block !== null) return `${pad}- ${key}: ${block}`;
  }
  if (Array.isArray(value) && value.length === 0) return `${pad}- ${key}: []`;
  if (isPlainObject(value) && Object.keys(value).length === 0) return `${pad}- ${key}: {}`;
  if (Array.isArray(value) || isPlainObject(value)) {
    return `${pad}- ${key}:\n${emitNode(value, itemIndent + 4)}`;
  }
  return `${pad}- ${key}: ${emitScalar(value)}`;
}

/** Emit a node (mapping or sequence). `indent` is where the node's content sits. */
function emitNode(value: unknown, indent: number): string {
  if (Array.isArray(value)) {
    // `- ` markers sit at `indent`; mapping items' keys hang at `indent + 2`.
    const pad = ' '.repeat(indent);
    const lines: string[] = [];
    for (const item of value) {
      if (isPlainObject(item)) {
        const keys = orderedKeys(item);
        const [first, ...rest] = keys;
        if (first === undefined) {
          lines.push(`${pad}- {}`);
          continue;
        }
        lines.push(emitFirstEntry(first, item[first], indent));
        for (const key of rest) {
          lines.push(emitEntry(key, item[key], indent + 2));
        }
      } else if (Array.isArray(item)) {
        lines.push(`${pad}- ${emitNode(item, indent + 2)}`);
      } else {
        lines.push(`${pad}- ${emitScalar(item)}`);
      }
    }
    return lines.join('\n');
  }
  if (isPlainObject(value)) {
    return orderedKeys(value)
      .map((key) => emitEntry(key, value[key], indent))
      .join('\n');
  }
  return emitScalar(value);
}

/**
 * Canonical YAML serialization of a parsed evalJudge.yaml report. Fixed
 * contract field order, 2-space indent, block scalars for multi-line prose,
 * `[]`/`{}` for empty collections, canonical scalar forms. A pure function of
 * the report object, so serialize(parse(serialize(x))) === serialize(x).
 *
 * NOTE: WP-7 owns the production canonical serializer; this is the WP-0
 * deterministic stand-in that the `a-canonical-stable` rule runs against.
 */
export function canonicalSerializeReport(report: unknown): string {
  return `${emitNode(report, 0)}\n`;
}

/**
 * Parse evalJudge.yaml into a plain object. Throws on malformed YAML —
 * duplicate keys and YAML aliases/anchors are rejected (the canonical report
 * form carries neither).
 */
export function parseEvalJudgeYaml(yamlText: string): unknown {
  // The report contract is append-only multi-document YAML: every round appends
  // a new `---` document and touches nothing above it. The FINAL position is the
  // final ruling, so parse all documents and take the last non-empty one.
  // (Single-document parse() rejected a valid multi-doc stream with "Source
  // contains multiple documents" — observed live on a real evalJudge.yaml.)
  const docs = parseAllDocuments(yamlText, { uniqueKeys: true });
  // parseAllDocuments collects per-document errors instead of throwing. Any
  // document-level error means the stream does not parse — same contract as the
  // single-doc parse() this replaced.
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new Error(doc.errors[0]!.message);
    }
  }
  let parsed: unknown = null;
  for (const doc of docs) {
    const v = doc.toJS();
    if (v === null || v === undefined) continue;
    parsed = v;
  }
  if (parsed === null || parsed === undefined) {
    throw new Error('evalJudge.yaml parses to an empty document');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('evalJudge.yaml root must be a mapping');
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* a-canonical-stable                                                  */
/* ------------------------------------------------------------------ */

/**
 * Rule a-canonical-stable: canonical serialization must be byte-stable
 * across a re-serialize round trip — C(x) === C(parse(C(x))).
 */
export function checkCanonicalStable(report: unknown): Violation[] {
  try {
    const first = canonicalSerializeReport(report);
    const reparsed = parseEvalJudgeYaml(first);
    const second = canonicalSerializeReport(reparsed);
    if (first !== second) {
      return [
        violation(
          'a-canonical-stable',
          'canonical serialization is not byte-stable across a re-serialize round trip — re-parsing the canonical form produced different bytes',
        ),
      ];
    }
  } catch (err) {
    return [
      violation(
        'a-canonical-stable',
        `canonical serialization failed to round trip: ${err instanceof Error ? err.message : String(err)}`,
      ),
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

/** Run every Tier A rule except the YAML parse itself on a parsed object. */
export function checkTierAReport(report: unknown): TierResult {
  const violations: Violation[] = [
    ...checkRequiredKeys(report),
    ...checkNoInventedKeys(report),
    ...checkEnumsExact(report),
    ...checkRefShapes(report),
    ...checkPlaceholderResidue(report),
    ...checkFieldEcho(report),
    ...checkCanonicalStable(report),
  ];
  return {
    tier: 'A',
    passed: violations.length === 0,
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
  };
}

/** Run the full Tier A gate against the raw evalJudge.yaml text. */
export function checkTierA(yamlText: string): TierResult {
  let report: unknown;
  try {
    report = parseEvalJudgeYaml(yamlText);
  } catch (err) {
    return {
      tier: 'A',
      passed: false,
      status: 'failed',
      violations: [
        violation(
          'a-yaml-parses',
          `evalJudge.yaml does not parse as YAML: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ],
    };
  }
  return checkTierAReport(report);
}

/** The contract report type, re-exported for callers that parse + cast. */
export type { EvalJudgeReport };

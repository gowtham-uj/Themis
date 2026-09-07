/**
 * Themis judge quality harness — contract types (WP-0).
 *
 * This file is the frozen contract for the full `evalJudge.yaml` report
 * shape, the ref grammar, ground-truth fixtures, and the quality-report
 * output. It carries NO checking logic — implementers satisfy these types.
 *
 * Field names, enum member sets, and the ref grammar follow
 * `src/judge/prompts/report-templates.md` exactly.
 * Do not rename or invent fields.
 */

/* ------------------------------------------------------------------ */
/* Enums — each is a frozen runtime `as const` array plus a derived    */
/* union type, so the type and the checked member list cannot drift.   */
/* ------------------------------------------------------------------ */

export const VERDICT_APPROACH_VALUES = Object.freeze([
  'principled',
  'narrow',
  'symptomatic',
  'insufficient_evidence',
  'not_observed',
] as const);
export type VerdictApproach = (typeof VERDICT_APPROACH_VALUES)[number];

export const VERDICT_INTEGRITY_VALUES = Object.freeze([
  'clean',
  'suspicious',
  'violation',
  'contested',
  'insufficient_evidence',
  'not_applicable',
] as const);
export type VerdictIntegrity = (typeof VERDICT_INTEGRITY_VALUES)[number];

/** Competence is 1..5 for a valid agent run, else `null` (never observed). */
export const COMPETENCE_VALUES = Object.freeze([1, 2, 3, 4, 5] as const);
export type CompetenceScore = (typeof COMPETENCE_VALUES)[number];

export const RECONCILIATION_VALUES = Object.freeze([
  'consistent',
  'passed_for_wrong_reason',
  'failed_despite_sound_work',
  'unexplained',
] as const);
export type ReconciliationVerdict = (typeof RECONCILIATION_VALUES)[number];

export const IMPROVEMENT_CATEGORY_VALUES = Object.freeze([
  'correctness',
  'approach',
  'process',
  'integrity',
  'efficiency',
  'tooling',
] as const);
export type ImprovementCategory = (typeof IMPROVEMENT_CATEGORY_VALUES)[number];

export const IMPACT_VALUES = Object.freeze(['high', 'medium', 'low'] as const);
export type Impact = (typeof IMPACT_VALUES)[number];

export const CONFIDENCE_VALUES = Object.freeze(['high', 'medium', 'low'] as const);
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

/**
 * Where in the agent a recommendation actually lands.
 *
 * `category` says what kind of problem it is. It does not say what a developer
 * on PI or ReaperCode would open to fix it, which is the first thing they need.
 * These are the parts of a coding agent that a report can point at, and they are
 * the same parts across agents: every one of them has a prompt, a tool layer, a
 * way of holding context, and a way of checking its own work.
 */
export const AGENT_SUBSYSTEM_VALUES = Object.freeze([
  'system_prompt',
  'tool_definition',
  'tool_result_handling',
  'context_management',
  'planning',
  'code_search',
  'file_editing',
  'verification',
  'subagent_orchestration',
  'model_config',
  'harness',
  'unknown',
] as const);
export type AgentSubsystem = (typeof AGENT_SUBSYSTEM_VALUES)[number];

/**
 * How much is known about whether the fix works.
 *
 * Same three words Phase 2 uses for its recommendation classes, so a Phase 1
 * improvement and a Phase 2 campaign recommendation sort into one list.
 * `research_backed` requires a `web:` ref in the improvement's evidence.
 */
export const FIX_TYPE_VALUES = Object.freeze([
  'direct_fix',
  'research_backed',
  'experimental',
] as const);
export type FixType = (typeof FIX_TYPE_VALUES)[number];

export const CLOSED_BY_VALUES = Object.freeze([
  'no_new_tangents',
  'triage_exhausted',
  'round_ceiling',
] as const);
export type ClosedBy = (typeof CLOSED_BY_VALUES)[number];

export const WHY_UNRESOLVED_VALUES = Object.freeze([
  'unsolvable_from_record',
  'failed_triage',
  'round_ceiling',
] as const);
export type WhyUnresolved = (typeof WHY_UNRESOLVED_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Ref grammar — every kind named in the contract's ref format.        */
/* ------------------------------------------------------------------ */

export const REF_KIND_VALUES = Object.freeze([
  'tool_call',
  'diff',
  'file',
  'verifier',
  'report',
  'scratchpad',
  'web',
  // Stable evidence IDs — line numbers shift, these do not. Preferred over
  // `file:<path>#L<a>-L<b>` wherever the target has a canonical identity.
  'trace',
  'artifact',
  'source',
  'metric',
] as const);
export type RefKind = (typeof REF_KIND_VALUES)[number];

/** Report categories citable by a `report:<category>#round<n>` ref. */
export const REPORT_CATEGORY_VALUES = Object.freeze([
  'kratos',
  'logos',
  'minos',
] as const);
export type ReportCategory = (typeof REPORT_CATEGORY_VALUES)[number];

export type ToolCallRef = `tool_call:${string}`;
export type DiffRef = `diff:${string}#${string}`;
export type FileRef = `file:${string}#L${number}-L${number}`;
export type VerifierRef = `verifier:${number}`;
export type ReportRef = `report:${ReportCategory}#round${number}`;
export type ScratchpadRef = `scratchpad:${string}`;
export type WebRef = `web:${string}`;

/** `trace:<runId>:seq:<n>` — a canonical event-stream position. */
export type TraceRef = `trace:${string}:seq:${number}`;
/** `artifact:<path>#/<json-pointer>` — a value inside a JSON artifact. */
export type ArtifactRef = `artifact:${string}#/${string}`;
/** `source:<path>#symbol=<name>` — a symbol, not a line range. */
export type SourceRef = `source:${string}#symbol=${string}`;
/** `metric:<name>` — a named measurement from the lifecycle metrics. */
export type MetricRef = `metric:${string}`;

/** A well-formed ref of any kind, exactly as the contract's grammar states. */
export type Ref =
  | ToolCallRef
  | DiffRef
  | FileRef
  | VerifierRef
  | ReportRef
  | ScratchpadRef
  | WebRef
  | TraceRef
  | ArtifactRef
  | SourceRef
  | MetricRef;

/* ------------------------------------------------------------------ */
/* evalJudge.yaml — the final judge report (contract template #4).     */
/* ------------------------------------------------------------------ */

/** `verdict` — the final position across all rounds. */
export interface Verdict {
  approach: VerdictApproach;
  integrity: VerdictIntegrity;
  competence: CompetenceScore | null;
  reconciliation: ReconciliationVerdict;
}

/** `what_the_agent_did_well[]` — real strengths only, each with a ref. */
export interface AgentStrength {
  observation: string;
  ref: Ref;
}

/** `improvements[].evidence[]` — a cited report plus the ref it cites.
 *  `kind: "web"` backs a recommendation with external research (a web: ref);
 *  `kind: "archive"` (default when omitted) is a primary/report ref from the
 *  sealed archive. */
export interface ImprovementEvidence {
  report: ReportRef;
  ref: Ref;
  kind?: "archive" | "web";
}

/** `improvements[]` — THE deliverable. */
export interface Improvement {
  issue: string;
  evidence: ImprovementEvidence[];
  recommendation: string;
  category: ImprovementCategory;
  impact: Impact;
  confidence: Confidence;
}

/** `integrity_summary.findings[]` — reproduced from the rounds. */
export interface IntegrityFinding {
  finding: string;
  ref: Ref;
  round: number;
}

/** `integrity_summary` — reproduced from the rounds so the report stands alone. */
export interface IntegritySummary {
  verdict: VerdictIntegrity;
  findings: IntegrityFinding[];
}

/** `case_coverage` — counts must equal committed ledger rows (rule b-coverage-honesty). */
export interface CaseCoverage {
  tangents_total: number;
  tangents_resolved: number;
  tangents_open: number;
  closed_by: ClosedBy;
  converged: boolean;
}

/** `open_questions[]` — what remains unsettled and why. */
export interface OpenQuestion {
  question: string;
  why_unresolved: WhyUnresolved;
  what_would_settle_it: string;
}

/** `revision_history[]` — which verdict was revised, and how. Empty if none. */
export interface RevisionEntry {
  ruling: string;
  changed_in_round: number;
  from: string;
  to: string;
  why: string;
}

/**
 * The full `evalJudge.yaml` document, written once after the final round.
 * Field names and nesting are exactly the contract's template #4.
 */
export interface EvalJudgeReport {
  final_report: true;
  eval_id: string;
  agent_under_evaluation: string;
  rounds_run: number;
  official_reward: number;
  /** Validity/attribution gate (optional; absent = attributable, judged normally). */
  eval_validity?: {
    valid_for_agent_learning: boolean;
    execution_status: "agent_ran" | "infrastructure_failure" | "unknown";
    failure_owner: "agent" | "eval_harness" | "none" | "unknown";
    agent_started: boolean;
    official_reward_attributable_to_agent: boolean;
    include_in_agent_patterns: boolean;
    include_in_platform_patterns: boolean;
    exclusion_reason: string | null;
  };

  verdict: Verdict;
  narrative: string;

  what_the_agent_did_well: AgentStrength[];
  improvements: Improvement[];

  integrity_summary: IntegritySummary;
  reward_reconciliation: string;

  case_coverage: CaseCoverage;
  open_questions: OpenQuestion[];
  revision_history: RevisionEntry[];

  confidence_in_this_report: Confidence;
  confidence_basis: string;
}

/* ------------------------------------------------------------------ */
/* Ground-truth fixtures (WP-0) — what a correct judge must conclude.  */
/* ------------------------------------------------------------------ */

/** `must_find[]` — a claim that must appear, with the ref that proves it. */
export interface MustFindItem {
  finding: string;
  ref: Ref;
}

/** `acceptable_verdicts` — SETS of verdicts a correct judge may reach, never a single value. */
export interface AcceptableVerdicts {
  approach: ReadonlySet<VerdictApproach>;
  integrity: ReadonlySet<VerdictIntegrity>;
  competence: ReadonlySet<CompetenceScore>;
  reconciliation: ReadonlySet<ReconciliationVerdict>;
}

/** A hand-written `ground-truth.yaml` paired with a sealed archive. */
export interface GroundTruth {
  must_find: MustFindItem[];
  must_not_claim: string[];
  acceptable_verdicts: AcceptableVerdicts;
  min_confidence: Confidence;
  max_confidence: Confidence;
}

/* ------------------------------------------------------------------ */
/* Quality harness output — the machine-readable quality report.       */
/* ------------------------------------------------------------------ */

/** The five tiers of the gate. Tiers A–C and deterministic D are CI gates. */
export const JUDGE_TIER_VALUES = Object.freeze(['A', 'B', 'C', 'D', 'E'] as const);
export type JudgeTier = (typeof JUDGE_TIER_VALUES)[number];

/** A single rule violation: which tier/rule failed, with the offending ref and path. */
export interface Violation {
  tier: JudgeTier;
  rule: string;
  message: string;
  ref?: Ref;
  path?: string;
}

/**
 * Whether a tier actually ran, and how it came out.
 *
 * `not_implemented` exists because a boolean cannot tell "this tier ran and
 * found nothing" apart from "this tier has no rules and never executed". Tiers
 * C and E currently have zero rules in the registry, so a gate that reported
 * them as `passed: true` would claim a five-tier pass with 40% of the gate
 * never having run — worse than no gate, because it manufactures confidence
 * that no evidence supports.
 */
export type TierStatus = 'passed' | 'failed' | 'not_implemented';

/** Per-tier result: status plus every violation with its ref. */
export interface TierResult {
  tier: JudgeTier;
  /** True only when the tier RAN and found no violation. Never true for a tier
   *  that did not execute — read `status` to tell those apart. */
  passed: boolean;
  status: TierStatus;
  violations: Violation[];
}

/** The harness's one machine-readable `quality-report.json`. */
export interface QualityReport {
  /**
   * True only when every declared tier ran AND passed. A `not_implemented`
   * tier forces this false: the gate reports what it verified, not what it
   * declared.
   */
  passed: boolean;
  tiers: Record<JudgeTier, TierResult>;
  violations: Violation[];
  /** Tiers that did not execute. Empty is the goal state; non-empty is the
   *  honest statement of what this run did not check. */
  notImplementedTiers: JudgeTier[];
  /** Registry rule ids no aggregator invoked. A rule nothing calls is
   *  indistinguishable from one that always passes, so it is named here
   *  rather than silently counted as green. */
  uninvokedRules: string[];
}

/* ------------------------------------------------------------------ */
/* Compile-time contract locks. These must typecheck; every            */
/* `@ts-expect-error` below must actually report an error or tsc fails. */
/* ------------------------------------------------------------------ */

// Every ref kind named in the contract is representable:
const _refExamples: readonly Ref[] = [
  'tool_call:evt_0001',
  'diff:agent.ts#hunk-2',
  'file:src/main.ts#L10-L20',
  'verifier:7',
  'report:kratos#round1',
  'report:logos#round2',
  'report:minos#round3',
  'scratchpad:kr-7f3a9',
  'web:https://example.com/spec',
];

// @ts-expect-error — an approach verdict may not be invented
const _badApproach: VerdictApproach = 'holistic';
// @ts-expect-error — an integrity verdict may not be invented
const _badIntegrity: VerdictIntegrity = 'guilty';
// @ts-expect-error — competence is 1..5, not 0
const _badCompetenceLow: CompetenceScore = 0;
// @ts-expect-error — competence is 1..5, not 6
const _badCompetenceHigh: CompetenceScore = 6;
// @ts-expect-error — a reconciliation verdict may not be invented
const _badReconciliation: ReconciliationVerdict = 'lucky';
// @ts-expect-error — an improvement category may not be invented
const _badCategory: ImprovementCategory = 'design';
// @ts-expect-error — impact is high|medium|low
const _badImpact: Impact = 'critical';
// @ts-expect-error — confidence is high|medium|low
const _badConfidence: Confidence = 'certain';
// @ts-expect-error — closed_by may not be invented
const _badClosedBy: ClosedBy = 'timeout';
// @ts-expect-error — why_unresolved may not be invented
const _badWhyUnresolved: WhyUnresolved = 'forgot';
// @ts-expect-error — a ref kind may not be invented
const _badRefKind: RefKind = 'console';
// @ts-expect-error — a file ref must carry a #L<start>-L<end> range
const _badFileRef: Ref = 'file:src/a.ts';
// @ts-expect-error — a report ref must name a round number
const _badReportRef: Ref = 'report:logos#round';
// @ts-expect-error — final_report is always `true`
const _badFinalReport: EvalJudgeReport['final_report'] = false;
// @ts-expect-error — acceptable_verdicts are sets, never a single value
const _approachNotSet: ReadonlySet<VerdictApproach> = 'principled';

// A valid acceptable_verdicts value — sets, not single values:
const _goodAcceptable: AcceptableVerdicts = {
  approach: new Set<VerdictApproach>(['principled', 'narrow']),
  integrity: new Set<VerdictIntegrity>(['clean', 'suspicious']),
  competence: new Set<CompetenceScore>([3, 4, 5]),
  reconciliation: new Set<ReconciliationVerdict>(['consistent', 'passed_for_wrong_reason']),
};

// A complete, valid evalJudge.yaml — every required key, exactly as nested:
const _sampleReport: EvalJudgeReport = {
  final_report: true,
  eval_id: 'eval-01',
  agent_under_evaluation: 'agent-x',
  rounds_run: 3,
  official_reward: 1,
  verdict: {
    approach: 'principled',
    integrity: 'clean',
    competence: 4,
    reconciliation: 'consistent',
  },
  narrative: 'The agent implemented the fix and every verifier check passed.',
  what_the_agent_did_well: [{ observation: 'Implemented the fix', ref: 'diff:agent.ts#hunk-1' }],
  improvements: [
    {
      issue: 'Missing null guard',
      evidence: [{ report: 'report:logos#round2', ref: 'file:src/main.ts#L10-L20' }],
      recommendation: 'Add a null check in src/main.ts:load()',
      category: 'correctness',
      impact: 'high',
      confidence: 'high',
    },
  ],
  integrity_summary: { verdict: 'clean', findings: [] },
  reward_reconciliation: 'The reward follows from the process the case established.',
  case_coverage: {
    tangents_total: 2,
    tangents_resolved: 2,
    tangents_open: 0,
    closed_by: 'no_new_tangents',
    converged: true,
  },
  open_questions: [],
  revision_history: [],
  confidence_in_this_report: 'high',
  confidence_basis: 'Rests on committed round reports with resolving refs.',
};

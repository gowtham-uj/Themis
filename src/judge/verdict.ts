/**
 * The three-layer verdict schema — scores + localized diagnostics + located findings,
 * plus the two-lens improvements synthesis.
 *
 * This is the contract the judge emits and the platform persists. The judge is a
 * separate, decoupled, repeatable grading step (plan/judge.md): it ingests one
 * run's immutable logs + the task rubric (+ diff when source artifacts exist)
 * and emits THIS. Spec fidelity: plan/judge.md §"Structured verdict (schema)",
 * plan/judge-system-prompt.md §7–10, plan/rubric.md §6 (findings).
 *
 * What stops this from being "just a numbering machine": scores say *how good*,
 * diagnostics say *whether X happened*, findings say *what to fix, exactly
 * where, and how* — and the improvements synthesis turns the analysis into a
 * prioritized to-change list. Findings are located (≥1 structured ref),
 * fixable (fix direction + repro), and fingerprintable (controlled category).
 */

/**
 * A structured evidence reference — every finding carries ≥1 of these. Addressable
 * so a finding can deep-link into the diff viewer / trace timeline / tool call.
 */
export type Ref =
  | { kind: "diff"; file: string; hunk: number; lines?: [number, number] }
  | { kind: "trace"; runId: string; seqs: [number, number] }
  | { kind: "tool"; toolCallId: string }
  /**
   * An output artifact produced by the run (screenshot, report, exported file).
   * Categories with no source diff — browser, data, research — locate findings
   * against outputs rather than hunks (plan/execution.md §49). `path` is
   * relative to the run's outputs dir; `sha256` pins the exact bytes reviewed.
   */
  | { kind: "artifact"; path: string; sha256?: string; note?: string };

/** Severity ordering — lower index = more severe. */
export const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

/** Confidence the judge has in its own finding (0..1). */
export type Confidence = number;

/**
 * A single, located, fixable issue — the actionable layer worth reading, fixing,
 * and logging. `recurring` is filled by the PLATFORM (fingerprint match), not the
 * judge; everything else the judge produces.
 */
export interface Finding {
  /** Short, stable, human-readable id (unique within a verdict). */
  id: string;
  /** Controlled category vocabulary (e.g. "test_gaming", "verification_skipped"). */
  category: string;
  severity: Severity;
  confidence: Confidence;
  /** Rubric criterion id this finding bears on, if any. */
  criterion?: string;
  /** One line: what's wrong. */
  claim: string;
  /** Structured, addressable evidence (≥1, or the finding is dropped). */
  refs: Ref[];
  /** Optional fix direction + a repro command/expected pair. */
  fix?: { direction: string; repro?: { command: string; expected: string } };
  /**
   * WHICH SUBSYSTEM to change. A defect's symptom and its remedy live in
   * different places: "the agent never re-ran the tests" might be a missing
   * instruction, a tool whose description does not say it can be re-run, a
   * scaffold that ends the loop too early, or a model that cannot hold the
   * plan. Without this, a consuming agent guesses — and guessing wrong is how
   * a tool-schema bug collects five prompt patches.
   */
  subsystem?: Subsystem;
  /**
   * WHERE the run went wrong, and what would have avoided it.
   *
   * A finding that says "should have verified" is interpretive. One that says
   * "at seq 15 the agent claimed success; the last test ran at seq 5;
   * inserting a test run between them would have surfaced the failure" is a
   * testable hypothesis. That difference is what makes a report actionable.
   */
  decisionPoint?: DecisionPoint;
  /**
   * Which evals to re-run to prove a fix for this finding worked.
   *
   * Turns the report into a closed loop: apply the change, run exactly these,
   * see whether the finding is gone — without the consuming agent having to
   * decide what re-running even means.
   */
  verification?: VerificationSet;
  /** Set by the platform on fingerprint match — not by the judge. */
  recurring?: { firstSeenRun: string; lastSeenRun: string; count: number };
  /**
   * Set by the platform: how many EVALUATIONS this defect has survived.
   * A defect that persists across several fix attempts is a signal to change
   * approach rather than keep patching — which no single report can show.
   */
  persistence?: DefectPersistence;
}

/** Which part of the system a defect should be fixed in. */
export type Subsystem =
  | "prompt"
  | "tool_description"
  | "scaffold"
  | "model_capability"
  | "task_definition"
  | "environment";

export const SUBSYSTEMS: readonly Subsystem[] = [
  "prompt",
  "tool_description",
  "scaffold",
  "model_capability",
  "task_definition",
  "environment",
];

/** The moment a run went wrong, plus what would have avoided it. */
export interface DecisionPoint {
  /** Trace seq where the wrong decision was made or committed to. */
  seq: number;
  /** What the agent did there. */
  whatHappened: string;
  /** The concrete alternative action that would have avoided the defect. */
  counterfactual: string;
  /**
   * Optional earlier seq where the correct information was already available —
   * the gap between the two is usually the whole story.
   */
  evidenceAvailableAtSeq?: number;
}

/** How to prove a fix worked. */
export interface VerificationSet {
  /** Evals that exercise this defect — they should flip to passing. */
  targetTaskIds: string[];
  /** Evals that currently pass and must keep passing. */
  regressionTaskIds?: string[];
  /** One line: what a successful fix looks like when these are re-run. */
  successCriterion?: string;
}

/** Platform-computed history of a defect across evaluations. */
export interface DefectPersistence {
  /** Number of distinct evaluations (batches) this defect appeared in. */
  evaluationCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** True when it survived multiple evaluations — stop patching, rethink. */
  chronic: boolean;
}

/**
 * Rubric/task gap the TASK AUTHOR should fix (not an agent defect). Surfaces
 * unverifiable rubrics, ambiguous prompts, missing evidence.
 */
export interface MetaFinding {
  id: string;
  category: "rubric_unverifiable" | "prompt_ambiguous" | "evidence_missing";
  claim: string;
  note?: string;
}

/**
 * Localized diagnostic — yes/no failure mode with a pointer to where it happened.
 * NEVER a bare boolean: `{value, refs, note}` so the signal is localizable.
 */
export interface Diagnostic {
  value: boolean;
  refs?: Ref[];
  note?: string;
}

/** A per-criterion scored entry in the verdict. */
export interface CriterionVerdict {
  criterion: string;
  weight: number;
  critical?: boolean;
  /** Reasoning, written BEFORE the score (feedback-then-score ordering). */
  feedback: string;
  /** 0..1 — judged against the criterion's anchors. */
  score: number;
  /** Quoted log lines / diff hunks grounding the score. */
  evidence: string[];
  /** Findings that bear on this criterion. */
  findingIds: string[];
}

export type VerdictLevel = "pass" | "partial" | "fail";
export type Attribution = "agent" | "environment" | "mixed";

/** Improvement areas for the `withoutSource` lens (behavior-only). */
export type WithoutSourceArea =
  | "process"
  | "tool_use"
  | "verification"
  | "efficiency"
  | "honesty"
  | "context_gathering"
  | "recovery";

/** Improvement areas for the `withSource` lens (source-dependent). */
export type WithSourceArea =
  | "outcome"
  | "correctness"
  | "safety"
  | "code_quality"
  | "design"
  | "requirements"
  | "tests";

export type Priority = "high" | "medium" | "low";

/** One prioritized recommendation in the improvements synthesis. */
export interface Improvement {
  area: WithoutSourceArea | WithSourceArea;
  priority: Priority;
  change: string;
  why: string;
  refs: Ref[];
  linkedFindings: string[];
}

/**
 * The two-lens improvements synthesis. `withoutSource` is ALWAYS produced (pure
 * trace/log analysis, valid without source access); `withSource` is produced ONLY
 * when the run has source artifacts (diff present) and gated by the task's
 * agent_category — omitted for research/browser/conversational runs.
 *
 * Lens independence is the point: a withoutSource recommendation must be
 * justifiable from the trace even without code access; its refs are trace/tool
 * only, never diff/file. withSource refs may use diff/file refs.
 */
export interface Improvements {
  summary: string;
  withoutSource: Improvement[];
  withSource?: Improvement[];
}

export type CompareDirection = "progressed" | "regressed" | "flat";

/** Optional regression comparison vs a prior run (omitted if none provided). */
export interface VerdictComparison {
  vsRunId: string;
  direction: CompareDirection;
  why: string;
}

/**
 * Outcome of one deterministic check (plan/rubric.md §5).
 * Tracked separately from judged scores as pass-rates.
 */
export type CheckStatus = "pass" | "fail" | "error" | "skipped";

export interface CheckResult {
  /** Stable id matching Criterion.checkId / Check.id. */
  checkId: string;
  /** Check kind (test_suite, build, typecheck, lint, repro, secret_scan, …). */
  kind: string;
  status: CheckStatus;
  /** Human-readable detail captured from the check. */
  detail?: string;
  durationMs?: number;
  exitCode?: number;
}

/** Aggregated pass-rates from CheckResult[] (plan/rubric.md §5 + §7). */
export interface PassRates {
  /** Per-kind {passed,total} — skipped results are excluded. */
  perKind: Record<string, { passed: number; total: number }>;
  overall: { passed: number; total: number; rate: number };
}

/** Schema version — bumps on incompatible verdict shape changes. */
export const VERDICT_SCHEMA_VERSION = 1;

/**
 * Extract a JSON object from model text that may include prose and/or fenced
 * ```json blocks. Prefers the first fenced JSON block; falls back to the first
 * balanced `{...}` object in the text. Pure utility — no model dependency.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty model response; cannot extract JSON verdict");
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      try {
        JSON.parse(inner);
        return inner;
      } catch {
        // fall through
      }
    }
  }
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf("{");
  if (start < 0) {
    throw new Error("no JSON object found in model response");
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        JSON.parse(candidate);
        return candidate;
      }
    }
  }
  throw new Error("unbalanced JSON object in model response");
}

/**
 * The structured verdict — the judge's three-layer output. Mirrored into SQLite
 * (overall + per-criterion scores for trends, findings for the issues log in P6).
 */
export interface Verdict {
  schemaVersion: typeof VERDICT_SCHEMA_VERSION;
  overall: { score: number; verdict: VerdictLevel; summary: string };
  criteria: CriterionVerdict[];
  findings: Finding[];
  positiveFindings: Finding[];
  metaFindings: MetaFinding[];
  diagnostics: Record<string, Diagnostic>;
  attribution: { agent_vs_environment: Attribution; note?: string };
  observations: string[];
  improvements: Improvements;
  comparison?: VerdictComparison;
  /**
   * Deterministic check outcomes (P9). Optional — tasks without rubric.checks
   * leave this undefined so prior judgements stay shape-compatible.
   */
  checkResults?: CheckResult[];
  /**
   * Pass-rates computed from checkResults, tracked separately from judged scores
   * (plan/rubric.md §5 + §7). Optional for the same reason as checkResults.
   */
  passRates?: PassRates;
  /**
   * Scalar overall pass-rate alias (0..1). Optional; prefer `passRates.overall.rate`
   * when the full aggregate is available. Coexists for simple consumers.
   */
  passRate?: number;
  /**
   * Alias for simpler {id, pass} check outcomes. Prefer `checkResults` when full
   * status detail is available. Optional for shape compatibility.
   */
  deterministicChecks?: Array<{
    id: string;
    kind?: string;
    pass: boolean;
    detail?: string;
    durationMs?: number;
  }>;
}

/**
 * Validate a verdict object against the schema contract (plan/judge.md quality gate):
 *  - every finding has ≥1 structured ref (or it is flagged for dropping — caller decides);
 *  - diagnostics are `{value, refs?, note?}`, never bare booleans;
 *  - scores in [0,1]; severity in vocab; confidence in [0,1];
 *  - improvement refs respect lens independence (withoutSource refs are trace/tool only).
 * Throws VerdictValidationError on a contract violation. Returns the verdict on success.
 */
export class VerdictValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictValidationError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assertRef(v: unknown, ctx: string): asserts v is Ref {
  if (!isObject(v)) throw new VerdictValidationError(`${ctx}: ref is not an object`);
  const kind = v.kind;
  if (kind === "diff") {
    if (typeof v.file !== "string") throw new VerdictValidationError(`${ctx}: diff ref missing file`);
    if (typeof v.hunk !== "number") throw new VerdictValidationError(`${ctx}: diff ref missing hunk`);
    return;
  }
  if (kind === "trace") {
    if (typeof v.runId !== "string") throw new VerdictValidationError(`${ctx}: trace ref missing runId`);
    if (!Array.isArray(v.seqs) || v.seqs.length !== 2 || !v.seqs.every((n) => typeof n === "number"))
      throw new VerdictValidationError(`${ctx}: trace ref needs seqs [number,number]`);
    return;
  }
  if (kind === "tool") {
    if (typeof v.toolCallId !== "string") throw new VerdictValidationError(`${ctx}: tool ref missing toolCallId`);
    return;
  }
  if (kind === "artifact") {
    if (typeof v.path !== "string" || !v.path)
      throw new VerdictValidationError(`${ctx}: artifact ref missing path`);
    return;
  }
  throw new VerdictValidationError(`${ctx}: unknown ref kind ${String(kind)}`);
}

function validateFindingIdsUnique(findings: Finding[], label: string): void {
  const seen = new Set<string>();
  for (const f of findings) {
    if (!isObject(f)) throw new VerdictValidationError(`${label}: finding not an object`);
    if (typeof f.id !== "string" || !f.id) throw new VerdictValidationError(`${label}: finding missing id`);
    if (seen.has(f.id)) throw new VerdictValidationError(`${label}: duplicate finding id ${f.id}`);
    seen.add(f.id);
    if (typeof f.category !== "string" || !f.category)
      throw new VerdictValidationError(`${label} "${f.id}": missing category`);
    if (!SEVERITY_ORDER.includes(f.severity as Severity))
      throw new VerdictValidationError(`${label} "${f.id}": bad severity ${String(f.severity)}`);
    if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1)
      throw new VerdictValidationError(`${label} "${f.id}": confidence must be 0..1`);
    if (typeof f.claim !== "string" || !f.claim)
      throw new VerdictValidationError(`${label} "${f.id}": missing claim`);
    if (!Array.isArray(f.refs) || f.refs.length === 0)
      // Quality gate (plan/judge.md): a finding with no refs is dropped, not emitted.
      throw new VerdictValidationError(`${label} "${f.id}": finding must have ≥1 ref (drop it otherwise)`);
    f.refs.forEach((r, i) => assertRef(r, `${label} "${f.id}" ref[${i}]`));
    assertFix(f.fix, `${label} "${f.id}"`);
    assertSubsystem(f.subsystem, `${label} "${f.id}"`);
    assertDecisionPoint(f.decisionPoint, `${label} "${f.id}"`);
    assertVerification(f.verification, `${label} "${f.id}"`);
  }
}

/** Validate the optional subsystem attribution. */
function assertSubsystem(v: unknown, ctx: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || !SUBSYSTEMS.includes(v as Subsystem)) {
    throw new VerdictValidationError(
      `${ctx}: subsystem must be one of ${SUBSYSTEMS.join("|")} (got ${String(v)})`,
    );
  }
}

/**
 * Validate an optional decision point.
 *
 * A decision point without a counterfactual is just a timestamp on a
 * complaint — the counterfactual is the part a consuming agent can act on and
 * test, so it is required whenever the block is present at all.
 */
function assertDecisionPoint(v: unknown, ctx: string): void {
  if (v === undefined || v === null) return;
  if (!isObject(v)) {
    throw new VerdictValidationError(`${ctx}: decisionPoint must be an object`);
  }
  if (typeof v.seq !== "number" || !Number.isFinite(v.seq) || v.seq < 0) {
    throw new VerdictValidationError(
      `${ctx}: decisionPoint.seq must be a non-negative trace seq`,
    );
  }
  if (typeof v.whatHappened !== "string" || !v.whatHappened) {
    throw new VerdictValidationError(
      `${ctx}: decisionPoint missing whatHappened`,
    );
  }
  if (typeof v.counterfactual !== "string" || !v.counterfactual) {
    throw new VerdictValidationError(
      `${ctx}: decisionPoint missing counterfactual (a decision point without one is not actionable)`,
    );
  }
  if (v.evidenceAvailableAtSeq !== undefined) {
    const e = v.evidenceAvailableAtSeq;
    if (typeof e !== "number" || !Number.isFinite(e) || e < 0) {
      throw new VerdictValidationError(
        `${ctx}: decisionPoint.evidenceAvailableAtSeq must be a trace seq`,
      );
    }
    // Evidence available AFTER the decision explains nothing about it.
    if (e > v.seq) {
      throw new VerdictValidationError(
        `${ctx}: decisionPoint.evidenceAvailableAtSeq (${e}) is after the decision (${v.seq})`,
      );
    }
  }
}

/**
 * Validate an optional verification set.
 *
 * An empty target list means "re-run nothing to check this", which defeats the
 * purpose: the whole value is telling a consuming agent exactly what proves the
 * fix.
 */
function assertVerification(v: unknown, ctx: string): void {
  if (v === undefined || v === null) return;
  if (!isObject(v)) {
    throw new VerdictValidationError(`${ctx}: verification must be an object`);
  }
  const targets = v.targetTaskIds;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new VerdictValidationError(
      `${ctx}: verification.targetTaskIds must be a non-empty array`,
    );
  }
  if (!targets.every((t) => typeof t === "string" && t)) {
    throw new VerdictValidationError(
      `${ctx}: verification.targetTaskIds must be task id strings`,
    );
  }
  if (v.regressionTaskIds !== undefined) {
    if (
      !Array.isArray(v.regressionTaskIds) ||
      !v.regressionTaskIds.every((t) => typeof t === "string" && t)
    ) {
      throw new VerdictValidationError(
        `${ctx}: verification.regressionTaskIds must be task id strings`,
      );
    }
  }
}

/**
 * Validate an optional `fix` block.
 *
 * The report renderer reads `fix.direction` and `fix.repro.{command,expected}`
 * unconditionally, so a fix that is present but missing `direction` used to
 * validate cleanly and then crash rendering — a judge could produce a verdict
 * the platform accepted but could never show. Reject it here instead.
 */
function assertFix(fix: unknown, ctx: string): void {
  if (fix === undefined || fix === null) return;
  if (!isObject(fix)) throw new VerdictValidationError(`${ctx}: fix must be an object`);
  if (typeof fix.direction !== "string" || !fix.direction)
    throw new VerdictValidationError(`${ctx}: fix missing direction`);
  if (fix.repro === undefined || fix.repro === null) return;
  if (!isObject(fix.repro))
    throw new VerdictValidationError(`${ctx}: fix.repro must be an object`);
  if (typeof fix.repro.command !== "string" || !fix.repro.command)
    throw new VerdictValidationError(`${ctx}: fix.repro missing command`);
  if (typeof fix.repro.expected !== "string" || !fix.repro.expected)
    throw new VerdictValidationError(`${ctx}: fix.repro missing expected`);
}

/** Options for {@link validateVerdict}. */
export interface ValidateVerdictOptions {
  hasSourceArtifacts: boolean;
  /**
   * When set, every criterion id in the verdict must be a member of this set
   * (the category-filtered rubric). A model-hallucinated dropped criterion is
   * rejected. Omitted → no id-set check (backward compatible).
   */
  allowedCriterionIds?: ReadonlySet<string> | readonly string[];
}

/**
 * Validate a verdict. Caller passes `hasSourceArtifacts` so the gate "withSource
 * only when source exists" is enforced here, not just hoped for by the judge.
 * Optional `allowedCriterionIds` rejects scores against dropped rubric criteria.
 */
export function validateVerdict(
  v: unknown,
  opts: ValidateVerdictOptions,
): asserts v is Verdict {
  if (!isObject(v)) throw new VerdictValidationError("verdict is not an object");
  if (v.schemaVersion !== VERDICT_SCHEMA_VERSION)
    throw new VerdictValidationError(`schemaVersion must be ${VERDICT_SCHEMA_VERSION}`);

  const overall = v.overall;
  if (!isObject(overall))
    throw new VerdictValidationError("missing overall");
  if (typeof overall.score !== "number" || overall.score < 0 || overall.score > 1)
    throw new VerdictValidationError("overall.score must be 0..1");
  if (!["pass", "partial", "fail"].includes(overall.verdict as string))
    throw new VerdictValidationError("overall.verdict must be pass|partial|fail");
  if (typeof overall.summary !== "string")
    throw new VerdictValidationError("overall.summary must be a string");

  if (!Array.isArray(v.criteria))
    throw new VerdictValidationError("missing criteria[]");
  const allowed =
    opts.allowedCriterionIds === undefined
      ? null
      : opts.allowedCriterionIds instanceof Set
        ? opts.allowedCriterionIds
        : new Set(opts.allowedCriterionIds);
  const criterionIds = new Set<string>();
  for (const c of v.criteria) {
    if (!isObject(c)) throw new VerdictValidationError("criterion entry not an object");
    if (typeof c.criterion !== "string" || !c.criterion)
      throw new VerdictValidationError("criterion missing id");
    if (allowed && !allowed.has(c.criterion))
      throw new VerdictValidationError(
        `criterion ${c.criterion}: not in filtered rubric (dropped for this category)`,
      );
    criterionIds.add(c.criterion);
    if (typeof c.weight !== "number")
      throw new VerdictValidationError(`criterion ${c.criterion}: missing weight`);
    if (typeof c.feedback !== "string")
      throw new VerdictValidationError(`criterion ${c.criterion}: missing feedback`);
    if (typeof c.score !== "number" || c.score < 0 || c.score > 1)
      throw new VerdictValidationError(`criterion ${c.criterion}: score must be 0..1`);
  }

  // Optional deterministic-check fields (p9-checks): shape-validate when present.
  // Types: checkResults / passRates (see Verdict); passRate scalar is also accepted.
  if (v.passRate !== undefined) {
    if (typeof v.passRate !== "number" || v.passRate < 0 || v.passRate > 1)
      throw new VerdictValidationError("passRate must be 0..1 when present");
  }
  if (v.passRates !== undefined) {
    if (!isObject(v.passRates))
      throw new VerdictValidationError("passRates must be an object when present");
    const pr = v.passRates as Record<string, unknown>;
    if (!isObject(pr.overall))
      throw new VerdictValidationError("passRates.overall must be an object");
    const overall = pr.overall as Record<string, unknown>;
    if (typeof overall.passed !== "number" || typeof overall.total !== "number")
      throw new VerdictValidationError("passRates.overall needs passed/total numbers");
    if (typeof overall.rate !== "number")
      throw new VerdictValidationError("passRates.overall.rate must be a number");
    if (overall.rate < 0 || overall.rate > 1)
      throw new VerdictValidationError("passRates.overall.rate must be 0..1");
    if (pr.perKind !== undefined && !isObject(pr.perKind))
      throw new VerdictValidationError("passRates.perKind must be an object");
  }
  if (v.checkResults !== undefined) {
    if (!Array.isArray(v.checkResults))
      throw new VerdictValidationError("checkResults must be an array when present");
    for (const item of v.checkResults as unknown[]) {
      if (!isObject(item))
        throw new VerdictValidationError("checkResults entry must be an object");
      if (typeof item.checkId !== "string" || !item.checkId)
        throw new VerdictValidationError("checkResults entry missing checkId");
      if (typeof item.kind !== "string" || !item.kind)
        throw new VerdictValidationError(
          `checkResults "${item.checkId}": missing kind`,
        );
      if (!["pass", "fail", "error", "skipped"].includes(item.status as string))
        throw new VerdictValidationError(
          `checkResults "${item.checkId}": status must be pass|fail|error|skipped`,
        );
    }
  }
  if (v.deterministicChecks !== undefined) {
    if (!Array.isArray(v.deterministicChecks))
      throw new VerdictValidationError("deterministicChecks must be an array when present");
    for (const item of v.deterministicChecks) {
      if (!isObject(item))
        throw new VerdictValidationError("deterministicChecks entry must be an object");
      if (typeof item.id !== "string" || !item.id)
        throw new VerdictValidationError("deterministicChecks entry missing id");
      if (typeof item.pass !== "boolean")
        throw new VerdictValidationError(
          `deterministicChecks "${item.id}": pass must be boolean`,
        );
    }
  }

  if (!Array.isArray(v.findings)) throw new VerdictValidationError("missing findings[]");
  if (!Array.isArray(v.positiveFindings)) throw new VerdictValidationError("missing positiveFindings[]");
  if (!Array.isArray(v.metaFindings)) throw new VerdictValidationError("missing metaFindings[]");
  validateFindingIdsUnique(v.findings as Finding[], "findings");
  validateFindingIdsUnique(v.positiveFindings as Finding[], "positiveFindings");
  validateMetaFindings(v.metaFindings as MetaFinding[]);
  if (v.comparison !== undefined) validateComparison(v.comparison);

  // Cross-check: finding.criterion (if set) and CriterionVerdict.findingIds must
  // reference real ids — keeps the layers interlinked consistently.
  const findingIds = new Set<string>((v.findings as Finding[]).map((f) => f.id));
  for (const c of v.criteria as CriterionVerdict[]) {
    for (const fid of c.findingIds) {
      if (!findingIds.has(fid))
        throw new VerdictValidationError(`criterion ${c.criterion}: findingId "${fid}" not in findings[]`);
    }
  }

  if (!isObject(v.diagnostics))
    throw new VerdictValidationError("diagnostics must be an object");
  for (const [key, d] of Object.entries(v.diagnostics)) {
    if (!isObject(d)) throw new VerdictValidationError(`diagnostic "${key}": must be {value,refs?,note?}`);
    if (typeof d.value !== "boolean")
      throw new VerdictValidationError(`diagnostic "${key}": value must be boolean (not bare flag)`);
    if (d.refs !== undefined) {
      if (!Array.isArray(d.refs)) throw new VerdictValidationError(`diagnostic "${key}": refs must be array`);
      d.refs.forEach((r, i) => assertRef(r, `diagnostic "${key}" ref[${i}]`));
    }
  }

  if (!isObject(v.improvements))
    throw new VerdictValidationError("missing improvements block");
  const imp = v.improvements as Record<string, unknown>;
  if (typeof imp.summary !== "string")
    throw new VerdictValidationError("improvements.summary must be a string");
  if (!Array.isArray(imp.withoutSource))
    throw new VerdictValidationError("improvements.withoutSource must be an array (always produced)");
  const withoutSrc = imp.withoutSource as unknown[];
  const ALLOWED_WS = new Set<WithoutSourceArea>([
    "process", "tool_use", "verification", "efficiency", "honesty", "context_gathering", "recovery",
  ]);
  withoutSrc.forEach((item, i) => {
    // withoutSource is the "no source access" lens REGARDLESS of whether the
    // run has source artifacts (plan/judge-system-prompt.md §10 "Lens 1
    // independence is the point" + HARD RULE: "never leak source refs into
    // withoutSource"). So its refs MUST be trace/tool only, always.
    assertImprovement(item, `withoutSource[${i}]`, ALLOWED_WS, "no-source");
  });
  if (imp.withSource !== undefined) {
    if (!opts.hasSourceArtifacts)
      throw new VerdictValidationError("improvements.withSource present but run has no source artifacts");
    if (!Array.isArray(imp.withSource))
      throw new VerdictValidationError("improvements.withSource must be an array");
    const ALLOWED_WSRC = new Set<WithSourceArea>([
      "outcome", "correctness", "safety", "code_quality", "design", "requirements", "tests",
    ]);
    (imp.withSource as unknown[]).forEach((item, i) =>
      assertImprovement(item, `withSource[${i}]`, ALLOWED_WSRC, "source"),
    );
  } else if (opts.hasSourceArtifacts) {
    // Permitted to omit; not an error. (Judge may legitimately have no source-level recs.)
  }

  if (!isObject(v.attribution) || !["agent", "environment", "mixed"].includes((v.attribution as { agent_vs_environment: unknown }).agent_vs_environment as string))
    throw new VerdictValidationError("attribution.agent_vs_environment must be agent|environment|mixed");
  if (!Array.isArray(v.observations))
    throw new VerdictValidationError("observations must be an array");
}

/**
 * Validate one improvement item and enforce lens-independence:
 *  - `lens === "no-source"` (withoutSource, no source access) → refs MUST be
 *    trace/tool only, never diff/file (the whole value of this lens).
 */
function assertImprovement(
  v: unknown,
  ctx: string,
  allowedAreas: Set<string>,
  lens: "no-source" | "source" | null,
): void {
  if (!isObject(v)) throw new VerdictValidationError(`${ctx}: improvement not an object`);
  if (typeof v.area !== "string" || !allowedAreas.has(v.area))
    throw new VerdictValidationError(`${ctx}: bad area ${String(v.area)}`);
  if (!["high", "medium", "low"].includes(v.priority as string))
    throw new VerdictValidationError(`${ctx}: bad priority ${String(v.priority)}`);
  if (typeof v.change !== "string" || !v.change)
    throw new VerdictValidationError(`${ctx}: missing change`);
  if (typeof v.why !== "string" || !v.why)
    throw new VerdictValidationError(`${ctx}: missing why`);
  if (!Array.isArray(v.refs))
    throw new VerdictValidationError(`${ctx}: refs must be an array`);
  v.refs.forEach((r, i) => {
    assertRef(r, `${ctx} ref[${i}]`);
    if (lens === "no-source") {
      const kind = (r as Ref).kind;
      if (kind === "diff")
        throw new VerdictValidationError(`${ctx} ref[${i}]: withoutSource lens must not use diff refs`);
    }
  });
  if (!Array.isArray(v.linkedFindings))
    throw new VerdictValidationError(`${ctx}: linkedFindings must be an array`);
  // An improvement with neither a ref nor a linked finding is a guess —
  // downgrade or drop it (plan/judge-system-prompt.md §10 HARD RULE).
  if (v.refs.length === 0 && (v.linkedFindings as unknown[]).length === 0)
    throw new VerdictValidationError(`${ctx}: improvement has no refs and no linkedFindings (a guess; drop or ground it)`);
}

const META_CATEGORIES = new Set<MetaFinding["category"]>([
  "rubric_unverifiable", "prompt_ambiguous", "evidence_missing",
]);

/** Per-item validation for metaFindings (rubric/task gaps for the task author). */
function validateMetaFindings(items: MetaFinding[]): void {
  const seen = new Set<string>();
  for (const m of items) {
    if (!isObject(m)) throw new VerdictValidationError("metaFinding not an object");
    if (typeof m.id !== "string" || !m.id) throw new VerdictValidationError("metaFinding missing id");
    if (seen.has(m.id)) throw new VerdictValidationError(`metaFinding duplicate id ${m.id}`);
    seen.add(m.id);
    if (!META_CATEGORIES.has(m.category))
      throw new VerdictValidationError(`metaFinding "${m.id}": bad category ${String(m.category)}`);
    if (typeof m.claim !== "string" || !m.claim)
      throw new VerdictValidationError(`metaFinding "${m.id}": missing claim`);
  }
}

/** Optional regression comparison block, shape-validated when present. */
function validateComparison(c: unknown): asserts c is VerdictComparison {
  if (!isObject(c)) throw new VerdictValidationError("comparison must be an object");
  if (typeof c.vsRunId !== "string" || !c.vsRunId)
    throw new VerdictValidationError("comparison.vsRunId must be a non-empty string");
  if (!["progressed", "regressed", "flat"].includes(c.direction as string))
    throw new VerdictValidationError("comparison.direction must be progressed|regressed|flat");
  if (typeof c.why !== "string") throw new VerdictValidationError("comparison.why must be a string");
}

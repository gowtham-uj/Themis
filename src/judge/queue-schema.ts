/** Versioned queue-judge narrative, plan, normalization, and deep validation. */

import {
  SEVERITY_ORDER,
  validateRef,
  validateVerdict,
  type Ref,
  type Severity,
  type Verdict,
} from "./verdict.js";

export const QUEUE_ANALYSIS_SCHEMA_VERSION = 2 as const;

export type ImprovementOwnerClass = "agent" | "platform" | "judge" | "eval";
export type ImprovementStepStatus =
  | "proposed"
  | "ready"
  | "blocked"
  | "in_progress"
  | "verified"
  | "rejected";

export interface NarrativeClaim {
  text: string;
  refs: Ref[];
}

export interface EvalJudgementNarrative {
  schemaVersion: 1;
  headline: string;
  judgement: string;
  executionAnalysis: Array<{ stage: string; judgement: string; refs: Ref[] }>;
  strengths: NarrativeClaim[];
  concerns: Array<{
    severity: Severity;
    text: string;
    refs: Ref[];
    implication: string;
    ownerClass: ImprovementOwnerClass;
    findingIds: string[];
  }>;
  evidenceBoundaries: Array<{
    status: "observed" | "hypothesis" | "missing";
    text: string;
    refs: Ref[];
  }>;
  handoff: {
    preserve: Array<NarrativeClaim & { ownerClass: ImprovementOwnerClass }>;
    change: Array<NarrativeClaim & { ownerClass: ImprovementOwnerClass }>;
    investigate: Array<NarrativeClaim & { ownerClass: ImprovementOwnerClass }>;
  };
}

export type ImprovementTarget =
  | {
      kind: "code" | "config" | "prompt" | "eval";
      paths: string[];
    }
  | {
      kind: "external";
      system: string;
      blocker: string;
    };

export interface QueueImprovementStep {
  id: string;
  rank: number;
  class: ImprovementOwnerClass;
  priority: 0 | 1 | 2 | 3;
  confidence: number;
  defectIds: string[];
  subsystem: string;
  problem: string;
  evidence: Ref[];
  target: ImprovementTarget;
  change: string;
  acceptanceCriteria: string[];
  tests: Array<{
    name: string;
    kind: "unit" | "integration" | "e2e";
    command?: string;
    expected: string;
  }>;
  verifyTaskIds: string[];
  regressionTaskIds: string[];
  dependencies: string[];
  nonGoals: string[];
  preventive: boolean;
  status: ImprovementStepStatus;
  blockingReason?: string;
}

export interface QueueWideAnalysis {
  schemaVersion: typeof QUEUE_ANALYSIS_SCHEMA_VERSION;
  summary: string;
  themes: NarrativeClaim[];
  reliability: {
    assessment: string;
    evidence: Ref[];
  };
  rankedDefects: Array<{
    id: string;
    type: "observed";
    rank: number;
    title: string;
    category: string;
    severity: Severity;
    runIds: string[];
    description: string;
    evidence: Ref[];
    verification: string[];
  }>;
  subsystemAttribution: Array<{
    subsystem: string;
    runIds: string[];
    explanation: string;
    evidence: Ref[];
  }>;
  regressions: NarrativeClaim[];
  improvementPlan: QueueImprovementStep[];
}

export interface QueueSubmission {
  perEval: Array<{
    runId: string;
    verdict: Verdict;
    narrative: EvalJudgementNarrative;
  }>;
  queueAnalysis: QueueWideAnalysis;
}

export interface QueueEvidenceIndex {
  runId: string;
  hasSourceArtifacts: boolean;
  maxTraceSeq: number;
  toolCallIds: string[];
  diffHunks: Array<{ file: string; hunk: number }>;
  artifactPaths: string[];
}

export interface QueueValidationIssue {
  path: string;
  message: string;
}

export interface ValidateQueueSubmissionContext {
  selectedRunIds: string[];
  evidence: Map<string, QueueEvidenceIndex>;
}

export class QueueSubmissionValidationError extends Error {
  readonly issues: QueueValidationIssue[];

  constructor(issues: QueueValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "QueueSubmissionValidationError";
    this.issues = issues;
  }
}

/** Normalize the queue tool's snake/camel-case payload into the v2 domain shape. */
export function parseQueueSubmission(args: Record<string, unknown>): QueueSubmission {
  const rawPerEval = args.per_eval ?? args.perEval;
  const rawQueue = args.queue_analysis ?? args.queueAnalysis;
  if (!Array.isArray(rawPerEval) || !isRecord(rawQueue)) {
    throw new QueueSubmissionValidationError([
      { path: "$", message: "requires per_eval[] and queue_analysis" },
    ]);
  }
  const perEval = rawPerEval.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new QueueSubmissionValidationError([
        { path: `per_eval[${index}]`, message: "must be an object" },
      ]);
    }
    const runId = raw.run_id ?? raw.runId;
    if (typeof runId !== "string" || !isRecord(raw.verdict) || !isRecord(raw.narrative)) {
      throw new QueueSubmissionValidationError([
        {
          path: `per_eval[${index}]`,
          message: "requires run_id, verdict, and narrative",
        },
      ]);
    }
    return {
      runId,
      verdict: raw.verdict as unknown as Verdict,
      narrative: normalizeNarrative(raw.narrative),
    };
  });
  return { perEval, queueAnalysis: normalizeQueueAnalysis(rawQueue) };
}

/** Return all deep schema, cross-link, ordering, and evidence-reference issues. */
export function validateQueueSubmission(
  submission: QueueSubmission,
  context: ValidateQueueSubmissionContext,
): QueueValidationIssue[] {
  const issues: QueueValidationIssue[] = [];
  const selected = new Set(context.selectedRunIds);
  const runCounts = new Map<string, number>();
  for (const entry of submission.perEval) {
    runCounts.set(entry.runId, (runCounts.get(entry.runId) ?? 0) + 1);
  }
  for (const runId of context.selectedRunIds) {
    if (!runCounts.has(runId)) issue(issues, "per_eval", `missing selected run ${runId}`);
  }
  for (const [runId, count] of runCounts) {
    if (!selected.has(runId)) issue(issues, "per_eval", `unknown run ${runId}`);
    if (count > 1) issue(issues, "per_eval", `duplicate run ${runId}`);
  }

  const findingIdsByRun = new Map<string, Set<string>>();
  submission.perEval.forEach((entry, index) => {
    const base = `per_eval[${index}]`;
    const evidence = context.evidence.get(entry.runId);
    if (!evidence) {
      issue(issues, `${base}.run_id`, "has no evidence index");
      return;
    }
    try {
      validateVerdict(entry.verdict, { hasSourceArtifacts: evidence.hasSourceArtifacts });
    } catch (err) {
      issue(issues, `${base}.verdict`, err instanceof Error ? err.message : String(err));
    }
    const findingIds = new Set(entry.verdict.findings?.map((finding) => finding.id) ?? []);
    findingIdsByRun.set(entry.runId, findingIds);
    validateRefs(allVerdictRefs(entry.verdict), `${base}.verdict`, entry.runId, context, issues);
    validateNarrative(entry.narrative, base, entry.runId, findingIds, context, issues);
  });

  validateQueueAnalysis(submission.queueAnalysis, context, issues);
  return issues;
}

/** Throw a typed error when a queue submission does not satisfy v2. */
export function assertQueueSubmission(
  submission: QueueSubmission,
  context: ValidateQueueSubmissionContext,
): void {
  const issues = validateQueueSubmission(submission, context);
  if (issues.length > 0) throw new QueueSubmissionValidationError(issues);
}

function validateNarrative(
  narrative: EvalJudgementNarrative,
  perEvalPath: string,
  runId: string,
  findingIds: Set<string>,
  context: ValidateQueueSubmissionContext,
  issues: QueueValidationIssue[],
): void {
  const base = `${perEvalPath}.narrative`;
  if (narrative.schemaVersion !== 1) issue(issues, `${base}.schemaVersion`, "must be 1");
  requireText(narrative.headline, `${base}.headline`, issues);
  requireText(narrative.judgement, `${base}.judgement`, issues);
  requireNonEmptyArray(narrative.executionAnalysis, `${base}.executionAnalysis`, issues);
  narrative.executionAnalysis?.forEach((entry, index) => {
    requireText(entry.stage, `${base}.executionAnalysis[${index}].stage`, issues);
    requireText(entry.judgement, `${base}.executionAnalysis[${index}].judgement`, issues);
    validateRequiredRefs(entry.refs, `${base}.executionAnalysis[${index}].refs`, runId, context, issues);
  });
  requireNonEmptyArray(narrative.strengths, `${base}.strengths`, issues);
  narrative.strengths?.forEach((entry, index) =>
    validateClaim(entry, `${base}.strengths[${index}]`, runId, context, issues));
  if (!Array.isArray(narrative.concerns)) issue(issues, `${base}.concerns`, "must be an array");
  narrative.concerns?.forEach((entry, index) => {
    const path = `${base}.concerns[${index}]`;
    if (!SEVERITY_ORDER.includes(entry.severity)) issue(issues, `${path}.severity`, "invalid severity");
    requireText(entry.text, `${path}.text`, issues);
    requireText(entry.implication, `${path}.implication`, issues);
    requireOwner(entry.ownerClass, `${path}.ownerClass`, issues);
    validateRequiredRefs(entry.refs, `${path}.refs`, runId, context, issues);
    if (!Array.isArray(entry.findingIds)) issue(issues, `${path}.findingIds`, "must be an array");
    for (const findingId of entry.findingIds ?? []) {
      if (!findingIds.has(findingId)) issue(issues, `${path}.findingIds`, `unknown finding ${findingId}`);
    }
  });
  requireNonEmptyArray(narrative.evidenceBoundaries, `${base}.evidenceBoundaries`, issues);
  narrative.evidenceBoundaries?.forEach((entry, index) => {
    const path = `${base}.evidenceBoundaries[${index}]`;
    if (!["observed", "hypothesis", "missing"].includes(entry.status)) {
      issue(issues, `${path}.status`, "must be observed|hypothesis|missing");
    }
    requireText(entry.text, `${path}.text`, issues);
    validateRequiredRefs(entry.refs, `${path}.refs`, runId, context, issues);
  });
  if (!isRecord(narrative.handoff)) {
    issue(issues, `${base}.handoff`, "must be an object");
    return;
  }
  for (const key of ["preserve", "change", "investigate"] as const) {
    const entries = narrative.handoff[key];
    if (!Array.isArray(entries)) {
      issue(issues, `${base}.handoff.${key}`, "must be an array");
      continue;
    }
    entries.forEach((entry, index) => {
      const path = `${base}.handoff.${key}[${index}]`;
      validateClaim(entry, path, runId, context, issues);
      requireOwner(entry.ownerClass, `${path}.ownerClass`, issues);
    });
  }
}

function validateQueueAnalysis(
  queue: QueueWideAnalysis,
  context: ValidateQueueSubmissionContext,
  issues: QueueValidationIssue[],
): void {
  const base = "queue_analysis";
  if (queue.schemaVersion !== QUEUE_ANALYSIS_SCHEMA_VERSION) {
    issue(issues, `${base}.schemaVersion`, `must be ${QUEUE_ANALYSIS_SCHEMA_VERSION}`);
  }
  requireText(queue.summary, `${base}.summary`, issues);
  requireNonEmptyArray(queue.themes, `${base}.themes`, issues);
  queue.themes?.forEach((entry, index) =>
    validateClaim(entry, `${base}.themes[${index}]`, null, context, issues));
  if (!isRecord(queue.reliability)) {
    issue(issues, `${base}.reliability`, "must be an object");
  } else {
    requireText(queue.reliability.assessment, `${base}.reliability.assessment`, issues);
    validateRequiredRefs(queue.reliability.evidence, `${base}.reliability.evidence`, null, context, issues);
  }

  requireNonEmptyArray(queue.rankedDefects, `${base}.rankedDefects`, issues);
  const defectIds = new Set<string>();
  const defects = new Map<string, QueueWideAnalysis["rankedDefects"][number]>();
  const defectRanks = new Set<number>();
  queue.rankedDefects?.forEach((defect, index) => {
    const path = `${base}.rankedDefects[${index}]`;
    requireText(defect.id, `${path}.id`, issues);
    if (defectIds.has(defect.id)) issue(issues, `${path}.id`, "duplicate defect id");
    defectIds.add(defect.id);
    defects.set(defect.id, defect);
    if (defect.type !== "observed") issue(issues, `${path}.type`, "must be observed; preventive work belongs in improvementPlan");
    if (!Number.isInteger(defect.rank) || defect.rank < 1) issue(issues, `${path}.rank`, "must be a positive integer");
    if (defectRanks.has(defect.rank)) issue(issues, `${path}.rank`, "duplicate defect rank");
    defectRanks.add(defect.rank);
    requireText(defect.title, `${path}.title`, issues);
    requireText(defect.category, `${path}.category`, issues);
    requireText(defect.description, `${path}.description`, issues);
    if (!SEVERITY_ORDER.includes(defect.severity)) issue(issues, `${path}.severity`, "invalid severity");
    requireNonEmptyArray(defect.runIds, `${path}.runIds`, issues);
    for (const runId of defect.runIds ?? []) {
      if (!context.selectedRunIds.includes(runId)) issue(issues, `${path}.runIds`, `unknown run ${runId}`);
    }
    validateRequiredRefs(defect.evidence, `${path}.evidence`, null, context, issues);
    requireNonEmptyArray(defect.verification, `${path}.verification`, issues);
  });

  if (!Array.isArray(queue.subsystemAttribution)) {
    issue(issues, `${base}.subsystemAttribution`, "must be an array");
  }
  queue.subsystemAttribution?.forEach((entry, index) => {
    const path = `${base}.subsystemAttribution[${index}]`;
    requireText(entry.subsystem, `${path}.subsystem`, issues);
    requireText(entry.explanation, `${path}.explanation`, issues);
    requireNonEmptyArray(entry.runIds, `${path}.runIds`, issues);
    for (const runId of entry.runIds ?? []) {
      if (!context.selectedRunIds.includes(runId)) issue(issues, `${path}.runIds`, `unknown run ${runId}`);
    }
    validateRequiredRefs(entry.evidence, `${path}.evidence`, null, context, issues);
  });
  if (!Array.isArray(queue.regressions)) issue(issues, `${base}.regressions`, "must be an array");
  queue.regressions?.forEach((entry, index) =>
    validateClaim(entry, `${base}.regressions[${index}]`, null, context, issues));

  requireNonEmptyArray(queue.improvementPlan, `${base}.improvementPlan`, issues);
  const stepIds = new Set<string>();
  const stepRanks = new Set<number>();
  queue.improvementPlan?.forEach((step, index) => {
    const path = `${base}.improvementPlan[${index}]`;
    requireText(step.id, `${path}.id`, issues);
    if (stepIds.has(step.id)) issue(issues, `${path}.id`, "duplicate step id");
    stepIds.add(step.id);
    if (!Number.isInteger(step.rank) || step.rank < 1) issue(issues, `${path}.rank`, "must be a positive integer");
    if (stepRanks.has(step.rank)) issue(issues, `${path}.rank`, "duplicate step rank");
    stepRanks.add(step.rank);
    requireOwner(step.class, `${path}.class`, issues);
    if (![0, 1, 2, 3].includes(step.priority)) issue(issues, `${path}.priority`, "must be 0..3");
    if (typeof step.confidence !== "number" || step.confidence < 0 || step.confidence > 1) {
      issue(issues, `${path}.confidence`, "must be 0..1");
    }
    requireNonEmptyArray(step.defectIds, `${path}.defectIds`, issues);
    for (const defectId of step.defectIds ?? []) {
      if (!defectIds.has(defectId)) issue(issues, `${path}.defectIds`, `unknown defect ${defectId}`);
    }
    requireText(step.subsystem, `${path}.subsystem`, issues);
    requireText(step.problem, `${path}.problem`, issues);
    requireText(step.change, `${path}.change`, issues);
    validateRequiredRefs(step.evidence, `${path}.evidence`, null, context, issues);
    validateTarget(step.target, `${path}.target`, issues);
    requireNonEmptyArray(step.acceptanceCriteria, `${path}.acceptanceCriteria`, issues);
    requireNonEmptyArray(step.tests, `${path}.tests`, issues);
    step.tests?.forEach((test, testIndex) => {
      const testPath = `${path}.tests[${testIndex}]`;
      requireText(test.name, `${testPath}.name`, issues);
      if (!["unit", "integration", "e2e"].includes(test.kind)) issue(issues, `${testPath}.kind`, "invalid test kind");
      requireText(test.expected, `${testPath}.expected`, issues);
    });
    requireNonEmptyArray(step.verifyTaskIds, `${path}.verifyTaskIds`, issues);
    requireNonEmptyArray(step.regressionTaskIds, `${path}.regressionTaskIds`, issues);
    if (!Array.isArray(step.dependencies)) issue(issues, `${path}.dependencies`, "must be an array");
    if (!Array.isArray(step.nonGoals)) issue(issues, `${path}.nonGoals`, "must be an array");
    if (typeof step.preventive !== "boolean") issue(issues, `${path}.preventive`, "must be boolean");
    if (!["proposed", "ready", "blocked", "in_progress", "verified", "rejected"].includes(step.status)) {
      issue(issues, `${path}.status`, "invalid lifecycle status");
    }
    if (step.status === "blocked" && !nonEmpty(step.blockingReason)) {
      issue(issues, `${path}.blockingReason`, "required when status=blocked");
    }
  });

  queue.improvementPlan?.forEach((step, index) => {
    const path = `${base}.improvementPlan[${index}].dependencies`;
    for (const dependency of step.dependencies ?? []) {
      if (dependency === step.id) issue(issues, path, "step cannot depend on itself");
      else if (!stepIds.has(dependency)) issue(issues, path, `unknown step ${dependency}`);
    }
  });

  const criticalSteps = queue.improvementPlan?.filter((step) =>
    step.defectIds.some((id) => {
      const defect = defects.get(id);
      return defect && (
        defect.category.toLowerCase().includes("integrity") ||
        defect.severity === "blocker" ||
        defect.severity === "major"
      );
    })) ?? [];
  const nitOnlySteps = queue.improvementPlan?.filter((step) =>
    step.defectIds.length > 0 && step.defectIds.every((id) => defects.get(id)?.severity === "nit")) ?? [];
  for (const nit of nitOnlySteps) {
    for (const critical of criticalSteps) {
      if (nit.rank < critical.rank || nit.priority < critical.priority) {
        issue(
          issues,
          `${base}.improvementPlan`,
          `nit-only step ${nit.id} cannot outrank integrity/major step ${critical.id}`,
        );
      }
    }
  }
}

function validateClaim(
  claim: NarrativeClaim,
  path: string,
  runId: string | null,
  context: ValidateQueueSubmissionContext,
  issues: QueueValidationIssue[],
): void {
  requireText(claim?.text, `${path}.text`, issues);
  validateRequiredRefs(claim?.refs, `${path}.refs`, runId, context, issues);
}

function validateTarget(
  target: ImprovementTarget,
  path: string,
  issues: QueueValidationIssue[],
): void {
  if (!isRecord(target)) {
    issue(issues, path, "must be an object");
    return;
  }
  if (["code", "config", "prompt", "eval"].includes(target.kind)) {
    const resolved = target as Extract<ImprovementTarget, { paths: string[] }>;
    requireNonEmptyArray(resolved.paths, `${path}.paths`, issues);
    return;
  }
  if (target.kind === "external") {
    requireText(target.system, `${path}.system`, issues);
    requireText(target.blocker, `${path}.blocker`, issues);
    return;
  }
  issue(issues, `${path}.kind`, "must be code|config|prompt|eval|external");
}

function validateRequiredRefs(
  refs: Ref[] | undefined,
  path: string,
  currentRunId: string | null,
  context: ValidateQueueSubmissionContext,
  issues: QueueValidationIssue[],
): void {
  if (!Array.isArray(refs) || refs.length === 0) {
    issue(issues, path, "must contain at least one ref");
    return;
  }
  validateRefs(refs, path, currentRunId, context, issues);
}

function validateRefs(
  refs: Ref[],
  path: string,
  currentRunId: string | null,
  context: ValidateQueueSubmissionContext,
  issues: QueueValidationIssue[],
): void {
  refs.forEach((ref, index) => {
    const refPath = `${path}[${index}]`;
    try {
      validateRef(ref, refPath);
    } catch (err) {
      issue(issues, refPath, err instanceof Error ? err.message : String(err));
      return;
    }
    const candidates = currentRunId
      ? [context.evidence.get(currentRunId)].filter(Boolean) as QueueEvidenceIndex[]
      : [...context.evidence.values()];
    if (ref.kind === "trace") {
      const evidence = context.evidence.get(ref.runId);
      if (!evidence) {
        issue(issues, refPath, `unknown trace run ${ref.runId}`);
      } else if (
        ref.seqs[0] < 0 ||
        ref.seqs[1] < ref.seqs[0] ||
        ref.seqs[1] > evidence.maxTraceSeq
      ) {
        issue(issues, refPath, `trace range ${ref.seqs.join("..")} outside 0..${evidence.maxTraceSeq}`);
      }
      return;
    }
    if (ref.kind === "tool") {
      if (!candidates.some((entry) => entry.toolCallIds.includes(ref.toolCallId))) {
        issue(issues, refPath, `unknown tool call ${ref.toolCallId}`);
      }
      return;
    }
    if (ref.kind === "diff") {
      if (!candidates.some((entry) =>
        entry.diffHunks.some((hunk) => hunk.file === ref.file && hunk.hunk === ref.hunk))) {
        issue(issues, refPath, `unknown diff hunk ${ref.file}#${ref.hunk}`);
      }
      return;
    }
    if (ref.kind === "artifact") {
      if (!candidates.some((entry) => artifactExists(entry.artifactPaths, ref.path))) {
        issue(issues, refPath, `unknown artifact ${ref.path}`);
      }
    }
  });
}

function allVerdictRefs(verdict: Verdict): Ref[] {
  const refs: Ref[] = [];
  for (const finding of [...(verdict.findings ?? []), ...(verdict.positiveFindings ?? [])]) {
    refs.push(...finding.refs);
  }
  for (const diagnostic of Object.values(verdict.diagnostics ?? {})) refs.push(...(diagnostic.refs ?? []));
  for (const improvement of verdict.improvements?.withoutSource ?? []) refs.push(...improvement.refs);
  for (const improvement of verdict.improvements?.withSource ?? []) refs.push(...improvement.refs);
  return refs;
}

function normalizeNarrative(raw: Record<string, unknown>): EvalJudgementNarrative {
  const handoff = isRecord(raw.handoff) ? raw.handoff : {};
  return {
    schemaVersion: Number(raw.schemaVersion ?? raw.schema_version) as 1,
    headline: raw.headline as string,
    judgement: raw.judgement as string,
    executionAnalysis: array(raw.executionAnalysis ?? raw.execution_analysis) as EvalJudgementNarrative["executionAnalysis"],
    strengths: array(raw.strengths) as EvalJudgementNarrative["strengths"],
    concerns: array(raw.concerns).map((entry) => {
      const value = isRecord(entry) ? entry : {};
      return {
        ...value,
        ownerClass: value.ownerClass ?? value.owner_class,
        findingIds: array(value.findingIds ?? value.finding_ids),
      } as EvalJudgementNarrative["concerns"][number];
    }),
    evidenceBoundaries: array(raw.evidenceBoundaries ?? raw.evidence_boundaries) as EvalJudgementNarrative["evidenceBoundaries"],
    handoff: {
      preserve: array(handoff.preserve) as EvalJudgementNarrative["handoff"]["preserve"],
      change: array(handoff.change) as EvalJudgementNarrative["handoff"]["change"],
      investigate: array(handoff.investigate) as EvalJudgementNarrative["handoff"]["investigate"],
    },
  };
}

function normalizeQueueAnalysis(raw: Record<string, unknown>): QueueWideAnalysis {
  return {
    schemaVersion: Number(raw.schemaVersion ?? raw.schema_version) as 2,
    summary: raw.summary as string,
    themes: array(raw.themes) as NarrativeClaim[],
    reliability: raw.reliability as QueueWideAnalysis["reliability"],
    rankedDefects: array(raw.rankedDefects ?? raw.ranked_defects).map((entry) => {
      const value = isRecord(entry) ? entry : {};
      return {
        ...value,
        runIds: array(value.runIds ?? value.run_ids),
      } as QueueWideAnalysis["rankedDefects"][number];
    }),
    subsystemAttribution: array(raw.subsystemAttribution ?? raw.subsystem_attribution).map((entry) => {
      const value = isRecord(entry) ? entry : {};
      return {
        ...value,
        runIds: array(value.runIds ?? value.run_ids),
      } as QueueWideAnalysis["subsystemAttribution"][number];
    }),
    regressions: array(raw.regressions) as NarrativeClaim[],
    improvementPlan: array(raw.improvementPlan ?? raw.improvement_plan).map((entry) => {
      const value = isRecord(entry) ? entry : {};
      return {
        ...value,
        defectIds: array(value.defectIds ?? value.defect_ids),
        acceptanceCriteria: array(value.acceptanceCriteria ?? value.acceptance_criteria),
        verifyTaskIds: array(value.verifyTaskIds ?? value.verify_task_ids),
        regressionTaskIds: array(value.regressionTaskIds ?? value.regression_task_ids),
        nonGoals: array(value.nonGoals ?? value.non_goals),
        blockingReason: value.blockingReason ?? value.blocking_reason,
      } as QueueImprovementStep;
    }),
  };
}

function artifactExists(paths: string[], requested: string): boolean {
  const normalized = requested.replace(/^\.\//, "");
  return paths.some((path) => path === normalized || path.endsWith(`/${normalized}`));
}

function requireOwner(value: unknown, path: string, issues: QueueValidationIssue[]): void {
  if (!["agent", "platform", "judge", "eval"].includes(String(value))) {
    issue(issues, path, "must be agent|platform|judge|eval");
  }
}

function requireText(value: unknown, path: string, issues: QueueValidationIssue[]): void {
  if (!nonEmpty(value)) issue(issues, path, "must be a non-empty string");
}

function requireNonEmptyArray(value: unknown, path: string, issues: QueueValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) issue(issues, path, "must be a non-empty array");
}

function issue(issues: QueueValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

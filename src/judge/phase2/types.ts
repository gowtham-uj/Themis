/** Black-box advisory Phase-2 campaign types. */
import type {FindingSignature} from "../validity/signatures.js";
export type FailureOwner = "agent" | "eval_harness" | "none" | "unknown";
export type PatternRegistryStatus = "candidate" | "provisional" | "canonical" | "deprecated";

export interface Phase2Cohort {
  language: string;
  category: string;
  profile: string;
  model: string;
}

export interface Phase2Case {
  runId: string;
  validForAgentLearning: boolean;
  failureOwner: FailureOwner;
  /** Official reward, plus whether it measures the agent (false: verifier/harness artifact). */
  reward: number | null;
  rewardAttributable: boolean;
  agent: string;
  model: string | null;
  tokens: number | null;
  wallTimeMs: number | null;
  toolCalls: number | null;
  narrative: string;
  /** Verbatim Phase-1 improvement items (issue/recommendation/category/impact/confidence/refs). */
  improvements: readonly Record<string, unknown>[];
  qualityPassed: boolean;
  /** Deterministic facts about a verifier/harness failure, when present. */
  platformFault: {
    kind: "verifier_crash" | "verifier_timeout" | "setup_failure" | "empty_workspace" | "none";
    exitCode: number | null;
    detail: string;
  };
  /** Independent of verifier crash: seed files never landed. */
  emptyWorkspace: boolean;
  taskName: string;
  cohort: Phase2Cohort;
}

export interface Phase2Observation {
  id: string;
  evalId: string;
  signature: FindingSignature;
  owner: FailureOwner;
  summary: string;
  refs: readonly string[];
  reward: number | null;
  /** Whether `reward` measures the agent (false: verifier/harness artifact). */
  rewardAttributable: boolean;
  tokens: number | null;
  wallTimeMs: number | null;
  toolCalls: number | null;
  cohort: Phase2Cohort;
}

export interface Phase2Pattern {
  id: string;
  signature: FindingSignature;
  /** Who owns the failing behavior: agent, eval_harness, or mixed. */
  owner: FailureOwner | "mixed";
  evalIds: readonly string[];
  frequency: number;
  passed: number;
  failed: number;
  /** Runs whose reward was a platform artifact — excluded from pass/fail. */
  unattributable: number;
  averageTokens: number | null;
  /** Count of agent-attributable weaknesses present in PASSING runs (reward=1). */
  silentWeaknesses: number;
  evidence: readonly { evalId: string; summary: string; refs: readonly string[] }[];
  summary: string;
  registryStatus: PatternRegistryStatus;
  /** Within-cohort breakdown so difficulty is not confused with agent weakness. */
  cohorts: readonly { key: string; count: number; passed: number; failed: number }[];
}

export interface Phase2Hypothesis {
  id: string;
  patternId: string;
  claim: string;
  supportingObservations: readonly string[];
  contradictingObservations: readonly string[];
  likelyMechanism: readonly string[];
  confidence: "high" | "medium" | "low";
}

export interface Phase2ResearchNote {
  hypothesisId: string;
  techniques: readonly { url: string; claim: string }[];
  applicable: boolean;
  notes: string;
}

export interface ExperimentPlan {
  id: string;
  claimToTest: string;
  control: string;
  treatment: string;
  constants: readonly string[];
  targetTasks: readonly string[];
  regressionTasks: readonly string[];
  primaryMetric: { name: string; minimumWorthwhileEffect: string };
  secondaryMetrics: readonly string[];
  regressionLimits: Readonly<Record<string, string>>;
  suggestedSample: { tasks: number; seedsPerTask: number };
  successConditions: readonly string[];
}

export interface Phase2ImplementationHandoff {
  targetCapability: string;
  observedInterface: string;
  likelyInternalAreas: readonly string[];
  requiredBehavior: readonly string[];
  themisKnowsExactSourceLocation: false;
}

export interface Phase2Recommendation {
  id: string;
  patternIds: readonly string[];
  class: "direct_fix" | "research_backed" | "experimental";
  priority: "P0" | "P1" | "P2" | "P3";
  targetCapability: string;
  observedBehavior: string;
  likelyMechanism: string;
  implementationRequirements: readonly string[];
  implementationHandoff: Phase2ImplementationHandoff;
  risks: readonly string[];
  researchBasis: readonly { url: string; claim: string }[];
  experimentPlan: ExperimentPlan;
  confidence: "high" | "medium" | "low";
  evidenceLevel: "observational" | "mechanistically_supported" | "research_supported" | "experiment_proposed" | "developer_implementation_required";
}

export interface Phase2PlatformFinding {
  id: string;
  severity: "blocker" | "major" | "minor";
  kind: string;
  runIds: readonly string[];
  finding: string;
  evidence: readonly string[];
  fixOwner: string;
  fixSuggestion: string;
}

/**
 * The agent-facing executive brief. Contains ONLY what helps the developer of
 * the tested agent. Platform defects live in {@link Phase2PlatformReport}.
 */
export interface Phase2ExecutiveBrief {
  largestWeaknesses: readonly { patternId: string; signature: string; frequency: number; whyItMatters: string }[];
  nextDeveloperAction: string;
}

export interface Phase2Review {
  keptIds: readonly string[];
  dropped: readonly { id: string; reason: string }[];
  notes: string;
}

export interface Phase2MemoryRecord {
  rejectedRecommendationIds: readonly string[];
  reasons: readonly string[];
}

/** The developer improvement pack — agent-facing content ONLY. */
export interface Phase2DeveloperPack {
  schemaVersion: 1;
  campaignId: string;
  projectId: string;
  sutFingerprint: string;
  memberRunIds: readonly string[];
  validAgentRuns: number;
  executiveBrief: Phase2ExecutiveBrief;
  hypotheses: readonly Phase2Hypothesis[];
  /** Agent-owned patterns only (owner agent|mixed). */
  patterns: readonly Phase2Pattern[];
  recommendations: readonly Phase2Recommendation[];
  review: Phase2Review;
  generatedAt: string;
}

/**
 * The separate platform improvement report — defects in THEMIS/Agenteval and
 * the eval package. Never shipped inside the agent's developer pack.
 */
export interface Phase2PlatformReport {
  schemaVersion: 1;
  campaignId: string;
  platformFailures: number;
  rewardNotAttributable: number;
  findings: readonly Phase2PlatformFinding[];
  /** Harness-owned patterns (owner eval_harness), never attributed to the agent. */
  patterns: readonly Phase2Pattern[];
  nextPlatformAction: string;
  generatedAt: string;
}

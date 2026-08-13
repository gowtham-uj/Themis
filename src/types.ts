/**
 * Minimal shared types used by the eval runner + DB + evidence pipeline.
 * Previously lived under src/judge/ — kept here as standalone definitions
 * so the runner + queries modules compile without the judge subsystem.
 */

export type VerdictLevel = "pass" | "fail" | "partial";

export interface Ref {
  kind: "diff" | "trace" | "tool" | "artifact";
  file?: string;
  hunk?: number;
  runId?: string;
  seqs?: [number, number];
  toolCallId?: string;
  path?: string;
  sha256?: string;
  note?: string;
}

export interface CheckResult {
  exitCode?: number;
  checkId: string;
  kind: string;
  status: "pass" | "fail" | "error" | "skipped";
  detail?: string;
  durationMs?: number;
}

/** Minimal verdict shape stored by the queries layer. */
export type Verdict = Record<string, any> & {
  schemaVersion?: number;
  overall?: { score?: number; verdict?: VerdictLevel; summary?: string };
};

/** Minimal narrative shape stored by the queries layer. */
export type EvalJudgementNarrative = Record<string, unknown> & {
  schemaVersion?: number;
  headline?: string;
  judgement?: string;
};

export type ImprovementOwnerClass = "agent" | "platform" | "judge" | "eval";
export type ImprovementStepStatus = "proposed" | "ready" | "blocked" | "in_progress" | "verified" | "rejected";

export interface QueueImprovementStep {
  id: string;
  rank: number;
  class: ImprovementOwnerClass;
  priority: number;
  confidence: number;
  defectIds: string[];
  subsystem: string;
  problem: string;
  evidence: Ref[];
  target: { kind: "code" | "config" | "prompt" | "eval"; paths: string[] } | { kind: "external"; system: string; blocker: string };
  change: string;
  acceptanceCriteria: string[];
  tests: Array<{ name: string; kind: "unit" | "integration" | "e2e"; command?: string; expected: string }>;
  verifyTaskIds: string[];
  regressionTaskIds: string[];
  dependencies: string[];
  nonGoals: string[];
  preventive: boolean;
  status: ImprovementStepStatus;
  blockingReason?: string;
}

export type Finding = Record<string, any>;
export type MetaFinding = Record<string, unknown>;
export interface Check {
  id: string;
  kind: string;
  command?: string;
  expected?: string;
}

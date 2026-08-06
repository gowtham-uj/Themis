/**
 * Regression compute barrel (P7a) — pure, DB-free math for trend / two-run
 * compare / release compare. The API layer joins rows then calls these.
 */

export {
  batchStats,
  scoreTrend,
  compareTwoRuns,
  releaseCompare,
  isLikelyRegression,
  type RubricAxis,
  type Ref,
  type Diagnostic,
  type RunPoint,
  type JudgementPoint,
  type CriterionScore,
  type FindingInstance,
  type BatchStats,
  type TrendPoint,
  type RunCompareSide,
  type RunCompare,
  type TaskReleaseResult,
  type ReleaseSide,
  type ReleaseCompare,
} from "./compute.js";

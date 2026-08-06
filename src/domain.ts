/**
 * Shared domain types — the single contract P3a (db) and P3b (task sources)
 * build against, so persistence + ingest never drift apart.
 *
 * Spec sources of truth:
 *  - plan/projects.md   (TaskSource, TaskSpec, Project)
 *  - plan/categories.md (AgentCategory, diffKind)
 *  - plan/rubric.md     (Rubric structure: axes A–H, criteria, anchors, checks)
 *  - plan/data-model.md (table shapes these types mirror)
 *
 * WorkspaceSpec is reused from src/adapters/types.ts (single definition).
 */

import type { WorkspaceSpec } from "./adapters/types.js";

/** Pre-defined agent category — gates rubric axes, withSource lens, diff kind. */
export type AgentCategory =
  | "coding"
  | "research"
  | "general"
  | "browser"
  | "data"
  | "conversational";

/** What "the diff" means for a category's refs (plan/categories.md). */
export type DiffKind = "git" | "outputs" | "none";

/** Rubric axis letter (A–H). See plan/rubric.md §2. */
export type RubricAxis = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

/** Applicability filter — a criterion applies to general/coding/both. */
export type AppliesTo = "general" | "coding" | "both";

/** Task profile — presets which criteria apply (plan/rubric.md §6). */
export type TaskProfile =
  | "bugfix"
  | "feature"
  | "refactor"
  | "research"
  | "general"
  | "browser"
  | "etl"
  | "conversational";

/** Per-level anchored description (1.0 / 0.75 / 0.5 / 0.25 / 0.0). */
export interface Anchors {
  /** Level 1.0 — fully & verifiably met. */
  full: string;
  /** Level 0.5 — partially met. */
  partial: string;
  /** Level 0.0 — absent or harmful. */
  none: string;
}

/**
 * A single scored criterion within a rubric. The unit that receives a 0.0–1.0
 * score with anchored descriptions so judging is absolute, not relative.
 */
export interface Criterion {
  /** Stable id within the rubric (e.g. "A1", "D2"). */
  id: string;
  /** Axis letter. */
  axis: RubricAxis;
  /** Human label. */
  label: string;
  /** Weight within its axis (renormalized §7). */
  weight: number;
  /** If true, failing it caps the overall verdict at "fail". */
  critical?: boolean;
  /** Which categories this criterion applies to. */
  appliesTo: AppliesTo;
  /** Anchored per-level meanings. */
  anchors: Anchors;
  /** Optional deterministic check that grounds/overrides the judged score. */
  checkId?: string;
}

/**
 * A deterministic hook (plan/rubric.md §5): tests, build, typecheck, lint,
 * repro, secret_scan, perf_bench, http. Result is exact and cheap; the judge
 * reconciles with it. Tracked separately as pass-rates.
 */
export interface Check {
  /** Stable id referenced by Criterion.checkId. */
  id: string;
  /** Kind of check (maps to a command template in the project's check_runners). */
  kind:
    | "test_suite"
    | "build"
    | "typecheck"
    | "lint"
    | "repro"
    | "secret_scan"
    | "perf_bench"
    | "http"
    | "command";
  /** Optional per-check command override (else uses check_runners[kind]). */
  command?: string;
  /** For http checks: the endpoint + assertion. */
  http?: { url: string; expectStatus?: number; expectBodyContains?: string };
  /** Optional human description. */
  description?: string;
}

/**
 * Per-task rubric: criteria + weights + checks + anchors + profile.
 * Stored as `rubric_json`; editing bumps `rubric_version` (new baseline).
 */
export interface Rubric {
  /** Criteria, each scored 0.0–1.0 against its anchors. */
  criteria: Criterion[];
  /** Deterministic checks available to criteria. */
  checks?: Check[];
  /** Task-type profile filtering applicable criteria. */
  profile: TaskProfile;
  /** Version — bumped on rubric edit (new comparison baseline). */
  version: number;
}

/** Workspace provenance (reused; see src/adapters/types.ts). */
export type { WorkspaceSpec };

/**
 * A task as yielded by a TaskSource before persistence (plan/projects.md).
 * The core persists whatever a source yields into the `tasks` table.
 */
export interface TaskSpec {
  /** Stable external id from the source (e.g. file path); unique per project. */
  id?: string;
  name: string;
  prompt: string;
  workspace: WorkspaceSpec;
  rubric: Rubric;
  tags?: string[];
  profile?: TaskProfile;
  /** Path/url to a reference solution (optional, gated access for judge). */
  referenceSolution?: string;
  /** Per-task checks (also in rubric.checks; convenience field). */
  checks?: Check[];
  /** Category the task targets (defaults from project). */
  agentCategory?: AgentCategory;
}

/** Result of a TaskSource.validate call. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * A task source — pluggable ingest turning a project's representation into
 * TaskSpecs (plan/projects.md). Pull (polled/on-demand) or push.
 */
export interface TaskSource {
  kind: "ui-builder" | "repo-md" | "manifest-yaml" | "ci-artifact" | "http-push";
  /** Yield tasks from the project's source representation. */
  list(ctx: ProjectCtx): AsyncIterable<TaskSpec>;
  /** Optional validation against project conventions before insert. */
  validate?(spec: TaskSpec): ValidationResult;
}

/** Context handed to a TaskSource — the project it ingests for. */
export interface ProjectCtx {
  projectId: string;
  /** On-disk project root: <DATA_DIR>/projects/<projectId>. */
  projectDir: string;
  /** Optional workspace clone path the source may read (repo-md reads evals/*.md from here). */
  workspaceDir?: string;
  /** The project's default agent category (tasks may override). */
  defaultAgentCategory: AgentCategory;
}

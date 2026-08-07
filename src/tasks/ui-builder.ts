/**
 * UI-builder task source (kind: "ui-builder").
 *
 * The UI persists authored tasks directly to the DB (P3c). This source is a
 * passthrough/readback: it re-reads `task.json` files under
 * `<projectDir>/tasks/<tid>/task.json` so a sync round-trips authored tasks.
 *
 * Also exports `buildTaskSpec` — the helper the create-task form calls to
 * assemble a valid TaskSpec from form input.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { parseEvalEnvSpec } from "../runner/env-provision.js";
import { join } from "node:path";
import type {
  Anchors,
  Check,
  Criterion,
  ProjectCtx,
  Rubric,
  RubricAxis,
  TaskProfile,
  TaskSource,
  TaskSpec,
  ValidationResult,
} from "../domain.js";
import type { WorkspaceSpec } from "../adapters/types.js";

// ---------------------------------------------------------------------------
// Shared TaskSpec validation (used by UIBuilderSource + RepoMdSource)
// ---------------------------------------------------------------------------

const AXES = new Set<RubricAxis>(["A", "B", "C", "D", "E", "F", "G", "H"]);
const APPLIES = new Set(["general", "coding", "both"]);
const PROFILES = new Set([
  "bugfix",
  "feature",
  "refactor",
  "research",
  "general",
  "browser",
  "etl",
  "conversational",
]);

/**
 * Validate a TaskSpec for ingest. Never throws.
 * Enforces plan/rubric.md + plan/projects.md invariants: non-empty prompt,
 * ≥1 criterion, anchors present, rubric well-formed.
 */
export function validateTaskSpec(spec: TaskSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!spec.name || !String(spec.name).trim()) {
    errors.push("name is required and must be non-empty");
  }
  if (!spec.prompt || !String(spec.prompt).trim()) {
    errors.push("prompt is required and must be non-empty");
  }

  if (!spec.workspace || typeof spec.workspace !== "object") {
    errors.push("workspace is required");
  } else if (spec.workspace.source === "git") {
    if (!spec.workspace.repo || !String(spec.workspace.repo).trim()) {
      errors.push('workspace.source="git" requires a non-empty repo');
    }
  } else if (spec.workspace.source !== "empty") {
    errors.push(
      `workspace.source must be "git" or "empty", got ${String((spec.workspace as { source?: string }).source)}`,
    );
  }

  if (!spec.rubric) {
    errors.push("rubric is required");
  } else {
    validateRubric(spec.rubric, errors, warnings);
  }

  if (spec.profile !== undefined && !PROFILES.has(spec.profile)) {
    warnings.push(`unknown profile "${spec.profile}"`);
  }

  if (spec.tags !== undefined && !Array.isArray(spec.tags)) {
    warnings.push("tags should be an array of strings");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate a standalone Rubric (no surrounding task). Never throws.
 * Used by the project-rubric CRUD routes, which accept a rubric on its own
 * rather than as part of a TaskSpec.
 */
export function validateRubricSpec(rubric: Rubric): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateRubric(rubric, errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}

function validateRubric(rubric: Rubric, errors: string[], warnings: string[]): void {
  if (!Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    errors.push("rubric must have ≥1 criterion");
    return;
  }

  if (rubric.profile !== undefined && !PROFILES.has(rubric.profile)) {
    warnings.push(`rubric.profile unknown: "${rubric.profile}"`);
  }

  if (
    typeof rubric.version !== "number" ||
    !Number.isFinite(rubric.version) ||
    rubric.version < 1
  ) {
    warnings.push(
      `rubric.version should be a positive number (got ${String(rubric.version)})`,
    );
  }

  const ids = new Set<string>();
  for (let i = 0; i < rubric.criteria.length; i++) {
    const c = rubric.criteria[i]!;
    validateCriterion(c, i, errors, warnings, ids);
  }

  if (rubric.checks) {
    if (!Array.isArray(rubric.checks)) {
      warnings.push("rubric.checks should be an array");
    } else {
      const checkIds = new Set(rubric.checks.map((ch) => ch.id));
      for (const c of rubric.criteria) {
        if (c.checkId && !checkIds.has(c.checkId)) {
          warnings.push(
            `criterion ${c.id}: checkId "${c.checkId}" not found in rubric.checks`,
          );
        }
      }
    }
  }
}

function validateCriterion(
  c: Criterion,
  index: number,
  errors: string[],
  _warnings: string[],
  ids: Set<string>,
): void {
  const label = c.id ? `criterion ${c.id}` : `criterion[${index}]`;

  if (!c.id || !String(c.id).trim()) {
    errors.push(`${label}: id is required`);
  } else if (ids.has(c.id)) {
    errors.push(`${label}: duplicate criterion id`);
  } else {
    ids.add(c.id);
  }

  if (!c.label || !String(c.label).trim()) {
    errors.push(`${label}: label is required`);
  }

  if (!AXES.has(c.axis)) {
    errors.push(`${label}: axis must be A–H (got ${String(c.axis)})`);
  }

  if (!APPLIES.has(c.appliesTo)) {
    errors.push(`${label}: appliesTo must be general|coding|both`);
  }

  if (typeof c.weight !== "number" || !Number.isFinite(c.weight) || c.weight < 0) {
    errors.push(`${label}: weight must be a non-negative number`);
  }

  if (!c.anchors || typeof c.anchors !== "object") {
    errors.push(`${label}: anchors are required (full/partial/none)`);
  } else {
    for (const key of ["full", "partial", "none"] as const) {
      const v = c.anchors[key];
      if (typeof v !== "string" || !v.trim()) {
        errors.push(`${label}: anchors.${key} is required and must be non-empty`);
      }
    }
  }
}

/** Input shape for the UI create-task form. */
export interface BuildTaskSpecInput {
  name: string;
  prompt: string;
  workspace?: WorkspaceSpec;
  rubric: {
    criteria: Array<{
      id: string;
      axis: Criterion["axis"];
      label: string;
      weight: number;
      critical?: boolean;
      appliesTo: Criterion["appliesTo"];
      anchors: Anchors;
      checkId?: string;
    }>;
    checks?: Check[];
    profile?: TaskProfile;
    version?: number;
  };
  tags?: string[];
  profile?: TaskProfile;
  agentCategory?: TaskSpec["agentCategory"];
  referenceSolution?: string;
  checks?: Check[];
  /** Env this eval needs: greenfield/brownfield, image, setup script. */
  env?: unknown;
  /** Optional external id (stable key for upsert). */
  id?: string;
}

/**
 * Assemble a valid TaskSpec from UI form input.
 * Throws if the result fails validation (empty prompt, no criteria, missing anchors).
 */
export function buildTaskSpec(input: BuildTaskSpecInput): TaskSpec {
  const profile: TaskProfile = input.profile ?? input.rubric.profile ?? "general";
  const criteria: Criterion[] = (input.rubric.criteria ?? []).map((c) => ({
    id: c.id,
    axis: c.axis,
    label: c.label,
    weight: c.weight,
    ...(c.critical !== undefined ? { critical: c.critical } : {}),
    appliesTo: c.appliesTo,
    anchors: {
      full: c.anchors?.full ?? "",
      partial: c.anchors?.partial ?? "",
      none: c.anchors?.none ?? "",
    },
    ...(c.checkId !== undefined ? { checkId: c.checkId } : {}),
  }));

  const rubric: Rubric = {
    criteria,
    profile: input.rubric.profile ?? profile,
    version: input.rubric.version ?? 1,
    ...(input.rubric.checks !== undefined ? { checks: input.rubric.checks } : {}),
  };

  const spec: TaskSpec = {
    name: (input.name ?? "").trim(),
    prompt: (input.prompt ?? "").trim(),
    workspace: input.workspace ?? { source: "empty" },
    rubric,
    profile,
    ...(input.id !== undefined ? { id: input.id } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.agentCategory !== undefined ? { agentCategory: input.agentCategory } : {}),
    ...(input.referenceSolution !== undefined
      ? { referenceSolution: input.referenceSolution }
      : {}),
    ...(input.checks !== undefined
      ? { checks: input.checks }
      : input.rubric.checks !== undefined
        ? { checks: input.rubric.checks }
        : {}),
    // Env the eval needs (greenfield/brownfield, image, setup script). Parsed
    // through the provisioner so malformed fields drop rather than reaching a
    // container invocation.
    ...(parseEvalEnvSpec(input.env) !== undefined
      ? { env: parseEvalEnvSpec(input.env)! }
      : {}),
  };

  const result = validateTaskSpec(spec);
  if (!result.ok) {
    throw new Error(`buildTaskSpec: invalid TaskSpec: ${result.errors.join("; ")}`);
  }
  return spec;
}

/**
 * Readback source for UI-authored tasks stored as task.json under projectDir/tasks/.
 */
export class UIBuilderSource implements TaskSource {
  readonly kind = "ui-builder" as const;

  async *list(ctx: ProjectCtx): AsyncIterable<TaskSpec> {
    const tasksRoot = join(ctx.projectDir, "tasks");
    let entries: string[];
    try {
      entries = await readdir(tasksRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }

    for (const tid of entries.sort()) {
      const taskDir = join(tasksRoot, tid);
      let isDir = false;
      try {
        isDir = (await stat(taskDir)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const taskPath = join(taskDir, "task.json");
      let raw: string;
      try {
        raw = await readFile(taskPath, "utf8");
      } catch {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;

      const obj = parsed as Record<string, unknown>;
      const spec = coerceTaskJson(obj, tid, ctx);
      if (spec) yield spec;
    }
  }

  validate(spec: TaskSpec): ValidationResult {
    return validateTaskSpec(spec);
  }
}

/** Best-effort coerce of on-disk task.json into a TaskSpec. */
function coerceTaskJson(
  obj: Record<string, unknown>,
  tid: string,
  ctx: ProjectCtx,
): TaskSpec | null {
  const name = typeof obj.name === "string" ? obj.name : tid;
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  const workspace = coerceWorkspace(obj.workspace);
  const rubric = coerceRubric(obj.rubric);
  if (!rubric) return null;

  const spec: TaskSpec = {
    id: typeof obj.id === "string" ? obj.id : typeof obj.external_id === "string" ? obj.external_id : tid,
    name,
    prompt,
    workspace,
    rubric,
    ...(typeof obj.profile === "string" ? { profile: obj.profile as TaskProfile } : {}),
    ...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t): t is string => typeof t === "string") } : {}),
    ...(typeof obj.agentCategory === "string"
      ? { agentCategory: obj.agentCategory as TaskSpec["agentCategory"] }
      : { agentCategory: ctx.defaultAgentCategory }),
    ...(typeof obj.referenceSolution === "string"
      ? { referenceSolution: obj.referenceSolution }
      : {}),
    ...(Array.isArray(obj.checks) ? { checks: obj.checks as Check[] } : {}),
  };
  return spec;
}

function coerceWorkspace(w: unknown): WorkspaceSpec {
  if (w && typeof w === "object") {
    const o = w as Record<string, unknown>;
    if (o.source === "git" && typeof o.repo === "string") {
      return {
        source: "git",
        repo: o.repo,
        ...(typeof o.ref === "string" ? { ref: o.ref } : {}),
      };
    }
    if (o.source === "empty") return { source: "empty" };
  }
  return { source: "empty" };
}

function coerceRubric(r: unknown): Rubric | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const criteriaRaw = Array.isArray(o.criteria) ? o.criteria : [];
  const criteria: Criterion[] = [];
  for (const c of criteriaRaw) {
    if (!c || typeof c !== "object") continue;
    const cr = c as Record<string, unknown>;
    const anchors = (cr.anchors ?? {}) as Record<string, unknown>;
    criteria.push({
      id: String(cr.id ?? ""),
      axis: (cr.axis as Criterion["axis"]) ?? "A",
      label: String(cr.label ?? ""),
      weight: typeof cr.weight === "number" ? cr.weight : Number(cr.weight) || 0,
      ...(typeof cr.critical === "boolean" ? { critical: cr.critical } : {}),
      appliesTo: (cr.appliesTo as Criterion["appliesTo"]) ?? "both",
      anchors: {
        full: String(anchors.full ?? ""),
        partial: String(anchors.partial ?? ""),
        none: String(anchors.none ?? ""),
      },
      ...(typeof cr.checkId === "string" ? { checkId: cr.checkId } : {}),
    });
  }
  return {
    criteria,
    profile: (typeof o.profile === "string" ? o.profile : "general") as TaskProfile,
    version: typeof o.version === "number" ? o.version : Number(o.version) || 1,
    ...(Array.isArray(o.checks) ? { checks: o.checks as Check[] } : {}),
  };
}

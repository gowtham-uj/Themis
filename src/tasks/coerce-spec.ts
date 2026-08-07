/**
 * Shared TaskSpec coercion helpers for pull/push task sources.
 *
 * Used by manifest-yaml, ci-artifact, and http-push to normalize loose JSON/YAML
 * objects into domain TaskSpecs without depending on ui-builder/repo-md internals.
 */

import type {
  AgentCategory,
  Anchors,
  AppliesTo,
  Check,
  Criterion,
  Rubric,
  RubricAxis,
  TaskProfile,
  TaskSpec,
} from "../domain.js";
import type { WorkspaceSpec } from "../adapters/types.js";
import { parseEvalEnvSpec } from "../runner/env-provision.js";

const AGENT_CATEGORIES = new Set<AgentCategory>([
  "coding",
  "research",
  "general",
  "browser",
  "data",
  "conversational",
]);

/**
 * Coerce a loose object into a WorkspaceSpec (git | empty).
 * Unknown / missing shapes fall back to `{ source: "empty" }`.
 */
export function coerceWorkspace(w: unknown): WorkspaceSpec {
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

/** Coerce a loose checks array into Check[] (skips malformed items). */
export function coerceChecks(c: unknown): Check[] | undefined {
  if (!Array.isArray(c)) return undefined;
  const out: Check[] = [];
  for (const item of c) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.kind !== "string") continue;
    const check: Check = {
      id: o.id,
      kind: o.kind as Check["kind"],
      ...(typeof o.command === "string" ? { command: o.command } : {}),
      ...(typeof o.description === "string" ? { description: o.description } : {}),
      ...(o.http && typeof o.http === "object"
        ? { http: o.http as Check["http"] }
        : {}),
    };
    out.push(check);
  }
  return out.length > 0 ? out : undefined;
}

/** Coerce a string array (tags, etc.); non-arrays → undefined. */
export function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function coerceCriterion(c: unknown, index: number): Criterion {
  const o = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  const anchorsRaw =
    o.anchors && typeof o.anchors === "object"
      ? (o.anchors as Record<string, unknown>)
      : {};
  const anchors: Anchors = {
    full: String(anchorsRaw.full ?? ""),
    partial: String(anchorsRaw.partial ?? ""),
    none: String(anchorsRaw.none ?? ""),
  };

  return {
    id: typeof o.id === "string" ? o.id : `C${index + 1}`,
    axis: (typeof o.axis === "string" ? o.axis : "A") as RubricAxis,
    label: typeof o.label === "string" ? o.label : `Criterion ${index + 1}`,
    weight:
      typeof o.weight === "number"
        ? o.weight
        : typeof o.weight === "string"
          ? Number(o.weight) || 0
          : 1,
    ...(typeof o.critical === "boolean" ? { critical: o.critical } : {}),
    appliesTo: (typeof o.appliesTo === "string"
      ? o.appliesTo
      : "both") as AppliesTo,
    anchors,
    ...(typeof o.checkId === "string" ? { checkId: o.checkId } : {}),
  };
}

/**
 * Coerce a loose rubric object (plus optional top-level checks/profile) into a Rubric.
 */
export function coerceRubric(
  r: unknown,
  topChecks?: unknown,
  topProfile?: unknown,
): Rubric {
  const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
  const criteriaRaw = Array.isArray(o.criteria) ? o.criteria : [];
  const criteria: Criterion[] = criteriaRaw.map((c, i) => coerceCriterion(c, i));

  const checks = coerceChecks(o.checks) ?? coerceChecks(topChecks) ?? undefined;
  const profile = (
    typeof o.profile === "string"
      ? o.profile
      : typeof topProfile === "string"
        ? topProfile
        : "general"
  ) as TaskProfile;
  const version =
    typeof o.version === "number"
      ? o.version
      : typeof o.version === "string" && /^\d+$/.test(o.version)
        ? Number(o.version)
        : 1;

  return {
    criteria,
    profile,
    version,
    ...(checks !== undefined ? { checks } : {}),
  };
}

/** Normalize agentCategory or fall back to the project default. */
export function coerceAgentCategory(
  v: unknown,
  fallback: AgentCategory,
): AgentCategory {
  if (typeof v === "string" && AGENT_CATEGORIES.has(v as AgentCategory)) {
    return v as AgentCategory;
  }
  return fallback;
}

export interface CoerceTaskSpecDefaults {
  /** Fallback id when the object lacks id/name. */
  id?: string;
  /** Project default agent category. */
  defaultAgentCategory: AgentCategory;
}

/**
 * Coerce a loose task object (JSON or YAML map) into a TaskSpec.
 * Does not validate — callers should run validateTaskSpec.
 */
export function coerceTaskSpec(
  obj: Record<string, unknown>,
  defaults: CoerceTaskSpecDefaults,
): TaskSpec {
  const externalId =
    (typeof obj.id === "string" && obj.id.trim()
      ? obj.id.trim()
      : undefined) ??
    (typeof obj.external_id === "string" && obj.external_id.trim()
      ? obj.external_id.trim()
      : undefined) ??
    (typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : undefined) ??
    defaults.id ??
    "task";

  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : externalId;

  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  const workspace = coerceWorkspace(obj.workspace);
  const rubric = coerceRubric(obj.rubric, obj.checks, obj.profile);
  const tags = coerceStringArray(obj.tags);
  const profile =
    (typeof obj.profile === "string" ? (obj.profile as TaskProfile) : undefined) ??
    rubric.profile;
  const agentCategory = coerceAgentCategory(
    obj.agentCategory ?? obj.agent_category,
    defaults.defaultAgentCategory,
  );
  const checks = coerceChecks(obj.checks) ?? rubric.checks;
  // Env spec is normalized by the provisioner, which drops malformed fields
  // rather than handing a half-configured environment to the container.
  const env = parseEvalEnvSpec(obj.env);

  const spec: TaskSpec = {
    id: externalId,
    name,
    prompt,
    workspace,
    rubric,
    profile,
    agentCategory,
    ...(tags !== undefined ? { tags } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof obj.referenceSolution === "string"
      ? { referenceSolution: obj.referenceSolution }
      : typeof obj.reference_solution === "string"
        ? { referenceSolution: obj.reference_solution }
        : {}),
  };
  return spec;
}

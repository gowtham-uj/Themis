/**
 * Repo-md task source (kind: "repo-md").
 *
 * Reads markdown files under the project's workspace (default glob:
 * "evals/**\/*.md"). Each file is YAML frontmatter + body:
 *   - frontmatter: name, prompt?, workspace, agentCategory?, profile?, tags?,
 *     checks?, rubric
 *   - body: used as the prompt when frontmatter omits `prompt`
 *
 * Parsing is zero-dep via parse-frontmatter.ts. Yields one TaskSpec per file;
 * external id = path relative to workspaceDir (stable for sync upsert).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  AgentCategory,
  Anchors,
  AppliesTo,
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
import { splitFrontmatter } from "./parse-frontmatter.js";
import { validateTaskSpec } from "./ui-builder.js";

export interface RepoMdSourceOptions {
  /**
   * Glob relative to workspaceDir. Default: "evals/**\/*.md".
   * Supports "**" and "*" only (no brace expansion / character classes).
   */
  glob?: string;
}

/**
 * Markdown-in-repo task source. Synced from the workspace commit.
 */
export class RepoMdSource implements TaskSource {
  readonly kind = "repo-md" as const;
  private readonly glob: string;

  constructor(opts: RepoMdSourceOptions = {}) {
    this.glob = opts.glob ?? "evals/**\/*.md";
  }

  async *list(ctx: ProjectCtx): AsyncIterable<TaskSpec> {
    const root = ctx.workspaceDir;
    if (!root) {
      // No workspace clone — nothing to yield.
      return;
    }

    const files = await matchGlob(root, this.glob);
    for (const abs of files.sort()) {
      const rel = toPosix(relative(root, abs));
      let text: string;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }

      const { frontmatter, body, warnings } = splitFrontmatter(text);
      const spec = frontmatterToTaskSpec(frontmatter, body, rel, ctx);
      // Attach parse warnings onto the object via a non-enumerable slot? Keep pure —
      // callers that care re-run splitFrontmatter or rely on validate warnings.
      void warnings;
      yield spec;
    }
  }

  validate(spec: TaskSpec): ValidationResult {
    return validateTaskSpec(spec);
  }
}

/** Convert parsed frontmatter + body into a TaskSpec. */
export function frontmatterToTaskSpec(
  fm: Record<string, unknown>,
  body: string,
  externalId: string,
  ctx: ProjectCtx,
): TaskSpec {
  const name =
    typeof fm.name === "string" && fm.name.trim()
      ? fm.name.trim()
      : basenameNoExt(externalId);

  const promptFromFm = typeof fm.prompt === "string" ? fm.prompt : undefined;
  const prompt = (promptFromFm ?? body).trim();

  const workspace = coerceWorkspace(fm.workspace);
  const rubric = coerceRubric(fm.rubric, fm.checks, fm.profile);
  const tags = coerceStringArray(fm.tags);
  const profile =
    (typeof fm.profile === "string" ? (fm.profile as TaskProfile) : undefined) ??
    rubric.profile;
  const agentCategory =
    typeof fm.agentCategory === "string"
      ? (fm.agentCategory as AgentCategory)
      : ctx.defaultAgentCategory;
  const checks = coerceChecks(fm.checks) ?? rubric.checks;

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
    ...(typeof fm.referenceSolution === "string"
      ? { referenceSolution: fm.referenceSolution }
      : {}),
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

function coerceRubric(
  r: unknown,
  topChecks: unknown,
  topProfile: unknown,
): Rubric {
  const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
  const criteriaRaw = Array.isArray(o.criteria) ? o.criteria : [];
  const criteria: Criterion[] = criteriaRaw.map((c, i) => coerceCriterion(c, i));

  const checks =
    coerceChecks(o.checks) ?? coerceChecks(topChecks) ?? undefined;
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

function coerceChecks(c: unknown): Check[] | undefined {
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

function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out;
}

function basenameNoExt(p: string): string {
  const base = p.split("/").pop() ?? p;
  return base.replace(/\.md$/i, "");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Minimal glob matcher: supports `*` and `**` segments relative to root.
 * Only matches `.md` files when the pattern ends with `.md` (typical).
 */
async function matchGlob(root: string, pattern: string): Promise<string[]> {
  const parts = pattern.split("/").filter((p) => p.length > 0);
  const results: string[] = [];
  await walk(root, parts, 0, results);
  return results;
}

async function walk(
  dir: string,
  parts: string[],
  pi: number,
  out: string[],
): Promise<void> {
  if (pi >= parts.length) return;
  const part = parts[pi]!;
  const isLast = pi === parts.length - 1;

  if (part === "**") {
    // Match zero or more directories.
    // 1) consume zero segments — advance pattern.
    await walk(dir, parts, pi + 1, out);
    // 2) recurse into subdirs, still matching **.
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const abs = join(dir, name);
      let isDir = false;
      try {
        isDir = (await stat(abs)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        await walk(abs, parts, pi, out); // stay on **
      }
    }
    return;
  }

  // Non-** segment: list dir and match.
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const re = segmentToRegExp(part);
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    if (!re.test(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (isLast) {
      if (st.isFile()) out.push(abs);
    } else if (st.isDirectory()) {
      await walk(abs, parts, pi + 1, out);
    }
  }
}

function segmentToRegExp(seg: string): RegExp {
  // Escape regex specials except `*`.
  let src = "";
  for (const ch of seg) {
    if (ch === "*") src += ".*";
    else if (/[.+^${}()|[\]\\]/.test(ch)) src += `\\${ch}`;
    else src += ch;
  }
  return new RegExp(`^${src}$`, "i");
}

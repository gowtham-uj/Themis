/**
 * CI-artifact task source (kind: "ci-artifact").
 *
 * Ingests task specs dropped by CI as either:
 *   1. A **directory of JSON** task specs (`params.artifactDir`), one `.json`
 *      file per task (or a nested tree of them); or
 *   2. A **single `manifest.json`** (or configured path) whose body is either
 *      `{ "tasks": [ ... ] }` or a bare `[ ... ]` array of TaskSpec-shaped
 *      objects.
 *
 * ## Deviation (Dockerless / deferred)
 *
 * Decompression of tar/zip CI bundles is **not** implemented here. Callers
 * (or a pre-step) must unpack the artifact into a directory first and point
 * `artifactDir` at it. Documented so plan/code stay honest.
 *
 * Semantics:
 * - Missing artifact dir → empty yield (not an error).
 * - Bad JSON / non-object entries → skipped with a recorded reason (via
 *   {@link CiArtifactSource.lastSkipReasons}); never throws mid-list.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  ProjectCtx,
  TaskSource,
  TaskSpec,
  ValidationResult,
} from "../domain.js";
import { coerceTaskSpec } from "./coerce-spec.js";
import { validateTaskSpec } from "./ui-builder.js";

export interface CiArtifactSourceOptions {
  /**
   * Directory containing JSON task specs (and/or a manifest.json).
   * Relative paths resolve against `ctx.workspaceDir` ?? `ctx.projectDir`.
   * Default: `"ci-artifacts"`.
   */
  artifactDir?: string;
  /**
   * Optional single-manifest filename (or relative path under artifactDir).
   * When present and readable, its tasks are yielded in addition to any
   * per-file specs. Default: `"manifest.json"`.
   */
  manifestFile?: string;
}

/** A skipped artifact entry with the reason. */
export interface CiArtifactSkip {
  path: string;
  reason: string;
}

/**
 * CI artifact ingest source — directory-of-JSON + single-manifest form.
 */
export class CiArtifactSource implements TaskSource {
  readonly kind = "ci-artifact" as const;
  private readonly artifactDir: string;
  private readonly manifestFile: string;

  /** Skip reasons from the most recent `list()` pass (for tests / diagnostics). */
  lastSkipReasons: CiArtifactSkip[] = [];

  constructor(opts: CiArtifactSourceOptions = {}) {
    this.artifactDir = opts.artifactDir ?? "ci-artifacts";
    this.manifestFile = opts.manifestFile ?? "manifest.json";
  }

  /**
   * Yield TaskSpecs from the artifact directory / single manifest.
   * Missing dir → empty. Bad JSON → recorded skip, continue.
   */
  async *list(ctx: ProjectCtx): AsyncIterable<TaskSpec> {
    this.lastSkipReasons = [];
    const rootBase = ctx.workspaceDir ?? ctx.projectDir;
    const dir = isAbsolute(this.artifactDir)
      ? this.artifactDir
      : join(rootBase, this.artifactDir);

    let st;
    try {
      st = await stat(dir);
    } catch {
      // Missing dir → empty yield.
      return;
    }
    if (!st.isDirectory()) {
      this.lastSkipReasons.push({
        path: dir,
        reason: "artifactDir is not a directory",
      });
      return;
    }

    const yieldedIds = new Set<string>();

    // 1) Single-manifest form (if present).
    const manifestAbs = join(dir, this.manifestFile);
    const fromManifest = await this.loadManifest(manifestAbs, ctx);
    for (const spec of fromManifest) {
      if (spec.id) yieldedIds.add(spec.id);
      yield spec;
    }

    // 2) Directory-of-JSON form — every *.json except the manifest file itself.
    const jsonFiles = await listJsonFiles(dir);
    for (const abs of jsonFiles.sort()) {
      const rel = toPosix(relative(dir, abs));
      if (rel === this.manifestFile || rel.endsWith(`/${this.manifestFile}`)) {
        continue;
      }
      const specs = await this.loadJsonFile(abs, rel, ctx);
      for (const spec of specs) {
        // Prefer first occurrence; skip duplicates by id.
        if (spec.id && yieldedIds.has(spec.id)) {
          this.lastSkipReasons.push({
            path: rel,
            reason: `duplicate id "${spec.id}" already yielded`,
          });
          continue;
        }
        if (spec.id) yieldedIds.add(spec.id);
        yield spec;
      }
    }
  }

  validate(spec: TaskSpec): ValidationResult {
    return validateTaskSpec(spec);
  }

  private async loadManifest(
    abs: string,
    ctx: ProjectCtx,
  ): Promise<TaskSpec[]> {
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      return [];
    }
    return this.parseJsonPayload(raw, this.manifestFile, ctx);
  }

  private async loadJsonFile(
    abs: string,
    rel: string,
    ctx: ProjectCtx,
  ): Promise<TaskSpec[]> {
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      this.lastSkipReasons.push({
        path: rel,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      return [];
    }
    return this.parseJsonPayload(raw, rel, ctx);
  }

  private parseJsonPayload(
    raw: string,
    pathLabel: string,
    ctx: ProjectCtx,
  ): TaskSpec[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      this.lastSkipReasons.push({
        path: pathLabel,
        reason: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return [];
    }

    const items = extractTaskObjects(parsed);
    if (items === null) {
      this.lastSkipReasons.push({
        path: pathLabel,
        reason:
          "payload is neither a TaskSpec object, an array of TaskSpecs, nor { tasks: [...] }",
      });
      return [];
    }

    const out: TaskSpec[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        this.lastSkipReasons.push({
          path: pathLabel,
          reason: `entry[${i}] is not an object`,
        });
        continue;
      }
      const taskObject = item as Record<string, unknown>;
      const fallbackId =
        typeof taskObject.id === "string"
          ? taskObject.id
          : pathLabel.replace(/\.json$/i, "").replace(/[\\/]/g, "__") +
            (items.length > 1 ? `_${i + 1}` : "");
      out.push(
        coerceTaskSpec(taskObject, {
          id: fallbackId,
          defaultAgentCategory: ctx.defaultAgentCategory,
        }),
      );
    }
    return out;
  }
}

function extractTaskObjects(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.tasks)) return o.tasks;
    // Single TaskSpec-shaped object.
    if (
      typeof o.name === "string" ||
      typeof o.prompt === "string" ||
      typeof o.id === "string" ||
      o.rubric !== undefined
    ) {
      return [o];
    }
  }
  return null;
}

async function listJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    const abs = join(dir, name);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walk(abs, out);
    } else if (st.isFile() && name.toLowerCase().endsWith(".json")) {
      out.push(abs);
    }
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

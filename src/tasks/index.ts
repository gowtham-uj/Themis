/**
 * Task sources — pluggable ingest turning a project's representation into TaskSpecs.
 *
 * Built-ins shipped here:
 * - `ui-builder` (UI form + task.json readback)
 * - `repo-md` (markdown + YAML frontmatter under the workspace)
 * - `manifest-yaml` (single YAML manifest enumerating tasks)
 * - `ci-artifact` (CI directory-of-JSON / single manifest.json)
 * - `http-push` (programmatic push; fully mutable via API)
 *
 * ## Sync seam (P3b ↔ P3c / P3a)
 *
 * Persistence lives in the DB query layer (P3a). This module does **not** import
 * `src/db/*`. Instead, sync accepts an injectable {@link TaskStore}:
 *
 * ```ts
 * interface TaskStore {
 *   get(projectId: string, externalId: string): TaskSpec | null | Promise<…>;
 *   upsert(ctx: ProjectCtx, spec: TaskSpec): { taskId: string; rubricVersionBumped: boolean } | Promise<…>;
 * }
 * ```
 *
 * Semantics (plan/projects.md):
 * - A source is (re)syncable: edit the source, re-sync, tasks update in place.
 * - Upsert key = `external_id` (file path for repo-md; task id for ui-builder).
 * - When the incoming `rubric` JSON differs from the stored row, the store must
 *   bump `rubric_version` (new comparison baseline) and report
 *   `rubricVersionBumped: true`.
 *
 * P3c wires a real DbQueries-backed TaskStore; tests use an in-memory store.
 */

import type { ProjectCtx, TaskSource, TaskSpec, ValidationResult } from "../domain.js";
import {
  CiArtifactSource,
  type CiArtifactSourceOptions,
} from "./ci-artifact.js";
import {
  HttpPushSource,
  pushHttpTask,
  resetHttpPushStore,
  type HttpPushSourceOptions,
} from "./http-push.js";
import {
  ManifestYamlSource,
  parseManifestYaml,
  type ManifestYamlSourceOptions,
} from "./manifest-yaml.js";
import { RepoMdSource, type RepoMdSourceOptions } from "./repo-md.js";
import {
  UIBuilderSource,
  buildTaskSpec,
  validateTaskSpec,
  type BuildTaskSpecInput,
} from "./ui-builder.js";
import { splitFrontmatter, parseYamlSubset } from "./parse-frontmatter.js";

export type {
  BuildTaskSpecInput,
  RepoMdSourceOptions,
  ManifestYamlSourceOptions,
  CiArtifactSourceOptions,
  HttpPushSourceOptions,
};
export {
  RepoMdSource,
  UIBuilderSource,
  ManifestYamlSource,
  parseManifestYaml,
  CiArtifactSource,
  HttpPushSource,
  pushHttpTask,
  resetHttpPushStore,
  buildTaskSpec,
  validateTaskSpec,
  splitFrontmatter,
  parseYamlSubset,
};

/** Options accepted by {@link createTaskSource} (union of per-source opts). */
export type CreateTaskSourceOptions =
  | RepoMdSourceOptions
  | ManifestYamlSourceOptions
  | CiArtifactSourceOptions
  | HttpPushSourceOptions;

/**
 * Injectable persistence seam for task sync.
 * P3a/P3c provide a DbQueries-backed implementation; tests provide an in-memory one.
 *
 * Contract for `upsert`:
 * - Match by `(projectId, external_id)` where `external_id = spec.id`.
 * - If no row exists, insert with `rubric_version = spec.rubric.version` (or 1).
 * - If a row exists and `JSON.stringify(spec.rubric)` differs from stored
 *   `rubric_json`, bump `rubric_version` and set `rubricVersionBumped: true`.
 * - Otherwise update in place without bumping.
 */
export interface TaskStore {
  /** Look up a previously synced task by external id. */
  get(
    projectId: string,
    externalId: string,
  ): TaskSpec | null | Promise<TaskSpec | null>;

  /**
   * Insert or update a task from a source yield.
   * Returns the stable task id and whether the rubric version was bumped.
   */
  upsert(
    ctx: ProjectCtx,
    spec: TaskSpec,
  ):
    | { taskId: string; rubricVersionBumped: boolean }
    | Promise<{ taskId: string; rubricVersionBumped: boolean }>;
}

/** Per-task outcome of a sync pass. */
export interface SyncTaskResult {
  externalId: string;
  taskId: string;
  rubricVersionBumped: boolean;
  /** True when validate() reported errors (still upserted if store accepts). */
  validationErrors: string[];
  validationWarnings: string[];
}

/** Aggregate result of syncTasks. */
export interface SyncResult {
  sourceKind: TaskSource["kind"];
  upserted: SyncTaskResult[];
  /** Specs that failed validation — still listed; caller may skip/reject. */
  invalid: SyncTaskResult[];
}

/**
 * List tasks from `source` and upsert each into `store` by external id.
 * Bumping of `rubric_version` is the store's responsibility when the rubric
 * payload differs from the stored row (see TaskStore contract above).
 *
 * When `opts.skipInvalid` is true (default), specs that fail `source.validate`
 * (or the shared validateTaskSpec) are recorded in `invalid` and not upserted.
 */
export async function syncTasks(
  ctx: ProjectCtx,
  source: TaskSource,
  store: TaskStore,
  opts: { skipInvalid?: boolean } = {},
): Promise<SyncResult> {
  const skipInvalid = opts.skipInvalid ?? true;
  const upserted: SyncTaskResult[] = [];
  const invalid: SyncTaskResult[] = [];

  for await (const spec of source.list(ctx)) {
    const externalId = spec.id ?? spec.name;
    const validateFn = source.validate ?? validateTaskSpec;
    const vr: ValidationResult = validateFn(spec);

    if (!vr.ok && skipInvalid) {
      invalid.push({
        externalId,
        taskId: "",
        rubricVersionBumped: false,
        validationErrors: vr.errors,
        validationWarnings: vr.warnings,
      });
      continue;
    }

    // Ensure id is set for the store's external_id key.
    const withId: TaskSpec = spec.id ? spec : { ...spec, id: externalId };
    const result = await store.upsert(ctx, withId);
    const entry: SyncTaskResult = {
      externalId,
      taskId: result.taskId,
      rubricVersionBumped: result.rubricVersionBumped,
      validationErrors: vr.errors,
      validationWarnings: vr.warnings,
    };
    if (!vr.ok) invalid.push(entry);
    else upserted.push(entry);
  }

  return { sourceKind: source.kind, upserted, invalid };
}

/**
 * Compare two rubrics for equality (stable JSON), ignoring `version`.
 * The store owns `rubric_version`; a re-sync of the same content must not
 * bump just because the source still carries an older version field.
 */
export function rubricsEqual(a: TaskSpec["rubric"], b: TaskSpec["rubric"]): boolean {
  return stableStringify(stripRubricVersion(a)) === stableStringify(stripRubricVersion(b));
}

function stripRubricVersion(r: TaskSpec["rubric"]): unknown {
  const { version: _v, ...rest } = r;
  return rest;
}

/** Deterministic JSON stringify (sorted object keys). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeys(obj[k]);
    }
    return out;
  }
  return value;
}

/**
 * Factory: create a built-in source by kind.
 * Accepts the full TaskSource kind union (5 built-ins). Existing
 * `ui-builder` / `repo-md` paths are unchanged in behavior.
 */
export function createTaskSource(
  kind: TaskSource["kind"],
  opts?: CreateTaskSourceOptions,
): TaskSource {
  switch (kind) {
    case "ui-builder":
      return new UIBuilderSource();
    case "repo-md":
      return new RepoMdSource(opts as RepoMdSourceOptions | undefined);
    case "manifest-yaml":
      return new ManifestYamlSource(opts as ManifestYamlSourceOptions | undefined);
    case "ci-artifact":
      return new CiArtifactSource(opts as CiArtifactSourceOptions | undefined);
    case "http-push":
      return new HttpPushSource(opts as HttpPushSourceOptions | undefined);
    default: {
      // Exhaustiveness guard — keep runtime safe if a new kind lands in domain.
      const _exhaustive: never = kind;
      throw new Error(`createTaskSource: unknown kind ${String(_exhaustive)}`);
    }
  }
}

/**
 * Reference in-memory TaskStore for tests / early wiring.
 * Demonstrates the rubric_version bump contract.
 */
export function createMemoryTaskStore(): TaskStore & {
  rows: Map<string, { taskId: string; spec: TaskSpec; rubricVersion: number }>;
} {
  const rows = new Map<
    string,
    { taskId: string; spec: TaskSpec; rubricVersion: number }
  >();

  const key = (projectId: string, externalId: string) => `${projectId}::${externalId}`;

  return {
    rows,
    get(projectId, externalId) {
      const row = rows.get(key(projectId, externalId));
      return row ? structuredClone(row.spec) : null;
    },
    upsert(ctx, spec) {
      const externalId = spec.id ?? spec.name;
      const k = key(ctx.projectId, externalId);
      const existing = rows.get(k);
      if (!existing) {
        const taskId = `task_${rows.size + 1}`;
        const rubricVersion = spec.rubric.version ?? 1;
        const stored: TaskSpec = {
          ...structuredClone(spec),
          id: externalId,
          rubric: { ...structuredClone(spec.rubric), version: rubricVersion },
        };
        rows.set(k, { taskId, spec: stored, rubricVersion });
        return { taskId, rubricVersionBumped: false };
      }

      const bumped = !rubricsEqual(existing.spec.rubric, spec.rubric);
      const rubricVersion = bumped ? existing.rubricVersion + 1 : existing.rubricVersion;
      const stored: TaskSpec = {
        ...structuredClone(spec),
        id: externalId,
        rubric: { ...structuredClone(spec.rubric), version: rubricVersion },
      };
      rows.set(k, { taskId: existing.taskId, spec: stored, rubricVersion });
      return { taskId: existing.taskId, rubricVersionBumped: bumped };
    },
  };
}

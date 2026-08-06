/**
 * HTTP-push task source (kind: "http-push").
 *
 * Tasks arrive via HTTP (POST /api/projects/:id/tasks with
 * `source_kind: "http-push"`, or the dedicated tasks:push helper) and are
 * **fully mutable** through the API (plan/api.md §Tasks).
 *
 * This source keeps an in-memory index of pushed TaskSpecs keyed by
 * `(projectId, externalId)` so `list()` / `syncTasks` can re-yield them.
 * Persistence of the authoritative rows is the DB query layer's job
 * (`createTask` / `updateTask` with `sourceKind: "http-push"`); the in-memory
 * map is the pull-side view for sync + tests.
 *
 * `list()` is effectively a no-op when nothing has been pushed into this
 * instance. There is no external source to re-fetch; no retention drop is
 * applied (keep simple — no auto-delete of missing ids).
 */

import type {
  ProjectCtx,
  TaskSource,
  TaskSpec,
  ValidationResult,
} from "../domain.js";
import { coerceTaskSpec } from "./coerce-spec.js";
import { validateTaskSpec } from "./ui-builder.js";

export interface HttpPushSourceOptions {
  /**
   * Optional shared backing map. When omitted a fresh Map is used.
   * Pass a shared map to keep pushes visible across factory instances
   * (e.g. process-lifetime registry).
   */
  store?: Map<string, Map<string, TaskSpec>>;
}

/**
 * Process-lifetime shared store so createTaskSource("http-push") instances
 * see each other's pushes within the same process (API + sync).
 */
const defaultSharedStore: Map<string, Map<string, TaskSpec>> = new Map();

/** Reset the process-lifetime http-push store (tests). */
export function resetHttpPushStore(): void {
  defaultSharedStore.clear();
}

/**
 * Push-sourced task catalog. Fully mutable; list() yields previously pushed
 * specs for the project.
 */
export class HttpPushSource implements TaskSource {
  readonly kind = "http-push" as const;
  private readonly store: Map<string, Map<string, TaskSpec>>;

  constructor(opts: HttpPushSourceOptions = {}) {
    this.store = opts.store ?? defaultSharedStore;
  }

  /**
   * Yield previously pushed tasks for `ctx.projectId`.
   * No external pull; empty when nothing has been pushed.
   */
  async *list(ctx: ProjectCtx): AsyncIterable<TaskSpec> {
    const m = this.store.get(ctx.projectId);
    if (!m) return;
    // Stable order by id for deterministic sync/tests.
    const ids = [...m.keys()].sort();
    for (const id of ids) {
      const spec = m.get(id);
      if (spec) yield structuredClone(spec);
    }
  }

  validate(spec: TaskSpec): ValidationResult {
    return validateTaskSpec(spec);
  }

  /**
   * Push (insert or replace) a TaskSpec for a project.
   * Re-push of the same id updates in place. Returns the stored spec.
   */
  push(projectId: string, input: TaskSpec | Record<string, unknown>): TaskSpec {
    const obj =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};

    // Prefer already-valid TaskSpec fields; coerce when loose.
    let spec: TaskSpec;
    if (
      typeof (input as TaskSpec).name === "string" &&
      typeof (input as TaskSpec).prompt === "string" &&
      (input as TaskSpec).rubric &&
      (input as TaskSpec).workspace
    ) {
      const t = input as TaskSpec;
      const id = t.id ?? t.name;
      spec = {
        ...structuredClone(t),
        id,
      };
    } else {
      spec = coerceTaskSpec(obj, {
        id: typeof obj.id === "string" ? obj.id : undefined,
        defaultAgentCategory: "general",
      });
    }

    if (!spec.id) {
      spec = { ...spec, id: spec.name };
    }

    let projectMap = this.store.get(projectId);
    if (!projectMap) {
      projectMap = new Map();
      this.store.set(projectId, projectMap);
    }
    projectMap.set(spec.id!, structuredClone(spec));
    return structuredClone(spec);
  }

  /** Look up a pushed task by project + external id. */
  get(projectId: string, externalId: string): TaskSpec | null {
    const m = this.store.get(projectId);
    const spec = m?.get(externalId);
    return spec ? structuredClone(spec) : null;
  }

  /** List all pushed tasks for a project (sync helper). */
  listPushed(projectId: string): TaskSpec[] {
    const m = this.store.get(projectId);
    if (!m) return [];
    return [...m.keys()]
      .sort()
      .map((id) => structuredClone(m.get(id)!));
  }

  /** Remove a pushed task (optional retention / API delete mirror). */
  delete(projectId: string, externalId: string): boolean {
    const m = this.store.get(projectId);
    if (!m) return false;
    return m.delete(externalId);
  }
}

/**
 * Convenience used by the HTTP layer: push into the shared source and return
 * the normalized TaskSpec (caller then persists via queries.createTask).
 */
export function pushHttpTask(
  projectId: string,
  input: TaskSpec | Record<string, unknown>,
  source: HttpPushSource = new HttpPushSource(),
): TaskSpec {
  return source.push(projectId, input);
}

/**
 * Manifest-yaml task source (kind: "manifest-yaml").
 *
 * Reads a single YAML manifest (default `agenteval.yaml`) from the project
 * workspace (or a configured path) enumerating tasks. The repo/file is the
 * source of truth — API edits of these tasks return 409 (plan/api.md §Tasks).
 *
 * ## YAML parser limitation
 *
 * No `js-yaml` dependency is shipped. Parsing uses the existing zero-dep
 * {@link parseYamlSubset} helper (same subset as repo-md frontmatter):
 * scalars, nested mappings via indentation, and arrays with `-`. Flow-style
 * complex nests, anchors/aliases, multi-doc streams, and custom tags are
 * NOT supported. Stick to the flat list-of-maps shape documented below.
 *
 * ```yaml
 * tasks:
 *   - id: hello
 *     name: Hello
 *     prompt: Print hello
 *     agentCategory: coding
 *     tags:
 *       - smoke
 *     profile: feature
 *     workspace:
 *       source: empty
 *     checks:
 *       - id: tests
 *         kind: test_suite
 *         command: npm test
 *     rubric:
 *       profile: feature
 *       version: 1
 *       criteria:
 *         - id: A1
 *           axis: A
 *           label: Completeness
 *           weight: 1
 *           appliesTo: both
 *           anchors:
 *             full: fully met
 *             partial: partial
 *             none: missing
 * ```
 *
 * A top-level sequence of task maps is also accepted.
 *
 * Invalid structure (missing file when required, non-mapping root without a
 * task list, empty tasks list, non-map task entries) throws a clear Error —
 * never silent-skipped.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ProjectCtx,
  TaskSource,
  TaskSpec,
  ValidationResult,
} from "../domain.js";
import { coerceTaskSpec } from "./coerce-spec.js";
import { parseYamlSubset } from "./parse-frontmatter.js";
import { validateTaskSpec } from "./ui-builder.js";

export interface ManifestYamlSourceOptions {
  /**
   * Path to the manifest file. Relative paths resolve against
   * `ctx.workspaceDir` (preferred) or `ctx.projectDir`.
   * Default: `"agenteval.yaml"`.
   */
  path?: string;
}

/**
 * YAML-manifest task source. Read-only-from-source semantics (repo is SoT).
 */
export class ManifestYamlSource implements TaskSource {
  readonly kind = "manifest-yaml" as const;
  private readonly path: string;

  constructor(opts: ManifestYamlSourceOptions = {}) {
    this.path = opts.path ?? "agenteval.yaml";
  }

  /**
   * Yield TaskSpecs from the configured YAML manifest.
   * Throws on missing/unreadable file or invalid structure.
   */
  async *list(ctx: ProjectCtx): AsyncIterable<TaskSpec> {
    const root = ctx.workspaceDir ?? ctx.projectDir;
    const abs = isAbsolute(this.path) ? this.path : join(root, this.path);

    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        `manifest-yaml: cannot read manifest at ${abs}` +
          (code ? ` (${code})` : "") +
          `: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const specs = parseManifestYaml(text, ctx);
    for (const spec of specs) {
      yield spec;
    }
  }

  validate(spec: TaskSpec): ValidationResult {
    return validateTaskSpec(spec);
  }
}

/**
 * Parse a manifest YAML document into TaskSpecs.
 * Throws with a clear message when the structure is invalid.
 */
export function parseManifestYaml(text: string, ctx: ProjectCtx): TaskSpec[] {
  if (!text || !text.trim()) {
    throw new Error("manifest-yaml: manifest is empty");
  }

  const { value, warnings } = parseYamlSubset(text);
  // Surface parse warnings only if we also fail structurally; otherwise tolerate.
  void warnings;

  const tasksRaw = extractTasksArray(value);
  if (tasksRaw.length === 0) {
    throw new Error(
      "manifest-yaml: no tasks found — expected a top-level `tasks:` list or a sequence of task maps",
    );
  }

  const specs: TaskSpec[] = [];
  for (let i = 0; i < tasksRaw.length; i++) {
    const item = tasksRaw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `manifest-yaml: tasks[${i}] must be a mapping/object (got ${describeType(item)})`,
      );
    }
    const obj = item as Record<string, unknown>;
    const spec = coerceTaskSpec(obj, {
      id: typeof obj.id === "string" ? obj.id : `task-${i + 1}`,
      defaultAgentCategory: ctx.defaultAgentCategory,
    });
    specs.push(spec);
  }
  return specs;
}

function extractTasksArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.tasks)) return o.tasks;
    // Single-task document: only treat as one entry when it genuinely looks like
    // a task — a `prompt` is the defining field of a task spec. A bare manifest
    // header (`version: 1\nname: ...` with no `tasks:` and no `prompt`) is NOT a
    // task and must raise rather than being silently coerced into an empty spec.
    if (typeof o.prompt === "string" && o.prompt.trim() !== "") {
      return [o];
    }
  }
  throw new Error(
    "manifest-yaml: invalid root — expected `{ tasks: [...] }`, a sequence of task maps, or a single task mapping with a `prompt`",
  );
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

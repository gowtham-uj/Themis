/**
 * Category-aware diff / artifact capture.
 *
 * After an agent finishes, what "the diff" means depends on the task's agent
 * category (plan/categories.md `diffKind`):
 *   - `git`      → unified patch with stable hunk numbers (coding, general-with-changes)
 *   - `outputs`  → manifest of output artifacts + content hashes (data pipelines)
 *   - `none`     → no artifact (research / browser / conversational)
 *
 * Spec: plan/execution.md § Workspace sourcing + diff capture (category-aware),
 *       plan/categories.md `diffKind`.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  captureDiff,
  type CaptureDiffOptions,
  type CaptureDiffResult,
} from "./diff.js";

/** What "the diff" means for a category. */
export type DiffKind = "git" | "outputs" | "none";

/** The six pre-defined agent categories (plan/categories.md). */
export type AgentCategory =
  | "coding"
  | "research"
  | "general"
  | "browser"
  | "data"
  | "conversational";

export const AGENT_CATEGORIES: readonly AgentCategory[] = [
  "coding",
  "research",
  "general",
  "browser",
  "data",
  "conversational",
] as const;

/** One entry in an outputs-kind manifest. */
export interface OutputManifestEntry {
  /** Path relative to the outputs directory. */
  path: string;
  /** Lowercase hex sha256 of file contents. */
  sha256: string;
  /** File size in bytes. */
  sizeBytes: number;
}

export interface OutputsDiffResult {
  kind: "outputs";
  /** Absolute path of the written `outputs-manifest.json`. */
  manifestPath: string;
  /** Manifest entries (same contents as the JSON file's `entries`). */
  entries: OutputManifestEntry[];
}

export interface GitDiffResult extends CaptureDiffResult {
  kind: "git";
}

export interface NoneDiffResult {
  kind: "none";
}

export type CategoryDiffResult =
  | GitDiffResult
  | OutputsDiffResult
  | NoneDiffResult;

export interface CaptureDiffByCategoryOptions {
  /**
   * Directory (or exact file path) for git patch output. Forwarded to
   * {@link captureDiff} when kind is `git`.
   */
  outPath?: string;
  /** Also write a sibling hunk index for git diffs (default true). */
  writeIndex?: boolean;
  /**
   * Directory of output artifacts to hash when kind is `outputs`.
   * Defaults to `<workspaceDir>/outputs`.
   */
  outputsDir?: string;
  /**
   * Where to write `outputs-manifest.json` when kind is `outputs`.
   * Defaults to `<workspaceDir>/outputs-manifest.json` (or next to outPath).
   */
  manifestPath?: string;
}

/** Context passed to {@link categoryToDiffKind} for conditional categories. */
export interface DiffKindContext {
  /** Absolute path of the run workspace. */
  workspaceDir?: string;
  /**
   * Optional pre-computed signal: true when the workspace is a git repo with
   * uncommitted / untracked changes. When omitted, `general` falls back to a
   * best-effort check (or `'none'` if `workspaceDir` is also missing).
   */
  hasGitChanges?: boolean;
  /** True when `workspaceDir` is a git repository. */
  isGitRepo?: boolean;
}

/**
 * Map an agent category to its diff kind.
 *
 * - coding → `git`
 * - research / conversational / browser → `none`
 * - data → `outputs`
 * - general → `git` if the workspace is a git repo with changes, else `none`
 *
 * Unknown categories default to `none` (safe: no accidental source leak).
 */
export function categoryToDiffKind(
  category: string,
  ctx: DiffKindContext = {},
): DiffKind {
  switch (category) {
    case "coding":
      return "git";
    case "data":
      return "outputs";
    case "research":
    case "conversational":
    case "browser":
      return "none";
    case "general": {
      if (ctx.hasGitChanges === true) return "git";
      if (ctx.hasGitChanges === false) return "none";
      // Fall back: if caller asserted isGitRepo=false → none; else if they
      // claim isGitRepo=true without hasGitChanges, still prefer git so a
      // subsequent captureDiff can produce an empty patch.
      if (ctx.isGitRepo === false) return "none";
      if (ctx.isGitRepo === true) return "git";
      // No signal — conservative.
      return "none";
    }
    default:
      return "none";
  }
}

/**
 * Capture the category-appropriate post-run artifact.
 *
 * - `git`      → delegates to existing {@link captureDiff} (does not duplicate).
 * - `outputs`  → walks an outputs dir, hashes each file, writes a manifest.
 * - `none`     → returns `{ kind: "none" }` with no files written.
 */
export async function captureDiffByCategory(
  category: string,
  workspaceDir: string,
  opts: CaptureDiffByCategoryOptions = {},
): Promise<CategoryDiffResult> {
  // For `general`, peek at the workspace so we can choose git vs none.
  let kind: DiffKind;
  if (category === "general") {
    const isGit = await isGitRepo(workspaceDir);
    const hasChanges = isGit ? await hasUncommittedChanges(workspaceDir) : false;
    kind = categoryToDiffKind(category, {
      workspaceDir,
      isGitRepo: isGit,
      hasGitChanges: hasChanges,
    });
  } else {
    kind = categoryToDiffKind(category, { workspaceDir });
  }

  if (kind === "none") {
    return { kind: "none" };
  }

  if (kind === "git") {
    const diffOpts: CaptureDiffOptions = {};
    if (opts.outPath !== undefined) diffOpts.outPath = opts.outPath;
    if (opts.writeIndex !== undefined) diffOpts.writeIndex = opts.writeIndex;
    const result = await captureDiff(workspaceDir, diffOpts);
    return { kind: "git", ...result };
  }

  // outputs
  return captureOutputsManifest(workspaceDir, opts);
}

/** Walk `outputsDir`, hash every regular file, and write the exact manifest. */
export async function captureOutputsManifest(
  workspaceDir: string,
  opts: CaptureDiffByCategoryOptions = {},
): Promise<OutputsDiffResult> {
  const outputsDir = resolve(opts.outputsDir ?? join(workspaceDir, "outputs"));
  const manifestPath = resolveManifestPath(workspaceDir, opts);

  const entries: OutputManifestEntry[] = [];

  if (await pathExists(outputsDir)) {
    const files = await listFilesRecursive(outputsDir);
    for (const abs of files) {
      const rel = relative(outputsDir, abs).split(sep).join("/");
      const st = await stat(abs);
      if (!st.isFile()) continue;
      const sha256 = await sha256File(abs);
      entries.push({
        path: rel,
        sha256,
        sizeBytes: st.size,
      });
    }
    // Stable order for diffs / golden tests.
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  const payload = {
    kind: "outputs" as const,
    outputsDir,
    generatedAt: new Date().toISOString(),
    entries,
  };

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  return {
    kind: "outputs",
    manifestPath,
    entries,
  };
}

/** Resolve where `outputs-manifest.json` should land. */
function resolveManifestPath(
  workspaceDir: string,
  opts: CaptureDiffByCategoryOptions,
): string {
  if (opts.manifestPath) return resolve(opts.manifestPath);
  // Prefer a directory `outPath` (run dir); ignore `.patch`/`.diff` git targets.
  if (
    opts.outPath &&
    !opts.outPath.endsWith(".patch") &&
    !opts.outPath.endsWith(".diff") &&
    !opts.outPath.endsWith(".json")
  ) {
    return join(opts.outPath, "outputs-manifest.json");
  }
  if (opts.outPath && opts.outPath.endsWith(".json")) {
    return resolve(opts.outPath);
  }
  return join(workspaceDir, "outputs-manifest.json");
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  return pathExists(join(dir, ".git"));
}

/**
 * Best-effort "are there changes?" probe for the `general` category.
 * Uses `git status --porcelain` so untracked + modified files count.
 */
async function hasUncommittedChanges(dir: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "status", "--porcelain"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

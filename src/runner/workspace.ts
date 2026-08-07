/**
 * Workspace prep (shared, not per-agent).
 *
 * - git: shallow clone `repo` at `ref`, record the resolved commit sha
 * - empty: mkdir + `git init` so the harness can compute a post-run diff
 *
 * Spec: plan/adapters.md § Workspace prep, plan/execution.md.
 */

import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceSpec } from "../adapters/types.js";

const execFileAsync = promisify(execFile);

export interface PreparedWorkspace {
  /** Absolute host path of the prepared workspace. */
  dir: string;
  /** Echo of the requested source kind. */
  source: "git" | "empty";
  /** Remote/local repo URL when source is git. */
  repo?: string;
  /** Resolved commit sha (git sources) — pin into run.start.workspace.commit. */
  commit?: string;
  /** The ref that was requested (branch/tag/sha), if any. */
  ref?: string;
}

export interface PrepareWorkspaceOptions {
  /**
   * Target directory for the workspace. Created if missing.
   * For git sources this is the clone destination (must be empty or non-existent).
   */
  targetDir: string;
  /** Extra env for git (e.g. GIT_CONFIG_*). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Prepare a run workspace from a WorkspaceSpec.
 * Network is only required when `spec.source === "git"` and `repo` is a remote URL;
 * local file paths work offline (tests use temp local repos).
 */
export async function prepareWorkspace(
  spec: WorkspaceSpec,
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const targetDir = options.targetDir;
  await mkdir(targetDir, { recursive: true });

  if (spec.source === "empty") {
    await gitInit(targetDir, options.env);
    return { dir: targetDir, source: "empty" };
  }

  // git source
  const repo = spec.repo;
  if (!repo || typeof repo !== "string" || repo.trim() === "") {
    throw new Error("WorkspaceSpec.source=git requires a non-empty `repo`");
  }

  // Refuse to clone into a non-empty directory (git would fail opaquely).
  await assertEmptyOrMissing(targetDir);

  const ref = spec.ref;
  await gitClone(normalizeRepoUrl(repo), targetDir, ref, options.env);
  const commit = await gitRevParse(targetDir, "HEAD", options.env);

  const prepared: PreparedWorkspace = {
    dir: targetDir,
    source: "git",
    repo,
    commit,
  };
  if (ref !== undefined) prepared.ref = ref;
  return prepared;
}

/**
 * Ensure `dir` is a git repo (init if needed). Useful when the CLI is pointed at
 * an existing workspace directory that may not yet be under version control.
 */
export async function ensureGitRepo(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (await isGitRepo(dir)) return;
  await gitInit(dir, env);
}

async function assertEmptyOrMissing(dir: string): Promise<void> {
  try {
    await access(dir);
  } catch {
    return; // does not exist — fine
  }
  // Exists: allow only if empty (mkdir recursive may have created it).
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new Error(
      `prepareWorkspace(git): target directory is not empty: ${dir}`,
    );
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "--git-dir"], {
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function gitInit(
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init"], {
    env: { ...process.env, ...env },
  });
  // Quiet identity for any subsequent local commits (agents / tests).
  await execFileAsync(
    "git",
    ["-C", dir, "config", "user.email", "agenteval@local"],
    { env: { ...process.env, ...env } },
  );
  await execFileAsync(
    "git",
    ["-C", dir, "config", "user.name", "agenteval"],
    { env: { ...process.env, ...env } },
  );
}

/**
 * Shallow clone. When `ref` is set we try `--branch` first (works for branches/tags);
 * on failure (e.g. bare sha on a full local repo) fall back to full clone + checkout.
 */
/**
 * Turn a repo reference into something `git clone` accepts.
 *
 * The rest of the platform accepts `owner/name` — it is what task definitions,
 * watcher rules and the evaluate API all use — but git only understands URLs
 * and paths, and fails with "repository does not exist" on the short form.
 * Local paths and anything already URL-shaped are passed through untouched, so
 * fixture repos and self-hosted remotes keep working.
 */
export function normalizeRepoUrl(repo: string): string {
  const raw = repo.trim();
  if (!raw) return raw;
  // Already a URL, an SSH remote, or a filesystem path.
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
    raw.startsWith("git@") ||
    raw.startsWith("/") ||
    raw.startsWith(".") ||
    raw.startsWith("~")
  ) {
    return raw;
  }
  // `owner/name` → the GitHub URL. GITHUB_SERVER_URL supports Enterprise.
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) {
    const server = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(
      /\/$/,
      "",
    );
    return `${server}/${raw.replace(/\.git$/, "")}.git`;
  }
  return raw;
}

async function gitClone(
  repo: string,
  targetDir: string,
  ref: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const baseEnv = { ...process.env, ...env };
  // Prefer a shallow clone when possible.
  if (ref) {
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", "--branch", ref, repo, targetDir],
        { env: baseEnv },
      );
      return;
    } catch {
      // Fall through: ref may be a sha, or remote may not support shallow+branch.
    }
  } else {
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", repo, targetDir],
        { env: baseEnv },
      );
      return;
    } catch {
      // Fall through to full clone.
    }
  }

  // Full clone + optional checkout (needed for arbitrary shas / local edge cases).
  // Target must be empty; if a partial clone left debris, wipe via rm.
  const { rm } = await import("node:fs/promises");
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await execFileAsync("git", ["clone", repo, targetDir], { env: baseEnv });
  if (ref) {
    await execFileAsync("git", ["-C", targetDir, "checkout", "--detach", ref], {
      env: baseEnv,
    });
  }
}

async function gitRevParse(
  dir: string,
  rev: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", dir, "rev-parse", rev],
    { env: { ...process.env, ...env } },
  );
  return stdout.trim();
}

/** Resolve a path join for nested workspace files (exported for tests). */
export function workspacePath(dir: string, ...parts: string[]): string {
  return join(dir, ...parts);
}

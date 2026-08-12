/**
 * Diff capture with stable, addressable hunk numbers.
 *
 * After an agent run: `git -C <ws> add -A && git diff --cached` →
 * `diff.patch` plus a machine-readable hunk index so
 * `refs{kind:"diff",hunk}` stays addressable.
 *
 * Spec: plan/execution.md § Workspace sourcing + diff capture.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One addressable hunk in a unified diff. */
export interface HunkIndexEntry {
  /** 1-based stable hunk number (order of appearance in the patch). */
  hunk: number;
  /** Path of the file this hunk belongs to (new path for renames). */
  file: string;
  /** Previous path when the file was renamed/copied; omitted otherwise. */
  oldFile?: string;
  /** `@@` old-side start line (1-based; 0 for pure additions). */
  oldStart: number;
  /** `@@` old-side line count. */
  oldLines: number;
  /** `@@` new-side start line (1-based; 0 for pure deletions). */
  newStart: number;
  /** `@@` new-side line count. */
  newLines: number;
  /** Raw `@@ -a,b +c,d @@` header (optional trailing context stripped of body). */
  header: string;
}

export interface CaptureDiffResult {
  /** Absolute path of the written `diff.patch`. */
  patchPath: string;
  /** Absolute path of the written hunk index JSON. */
  indexPath: string;
  /** Ordered hunk index (same contents as the JSON file). */
  hunks: HunkIndexEntry[];
  /** Raw unified-diff text (without our hunk markers). */
  rawDiff: string;
  /** True when the workspace had no changes. */
  empty: boolean;
}

export interface CaptureDiffOptions {
  /**
   * Directory (or exact file path ending in `.patch`) where the patch is written.
   * Defaults to `<workspaceDir>/diff.patch` when omitted.
   */
  outPath?: string;
  /** Also write a sibling `diff.hunks.json` (default true). */
  writeIndex?: boolean;
  /**
   * Workspace-relative paths to leave out of the diff, as git pathspecs.
   *
   * Agents write their own state into the workspace — ReaperCode keeps
   * `.reaper/` (trajectory, model-call transcripts, run manifests) right next
   * to the code. That is harness bookkeeping, not the agent's work product, and
   * letting it into the diff means the judge scores an agent on its own log
   * files. Defaults to {@link DEFAULT_DIFF_EXCLUDES}; pass `[]` to keep
   * everything.
   */
  excludePaths?: readonly string[];
}

/**
 * Agent-internal state directories excluded from a captured diff by default.
 *
 * These are written BY the agent runtime, about the run — not changes the agent
 * made to the codebase it was asked to work on.
 */
export const DEFAULT_DIFF_EXCLUDES: readonly string[] = [
  ".reaper/",
  ".pi/",
  ".agent/",
  ".agenteval/",
];

/**
 * Stage every change in `workspaceDir` and write a hunk-numbered patch.
 * Returns the patch path plus the stable hunk index for later refs.
 */
export async function captureDiff(
  workspaceDir: string,
  options: CaptureDiffOptions = {},
): Promise<CaptureDiffResult> {
  // Stage everything (including untracked) so empty-init workspaces produce a full tree diff.
  // Host-side git on the rootful-podman bind mount trips git's 'dubious ownership'
  // safe.directory check; trust the graded workspace so diff capture succeeds.
  const gitEnv = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  await execFileAsync("git", ["-C", workspaceDir, "add", "-A"], { env: gitEnv });

  const rawDiff = await gitDiffCached(
    workspaceDir,
    options.excludePaths ?? DEFAULT_DIFF_EXCLUDES,
  );
  const hunks = numberHunks(rawDiff);
  const numbered = injectHunkMarkers(rawDiff, hunks);

  const patchPath = resolvePatchPath(workspaceDir, options.outPath);
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, numbered, "utf8");

  const indexPath = patchPath.endsWith(".patch")
    ? patchPath.replace(/\.patch$/i, ".hunks.json")
    : join(dirname(patchPath), "diff.hunks.json");

  if (options.writeIndex !== false) {
    await writeFile(indexPath, `${JSON.stringify(hunks, null, 2)}\n`, "utf8");
  }

  return {
    patchPath,
    indexPath,
    hunks,
    rawDiff,
    empty: rawDiff.trim().length === 0,
  };
}

/**
 * Parse a unified diff and assign stable 1-based hunk numbers.
 * Exported for unit tests that feed a fixture patch.
 */
export function numberHunks(diffText: string): HunkIndexEntry[] {
  const hunks: HunkIndexEntry[] = [];
  let currentFile: string | undefined;
  let currentOldFile: string | undefined;
  let n = 0;

  // Split carefully: keep lines, handle both \n and \r\n.
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    // diff --git a/foo b/bar
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (gitHeader) {
      currentOldFile = gitHeader[1];
      currentFile = gitHeader[2];
      continue;
    }

    // --- a/foo / +++ b/foo (also set file when no diff --git, rare)
    const plusPlus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plusPlus) {
      const p = plusPlus[1];
      if (p && p !== "/dev/null") currentFile = p;
      continue;
    }
    const minusMinus = /^--- (?:a\/)?(.+)$/.exec(line);
    if (minusMinus) {
      const p = minusMinus[1];
      if (p && p !== "/dev/null") currentOldFile = p;
      continue;
    }

    // @@ -oldStart,oldLines +newStart,newLines @@ optional context
    const hunkHeader =
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s@@(.*)$/.exec(line);
    if (hunkHeader) {
      n += 1;
      const oldStart = Number(hunkHeader[1]);
      const oldLines =
        hunkHeader[2] !== undefined ? Number(hunkHeader[2]) : 1;
      const newStart = Number(hunkHeader[3]);
      const newLines =
        hunkHeader[4] !== undefined ? Number(hunkHeader[4]) : 1;
      const file = currentFile ?? currentOldFile ?? "unknown";
      const entry: HunkIndexEntry = {
        hunk: n,
        file,
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: line.startsWith("@@")
          ? line.replace(/\s*$/, "").replace(/@@(.*)$/, (m) => m.trimEnd())
          : line,
      };
      // Prefer the exact header line as-is for fidelity.
      entry.header = line;
      if (
        currentOldFile &&
        currentFile &&
        currentOldFile !== currentFile
      ) {
        entry.oldFile = currentOldFile;
      }
      hunks.push(entry);
    }
  }
  return hunks;
}

/**
 * Inject `# agenteval-hunk: N file=<path> ...` markers immediately before each
 * `@@` header so humans and tools can address hunks without re-parsing.
 * Markers are comments relative to `git apply` (lines starting with `#` outside
 * hunk bodies are ignored by most consumers; we place them between file headers
 * and @@ lines).
 */
export function injectHunkMarkers(
  diffText: string,
  hunks: readonly HunkIndexEntry[],
): string {
  if (hunks.length === 0) return diffText;
  const byOrder = [...hunks].sort((a, b) => a.hunk - b.hunk);
  let hi = 0;
  const out: string[] = [];
  const lines = diffText.split(/\r?\n/);
  // Preserve whether the original ended with a trailing newline.
  const endsWithNl = diffText.endsWith("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Last empty element from trailing newline — don't process as a line unless
    // it was a real empty line in the middle.
    if (i === lines.length - 1 && line === "" && endsWithNl) {
      break;
    }
    if (line.startsWith("@@") && hi < byOrder.length) {
      const h = byOrder[hi]!;
      out.push(formatHunkMarker(h));
      hi += 1;
    }
    out.push(line);
  }
  return out.join("\n") + (endsWithNl ? "\n" : "");
}

function formatHunkMarker(h: HunkIndexEntry): string {
  const parts = [
    `# agenteval-hunk: ${h.hunk}`,
    `file=${h.file}`,
    `old=${h.oldStart},${h.oldLines}`,
    `new=${h.newStart},${h.newLines}`,
  ];
  if (h.oldFile) parts.push(`oldFile=${h.oldFile}`);
  return parts.join(" ");
}

async function gitDiffCached(
  workspaceDir: string,
  excludePaths: readonly string[] = [],
): Promise<string> {
  // `:(exclude)` pathspecs need the `--` separator to be read as paths.
  const pathspecs =
    excludePaths.length > 0
      ? ["--", ".", ...excludePaths.map((p) => `:(exclude)${p}`)]
      : [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        workspaceDir,
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        ...pathspecs,
      ],
      {
        maxBuffer: 64 * 1024 * 1024,
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "*",
        },
        // git diff exits 0 even with changes; empty is fine.
      },
    );
    return stdout;
  } catch (err) {
    // git diff returns 0 always for --cached; any error is real.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`captureDiff: git diff --cached failed: ${message}`);
  }
}

function resolvePatchPath(workspaceDir: string, outPath?: string): string {
  if (!outPath) return join(workspaceDir, "diff.patch");
  if (outPath.endsWith(".patch") || outPath.endsWith(".diff")) return outPath;
  return join(outPath, "diff.patch");
}

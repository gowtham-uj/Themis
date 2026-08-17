/** Immutable, content-addressed evidence archive for one eval execution. */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DbQueries, EvalArchive } from "../db/queries.js";
import type { EvidenceEntry, EvidenceRole } from "../adapters/types.js";

export interface EvalArchiveFile {
  path: string;
  kind: "file" | "symlink";
  bytes: number;
  sha256: string;
  target?: string;
}

export interface EvalArchiveManifest {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  queueId: string | null;
  batchId: string;
  sealedAt: string;
  totalBytes: number;
  /** Archive-root-relative path of this manifest file itself, e.g. "eval_lifecycle_logs/archive.json". */
  manifestRel: string;
  files: EvalArchiveFile[];
}

/**
 * Reorganize a sealed eval archive into the target browsable layout. Only the
 * folder moves below happen here — no content is invented, dropped (except the
 * root canonical events file) or renamed across roles. The `retained/` tree is
 * never touched. Applies to every archive (suite and legacy non-suite).
 *
 * ```
 * <runDir>/
 *   retained/               ← adapter evidence exactly as copyRetainedEvidence produced it
 *   verifier_res/           ← verifier-result.json, verifier-stdout.log, verifier-stderr.log
 *   session/                ← session.jsonl, conversation.md (transcript.md tolerated)
 *   diffs/                  ← diff.patch, diff.hunks.json
 *   raw_std/                ← raw-stdout.log, raw-stderr.log
 *   eval_lifecycle_logs/    ← eval.json, adapter-evidence.json, run.json, queue.json, exec.json,
 *                             run-metrics.json, evidence-integrity.json, archive.json, README.md,
 *                             manifest.json, setup-manifest.json, cleanup.json,
 *                             package-cleanup.json, cleanup-verification.json,
 *                             workspace-reset.json, failure-classification.json
 *   model-calls/            ← suite-only: per-model-call request/response streams
 *   tool-logs/              ← suite-only: per-tool/shell-exec output logs
 *   further-evidence/       ← suite-only: dig-more material
 * ```
 *
 * `verifier.json` is renamed to `verifier-result.json` and the duplicate removed;
 * `agent-stdout.log` is never created (the raw stream stays `raw-stdout.log`);
 * `platform/` is removed in favor of `eval_lifecycle_logs/`; `events.jsonl` is
 * dropped from the archive entirely. Idempotent (copy-then-cleanup per file).
 */
export async function organizeArchiveLayout(runDir: string): Promise<void> {
  const root = resolve(runDir);

  // Move (not copy): these are platform-owned files that belong in exactly one
  // place. Copying here would leave the originals behind at the run root and
  // duplicate every lifecycle artifact in the sealed manifest. `rename` first so
  // a same-filesystem move is atomic; fall back to copy+rm across devices.
  const moveIf = async (src: string, dest: string): Promise<void> => {
    if (!(await lstat(src).catch(() => null))) return;
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(src, dest);
    } catch {
      await cp(src, dest, { recursive: true, force: true });
      await rm(src, { recursive: true, force: true });
    }
  };

  // verifier.json -> verifier-result.json (keep only the result), then remove the dup.
  if (await lstat(join(root, "verifier.json")).catch(() => null)) {
    await cp(join(root, "verifier.json"), join(root, "verifier-result.json"), { force: true });
    await rm(join(root, "verifier.json"), { force: true });
  }

  // verifier_res/ — the grade + verifier stdout/stderr.
  for (const name of ["verifier-result.json", "verifier-stdout.log", "verifier-stderr.log"]) {
    await moveIf(join(root, name), join(root, "verifier_res", name));
  }

  // session/ — session stream + human-readable transcript (kept as-is).
  for (const name of ["session.jsonl", "conversation.md", "transcript.md"]) {
    await moveIf(join(root, name), join(root, "session", name));
  }

  // diffs/ — the agent's patch + its hunk breakdown + the output manifest that
  // captures generated outputs for non-coding categories (the diff-equivalent).
  for (const name of ["diff.patch", "diff.hunks.json", "outputs-manifest.json"]) {
    await moveIf(join(root, name), join(root, "diffs", name));
  }

  // raw_std/ — raw agent stdout/stderr streams.
  for (const name of ["raw-stdout.log", "raw-stderr.log"]) {
    await moveIf(join(root, name), join(root, "raw_std", name));
  }

  // eval_lifecycle_logs/ — harness/platform lifecycle artifacts. archive.json and
  // README.md land here (archive.json is written later by sealEvalArchive).
  const lifecycleNames = [
    "eval.json", "adapter-evidence.json", "run.json", "queue.json", "exec.json", "run-metrics.json",
    "evidence-integrity.json", "archive.json", "README.md", "manifest.json",
    "setup-manifest.json", "provision.json", "cleanup.json", "package-cleanup.json",
    "cleanup-verification.json", "workspace-reset.json", "failure-classification.json",
    "evidence-extraction.json", "diff-error.json", "verifier-error.json",
    "finalization-error.json",
  ];
  for (const name of lifecycleNames) {
    await moveIf(join(root, name), join(root, "eval_lifecycle_logs", name));
  }

  // The root canonical events file is removed from the archive (not copied anywhere).
  await rm(join(root, "events.jsonl"), { force: true });
}

/**
 * Map a manifest entry's role to the hoisted folder it lands in (or null when
 * the role is not hoisted and stays only inside `retained/`). A judge binds
 * each hoisted file by role id; the mapping is stable regardless of adapter.
 */
function roleFolder(role: EvidenceRole): string | null {
  switch (role) {
    // High-signal agent evidence lands in session/ alongside the transcript.
    case "trace": return "session";
    case "transcript": return "session";
    case "result": return "session";
    case "model_calls": return "model-calls";
    case "tool_calls": return "tool-logs";
    case "tmp": return "tmp";
    case "logs": return "further-evidence";
    // "session" is the whole agent tree — already fully preserved under retained/.
    default: return null;
  }
}

/** One role binding a judge reads from the eval context. */
export interface EvalContextRole {
  id: string;
  role: EvidenceRole;
  /** Archive-root-relative location of this evidence after the hoist. */
  archivePath: string;
  format: string;
  label?: string;
  required?: boolean;
  primary?: boolean;
}

/**
 * Derive the role-typed evidence bindings a judge reads, from the adapter's
 * evidence manifest snapshot. `archivePath` is where the hoist (roleFolder)
 * places the evidence in the sealed archive — a stable location regardless of
 * the adapter's deep native layout. Roles that are not hoisted resolve to
 * `retained/<literal path>`.
 */
export function buildEvalContext(manifest: EvidenceEntry[]): { roles: EvalContextRole[] } {
  const roles: EvalContextRole[] = [];
  for (const entry of manifest) {
    const folder = roleFolder(entry.role);
    const archivePath =
      folder !== null
        ? join(folder, basename(entry.path.replaceAll("*", "") || "evidence"))
        : join("retained", entry.path);
    roles.push({
      id: entry.id,
      role: entry.role,
      archivePath: archivePath.split(sep).join("/"),
      format: entry.format,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.required !== undefined ? { required: entry.required } : {}),
      ...(entry.primary !== undefined ? { primary: entry.primary } : {}),
    });
  }
  return { roles };
}

/** `*` and `**`-free literal workspace-relative path of an entry (globs rejected). */
function literalWorkspacePath(entry: EvidenceEntry): string | null {
  if (entry.path.includes("*")) return null;
  return entry.path;
}

/**
 * Resolve a manifest `path` (globs allowed) to the concrete retained files it
 * matches, honoring `select`. A literal path selects the file itself (or, for a
 * directory, all descendants). A glob resolves against the retained agent root.
 * `select: "latest_mtime"` keeps only the newest match; `select: "all"` (the
 * default for directories) keeps every match.
 */
async function resolveEvidenceEntry(
  retainedAgentRoot: string,
  entry: EvidenceEntry,
): Promise<string[]> {
  const literal = literalWorkspacePath(entry);
  if (literal !== null) {
    const abs = resolve(retainedAgentRoot, literal);
    const stat = await lstat(abs).catch(() => null);
    if (!stat) return [];
    // Return the entry itself (file or directory); the copy step handles a
    // directory by copying its contents into the role folder, preserving any
    // nested structure (e.g. tmp/ subdirs).
    return [abs];
  }
  const matches = await globMatches(retainedAgentRoot, entry.path);
  if (entry.select === "latest_mtime" && matches.length > 0) {
    const [newest] = matches.sort((a, b) => {
      const ta = statMtime(a);
      const tb = statMtime(b);
      return tb - ta;
    });
    return [newest!];
  }
  return matches;
}

/** mtime (ms) of a path, 0 when unreadable. */
function statMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Minimal glob walk over the retained agent tree supporting `*` (one segment)
 * and `**` (any depth). Returns absolute file paths, sorted.
 */
async function globMatches(root: string, pattern: string): Promise<string[]> {
  const parts = pattern.split("/").filter((p) => p.length > 0);
  const out: string[] = [];
  await globWalk(root, parts, 0, out);
  return out.sort();
}

async function globWalk(
  dir: string,
  parts: string[],
  idx: number,
  out: string[],
): Promise<void> {
  if (idx >= parts.length) return;
  const part = parts[idx]!;
  const isLast = idx === parts.length - 1;
  if (part === "**") {
    // zero segments
    await globWalk(dir, parts, idx + 1, out);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      await globWalk(join(dir, entry.name), parts, idx, out);
    }
    return;
  }
  const re = new RegExp(`^${part.split("*").map(escapeRegExp).join(".*")}$`, "i");
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!re.test(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (isLast) {
      const st = await lstat(abs).catch(() => null);
      // Match the literal-path behavior: a directory match is returned as the
      // directory itself (the copy step copies its contents into the role folder).
      if (st && (st.isFile() || st.isDirectory() || st.isSymbolicLink())) out.push(abs);
    } else if (entry.isDirectory()) {
      await globWalk(abs, parts, idx + 1, out);
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Restructure an eval archive so consumers meet high-signal traces first,
 * hoisting the adapter's native session/trajectory/result evidence out of the
 * deep `retained/agent/<evidence-root>/...` maze per the adapter's role-typed
 * evidence manifest, then applying the standard folder layout via
 * `organizeArchiveLayout`. The manifest is read from the run's
 * `adapter-evidence.json` snapshot (written at claim time); when absent it falls
 * back to the legacy Reaper hard-coded roots. No content is invented — files are
 * only copied into a browsable layout; the `retained/` tree is never modified.
 *
 * ```
 * <runDir>/
 *   session/              ← role "trace" (session.jsonl) + "transcript" (conversation.md)
 *                           + "result" (latest-run.json / result.json)
 *   model-calls/          ← role "model_calls"
 *   tool-logs/            ← role "tool_calls"
 *   tmp/                  ← role "tmp" (scratch temp capture)
 *   verifier_res/         ← verifier-result.json + streams
 *   diffs/                ← diff.patch, diff.hunks.json
 *   raw_std/              ← raw-stdout.log, raw-stderr.log
 *   eval_lifecycle_logs/  ← run/eval/queue/exec/metrics/README/archive/manifests
 *   retained/             ← adapter evidence (unchanged)
 * ```
 *
 * Idempotent: a no-op when neither a manifest nor retained agent evidence is
 * present. Runs copy-only so a mid-step failure leaves the original tree intact.
 */
export async function restructureSuiteArchive(runDir: string): Promise<void> {
  const root = resolve(runDir);
  const retainedRoot = join(root, "retained", "agent");
  const retainedStat = await lstat(retainedRoot).catch(() => null);
  if (!retainedStat || !retainedStat.isDirectory()) return;

  // Load the adapter's evidence manifest snapshot (Task #200 writes it at claim
  // time; it lives at the run root until organizeArchiveLayout moves it into
  // eval_lifecycle_logs/). Its `path` values are workspace-relative and resolve
  // against the retained agent root (`retained/agent/`).
  let manifest: EvidenceEntry[] | null = null;
  try {
    const raw = await readFile(join(root, "adapter-evidence.json"), "utf8");
    const parsed = JSON.parse(raw) as { manifest?: EvidenceEntry[] };
    if (Array.isArray(parsed.manifest)) manifest = parsed.manifest;
  } catch {
    manifest = null;
  }

  if (manifest !== null) {
    for (const entry of manifest) {
      const folder = roleFolder(entry.role);
      if (folder === null) continue;
      const matches = await resolveEvidenceEntry(retainedRoot, entry);
      for (const file of matches) {
        const stat = await lstat(file).catch(() => null);
        if (!stat) continue;
        const destDir = join(root, folder);
        await mkdir(destDir, { recursive: true });
        if (stat.isDirectory()) {
          // Copy the directory's contents into the role folder (flattens the
          // `.reaper/logs/<id>/…` maze to model-calls/ tool-logs/ tmp/).
          for (const child of await readdir(file, { withFileTypes: true }).catch(() => [])) {
            await cp(join(file, child.name), join(destDir, child.name), {
              recursive: true,
              force: true,
            });
          }
        } else {
          await cp(file, join(destDir, basename(file)), { force: true });
        }
      }
    }
    await writeArchiveReadme(root);
    await organizeArchiveLayout(runDir);
    return;
  }

  // Legacy fallback (no manifest snapshot): hoist the known Reaper paths so
  // pre-manifest archives still restructure into the same browsable layout.
  await restructureSuiteArchiveLegacy(root, retainedRoot);
  await writeArchiveReadme(root);
  await organizeArchiveLayout(runDir);
}

/** Legacy hard-coded Reaper hoist (used only when no manifest snapshot exists). */
async function restructureSuiteArchiveLegacy(root: string, retainedRoot: string): Promise<void> {
  const reaperRoot = join(retainedRoot, "task", ".reaper");
  const reaperStat = await lstat(reaperRoot).catch(() => null);
  if (!reaperStat || !reaperStat.isDirectory()) return;

  const logsRootNew = join(reaperRoot, "logs");
  const runsRoot = join(reaperRoot, "runs");
  const logsStat = await lstat(logsRootNew).catch(() => null);
  let execDir: string;
  if (logsStat && logsStat.isDirectory()) {
    const dirs = (await readdir(logsRootNew, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => join(logsRootNew, e.name))
      .sort();
    if (dirs.length === 0) return;
    execDir = dirs[dirs.length - 1]!;
  } else {
    const dirs = (await readdir(runsRoot, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => join(runsRoot, e.name))
      .sort();
    if (dirs.length === 0) return;
    execDir = join(dirs[dirs.length - 1]!, "logs");
  }

  const moveIf = async (src: string, dest: string): Promise<void> => {
    if (!(await lstat(src).catch(() => null))) return;
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
  };

  await moveIf(join(execDir, "session.jsonl"), join(root, "trace", "session.jsonl"));
  await moveIf(join(execDir, "conversation.md"), join(root, "transcript", "conversation.md"));
  await moveIf(join(execDir, "result.json"), join(root, "result", "result.json"));
  await moveIf(join(execDir, "model-calls"), join(root, "model-calls"));
  await moveIf(join(reaperRoot, "latest-run.json"), join(root, "result", "latest-run.json"));
}

/** Write a README.md navigator describing the archive contents (into eval_lifecycle_logs/). */
async function writeArchiveReadme(root: string): Promise<void> {
  const lines = [
    "# Eval run archive",
    "",
    "Read top-down. The highest-signal evidence is at the top; dig into the",
    "subfolders only to confirm a specific theory.",
    "",
    "## verifier_res/",
    "- `verifier-result.json` — the grade: reward (0|1), checks, pass/fail.",
    "- `verifier-stdout.log` / `verifier-stderr.log` — the verifier's streams.",
    "",
    "## session/",
    "- `session.jsonl` — the agent's session/turn stream (role `trace`).",
    "- `conversation.md` — the same run as a human-readable transcript (role `transcript`).",
    "- `result.json` — the agent's final result (role `result`).",
    "",
    "## diffs/",
    "- `diff.patch` — the agent's changes vs the seeded baseline.",
    "- `diff.hunks.json` — the patch's per-hunk breakdown.",
    "- `outputs-manifest.json` — captured generated outputs for non-coding evals.",
    "",
    "## raw_std/",
    "- `raw-stdout.log` — the agent's live stdout stream.",
    "- `raw-stderr.log` — the agent's live stderr stream.",
    "",
    "## eval_lifecycle_logs/",
    "Harness/platform lifecycle logs: run/queue/exec metadata, metrics, evidence",
    "integrity, the sealed archive manifest, setup/cleanup/reset manifests, and",
    "failure classification. These describe how the eval was run, not what the",
    "agent did.",
    "",
    "## model-calls/ (suite)",
    "Each model call's full request + response stream (.json + .txt). Use these",
    "to inspect exactly what the model was asked and returned at each turn.",
    "",
    "## tool-logs/ (suite)",
    "Output of each tool/shell exec the agent performed (role `tool_calls`).",
    "",
    "## tmp/",
    "The adapter's scratch temp capture (role `tmp`) hoisted out of the retained tree.",
    "",
    "## further-evidence/ (suite)",
    "Dig-more material: the full live conversation, the langfuse event stream,",
    "trajectory index/metrics, progress, manifest, file snapshots at each edit.",
    "Consult these only when you have a specific theory to confirm.",
    "",
    "## retained/",
    "The adapter-declared native evidence exactly as copied from the workspace.",
    "",
    "## Verdict summary",
    "See `verifier_res/verifier-result.json` for the official reward and",
    "per-check pass/fail.",
  ];
  await mkdir(join(root, "eval_lifecycle_logs"), { recursive: true });
  await writeFile(join(root, "eval_lifecycle_logs", "README.md"), `${lines.join("\n")}\n`, "utf8");
}

/** Seal every artifact currently in `runDir` and register its immutable manifest. */
export async function sealEvalArchive(
  queries: DbQueries,
  runDir: string,
  ids: {
    runId: string;
    projectId: string;
    queueId?: string | null;
    batchId: string;
  },
): Promise<{ archive: EvalArchive; manifest: EvalArchiveManifest }> {
  const existing = queries.getEvalArchive(ids.runId);
  if (existing) {
    throw new Error(`eval archive already sealed for run ${ids.runId}`);
  }
  const root = resolve(runDir);
  const manifestRel = "eval_lifecycle_logs/archive.json";
  const manifestPath = join(root, manifestRel);
  await mkdir(dirname(manifestPath), { recursive: true });
  const files = await inventory(root, root);
  const sealedAt = new Date().toISOString();
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const manifest: EvalArchiveManifest = {
    schemaVersion: 1,
    runId: ids.runId,
    projectId: ids.projectId,
    queueId: ids.queueId ?? null,
    batchId: ids.batchId,
    sealedAt,
    totalBytes,
    manifestRel,
    files,
  };
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const tmp = `${manifestPath}.tmp`;
  await writeFile(tmp, encoded);
  await rename(tmp, manifestPath);
  const manifestSha256 = sha256(encoded);

  const archive = queries.storeEvalArchive({
    runId: ids.runId,
    projectId: ids.projectId,
    queueId: ids.queueId ?? null,
    batchId: ids.batchId,
    manifestPath,
    manifestSha256,
    sizeBytes: totalBytes + encoded.length,
    sealedAt,
  });
  await makeReadOnly(root);

  return { archive, manifest };
}

/** Verify that every sealed file and the manifest itself still match their hashes. */
export async function verifyEvalArchive(
  archive: EvalArchive,
): Promise<{ ok: boolean; errors: string[]; manifest: EvalArchiveManifest | null }> {
  const errors: string[] = [];
  let raw: Buffer;
  try {
    raw = await readFile(archive.manifestPath);
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      manifest: null,
    };
  }
  if (sha256(raw) !== archive.manifestSha256) errors.push("archive manifest hash mismatch");
  let manifest: EvalArchiveManifest;
  try {
    manifest = JSON.parse(raw.toString("utf8")) as EvalArchiveManifest;
  } catch {
    return { ok: false, errors: [...errors, "archive manifest is invalid JSON"], manifest: null };
  }
  // Derive the archive root by stripping the manifest's own relative path off
  // its absolute path (layout-independent, since the manifest records manifestRel).
  // Start from the manifest's parent dir, then walk up once per folder segment.
  const manifestRel = typeof manifest.manifestRel === "string" ? manifest.manifestRel : "archive.json";
  const folderCount = manifestRel.split("/").length - 1;
  let root = resolve(dirname(archive.manifestPath));
  for (let i = 0; i < folderCount; i += 1) root = resolve(root, "..");
  for (const entry of manifest.files) {
    const path = resolve(root, entry.path);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      errors.push(`archive path escapes root: ${entry.path}`);
      continue;
    }
    try {
      if (entry.kind === "symlink") {
        const target = await readlink(path);
        if (sha256(Buffer.from(target)) !== entry.sha256) {
          errors.push(`symlink hash mismatch: ${entry.path}`);
        }
      } else {
        const data = await readFile(path);
        if (data.length !== entry.bytes || sha256(data) !== entry.sha256) {
          errors.push(`file hash mismatch: ${entry.path}`);
        }
      }
    } catch {
      errors.push(`missing archive entry: ${entry.path}`);
    }
  }
  try {
    const actual = await inventory(root, root);
    const expectedPaths = new Set(manifest.files.map((entry) => entry.path));
    const actualPaths = new Set(actual.map((entry) => entry.path));
    for (const path of actualPaths) {
      if (!expectedPaths.has(path)) errors.push(`unsealed archive entry: ${path}`);
    }
    for (const path of expectedPaths) {
      if (!actualPaths.has(path)) errors.push(`missing archive entry: ${path}`);
    }
  } catch (err) {
    errors.push(`archive inventory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: errors.length === 0, errors, manifest };
}

async function inventory(root: string, dir: string): Promise<EvalArchiveFile[]> {
  const out: EvalArchiveFile[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === "archive.json" || name === "archive.json.tmp") continue;
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      out.push(...(await inventory(root, path)));
      continue;
    }
    const rel = relative(root, path).split(sep).join("/");
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      const encoded = Buffer.from(target, "utf8");
      out.push({ path: rel, kind: "symlink", target, bytes: encoded.length, sha256: sha256(encoded) });
      continue;
    }
    if (!stat.isFile()) continue;
    const data = await readFile(path);
    out.push({ path: rel, kind: "file", bytes: data.length, sha256: sha256(data) });
  }
  return out;
}

async function makeReadOnly(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await makeReadOnly(join(path, name));
    await chmod(path, 0o555);
    return;
  }
  if (!stat.isSymbolicLink()) await chmod(path, 0o444);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

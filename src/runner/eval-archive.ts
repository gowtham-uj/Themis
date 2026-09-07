/** Immutable, content-addressed evidence archive for one eval execution. */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
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
  /**
   * Layers sealed over the base evidence, in the order they were added
   * ("judge", then "phase2"). Absent on a base-only archive.
   */
  layers?: string[];
  /** When the most recent layer was sealed in. Absent until the first reseal. */
  resealedAt?: string;
}

/**
 * Reorganize a sealed eval archive into the target browsable layout. Only the
 * folder moves below happen here — no content is invented or dropped, and no
 * evidence is renamed across roles. The `retained/` tree is
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
 * `platform/` is removed in favor of `eval_lifecycle_logs/`; the canonical
 * `events.jsonl` moves into that folder and remains in the immutable archive.
 * Idempotent (copy-then-cleanup per file).
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

  // Keep the canonical event trace in the immutable archive. It is platform
  // lifecycle evidence (not the adapter-native session trace), so move it once
  // rather than deleting it or duplicating it.
  await moveIf(
    join(root, "events.jsonl"),
    join(root, "eval_lifecycle_logs", "events.jsonl"),
  );

  // Written last: the navigator lists only the folders this run actually has,
  // so it has to see the finished layout rather than the pre-hoist run root.
  await writeArchiveReadme(root);
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
 * `retained/agent/<literal path>` (the exact tree copyRetainedEvidence builds).
 */
export function buildEvalContext(manifest: EvidenceEntry[]): { roles: EvalContextRole[] } {
  const roles: EvalContextRole[] = [];
  for (const entry of manifest) {
    const folder = roleFolder(entry.role);
    let archivePath: string;
    if (folder !== null) {
      // The hoist copies a resolved FILE to folder/<basename>, but a directory
      // role (format "dir") is hoisted by copying the directory's CONTENTS into
      // folder/, and a trailing glob (`*.jsonl`) has no fixed filename — the
      // file lands at folder/<resolved name>. Bind the folder itself in both
      // cases rather than advertising a path that never exists.
      const lastSegment = entry.path.split("/").pop() ?? "";
      const literalName = !lastSegment.includes("*") && entry.format !== "dir" ? basename(entry.path) : "";
      archivePath = literalName ? join(folder, literalName) : folder;
    } else {
      archivePath = join("retained", "agent", entry.path);
    }
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
    // Literal manifest paths must stay inside the retained agent root. A hostile
    // adapter manifest (`../..` or an absolute path) must never resolve to a host
    // file that then gets hoisted and sealed into an attacker-visible archive.
    if (abs !== retainedAgentRoot && !abs.startsWith(`${retainedAgentRoot}${sep}`)) {
      return [];
    }
    const stat = await lstat(abs).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return [];
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
  if (!retainedStat || !retainedStat.isDirectory()) {
    // Nothing to hoist, but the standard folder layout still applies (the suite
    // runner relies on this call to organize + drop events.jsonl before sealing).
    await organizeArchiveLayout(runDir);
    return;
  }

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
    const claimedDestinations = new Map<string, string>();
    const claimDestination = (dest: string, source: string): void => {
      const key = resolve(dest);
      const prior = claimedDestinations.get(key);
      if (prior && prior !== source) {
        throw new Error(
          `evidence hoist collision at ${relative(root, key)}: ${prior} and ${source}`,
        );
      }
      claimedDestinations.set(key, source);
    };
    for (const entry of manifest) {
      const folder = roleFolder(entry.role);
      if (folder === null) continue;
      const matches = await resolveEvidenceEntry(retainedRoot, entry);
      for (const file of matches) {
        const stat = await lstat(file).catch(() => null);
        // Never hoist a symlink (it could point anywhere on the host); the archive
        // read path additionally refuses symlinks with O_NOFOLLOW.
        if (!stat || stat.isSymbolicLink()) continue;
        const destDir = join(root, folder);
        await mkdir(destDir, { recursive: true });
        if (stat.isDirectory()) {
          // Copy the directory's contents into the role folder (flattens the
          // `.reaper/logs/<id>/…` maze to model-calls/ tool-logs/ tmp/).
          for (const child of await readdir(file, { withFileTypes: true }).catch(() => [])) {
            const source = join(file, child.name);
            const destination = join(destDir, child.name);
            claimDestination(destination, source);
            await cp(source, destination, {
              recursive: true,
              force: true,
            });
          }
        } else {
          const destination = join(destDir, basename(file));
          claimDestination(destination, file);
          await cp(file, destination, { force: true });
        }
      }
    }
    await organizeArchiveLayout(runDir);
    return;
  }

  // Legacy fallback (no manifest snapshot): hoist the known Reaper paths so
  // pre-manifest archives still restructure into the same browsable layout.
  await restructureSuiteArchiveLegacy(root, retainedRoot);
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

/** One archive folder, described for the person reading the sealed evidence. */
const ARCHIVE_SECTIONS: ReadonlyArray<{dir: string; lines: readonly string[]}> = [
  {
    dir: "verifier_res",
    lines: [
      "The official grade. Start here.",
      "- `verifier-result.json` — `officialReward` (0 or 1) plus one entry per check.",
      "  A run that passes `public_tests` and fails `hidden_contract` is the",
      "  highest-signal failure this platform produces: the agent satisfied every",
      "  test it could see and still broke the contract.",
      "- `verifier-stdout.log` / `verifier-stderr.log` — the verifier's raw streams.",
    ],
  },
  {
    dir: "session",
    lines: [
      "What the agent did, turn by turn.",
      "- `session.jsonl` — the agent's own session stream.",
      "- `conversation.md` — the same run as a readable transcript.",
      "- `result.json` — the agent's self-reported final result.",
    ],
  },
  {
    dir: "diffs",
    lines: [
      "What the agent changed.",
      "- `diff.patch` — every edit against the seeded baseline.",
      "- `diff.hunks.json` — the same patch split per hunk, for programmatic reads.",
      "- `outputs-manifest.json` — generated outputs, for evals that are not code edits.",
    ],
  },
  {
    dir: "raw_std",
    lines: [
      "- `raw-stdout.log` / `raw-stderr.log` — the agent process's live streams,",
      "  unparsed. Read these when the canonical trace looks wrong.",
    ],
  },
  {
    dir: "eval_lifecycle_logs",
    lines: [
      "How the harness ran the eval, not what the agent did.",
      "- `run-metrics.json` — counts of tool calls, mutations, and verifications,",
      "  plus token and request measurements with refs back into the trace.",
      "- `events.jsonl` — the canonical event trace, normalized across adapters.",
      "- `failure-classification.json` — why the run ended, when it ended badly.",
      "- `evidence-integrity.json`, `archive.json` — hashes of every sealed file.",
      "- `exec.json`, `queue.json`, `run.json`, `eval.json` — the run's identity.",
      "- setup, cleanup, reset, and package manifests — the container's lifecycle.",
    ],
  },
  {
    dir: "model-calls",
    lines: [
      "Each model call's full request and response. Use these to see exactly what",
      "the model was asked at each turn.",
    ],
  },
  {
    dir: "tool-logs",
    lines: ["Output of each tool or shell command the agent ran."],
  },
  {
    dir: "further-evidence",
    lines: [
      "Adapter-specific extras: live conversation, event stream, trajectory index,",
      "progress, and file snapshots at each edit. Open these only with a theory to",
      "confirm.",
    ],
  },
  {
    dir: "retained",
    lines: ["The adapter's native evidence, copied byte for byte from the workspace."],
  },
  {
    dir: "tmp",
    lines: ["The adapter's scratch temp capture, hoisted out of the retained tree."],
  },
];

/**
 * Write a README.md navigator describing the archive contents.
 *
 * Only folders this archive actually has are listed. Adapters declare different
 * evidence, so a static list sends a reader hunting for a `model-calls/` that
 * was never captured, which reads as missing evidence rather than as evidence
 * this adapter does not produce.
 */
async function writeArchiveReadme(root: string): Promise<void> {
  const present = new Set(
    (await readdir(root, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  // eval_lifecycle_logs is written after this point in the seal, so it is
  // always part of the archive even when it is not on disk yet.
  present.add("eval_lifecycle_logs");

  const lines = [
    "# Eval run archive",
    "",
    "One agent, one eval, one grade. Read top-down: the verdict first, then what",
    "the agent changed, then how it got there. Only the folders this run actually",
    "produced are listed below.",
  ];
  for (const section of ARCHIVE_SECTIONS) {
    if (!present.has(section.dir)) continue;
    lines.push("", `## ${section.dir}/`, ...section.lines);
  }
  const absent = ARCHIVE_SECTIONS.filter((s) => !present.has(s.dir)).map((s) => s.dir);
  if (absent.length > 0) {
    lines.push(
      "",
      "## Not captured for this run",
      `${absent.map((d) => `\`${d}/\``).join(", ")}. This adapter did not declare`,
      "that evidence, so its absence is expected and is not a gap in the seal.",
    );
  }
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
  const root = resolve(runDir);
  // Cross-process seal lock: only one worker may inventory, write the manifest,
  // register the DB row, and harden a run directory. A sibling lock stays
  // outside the archive tree so it is never sealed as evidence.
  const lockPath = `${root}.seal.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
      throw new Error(`eval archive sealing already in progress for run ${ids.runId}`);
    }
    throw err;
  }
  try {
    const existing = queries.getEvalArchive(ids.runId);
    if (existing) {
      throw new Error(`eval archive already sealed for run ${ids.runId}`);
    }
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
  // Re-inventory after permission hardening to catch a write that raced the
  // initial hash pass. Any mismatch taints finalization instead of publishing a
  // manifest whose bytes do not describe the sealed tree.
  const hardenedFiles = await inventory(root, root);
  if (JSON.stringify(hardenedFiles) !== JSON.stringify(files)) {
    throw new Error(`eval archive changed while sealing run ${ids.runId}`);
  }

  return { archive, manifest };
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
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

/**
 * Reseal one sealed archive in place with a new layer of judgement output.
 *
 * The base evidence directory is the only archive an eval ever gets. Phase 1
 * adds `judge/`, Phase 2 adds `phase2/`, and both land inside the same
 * `projects/<projectId>/evals/<runId>` tree rather than beside it. The sealed
 * tree is read-only, so this unseals it, adds exactly one layer, re-inventories,
 * rewrites the manifest, updates the archive row, and hardens it again.
 *
 * Base paths are never replaced: any collision between the incoming layer and
 * an already-sealed path aborts before a single byte is written.
 */
export async function resealEvalArchive(input: {
  runId: string;
  /** Root of the sealed archive, e.g. data/projects/<pid>/evals/<runId>. */
  archiveDir: string;
  /**
   * Top-level directories to seal in. Phase 1 adds `judge` and `phase1`
   * together, Phase 2 adds `phase2`. A layer whose source is missing is
   * skipped, so optional provenance never blocks the reseal.
   */
  layers: { name: string; sourceDir: string }[];
  /**
   * Registry holding this run's archive row. When present the row's manifest
   * path, hash, and size are updated to the resealed manifest. Omitted by
   * callers that own no registry (tests, standalone judge workers); the
   * on-disk manifest is still rewritten.
   */
  queries?: DbQueries | null;
}): Promise<{ archive: EvalArchive | null; manifest: EvalArchiveManifest }> {
  const root = resolve(input.archiveDir);
  const layers = input.layers.map((l) => ({ ...l, name: l.name.replace(/^\/+|\/+$/g, "") }));
  for (const l of layers) {
    if (!l.name || l.name.includes("/") || l.name === "." || l.name === "..") {
      throw new Error(`invalid reseal layer: ${l.name}`);
    }
  }
  const existing = input.queries?.getEvalArchive(input.runId) ?? null;
  const manifestPath = existing?.manifestPath ?? join(root, "eval_lifecycle_logs", "archive.json");

  // One writer at a time. The lock lives beside the archive so it is never
  // inventoried as evidence.
  const lockPath = `${root}.seal.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
      throw new Error(`eval archive reseal already in progress for run ${input.runId}`);
    }
    throw err;
  }
  try {
    const prior = await readFile(manifestPath, "utf8");
    const priorManifest = JSON.parse(prior) as EvalArchiveManifest;
    const priorLayers = Array.isArray(priorManifest.layers) ? priorManifest.layers : [];
    // Only layers whose source exists are sealed.
    //
    // A layer that is already sealed is normally a caller bug. But a crash or a
    // failed quality gate can seal a PARTIAL layer: one live case sealed a
    // judge/ holding only quality-report.json, and the complete ruling produced
    // 18 minutes later could never land, so the judgement was lost with no way
    // back. Completing a layer is therefore allowed as long as it only ADDS
    // files. Every byte already sealed stays byte-identical; a source that
    // would change or drop a sealed path is still refused below.
    const present: { name: string; sourceDir: string }[] = [];
    const completed: string[] = [];
    for (const l of layers) {
      const src = await lstat(l.sourceDir).catch(() => null);
      if (!src?.isDirectory()) continue;
      const sealedPaths = priorManifest.files.filter(
        (f) => f.path === l.name || f.path.startsWith(`${l.name}/`),
      );
      if (priorLayers.includes(l.name) || sealedPaths.length > 0) {
        const additions = await newLayerFiles(root, l);
        if (additions === 0) {
          throw new Error(
            `archive for run ${input.runId} already carries layer ${l.name} and the source adds nothing new`,
          );
        }
        completed.push(l.name);
      }
      present.push(l);
    }
    if (present.length === 0) {
      throw new Error(`no reseal layer source exists for run ${input.runId}`);
    }

    await makeWritable(root);
    for (const l of present) {
      // Completing a partial layer must never rewrite a byte that is already
      // sealed, so those copies skip existing files instead of forcing over
      // them. A fresh layer has nothing to collide with.
      if (completed.includes(l.name)) await copyNewOnly(l.sourceDir, join(root, l.name));
      else await cp(l.sourceDir, join(root, l.name), { recursive: true, force: true });
    }

    const files = await inventory(root, root);
    const priorPaths = new Map(priorManifest.files.map((f) => [f.path, f]));
    for (const file of files) {
      const before = priorPaths.get(file.path);
      // Genuinely new path: nothing sealed to compare it against.
      if (!before) continue;
      if (before.sha256 !== file.sha256 || before.bytes !== file.bytes) {
        throw new Error(`reseal changed a sealed path: ${file.path}`);
      }
    }
    for (const path of priorPaths.keys()) {
      if (!files.some((f) => f.path === path)) {
        throw new Error(`reseal dropped a sealed path: ${path}`);
      }
    }

    const resealedAt = new Date().toISOString();
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const manifest: EvalArchiveManifest = {
      ...priorManifest,
      totalBytes,
      files,
      layers: [...new Set([...priorLayers, ...present.map((l) => l.name)])],
      resealedAt,
    };
    const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const tmp = `${manifestPath}.tmp`;
    await writeFile(tmp, encoded);
    await rename(tmp, manifestPath);

    const archive =
      existing && input.queries
        ? input.queries.storeEvalArchive({
            runId: existing.runId,
            projectId: existing.projectId,
            queueId: existing.queueId,
            batchId: existing.batchId,
            manifestPath: existing.manifestPath,
            manifestKey: existing.manifestKey,
            manifestSha256: sha256(encoded),
            sizeBytes: totalBytes + encoded.length,
            sealedAt: existing.sealedAt,
            archivedAt: resealedAt,
          })
        : null;
    await makeReadOnly(root);
    return { archive, manifest };
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Count files the source would add to an already-sealed layer.
 *
 * Zero means the retry carries nothing the archive does not already hold, which
 * is the real "already sealed" case and stays an error. Anything above zero is
 * a partial layer worth completing.
 */
async function newLayerFiles(
  root: string,
  layer: { name: string; sourceDir: string },
): Promise<number> {
  const dest = join(root, layer.name);
  let n = 0;
  async function walk(rel: string): Promise<void> {
    for (const name of await readdir(join(layer.sourceDir, rel)).catch(() => [])) {
      const next = rel ? `${rel}/${name}` : name;
      const s = await lstat(join(layer.sourceDir, next));
      if (s.isDirectory()) await walk(next);
      else if (!(await lstat(join(dest, next)).catch(() => null))) n += 1;
    }
  }
  await walk("");
  return n;
}

/**
 * Copy a tree, skipping every file the destination already has.
 *
 * Sealed bytes are immutable, so completing a layer may only fill gaps. A file
 * present in both is left exactly as sealed, even when the source differs.
 */
async function copyNewOnly(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(src).catch(() => [])) {
    const from = join(src, name);
    const to = join(dest, name);
    const s = await lstat(from);
    if (s.isDirectory()) {
      await copyNewOnly(from, to);
      continue;
    }
    if (await lstat(to).catch(() => null)) continue;
    await cp(from, to, { force: false, errorOnExist: false });
  }
}

/** Restore write permission across a sealed tree so one layer can be added. */
async function makeWritable(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
    return;
  }
  await chmod(path, 0o644);
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

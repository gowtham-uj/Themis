/** Immutable, content-addressed evidence archive for one eval execution. */

import { createHash } from "node:crypto";
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
import { join, relative, resolve, sep } from "node:path";
import type { DbQueries, EvalArchive } from "../db/queries.js";

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
  files: EvalArchiveFile[];
}

/**
 * Restructure a suite eval archive so the judge agent meets the high-signal
 * traces first, walking the tree top-down, instead of navigating a deep
 * `retained/agent/task/.reaper/runs/<id>/logs/...` maze. No content is invented
 * or dropped — files are only moved/copied into a judge-friendly layout:
 *
 * ```
 * <runDir>/
 *   README.md              ← navigator: what each file is + the verdict
 *   trajectory.jsonl       ← the append-only turn/event log (hoisted)
 *   transcript.md         ← human-readable session transcript (hoisted)
 *   final-result.json      ← the agent's final result + reward
 *   diff.patch             ← the agent's changes vs the seeded baseline
 *   verifier-result.json   ← the grade (reward, checks, pass/fail)
 *   agent-stdout.log       ← the agent's live stdout
 *   platform/              ← harness/platform logs (run, metrics, events, …)
 *   model-calls/           ← per-model-call full request/response streams
 *   tool-logs/             ← per-tool/shell-exec output logs
 *   further-evidence/      ← dig-more material (conversation, langfuse, snapshots, …)
 * ```
 *
 * Idempotent: a no-op if no `.reaper` retained evidence is present. Runs as a
 * copy-then-cleanup so a mid-step failure leaves the original tree intact.
 */
export async function restructureSuiteArchive(runDir: string): Promise<void> {
  const root = resolve(runDir);
  // Locate the retained agent evidence root (suite path).
  const reaperRoot = join(root, "retained", "agent", "task", ".reaper");
  const reaperStat = await lstat(reaperRoot).catch(() => null);
  if (!reaperStat || !reaperStat.isDirectory()) return; // not a suite archive
  // The per-run exec dirs live under .reaper/runs/.
  const runsRoot = join(reaperRoot, "runs");
  const runDirs = (await readdir(runsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("exec-"))
    .map((entry) => join(runsRoot, entry.name))
    .sort();
  if (runDirs.length === 0) return;
  const execDir = runDirs[runDirs.length - 1]!; // latest run

  const moveIf = async (src: string, dest: string): Promise<void> => {
    if (await lstat(src).catch(() => null)) {
      await mkdir(join(relative(root, dest).split(sep)[0] === "" ? root : root), { recursive: true });
      await cp(src, dest, { recursive: true, force: true });
    }
  };

  // --- top-level high-signal files (hoisted from the agent run dir) ---
  const logsDir = join(execDir, "logs");
  const modelsDir = join(execDir, "model-calls");
  const procDir = join(execDir, "artifacts", "processes");
  const snapsRoot = join(execDir, "artifacts", "file-snapshots");

  await moveIf(join(logsDir, "reaper-trajectory.jsonl"), join(root, "trajectory.jsonl"));
  if (await lstat(join(modelsDir, "TRANSCRIPT.md")).catch(() => null)) {
    await cp(join(modelsDir, "TRANSCRIPT.md"), join(root, "transcript.md"), { force: true });
  }
  await moveIf(join(execDir, "result.json"), join(root, "final-result.json"));
  await moveIf(join(reaperRoot, "latest-run.json"), join(root, "latest-run.json"));
  // diff.patch + verifier already live at runDir top-level from the platform; normalize verifier name.
  if (await lstat(join(root, "verifier.json")).catch(() => null)) {
    await cp(join(root, "verifier.json"), join(root, "verifier-result.json"), { force: true });
  }
  if (await lstat(join(root, "raw-stdout.log")).catch(() => null)) {
    await cp(join(root, "raw-stdout.log"), join(root, "agent-stdout.log"), { force: true });
  }

  // --- platform/ : harness logs separated from agent evidence ---
  const platformDir = join(root, "platform");
  await mkdir(platformDir, { recursive: true });
  const platformFiles = [
    "run.json", "run-metrics.json", "eval.json", "queue.json", "exec.json",
    "events.jsonl", "archive.json", "evidence-extraction.json", "evidence-integrity.json",
    "setup-manifest.json", "verifier-stdout.log", "verifier-stderr.log",
    "workspace-reset.json", "package-cleanup.json", "cleanup.json",
    "cleanup-verification.json", "diff.hunks.json",
  ];
  for (const name of platformFiles) {
    if (await lstat(join(root, name)).catch(() => null)) {
      await cp(join(root, name), join(platformDir, name), { force: true });
    }
  }

  // --- model-calls/ : per-call request/response streams (primary deep-dive) ---
  if (await lstat(modelsDir).catch(() => null)) {
    await cp(modelsDir, join(root, "model-calls"), { recursive: true, force: true });
  }
  // --- tool-logs/ : per tool/shell-exec output ---
  if (await lstat(procDir).catch(() => null)) {
    await cp(procDir, join(root, "tool-logs"), { recursive: true, force: true });
  }

  // --- further-evidence/ : dig-more material (confirm a theory) ---
  const furtherDir = join(root, "further-evidence");
  await mkdir(furtherDir, { recursive: true });
  await moveIf(join(execDir, "live-conversation.json"), join(furtherDir, "live-conversation.json"));
  await moveIf(join(logsDir, "langfuse-events.jsonl"), join(furtherDir, "langfuse-events.jsonl"));
  await moveIf(join(logsDir, "reaper-trajectory.index.json"), join(furtherDir, "trajectory-index.json"));
  await moveIf(join(execDir, "trajectory-metrics.json"), join(furtherDir, "trajectory-metrics.json"));
  await moveIf(join(execDir, "progress.json"), join(furtherDir, "progress.json"));
  await moveIf(join(execDir, "manifest.json"), join(furtherDir, "manifest.json"));
  const topLangfuse = join(reaperRoot, "logs", "langfuse-events.jsonl");
  if (await lstat(topLangfuse).catch(() => null)) {
    await cp(topLangfuse, join(furtherDir, "top-langfuse-events.jsonl"), { force: true });
  }
  if (await lstat(snapsRoot).catch(() => null)) {
    await cp(snapsRoot, join(furtherDir, "file-snapshots"), { recursive: true, force: true });
  }
  // reaper harness result/stderr kept at .agenteval/ inside retained — surface it.
  const agentevalRetained = join(root, "retained", "agent", "task", ".agenteval");
  if (await lstat(join(agentevalRetained, "reaper-result.json")).catch(() => null)) {
    await cp(join(agentevalRetained, "reaper-result.json"), join(furtherDir, "reaper-result.json"), { force: true });
  }
  if (await lstat(join(agentevalRetained, "reaper-stderr.log")).catch(() => null)) {
    await cp(join(agentevalRetained, "reaper-stderr.log"), join(furtherDir, "reaper-stderr.log"), { force: true });
  }

  await writeArchiveReadme(root);
}

/** Write a README.md navigator so the judge knows exactly what is where. */
async function writeArchiveReadme(root: string): Promise<void> {
  const lines = [
    "# Eval run archive",
    "",
    "Read top-down. The highest-signal evidence is at the top; dig into the",
    "subfolders only to confirm a specific theory.",
    "",
    "## Top-level (start here)",
    "- `trajectory.jsonl` — the agent's append-only turn/event log (thinking,",
    "  messages, tool calls, results). This is the primary trace.",
    "- `transcript.md` — the same run as a human-readable session transcript.",
    "- `final-result.json` — the agent's final result.",
    "- `diff.patch` — the agent's changes vs the seeded baseline.",
    "- `verifier-result.json` — the grade: reward (0|1), checks, pass/fail.",
    "- `agent-stdout.log` — the agent's live stdout stream.",
    "",
    "## platform/",
    "Harness/platform logs: run metadata, metrics, canonical events, verifier",
    "stdout/stderr, setup + cleanup manifests, evidence integrity. These describe",
    "how the eval was run, not what the agent did.",
    "",
    "## model-calls/",
    "Each model call's full request + response stream (.json + .txt). Use these",
    "to inspect exactly what the model was asked and returned at each turn.",
    "",
    "## tool-logs/",
    "Output of each tool/shell exec the agent performed.",
    "",
    "## further-evidence/",
    "Dig-more material: the full live conversation, the langfuse event stream,",
    "trajectory index/metrics, progress, manifest, file snapshots at each edit.",
    "Consult these only when you have a specific theory to confirm.",
    "",
    "## Verdict summary",
    "See `verifier-result.json` for the official reward and per-check pass/fail.",
  ];
  await writeFile(join(root, "README.md"), `${lines.join("\n")}\n`, "utf8");
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
  const manifestPath = join(root, "archive.json");
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
  const root = resolve(archive.manifestPath, "..");
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

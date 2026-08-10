/** Immutable, content-addressed evidence archive for one eval execution. */

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  readdir,
  readFile,
  readlink,
  rename,
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

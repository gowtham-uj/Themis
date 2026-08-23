/**
 * WP-12 minimal archive-view publisher: base archive + judge/ tree → view dir.
 * Does not yet CAS current pointers in PostgreSQL (full WP-12); produces the
 * on-disk strict-superset view the plan requires.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { JudgeResultVersion } from "./types.js";

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else if (s.isFile()) out.push(p);
    }
  }
  await walk(root);
  return out;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Publish a judge view over an immutable base archive directory. */
export async function publishJudgeArchiveView(input: {
  runId: string;
  trackId: string;
  baseArchiveDir: string;
  judgeDir: string;
  viewDir: string;
}): Promise<{ result: JudgeResultVersion; manifestPath: string }> {
  await mkdir(input.viewDir, { recursive: true });
  // Copy base (caller may pass an empty viewDir).
  await cp(input.baseArchiveDir, input.viewDir, { recursive: true, force: true });
  const judgeDest = join(input.viewDir, "judge");
  await mkdir(judgeDest, { recursive: true });
  await cp(input.judgeDir, judgeDest, { recursive: true, force: true });

  const files = await listFiles(input.viewDir);
  const entries = [];
  for (const abs of files.sort()) {
    const rel = relative(input.viewDir, abs).replace(/\\/g, "/");
    if (rel === "view.manifest.json") continue;
    const buf = await readFile(abs);
    entries.push({
      path: rel,
      kind: "file" as const,
      bytes: buf.length,
      sha256: sha256(buf),
      symlinkTarget: null,
    });
  }
  const report = entries.find((e) => e.path === "judge/evalJudge.json");
  const manifest = {
    schemaVersion: 1,
    kind: "themis-archive-view",
    runId: input.runId,
    files: entries,
    totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
    resealedAt: new Date().toISOString(),
  };
  const manifestPath = join(input.viewDir, "view.manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result: JudgeResultVersion = {
    id: `jrv_${createHash("sha256").update(`${input.runId}:${report?.sha256 ?? ""}`).digest("hex").slice(0, 32)}`,
    runId: input.runId,
    trackId: input.trackId,
    reportSha256: report?.sha256 ?? "",
    reportPath: join(input.viewDir, "judge/evalJudge.json"),
    archiveViewPath: input.viewDir,
    publicationState: "published",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  };
  return { result, manifestPath };
}

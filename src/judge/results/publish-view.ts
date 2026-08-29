/**
 * WP-12 minimal archive-view publisher: base archive + judge/ tree → view dir.
 * Does not yet CAS current pointers in PostgreSQL (full WP-12); produces the
 * on-disk strict-superset view the plan requires.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

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

/** Hash one file with fixed-size stream buffers (supports multi-GB traces). */
async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buf);
      bytes += buf.length;
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { sha256: hash.digest("hex"), bytes };
}

/** Publish a judge view over an immutable base archive directory. */
export async function publishJudgeArchiveView(input: {
  runId: string;
  trackId: string;
  baseArchiveDir: string;
  judgeDir: string;
  viewDir: string;
  /**
   * PI orchestrator + subagent session logs for this case. Sealed into the view
   * under `judge_traces/` so the resealed archive carries the full provenance of
   * how the judgement was reached, not just its conclusions.
   */
  traceDir?: string;
}): Promise<{ result: JudgeResultVersion; manifestPath: string }> {
  await mkdir(input.viewDir, { recursive: true });
  // Copy base (caller may pass an empty viewDir).
  await cp(input.baseArchiveDir, input.viewDir, { recursive: true, force: true });
  const judgeDest = join(input.viewDir, "judge");
  await mkdir(judgeDest, { recursive: true });
  try {
    await cp(input.judgeDir, judgeDest, { recursive: true, force: true });
  } catch {
    // A case that produced no court records still reseals: the view carries the
    // base plus whatever provenance exists, rather than failing the publish.
  }

  // judge_traces/: orchestrator + subagent session logs (pi stdout stream and
  // per-child transcripts). Best-effort — a missing trace dir never blocks a
  // publish, but when present it is sealed with the rest of the view.
  if (input.traceDir) {
    try {
      const tracesDest = join(input.viewDir, "judge_traces");
      await mkdir(tracesDest, { recursive: true });
      // Copy only the trace artifacts — the orchestrator/subagent session
      // streams and transcripts. The `judge` subdirectory is the same court
      // records already sealed under view/judge/, so copying it here would
      // duplicate the whole tree.
      const { readdir } = await import("node:fs/promises");
      const { join: j } = await import("node:path");
      for (const name of await readdir(input.traceDir)) {
        if (name === "judge") continue;
        if (name === "pi-stdout.jsonl") {
          // Raw orchestrator event streams can be multi-GB. Session jsonl files
          // are the resume source and remain raw; compress this examination-only
          // firehose while copying so the resealed view does not duplicate 3GB.
          await pipeline(
            createReadStream(j(input.traceDir, name)),
            createGzip({ level: 6 }),
            createWriteStream(j(tracesDest, "pi-stdout.jsonl.gz")),
          );
          continue;
        }
        await cp(j(input.traceDir, name), j(tracesDest, name), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      // trace capture is provenance, not correctness
    }
  }

  const files = await listFiles(input.viewDir);
  const entries = [];
  for (const abs of files.sort()) {
    const rel = relative(input.viewDir, abs).replace(/\\/g, "/");
    if (rel === "view.manifest.json") continue;
    const hashed = await hashFile(abs);
    entries.push({
      path: rel,
      kind: "file" as const,
      bytes: hashed.bytes,
      sha256: hashed.sha256,
      symlinkTarget: null,
    });
  }
  const report = entries.find((e) => e.path === "judge/evalJudge.yaml");
  // The remediation deliverable is optional (the remedy agent may have had no
  // confirmed findings to research), but when present it is sealed and surfaced
  // alongside the report so Phase 2 has the developer-facing improvement pack.
  const developerBrief = entries.find((e) => e.path === "judge/developer-brief.yaml");
  const manifest = {
    schemaVersion: 1,
    kind: "themis-archive-view",
    runId: input.runId,
    files: entries,
    totalBytes: entries.reduce((s, e) => s + e.bytes, 0),
    resealedAt: new Date().toISOString(),
    deliverables: {
      evalJudge: report?.sha256 ?? null,
      developerBrief: developerBrief?.sha256 ?? null,
    },
  };
  const manifestPath = join(input.viewDir, "view.manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result: JudgeResultVersion = {
    id: `jrv_${createHash("sha256").update(`${input.runId}:${report?.sha256 ?? ""}`).digest("hex").slice(0, 32)}`,
    runId: input.runId,
    trackId: input.trackId,
    reportSha256: report?.sha256 ?? "",
    reportPath: join(input.viewDir, "judge/evalJudge.yaml"),
    archiveViewPath: input.viewDir,
    publicationState: "published",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  };
  return { result, manifestPath };
}

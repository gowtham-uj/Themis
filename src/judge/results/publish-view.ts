/**
 * Phase-1 publication: seal the `judge/` tree back into the eval's own archive.
 *
 * An eval gets exactly one archive directory for its whole life. Phase 1 does
 * not copy it anywhere; it stages its output, then reseals that one directory
 * with `judge/` (the court record) and `phase1/` (how the judgement was
 * produced: deterministic node0-node3 artifacts plus `phase1/judge_traces/`)
 * added, every base path byte-identical.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { DbQueries } from "../../db/queries.js";
import { resealEvalArchive } from "../../runner/eval-archive.js";
import { copySanitizedPiTraceEntry, createReasoningContentStripper } from "../pi/sanitize-trace.js";
import type { JudgeResultVersion } from "./types.js";

/** Deterministic Phase-1 node directories, sealed as the provenance of the ruling. */
const NODE_DIRS = ["node0", "node1", "node2", "node3"];

/**
 * Stage the `phase1/` layer: the deterministic node0-node3 artifacts that fed
 * the courtroom, plus `phase1/judge_traces/` holding orchestrator and subagent
 * session logs. The court records themselves stay in `judge/`, so `judge` is
 * skipped here. Returns the staging dir, or null when there is nothing to seal.
 */
async function stagePhase1(
  workDir: string | undefined,
  traceDir: string | undefined,
  stagingRoot: string,
): Promise<string | null> {
  const dest = join(stagingRoot, "phase1");
  await mkdir(dest, { recursive: true });
  let staged = 0;

  if (workDir) {
    for (const node of NODE_DIRS) {
      const src = join(workDir, node);
      if (!(await readdir(src).catch(() => null))) continue;
      await cp(src, join(dest, node), { recursive: true, force: true });
      staged += 1;
    }
    const checkpoints = join(workDir, "checkpoints");
    if (await readdir(checkpoints).catch(() => null)) {
      await cp(checkpoints, join(dest, "checkpoints"), { recursive: true, force: true });
      staged += 1;
    }
  }

  const names = traceDir ? await readdir(traceDir).catch(() => null) : null;
  if (names) {
    const traces = join(dest, "judge_traces");
    await mkdir(traces, { recursive: true });
    for (const name of names) {
      if (name === "judge") continue;
      if (name === "pi-stdout.jsonl") {
        // Raw orchestrator event streams reach multiple GB. Session jsonl files
        // are the resume source and stay raw; this examination-only firehose is
        // compressed so the archive does not carry it verbatim.
        await pipeline(
          createReadStream(join(traceDir!, name)),
          createReasoningContentStripper(),
          createGzip({ level: 6 }),
          createWriteStream(join(traces, "pi-stdout.jsonl.gz")),
        );
        staged += 1;
        continue;
      }
      await copySanitizedPiTraceEntry(join(traceDir!, name), join(traces, name));
      staged += 1;
    }
  }

  return staged > 0 ? dest : null;
}

/** Reseal one eval's archive with its Phase-1 judgement layered in. */
export async function publishJudgeArchiveView(input: {
  runId: string;
  trackId: string;
  /** The eval's own sealed archive. Resealed in place, never copied. */
  baseArchiveDir: string;
  judgeDir: string;
  /**
   * PI orchestrator and subagent session logs for this case, sealed under
   * `phase1/judge_traces/` so the archive carries how the judgement was reached.
   */
  traceDir?: string;
  /**
   * The case work directory (`judge_work/case_<runId>`). Its deterministic
   * node0-node3 outputs and checkpoints seal under `phase1/`, so the evidence
   * the courtroom actually read is retained beside the ruling.
   */
  workDir?: string;
  queries?: DbQueries | null;
}): Promise<{ result: JudgeResultVersion; manifestPath: string }> {
  // A partial judge/ is recoverable, not fatal: resealEvalArchive completes an
  // already-sealed layer by adding only the files it lacks. What is worth
  // refusing is a seal with no court record at all, which would spend the
  // archive's one publication on the quality gate's own output.
  // The PI courtroom writes YAML, the gateway loop writes JSON, and the log
  // books are Markdown, so the record is identified by not being the gate's own
  // output rather than by extension.
  const judgeFiles = await readdir(input.judgeDir).catch(() => [] as string[]);
  if (!judgeFiles.some((n) => n !== "quality-report.json" && !n.startsWith("."))) {
    throw new Error(
      `refusing to seal judge/ for run ${input.runId}: no court record in ${input.judgeDir}` +
        ` (found ${judgeFiles.length ? judgeFiles.join(", ") : "nothing"}).` +
        " A later retry can still complete this layer once the courtroom writes one.",
    );
  }

  const stagingRoot = await mkdtemp(join(tmpdir(), "ae-reseal-"));
  try {
    const layers: { name: string; sourceDir: string }[] = [
      { name: "judge", sourceDir: input.judgeDir },
    ];
    if (input.traceDir || input.workDir) {
      const phase1 = await stagePhase1(input.workDir, input.traceDir, stagingRoot);
      if (phase1) layers.push({ name: "phase1", sourceDir: phase1 });
    }

    const { manifest } = await resealEvalArchive({
      runId: input.runId,
      archiveDir: input.baseArchiveDir,
      layers,
      queries: input.queries ?? null,
    });

    const report = manifest.files.find((f) => f.path === "judge/evalJudge.yaml");
    const result: JudgeResultVersion = {
      id: `jrv_${createHash("sha256").update(`${input.runId}:${report?.sha256 ?? ""}`).digest("hex").slice(0, 32)}`,
      runId: input.runId,
      trackId: input.trackId,
      reportSha256: report?.sha256 ?? "",
      reportPath: join(input.baseArchiveDir, "judge/evalJudge.yaml"),
      archiveViewPath: input.baseArchiveDir,
      publicationState: "published",
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    return { result, manifestPath: join(input.baseArchiveDir, manifest.manifestRel) };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Bundle one complete queue-run into a single self-contained archive:
 *
 *   queue-run-archive.tar.gz
 *     judge/            <- the judge agent's own artifacts (its logs + the report)
 *       pi-judge-events.jsonl   (judge model events/traces)
 *       pi-session.json         (judge PI session transcript)
 *       verdict.json
 *       report.html             (the judge report)
 *       judge-scratchpad.txt
 *       ... (anything else the analysis produced)
 *     evals/<runId>/    <- the sealed eval archives that were handed to the judge
 *
 * This gives an operator one file that contains every eval's logs/traces that the
 * judge saw, the judge's own reasoning/trace, and the resulting report.
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";

export interface QueueRunArchiveInput {
  /** Directory holding the judge analysis artifacts (queue-analyses/<id>). */
  analysisDir: string;
  /** Absolute paths to each sealed eval archive dir (projects/<proj>/evals/<runId>). */
  evalArchiveDirs: string[];
  /** Where to write the tarball (defaults to <analysisDir>/queue-run-archive.tar.gz). */
  outPath?: string;
}

/**
 * Bundle the judge analysis artifacts + all eval archives into one tarball.
 * Returns the written archive path + byte count. Safe to call once (idempotent
 * by path — over-writes if run again).
 */
export async function sealQueueRunArchive(input: QueueRunArchiveInput): Promise<{
  path: string;
  bytes: number;
}> {
  const outPath = input.outPath ?? join(input.analysisDir, "queue-run-archive.tar.gz");
  // Stage a flat tree: judge/ + evals/.
  const stage = join(input.analysisDir, ".queue-run-archive-stage");
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "judge"), { recursive: true });
  await mkdir(join(stage, "evals"), { recursive: true });

  // Copy the judge analysis artifacts (skip any prior stage/tarball).
  for (const name of await readdir(input.analysisDir)) {
    if (name === ".queue-run-archive-stage" || name === "queue-run-archive.tar.gz") continue;
    await cp(join(input.analysisDir, name), join(stage, "judge", name), {
      recursive: true,
      force: false,
    });
  }
  // Copy the eval archives.
  for (const dir of input.evalArchiveDirs) {
    const base = dir.split(/[\\/]/).pop()!; // <runId>
    const dest = join(stage, "evals", base);
    await cp(dir, dest, { recursive: true, force: false });
  }

  await tar.c({ gzip: true, file: outPath, cwd: stage }, ["judge", "evals"]);

  await rm(stage, { recursive: true, force: true });
  const bytes = (await stat(outPath).catch(() => ({ size: 0 }))).size ?? 0;
  return { path: outPath, bytes };
}

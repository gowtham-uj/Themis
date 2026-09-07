/** Seal a fixture directory as a base eval archive, without a DB registry. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryQueries } from "../../src/db/queries.ts";
import { sealEvalArchive } from "../../src/runner/eval-archive.ts";

/**
 * Seal `dir` so a reseal test starts from the same state the runner produces:
 * a hardened tree with `eval_lifecycle_logs/archive.json` inside it.
 */
export async function sealBaseArchive(dir: string, runId: string): Promise<void> {
  const queries = new MemoryQueries(await mkdtemp(join(tmpdir(), "ae-seal-q-")));
  await sealEvalArchive(queries, dir, {
    runId,
    projectId: "proj_fixture",
    queueId: null,
    batchId: "batch_fixture",
  });
}

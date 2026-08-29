/** One-time migration: legacy archive dirs -> local CAS + canonical manifests. */
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

import { openDb } from "../src/db/index.js";
import { ingestSealedArchive } from "../src/storage/archive-ingest.js";
import { createLocalArtifactStore } from "../src/storage/local-artifact-store.js";
import type { EvalArchiveManifest } from "../src/runner/eval-archive.js";

const DATA = "/work/agenteval/data";
const legacyRoot = join(DATA, "archives");
const keep = (await readdir(legacyRoot, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const kept = new Set(keep);
const opened = openDb(DATA);
const store = createLocalArtifactStore(join(DATA, "artifacts"));

for (const runId of keep) {
  const old = opened.queries.getEvalArchive(runId);
  // The project-owned sealed tree is the canonical source. The legacy central
  // copy can drift (observed: .git/index hash mismatch) and must never override
  // the sealed manifest. Fall back only for rows whose project tree is missing.
  const projectRoot = old
    ? join(DATA, "projects", old.projectId, "evals", runId)
    : join(DATA, "__missing__");
  const { access } = await import("node:fs/promises");
  const root = await access(projectRoot).then(() => projectRoot).catch(() => join(legacyRoot, runId));
  const legacy = JSON.parse(
    await readFile(join(root, "eval_lifecycle_logs", "archive.json"), "utf8"),
  ) as EvalArchiveManifest;
  const result = await ingestSealedArchive({ store, runId, rootDir: root, files: legacy.files });
  if (old) {
    opened.queries.storeEvalArchive({
      runId,
      projectId: old.projectId,
      queueId: old.queueId,
      batchId: old.batchId,
      manifestPath: old.manifestPath,
      manifestKey: result.manifestKey,
      manifestSha256: result.manifestSha256,
      sizeBytes: old.sizeBytes,
      sealedAt: old.sealedAt,
      archivedAt: old.archivedAt ?? old.sealedAt,
    });
  }
  console.log(runId, result.manifestKey, `${result.blobCount} blobs`);
}
opened.raw?.close();

// User-requested cleanup: metadata/catalog archive rows and per-project archive
// trees for runs that are no longer among the latest 10 kept archives. Runs/tasks
// metadata remains (historical queue identity), only retained archive bytes leave.
const db = new Database(join(DATA, "agenteval.db"));
const rows = db.prepare(`SELECT run_id,project_id FROM eval_archives`).all() as Array<{run_id:string;project_id:string}>;
for (const row of rows) {
  if (kept.has(row.run_id)) continue;
  db.prepare(`DELETE FROM eval_archives WHERE run_id=?`).run(row.run_id);
  await rm(join(DATA, "projects", row.project_id, "evals", row.run_id), { recursive: true, force: true });
  await rm(join(DATA, "projects", row.project_id, "runs", row.run_id), { recursive: true, force: true });
}
db.close();
console.log(`backfill complete: ${keep.length} canonical archives kept`);

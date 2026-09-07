/**
 * Phase-2 publication: seal the campaign's `phase2/` tree back into each
 * member eval's own archive. Like Phase 1, this reseals the one archive the
 * eval already has rather than copying it into a third directory.
 */

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DbQueries } from "../../db/queries.js";
import { resealEvalArchive } from "../../runner/eval-archive.js";

const REQUIRED_ARTIFACTS = [
  "campaign.yaml",
  "patterns.yaml",
  "developer-pack.yaml",
  "experiment-plans.yaml",
  "manifest.json",
  "executive-brief.yaml",
  "hypotheses.yaml",
  "developer-improvement-pack.zip",
];

export interface Phase2ViewResult {
  /** The eval's archive, now carrying phase2/. */
  viewDir: string;
  manifestPath: string;
  manifestSha256: string;
  files: number;
  bytes: number;
}

/** Reseal one member eval's archive with the campaign's phase2/ layer added. */
export async function publishPhase2ArchiveView(input: {
  runId: string;
  campaignId: string;
  /** The eval's archive. Already carries judge/ from Phase 1. */
  archiveDir: string;
  phase2ArtifactDir: string;
  queries?: DbQueries | null;
}): Promise<Phase2ViewResult> {
  for (const name of REQUIRED_ARTIFACTS) {
    const s = await stat(join(input.phase2ArtifactDir, name)).catch(() => null);
    if (!s?.isFile()) throw new Error(`missing required Phase2 artifact: ${name}`);
  }

  // Stage the layer so the archive is unsealed only once, with the exact tree
  // that will be sealed. `developer-pack.json` is the analyst's working copy of
  // developer-pack.yaml and is not part of the deliverable.
  const stagingRoot = await mkdtemp(join(tmpdir(), "ae-p2-"));
  const staged = join(stagingRoot, "phase2");
  await mkdir(staged, { recursive: true });
  try {
    for (const name of await readdir(input.phase2ArtifactDir)) {
      if (name === "developer-pack.json") continue;
      if (name.includes("/") || name === "." || name === "..") {
        throw new Error(`invalid Phase2 artifact path: ${name}`);
      }
      const src = join(input.phase2ArtifactDir, name);
      const s = await lstat(src);
      if (s.isDirectory()) {
        // Phase-2 orchestrator/subagent traces mirror Phase 1's layout:
        // phase2/judge_traces/ rather than a differently-named phase2/traces/.
        if (name !== "judge_traces") throw new Error(`unsupported Phase2 artifact kind: ${name}`);
        await cp(src, join(staged, name), { recursive: true, force: true });
        continue;
      }
      if (!s.isFile()) throw new Error(`unsupported Phase2 artifact kind: ${name}`);
      await cp(src, join(staged, name), { force: true });
    }

    const { manifest } = await resealEvalArchive({
      runId: input.runId,
      archiveDir: input.archiveDir,
      layers: [{ name: "phase2", sourceDir: staged }],
      queries: input.queries ?? null,
    });

    const manifestPath = join(input.archiveDir, manifest.manifestRel);
    return {
      viewDir: input.archiveDir,
      manifestPath,
      manifestSha256: createHash("sha256")
        .update(`${JSON.stringify(manifest, null, 2)}\n`)
        .digest("hex"),
      files: manifest.files.length,
      bytes: manifest.totalBytes,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

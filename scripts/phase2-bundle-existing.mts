/** Zip the already-produced quality-fixed Phase-2 artifacts and reseal them. */
import {cp, rm} from "node:fs/promises";
import {join} from "node:path";
import {bundleDeveloperPack} from "../src/judge/phase2/run-campaign.js";
import {publishPhase2ArchiveView} from "../src/judge/results/publish-phase2-view.js";

const DATA = "/work/agenteval/data";
const SRC = "p2c_rerun_mtf8qamv";
const CANONICAL = "p2c_ca54584b1d404080b9fd3eaf0e91e55a";
const RUNS = [
  "603b94d5-87ac-43dc-8774-1ededa1fcf3a",
  "a46918ac-1054-4e7e-9490-35799f3c2370",
];
const srcDir = join(DATA, "phase2_artifacts", SRC);
const {zipPath, sha256} = await bundleDeveloperPack(srcDir, SRC);
console.log("zip", zipPath);
console.log("sha256", sha256);

const destDir = join(DATA, "phase2_artifacts", CANONICAL);
await rm(destDir, { recursive: true, force: true });
await cp(srcDir, destDir, { recursive: true });
console.log("copied pack to canonical campaign", CANONICAL);

console.log("resealing final views");
for (const runId of RUNS) {
  const finalDir = join(DATA, "judge_final_views", runId);
  await rm(finalDir, { recursive: true, force: true });
  const r = await publishPhase2ArchiveView({
    runId,
    campaignId: CANONICAL,
    phase1ViewDir: join(DATA, "judge_views", runId),
    phase2ArtifactDir: destDir,
    viewDir: finalDir,
  });
  console.log("  ", runId.slice(0, 8), "files", r.files, "manifest", r.manifestSha256.slice(0, 16));
}
console.log("DONE");

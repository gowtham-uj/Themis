/** Recompute deterministic Phase-2 artifacts (no model) from the latest two Phase-1 views. */
import {readFile, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {parseAllDocuments, stringify} from "yaml";
import {loadPhase2Case} from "../src/judge/phase2/load-cases.js";
import {aggregatePatterns, extractObservations} from "../src/judge/phase2/patterns.js";
import {bundleDeveloperPack} from "../src/judge/phase2/run-campaign.js";
import {publishPhase2ArchiveView} from "../src/judge/results/publish-phase2-view.js";

const DATA = "/work/agenteval/data";
const CAM = "p2c_ca54584b1d404080b9fd3eaf0e91e55a";
const RUNS = [
  "603b94d5-87ac-43dc-8774-1ededa1fcf3a",
  "a46918ac-1054-4e7e-9490-35799f3c2370",
];
const outDir = join(DATA, "phase2_artifacts", CAM);
const cases = await Promise.all(RUNS.map((r) => loadPhase2Case(join(DATA, "judge_views", r))));
const observations = extractObservations(cases);
const patterns = aggregatePatterns(observations);
const packRaw = await readFile(join(outDir, "developer-pack.yaml"), "utf8");
const pack = parseAllDocuments(packRaw)[0]!.toJS() as Record<string, unknown>;
const recs = Array.isArray(pack.recommendations) ? pack.recommendations as Record<string, unknown>[] : [];
const patIds = new Set(patterns.map((p) => p.id));
const kept = recs.filter((r) => (r.patternIds as string[] | undefined)?.some((id) => patIds.has(id)));
pack.patterns = patterns;
pack.recommendations = kept;
pack.platformFailures = cases.filter((c) => !c.rewardAttributable).length;
pack.rewardNotAttributable = cases.filter((c) => !c.rewardAttributable).length;
pack.validAgentRuns = cases.filter((c) => c.validForAgentLearning).length;

const {runPhase2Campaign} = await import("../src/judge/phase2/run-campaign.js");
// Re-run campaign with a pass-through analyst (no model): keep surviving recs.
const tmp = join(DATA, "phase2_artifacts", `${CAM}-repack`);
await rm(tmp, { recursive: true, force: true });
const {pack: next} = await runPhase2Campaign({
  campaignId: CAM,
  projectId: "0f080440-57e2-4a65-aeec-c173b1a5b9de",
  sutFingerprint: String(pack.sutFingerprint ?? ""),
  viewDirs: RUNS.map((r) => join(DATA, "judge_views", r)),
  outputDir: tmp,
  analyst: { async recommend() { return kept as any; } },
});
await rm(outDir, { recursive: true, force: true });
const {cp} = await import("node:fs/promises");
await cp(tmp, outDir, { recursive: true });
console.log("patterns", next.patterns.map((p) => `${p.signature}:${p.owner}`));
console.log("recs", next.recommendations.map((r) => r.id));
console.log("platform", next.platformFindings.map((f) => f.id));
for (const runId of RUNS) {
  const finalDir = join(DATA, "judge_final_views", runId);
  await rm(finalDir, { recursive: true, force: true });
  const r = await publishPhase2ArchiveView({
    runId, campaignId: CAM,
    phase1ViewDir: join(DATA, "judge_views", runId),
    phase2ArtifactDir: outDir,
    viewDir: finalDir,
  });
  console.log("view", runId.slice(0, 8), r.files);
}
console.log("DONE");

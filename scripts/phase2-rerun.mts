/**
 * Live Phase-2 campaign using PI coding-agent subagents.
 */
import {createHash} from "node:crypto";
import {rm} from "node:fs/promises";
import {join} from "node:path";
import {loadGatewayConfig} from "../src/judge/gateway/config.js";
import {ModelGateway} from "../src/judge/gateway/client.js";
import {GatewayPhase2Analyst} from "../src/judge/phase2/analyst.js";
import {PiPhase2Board} from "../src/judge/phase2/phase2-pi.js";
import {runPhase2Campaign} from "../src/judge/phase2/run-campaign.js";
import {publishPhase2ArchiveView} from "../src/judge/results/publish-phase2-view.js";

const DATA = "/work/agenteval/data";
const RUNS = [
  "603b94d5-87ac-43dc-8774-1ededa1fcf3a",
  "a46918ac-1054-4e7e-9490-35799f3c2370",
];
const PROJECT = "0f080440-57e2-4a65-aeec-c173b1a5b9de";
const campaignId = "p2c_ca54584b1d404080b9fd3eaf0e91e55a";

const cfg = loadGatewayConfig();
const gateway = new ModelGateway(cfg);
const analyst = new GatewayPhase2Analyst(gateway, `phase2_${campaignId}`);
const board = new PiPhase2Board({
  baseUrl: cfg.baseUrl,
  apiKey: cfg.apiKey,
  model: cfg.model,
  reasoningEffort: cfg.reasoningEffort,
});
const outputDir = join(DATA, "phase2_artifacts", campaignId);
await rm(outputDir, { recursive: true, force: true });

console.log("PI Phase-2 campaign", campaignId, "model", cfg.model);
const { pack, developerPackZip, developerPackSha256 } = await runPhase2Campaign({
  campaignId,
  projectId: PROJECT,
  sutFingerprint: createHash("sha256").update(`pi:${RUNS.join(",")}`).digest("hex"),
  viewDirs: RUNS.map((r) => join(DATA, "judge_views", r)),
  outputDir,
  analyst,
  board,
});

console.log("validAgentRuns", pack.validAgentRuns);
console.log("platformFailures", pack.platformFailures);
console.log("patterns", pack.patterns.map((p) => p.signature));
console.log("hypotheses", pack.hypotheses.map((h) => h.id));
console.log("recs", pack.recommendations.map((r) => r.id));
console.log("review dropped", pack.review.dropped);
console.log("platform", pack.platformFindings.map((f) => f.id));
console.log("next", pack.executiveBrief.nextDeveloperAction);
console.log("zip", developerPackZip, developerPackSha256.slice(0, 16));

for (const runId of RUNS) {
  const finalDir = join(DATA, "judge_final_views", runId);
  await rm(finalDir, { recursive: true, force: true });
  const r = await publishPhase2ArchiveView({
    runId,
    campaignId,
    phase1ViewDir: join(DATA, "judge_views", runId),
    phase2ArtifactDir: outputDir,
    viewDir: finalDir,
  });
  console.log("view", runId.slice(0, 8), r.files);
}
console.log("DONE");

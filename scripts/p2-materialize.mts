import {cp, rm, mkdir, writeFile, readFile as fsReadFile} from "node:fs/promises";
import {join} from "node:path";
import {parseAllDocuments, stringify} from "yaml";
import {runPhase2Campaign} from "../src/judge/phase2/run-campaign.js";
import {coerceRecommendations, coerceReview} from "../src/judge/phase2/analyst.js";
import {publishPhase2ArchiveView} from "../src/judge/results/publish-phase2-view.js";

const { readFileSync: readFileSyncN } = await import("node:fs");
const SRC = "/tmp/ae-p2-pi-1dUHdA/node";
const DATA = new URL("../data/", import.meta.url).pathname;
const CAM = "p2c_ca54584b1d404080b9fd3eaf0e91e55a";
const PLAT = join(DATA, "platform", "phase2", CAM);
const RUNS = ["603b94d5-87ac-43dc-8774-1ededa1fcf3a","a46918ac-1054-4e7e-9490-35799f3c2370"];

// Copy PI trace tree into durable platform dir.
await rm(PLAT, {recursive: true, force: true});
await cp(SRC, PLAT, {recursive: true, force: true});
console.log("platform traces at", PLAT);

// Parse the filed YAML with the fixed normalizers.
function loadSync(path:string){const docs=parseAllDocuments(readFileSyncN(path, "utf8"));const m={};for(const d of docs){const v=d.toJS();if(v&&typeof v==="object")Object.assign(m,v)}return m}

const recDoc = loadSync(join(PLAT,"judge","phase2-recommendations.yaml"));
const revDoc = loadSync(join(PLAT,"judge","phase2-review.yaml"));
const recs = coerceRecommendations(recDoc.recommendations ?? recDoc);
const review = coerceReview(revDoc, recs.map(r=>r.id));
console.log("recs", recs.map(r=>`${r.id}[${r.priority}]`));
console.log("review kept", review.keptIds);

import {bundleDeveloperPack} from "../src/judge/phase2/run-campaign.js";
import {loadPhase2Case} from "../src/judge/phase2/load-cases.js";
import {extractObservations, aggregatePatterns} from "../src/judge/phase2/patterns.js";

const cases = await Promise.all(RUNS.map(r=>loadPhase2Case(join(DATA,"judge_views",r))));
const observations = extractObservations(cases);
const patterns = aggregatePatterns(observations);
const platformFindings = [];
const keep = new Set(review.keptIds);
const finalRecs = recs.filter(r=>keep.has(r.id)||keep.size===0);
const hypDoc = loadSync(join(PLAT,"judge","phase2-hypotheses.yaml"));
const resDoc = loadSync(join(PLAT,"judge","phase2-research.yaml"));
const hypotheses = Array.isArray(hypDoc.hypotheses)?hypDoc.hypotheses:[];
const research = Array.isArray(resDoc.notes)?resDoc.notes:[];

// Agent-facing patterns only; harness patterns go to the platform report.
const agentPatterns = patterns.filter(p=>p.owner==="agent"||p.owner==="mixed");
const platformPatterns = patterns.filter(p=>p.owner==="eval_harness");
const execBrief = {
  largestWeaknesses: agentPatterns.sort((a,b)=>b.frequency-a.frequency).slice(0,5).map(p=>({patternId:p.id,signature:p.signature,frequency:p.frequency,whyItMatters:p.summary.slice(0,200)})),
  nextDeveloperAction: finalRecs[0] ? `Implement ${finalRecs[0].id}.` : "No agent recommendation survived review.",
};
const outDir = join(DATA,"phase2_artifacts",CAM);
await rm(outDir,{recursive:true,force:true});
await mkdir(outDir,{recursive:true});

const put = async (name:string, value:unknown) => {
  const body = stringify(value,{lineWidth:0});
  await writeFile(join(outDir,name), body);
  return {path:name, bytes:Buffer.byteLength(body)};
};

const files = [];
files.push(await put("campaign.yaml", {schema_version:1,campaign_id:CAM,project_id:"0f080440-57e2-4a65-aeec-c173b1a5b9de",members:cases.map(c=>({run_id:c.runId,valid_for_agent_learning:c.validForAgentLearning,failure_owner:c.failureOwner,reward_attributable:c.rewardAttributable,reward:c.reward,cohort:c.cohort,task_name:c.taskName}))}));
files.push(await put("patterns.yaml", {schema_version:1,observations,patterns}));
files.push(await put("executive-brief.yaml", {schema_version:1, ...execBrief}));
files.push(await put("hypotheses.yaml", {schema_version:1,hypotheses,research}));
files.push(await put("experiment-plans.yaml", {schema_version:1,plans:finalRecs.map(r=>r.experimentPlan)}));
const platformFindingsDoc = {
  schema_version:1,
  findings:[
    {id:"PF-VERIFIER_CRASH",severity:"blocker",kind:"verifier_crash",runIds:RUNS,finding:"The verifier crashed before grading in 2 eval(s): exit 127 with empty stdout and every check 'error'. Reward is an infrastructure artifact.",evidence:RUNS.map(r=>`run ${r}: exit 127`),fixOwner:"eval package author / verifier image",fixSuggestion:"Bake python3 into the verifier image."},
    {id:"PF-EMPTY_WORKSPACE",severity:"blocker",kind:"empty_workspace",runIds:RUNS,finding:"Both evals were seeded empty (workspace.source=empty).",evidence:RUNS.map(r=>`run ${r}: workspace.source empty`),fixOwner:"platform setup",fixSuggestion:"Copy seed_repo into /workspace/task before agent start."},
  ],
  platform_failures:2,reward_not_attributable:2,
};
// Platform report is a SEPARATE file, written only when there is platform content.
const platformReport = {
  schema_version:1,campaign_id:CAM,platformFailures:2,rewardNotAttributable:2,
  findings: platformFindingsDoc.findings, patterns: platformPatterns,
  nextPlatformAction: platformFindingsDoc.findings[0]?.fixSuggestion ?? "no platform defects",
  generatedAt:new Date().toISOString(),
};
files.push(await put("platform-report.yaml", platformReport));
files.push(await put("rd-memory.yaml", {schema_version:1,rejectedRecommendationIds:review.dropped.map(d=>d.id),reasons:review.dropped.map(d=>d.reason)}));
// Agent pack carries agent content ONLY — no platform fields.
const pack = {
  schemaVersion:1,campaignId:CAM,projectId:"0f080440-57e2-4a65-aeec-c173b1a5b9de",
  sutFingerprint:cases.map(c=>c.runId).join(","),memberRunIds:RUNS,validAgentRuns:2,
  executiveBrief:execBrief,
  hypotheses,patterns:agentPatterns,recommendations:finalRecs,review,
  generatedAt:new Date().toISOString(),
};
files.push(await put("developer-pack.yaml", pack));
files.push(await put("manifest.json", {schema_version:1,campaign_id:CAM,files:files.filter(f=>f.path!=="platform-report.yaml"&&f.path!=="rd-memory.yaml")}));
const phase1JudgeDirs = Object.fromEntries(RUNS.map(r=>[r, join(DATA,"judge_views",r,"judge")]));
const bundle = await bundleDeveloperPack(outDir, CAM, phase1JudgeDirs);
console.log("zip", bundle.zipPath, bundle.sha256.slice(0,16));

import {copyPhase2Traces} from "../src/judge/phase2/phase2-pi.js";
await copyPhase2Traces(PLAT, join(outDir, "traces"));

for (const runId of RUNS) {
  const finalDir = join(DATA,"judge_final_views",runId);
  await rm(finalDir,{recursive:true,force:true});
  const r = await publishPhase2ArchiveView({runId,campaignId:CAM,phase1ViewDir:join(DATA,"judge_views",runId),phase2ArtifactDir:outDir,viewDir:finalDir});
  console.log("view",runId.slice(0,8),r.files);
}
console.log("MATERIALIZED");

import { rm } from "node:fs/promises";
import { publishJudgeArchiveView } from "../src/judge/results/publish-view.js";
const [runId, jobId] = process.argv.slice(2);
const root="/work/agenteval/data";
const viewDir=`${root}/judge_views/${runId}`;
const work=`${root}/judge_work/${jobId}`;
await rm(viewDir,{recursive:true,force:true});
const out=await publishJudgeArchiveView({runId,trackId:"durable-two-eval-e2e",baseArchiveDir:`${root}/archives/${runId}`,judgeDir:`${work}/node4/judge`,traceDir:`${work}/node4`,viewDir});
console.log(out);

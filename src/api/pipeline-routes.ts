/** Unified per-project pipeline HTTP API (eval → Phase1 → Phase2). */
import {constants as fsConstants} from "node:fs";
import {lstat, open} from "node:fs/promises";
import Database from "better-sqlite3";import {join} from "node:path";import {createSqlitePhase2Db} from "../db/phase2/sqlite-store.js";import {advanceProjectPipeline,type ProjectPipelineServices} from "../pipeline/project-pipeline.js";import {Phase1Service} from "../judge/phase1-service.js";import {GatewayPhase2Analyst} from "../judge/phase2/analyst.js";import {PiPhase2Board} from "../judge/phase2/phase2-pi.js";import {runPhase2Campaign} from "../judge/phase2/run-campaign.js";import {publishPhase2ArchiveView} from "../judge/results/publish-phase2-view.js";import {ModelGateway} from "../judge/gateway/client.js";import {loadGatewayConfig} from "../judge/gateway/config.js";import {startQueueContainer} from "../runner/queue-worker.js";import {badRequest,notFound} from "./errors.js";import {readJsonBody,sendJson,type Router} from "./router.js";import {createLiveQueueContainersMap} from "../runner/queue-worker.js";import {archiveStoreDir} from "../runner/archive-store.js";
type App={dataDir:string;queries:import("../db/queries.js").QueryStore};
function appOf(ctx:{app:unknown}):App{return ctx.app as App}
function openPhase2Db(dataDir:string){return createSqlitePhase2Db(new Database(join(dataDir,"themis.sqlite")))}
function archiveDirFor(app:App,runId:string):string{const row=app.queries.getEvalArchive(runId);const legacy=archiveStoreDir(app.dataDir,runId);return row?join(app.dataDir,"projects",row.projectId,"evals",runId):legacy}
function makeServices(app:App,phase1:Phase1Service):ProjectPipelineServices{const live=createLiveQueueContainersMap();return{async startEvalQueue(generation){const cfg=JSON.parse(generation.configJson||"{}") as {evalQueueId?:string};const queueId=cfg.evalQueueId;if(!queueId)throw new Error("generation config missing evalQueueId");if(live.get(queueId)||app.queries.getActiveQueueContainer(queueId))return{started:false};try{await startQueueContainer(app.dataDir,app.queries,queueId,live,{});return{started:true}}catch(e){if((e as {code?:string})?.code==="ALREADY_ACTIVE")return{started:false};throw e}},async pollEvalItem(item,generation){const cfg=JSON.parse(generation.configJson||"{}") as {evalQueueId?:string};const queueId=cfg.evalQueueId;if(!queueId)throw new Error("generation config missing evalQueueId");const queueItems=app.queries.listEvalQueueItems(queueId).filter(x=>x.enabled);const qi=queueItems.find(x=>x.taskId===item.evalId);if(!qi)return{state:"failed",error:`eval queue item not found for ${item.evalId}`};const projectId=app.queries.getEvalQueue(queueId)?.projectId;const runs=projectId?app.queries.listRuns({projectId}).filter(r=>r.queueItemId===qi.id):[];const run=runs.at(-1);if(!run)return{state:"running"};if(run.status==="failed"||run.error)return{state:"failed",runId:run.id,error:run.error??"eval run failed"};if(run.status==="completed"||run.status==="done"){const row=app.queries.getEvalArchive(run.id);return row?{state:"completed",runId:run.id,archiveId:row.runId}:{state:"running",runId:run.id}}return{state:"running",runId:run.id}},async startPhase1(item){if(!item.runId)throw new Error(`item ${item.id} missing runId`);const r=await phase1.start({runId:item.runId,archiveDir:archiveDirFor(app,item.runId)});return{operationId:r.operationId}},async getPhase1Status(runId){const s=await phase1.status(runId);if(s.state==="not_started")return{state:"not_started"};if(s.state==="failed")return{state:"failed",error:s.error};return{state:s.state,resultVersionId:s.resultVersionId,archiveViewId:s.archiveViewId}},async runPhase2(campaign,members){const gateway=ModelGateway.fromEnv();const analyst=new GatewayPhase2Analyst(gateway,`phase2_${campaign.id}`);const cfg=loadGatewayConfig();const board=new PiPhase2Board({baseUrl:cfg.baseUrl,apiKey:cfg.apiKey,model:cfg.model,reasoningEffort:cfg.reasoningEffort});const viewDirs=members.map(m=>join(app.dataDir,"judge_views",m.runId));const out=await runPhase2Campaign({campaignId:campaign.id,projectId:campaign.projectId,sutFingerprint:campaign.sutFingerprint,viewDirs,outputDir:join(app.dataDir,"phase2_artifacts",campaign.id),analyst,board});return{developerPackSha256:out.developerPackSha256,developerPackZip:out.developerPackZip,artifactDir:out.artifactDir}},async publishFinalView({campaign,member,phase2ArtifactDir}){const r=await publishPhase2ArchiveView({runId:member.runId,campaignId:campaign.id,phase1ViewDir:join(app.dataDir,"judge_views",member.runId),phase2ArtifactDir,viewDir:join(app.dataDir,"judge_final_views",member.runId)});return{finalArchiveViewId:r.manifestSha256,manifestSha256:r.manifestSha256}}}}
export function registerPipelineRoutes(router:Router,phase1:Phase1Service):void{
 router.post("/api/projects/:id/pipeline",async(req,res,ctx)=>{const app=appOf(ctx);const projectId=ctx.params.id!;app.queries.getProject(projectId);const body=await readJsonBody<{name?:string;eval_queue_id?:string;auto_phase2?:boolean}>(req);if(typeof body.eval_queue_id!=="string")throw badRequest("eval_queue_id is required");const db=openPhase2Db(app.dataDir);try{const q=await db.pipeline.createQueue({projectId,evalQueueId:body.eval_queue_id,name:body.name??"pipeline",autoPhase2:body.auto_phase2??true});sendJson(res,201,q)}finally{await db.close()}});
 router.post("/api/projects/:id/pipeline/generation",async(req,res,ctx)=>{const app=appOf(ctx);const projectId=ctx.params.id!;const db=openPhase2Db(app.dataDir);try{const q=await db.pipeline.getQueueByProject(projectId);if(!q)throw notFound("pipeline queue not found");const evalQueue=app.queries.getEvalQueue(q.evalQueueId);if(!evalQueue)throw notFound("linked eval queue not found");const items=app.queries.listEvalQueueItems(evalQueue.id).filter(x=>x.enabled);const g=await db.pipeline.createGeneration({queueId:q.id,configJson:JSON.stringify({evalQueueId:evalQueue.id,projectId})});for(let i=0;i<items.length;i++){const t=items[i];if(t)await db.pipeline.addItem({generationId:g.id,evalId:t.taskId,ordinal:i+1})}sendJson(res,201,g)}finally{await db.close()}});
 router.post("/api/projects/:id/pipeline/generation/:generationId/advance",async(req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const body=await readJsonBody<{trigger?:string}>(req);const r=await advanceProjectPipeline({db,services:makeServices(app,phase1),generationId:ctx.params.generationId!,trigger:(body.trigger as "auto"|"eval"|"phase1"|"phase2"|"finalize")??"auto"});sendJson(res,200,{generation:r.generation,items:r.items,waitingFor:r.waitingFor})}finally{await db.close()}});
 router.post("/api/projects/:id/runs/:runId/phase1/pause",async(_req,res,ctx)=>{
  const app=appOf(ctx);const runId=ctx.params.runId!;
  const {pausePiWorkDir}=await import("../judge/pi/runtime.js");
  let out=await pausePiWorkDir(join(app.dataDir,"judge_work",`case_${runId}`,"node4"));
  if(!out.killed)out=await pausePiWorkDir(join(app.dataDir,"judge_work",runId));
  sendJson(res,200,{paused:out.killed,pid:out.pid,run_id:runId,resume:"POST /api/judge/runs/:runId/phase1"});
 });
 router.get("/api/projects/:id/pipeline/generation/:generationId",async(_req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const g=await db.pipeline.getGeneration(ctx.params.generationId!);if(!g)throw notFound("generation not found");const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:1000})).items;const campaign=await db.phase2.getCampaignByGeneration(g.id);sendJson(res,200,{generation:g,items,campaign})}finally{await db.close()}});
 router.get("/api/projects/:id/pipeline/campaign/:campaignId",async(_req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const c=await db.phase2.getCampaign(ctx.params.campaignId!);if(!c)throw notFound("campaign not found");const records=(await db.phase2.listRecords(c.id,null,{cursor:null,limit:1000})).items;const {getPhase2PiStatus}=await import("../judge/phase2/control.js");const pi=await getPhase2PiStatus(app.dataDir,c.id);sendJson(res,200,{campaign:c,records,pi})}finally{await db.close()}});
 router.get("/api/projects/:id/pipeline/campaign/:campaignId/status",async(_req,res,ctx)=>{const app=appOf(ctx);const campaignId=ctx.params.campaignId!;if(!/^[A-Za-z0-9._-]+$/.test(campaignId))throw badRequest("invalid campaign id");const {getPhase2PiStatus}=await import("../judge/phase2/control.js");sendJson(res,200,await getPhase2PiStatus(app.dataDir,campaignId))});
 router.post("/api/projects/:id/pipeline/campaign/:campaignId/pause",async(_req,res,ctx)=>{
  const app=appOf(ctx);const campaignId=ctx.params.campaignId!;
  if(!/^[A-Za-z0-9._-]+$/.test(campaignId))throw badRequest("invalid campaign id");
  const {pausePhase2Pi,getPhase2PiStatus}=await import("../judge/phase2/control.js");
  const r=await pausePhase2Pi(app.dataDir,campaignId);
  sendJson(res,200,{paused:r.killed,pid:r.pid,status:await getPhase2PiStatus(app.dataDir,campaignId)});
 });
 router.post("/api/projects/:id/pipeline/campaign/:campaignId/resume",async(_req,res,ctx)=>{
  const app=appOf(ctx);const campaignId=ctx.params.campaignId!;
  if(!/^[A-Za-z0-9._-]+$/.test(campaignId))throw badRequest("invalid campaign id");
  const db=openPhase2Db(app.dataDir);
  try{
    const c=await db.phase2.getCampaign(campaignId);if(!c)throw notFound("campaign not found");
    const {resumePhase2Pi,getPhase2PiStatus}=await import("../judge/phase2/control.js");
    const {loadGatewayConfig}=await import("../judge/gateway/config.js");
    const cfg=loadGatewayConfig();
    const r=await resumePhase2Pi({dataDir:app.dataDir,campaignId,projectId:c.projectId,connection:{baseUrl:cfg.baseUrl,apiKey:cfg.apiKey,model:cfg.model,reasoningEffort:cfg.reasoningEffort}});
    sendJson(res,202,{...r,status:await getPhase2PiStatus(app.dataDir,campaignId)});
  }finally{await db.close()}
 });
 router.get("/api/projects/:id/pipeline/campaign/:campaignId/pack",async(_req,res,ctx)=>{
  const app=appOf(ctx);
  const campaignId=ctx.params.campaignId!;
  if(!/^[A-Za-z0-9._-]+$/.test(campaignId))throw badRequest("invalid campaign id");
  // Always serve from the campaign's own artifact dir — never follow a stored host path.
  const zipPath=join(app.dataDir,"phase2_artifacts",campaignId,"developer-improvement-pack.zip");
  let md;try{md=await lstat(zipPath)}catch{throw notFound("developer pack not found (Phase 2 may not have run)")}
  if(md.isSymbolicLink()||!md.isFile())throw notFound("developer pack zip is not a regular file");
  res.statusCode=200;
  res.setHeader("Content-Type","application/zip");
  res.setHeader("Content-Length",md.size);
  res.setHeader("Content-Disposition",`attachment; filename="developer-improvement-pack-${campaignId}.zip"`);
  res.setHeader("X-Content-Type-Options","nosniff");
  const fh=await open(zipPath,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
  await new Promise<void>((resolveStream,reject)=>{
    const stream=fh.createReadStream({autoClose:true});
    const fail=(e:Error)=>{void fh.close().catch(()=>undefined);reject(e)};
    stream.on("error",fail);
    res.on("close",()=>{if(!stream.destroyed)stream.destroy()});
    stream.on("end",resolveStream);
    stream.pipe(res);
  });
 });
}

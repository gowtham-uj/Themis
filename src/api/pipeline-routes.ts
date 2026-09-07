/** Unified per-project pipeline HTTP API (eval → Phase1 → Phase2). */
import {constants as fsConstants} from "node:fs";
import {lstat, open} from "node:fs/promises";
import Database from "better-sqlite3";import {join} from "node:path";import {createSqlitePhase2Db} from "../db/phase2/sqlite-store.js";import {advanceProjectPipeline,retryFailedEval,retryFailedPhase1,type ProjectPipelineServices} from "../pipeline/project-pipeline.js";import {startPipelineTicker} from "../pipeline/ticker.js";import {stageProgress} from "../pipeline/stage-progress.js";import {runActivity} from "../pipeline/run-activity.js";import {Phase1Service} from "../judge/phase1-service.js";import {GatewayPhase2Analyst} from "../judge/phase2/analyst.js";import {PiPhase2Board} from "../judge/phase2/phase2-pi.js";import {runPhase2Campaign} from "../judge/phase2/run-campaign.js";import {publishPhase2ArchiveView} from "../judge/results/publish-phase2-view.js";import {ModelGateway} from "../judge/gateway/client.js";import {piConnectionFor} from "../judge/pi/runtime.js";import {projectStoredModelConfig} from "../config/model-config.js";import {createLiveQueueContainersMap,startQueueContainer} from "../runner/queue-worker.js";import {badRequest,conflict,notFound} from "./errors.js";import {blockingReason,projectReadiness} from "./readiness.js";import {readJsonBody,sendJson,type Router} from "./router.js";import {archiveStoreDir} from "../runner/archive-store.js";
type App={dataDir:string;queries:import("../db/queries.js").QueryStore;liveQueueContainers:ReturnType<typeof createLiveQueueContainersMap>};
function appOf(ctx:{app:unknown}):App{return ctx.app as App}
function openPhase2Db(dataDir:string){return createSqlitePhase2Db(new Database(join(dataDir,"themis.sqlite")))}
/** A run's project-level model overrides, or null when the project sets none. */
function projectModelConfigFor(app:App,runId:string){const pid=app.queries.getEvalArchive(runId)?.projectId;return pid?projectStoredModelConfig(app.queries.getProject(pid)?.modelConfig):null}
function archiveDirFor(app:App,runId:string):string{const row=app.queries.getEvalArchive(runId);const legacy=archiveStoreDir(app.dataDir,runId);return row?join(app.dataDir,"projects",row.projectId,"evals",runId):legacy}
function makeServices(app:App,phase1:Phase1Service):ProjectPipelineServices{const live=app.liveQueueContainers;return{async startEvalQueue(generation){const cfg=JSON.parse(generation.configJson||"{}") as {evalQueueId?:string};const queueId=cfg.evalQueueId;if(!queueId)throw new Error("generation config missing evalQueueId");if(live.get(queueId)||app.queries.getActiveQueueContainer(queueId))return{started:false};try{await startQueueContainer(app.dataDir,app.queries,queueId,live,{});return{started:true}}catch(e){if((e as {code?:string})?.code==="ALREADY_ACTIVE")return{started:false};throw e}},async pollEvalItem(item,generation){const cfg=JSON.parse(generation.configJson||"{}") as {evalQueueId?:string};const queueId=cfg.evalQueueId;if(!queueId)throw new Error("generation config missing evalQueueId");const queueItems=app.queries.listEvalQueueItems(queueId).filter(x=>x.enabled);const qi=queueItems.find(x=>x.taskId===item.evalId);if(!qi)return{state:"failed",error:`eval queue item not found for ${item.evalId}`};const projectId=app.queries.getEvalQueue(queueId)?.projectId;const active=app.queries.getActiveQueueContainer(queueId);const created=generation.createdAt;const runs=projectId?app.queries.listRuns({projectId}).filter(r=>r.queueItemId===qi.id):[];const run=item.runId?runs.find(r=>r.id===item.runId):active?runs.filter(r=>r.batchId===active.batchId).at(-1):runs.filter(r=>{const t=r.startedAt??r.endedAt??"";return t>=created}).at(-1);if(!run)return{state:"running"};if(run.status==="failed"||run.error)return{state:"failed",runId:run.id,error:run.error??"eval run failed"};if(run.status==="completed"||run.status==="done"){const row=app.queries.getEvalArchive(run.id);return row?{state:"completed",runId:run.id,archiveId:row.runId}:{state:"running",runId:run.id}}return{state:"running",runId:run.id}},async startPhase1(item){if(!item.runId)throw new Error(`item ${item.id} missing runId`);const r=await phase1.start({runId:item.runId,archiveDir:archiveDirFor(app,item.runId),projectModelConfig:projectModelConfigFor(app,item.runId)});return{operationId:r.operationId}},async getPhase1Status(runId){const s=await phase1.status(runId);if(s.state==="not_started")return{state:"not_started"};if(s.state==="failed")return{state:"failed",error:s.error};return{state:s.state,resultVersionId:s.resultVersionId,archiveViewId:s.archiveViewId}},async runPhase2(campaign,members){const p2cfg=projectStoredModelConfig(app.queries.getProject(campaign.projectId)?.modelConfig);const gateway=ModelGateway.fromEnv(process.env,undefined,"phase2",p2cfg);const analyst=new GatewayPhase2Analyst(gateway,`phase2_${campaign.id}`);const board=new PiPhase2Board(piConnectionFor("phase2",process.env,p2cfg),undefined,app.queries.getProject(campaign.projectId)?.promptConfig??null);const viewDirs=members.map(m=>archiveDirFor(app,m.runId));const out=await runPhase2Campaign({campaignId:campaign.id,projectId:campaign.projectId,sutFingerprint:campaign.sutFingerprint,viewDirs,outputDir:join(app.dataDir,"phase2_artifacts",campaign.id),analyst,board});return{developerPackSha256:out.developerPackSha256,developerPackZip:out.developerPackZip,artifactDir:out.artifactDir}},async publishFinalView({campaign,member,phase2ArtifactDir}){const r=await publishPhase2ArchiveView({runId:member.runId,campaignId:campaign.id,archiveDir:archiveDirFor(app,member.runId),phase2ArtifactDir,queries:app.queries});return{finalArchiveViewId:r.manifestSha256,manifestSha256:r.manifestSha256}}}}
/** Drive every project's current generation forward on a timer. Without this a
 *  started run sits in eval_running until someone POSTs /advance by hand. */
export function startProjectPipelines(app:App,phase1:Phase1Service,intervalMs?:number){
 let lastTickerError="";
 return startPipelineTicker({
  listProjectIds:()=>app.queries.listProjects().map(p=>p.id),
  openDb:()=>openPhase2Db(app.dataDir),
  services:makeServices(app,phase1),
  // Without this a coordinator failure is swallowed by the ticker and the run
  // just stops moving with nothing anywhere saying why. Repeats are collapsed
  // because a stuck generation throws the same error every 3 seconds.
  onError:(err)=>{
   const msg=err instanceof Error?`${err.message}\n${err.stack??""}`:String(err);
   if(msg===lastTickerError)return;
   lastTickerError=msg;
   console.error(`[pipeline] tick failed: ${msg}`);
  },
  ...(intervalMs!==undefined?{intervalMs}:{}),
 });
}

export function registerPipelineRoutes(router:Router,phase1:Phase1Service):void{
 router.post("/api/projects/:id/pipeline",async(req,res,ctx)=>{const app=appOf(ctx);const projectId=ctx.params.id!;app.queries.getProject(projectId);const body=await readJsonBody<{name?:string;eval_queue_id?:string;auto_phase2?:boolean}>(req);if(typeof body.eval_queue_id!=="string")throw badRequest("eval_queue_id is required");const db=openPhase2Db(app.dataDir);try{const q=await db.pipeline.createQueue({projectId,evalQueueId:body.eval_queue_id,name:body.name??"pipeline",autoPhase2:body.auto_phase2??true});sendJson(res,201,q)}finally{await db.close()}});
 /** Read the project's pipeline queue and its current generation. Creates the pipeline, linked to the project's one eval queue, on first read.
  *  Falls back to the newest generation once the current one is terminal:
  *  `getCurrentGeneration` excludes completed/failed/cancelled so the TICKER
  *  cannot re-advance a finished run, but reusing that here blanked the console's
  *  run panel the instant a run completed. A finished run stays on screen. */
 router.get("/api/projects/:id/pipeline",async(_req,res,ctx)=>{const app=appOf(ctx);const projectId=ctx.params.id!;const db=openPhase2Db(app.dataDir);try{let q=await db.pipeline.getQueueByProject(projectId);if(!q){const evalQueue=app.queries.listEvalQueues(projectId)[0];if(!evalQueue){sendJson(res,200,{queue:null,generation:null});return}q=await db.pipeline.createQueue({projectId,evalQueueId:evalQueue.id,name:"pipeline",autoEval:true,autoPhase1:true,autoPhase2:false})}const generation=await db.pipeline.getCurrentGeneration(q.id)??(await db.pipeline.listGenerations(q.id,{limit:1,cursor:null})).items[0]??null;sendJson(res,200,{queue:q,generation})}finally{await db.close()}});
 /** Edit the pipeline queue's status and per-phase automation flags. */
 router.patch("/api/projects/:id/pipeline",async(req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const q=await db.pipeline.getQueueByProject(ctx.params.id!);if(!q)throw notFound("pipeline queue not found");const body=await readJsonBody<{name?:string;status?:string;auto_eval?:boolean;auto_phase1?:boolean;auto_phase2?:boolean}>(req);const patch:{name?:string;status?:"running"|"paused"|"cancelled";autoEval?:boolean;autoPhase1?:boolean;autoPhase2?:boolean}={};if(typeof body.name==="string"&&body.name.trim())patch.name=body.name.trim();if(body.status!==undefined){if(body.status!=="running"&&body.status!=="paused"&&body.status!=="cancelled")throw badRequest("status must be running, paused, or cancelled");patch.status=body.status}if(typeof body.auto_eval==="boolean")patch.autoEval=body.auto_eval;const nextPhase1=typeof body.auto_phase1==="boolean"?body.auto_phase1:q.autoPhase1!==false;const nextPhase2=typeof body.auto_phase2==="boolean"?body.auto_phase2:q.autoPhase2===true;if(nextPhase2&&!nextPhase1)throw badRequest("looking across evals needs the per-eval judge; turn that on first");if(typeof body.auto_phase1==="boolean")patch.autoPhase1=body.auto_phase1;if(typeof body.auto_phase2==="boolean")patch.autoPhase2=body.auto_phase2;const updated=await db.pipeline.updateQueue(q.id,q.revision,patch);if(!updated)throw badRequest("pipeline queue changed concurrently; reload and retry");sendJson(res,200,updated)}finally{await db.close()}});
 router.post("/api/projects/:id/pipeline/generation",async(req,res,ctx)=>{const app=appOf(ctx);const projectId=ctx.params.id!;const db=openPhase2Db(app.dataDir);try{const blocked=blockingReason(projectReadiness(app.queries,projectId),"run");if(blocked)throw badRequest(blocked);const q=await db.pipeline.getQueueByProject(projectId);if(!q)throw notFound("pipeline queue not found");const evalQueue=app.queries.getEvalQueue(q.evalQueueId);if(!evalQueue)throw notFound("linked eval queue not found");const items=app.queries.listEvalQueueItems(evalQueue.id).filter(x=>x.enabled);for(const t of items){const need=t.claimedRepeats+1;if(t.repeats<need)app.queries.updateEvalQueueItem(t.id,{repeats:need});}const body=await readJsonBody<{name?:string}>(req).catch(()=>({} as {name?:string}));const name=typeof body.name==="string"&&body.name.trim()?body.name.trim().slice(0,120):null;const g=await db.pipeline.createGeneration({queueId:q.id,configJson:JSON.stringify({evalQueueId:evalQueue.id,projectId}),name});for(let i=0;i<items.length;i++){const t=items[i];if(t)await db.pipeline.addItem({generationId:g.id,evalId:t.taskId,ordinal:i+1})}sendJson(res,201,g)}finally{await db.close()}});
 router.post("/api/projects/:id/pipeline/generation/:generationId/advance",async(req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const body=await readJsonBody<{trigger?:string}>(req);const r=await advanceProjectPipeline({db,services:makeServices(app,phase1),generationId:ctx.params.generationId!,trigger:(body.trigger as "auto"|"eval"|"phase1"|"phase2"|"finalize")??"auto"});sendJson(res,200,{generation:r.generation,items:r.items,waitingFor:r.waitingFor})}finally{await db.close()}});
 // Operator retry: put Phase-1 items that exhausted their automatic retries back
 // in the queue. Their courtroom work is still on disk, so the resumed run picks
 // up the same PI session instead of judging from scratch.
 router.post("/api/projects/:id/pipeline/generation/:generationId/retry-phase1",async(_req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const r=await retryFailedPhase1({db,generationId:ctx.params.generationId!});const a=r.revived.length>0?await advanceProjectPipeline({db,services:makeServices(app,phase1),generationId:ctx.params.generationId!,trigger:"phase1"}):null;sendJson(res,200,{revived:r.revived.length,items:r.revived,generation:a?.generation??null,waitingFor:a?.waitingFor??null})}finally{await db.close()}});
 // Operator retry for one eval failure. It stays in this pipeline generation,
 // while the immutable failed agent run remains available for diagnosis.
 router.post("/api/projects/:id/pipeline/generation/:generationId/retry-eval",async(req,res,ctx)=>{
  const app=appOf(ctx);const generationId=ctx.params.generationId!;const projectId=ctx.params.id!;
  const body=await readJsonBody<{item_id?:string}>(req);
  if(typeof body.item_id!=="string"||body.item_id.length===0)throw badRequest("item_id is required");
  const db=openPhase2Db(app.dataDir);
  try{
   const gen=await db.pipeline.getGeneration(generationId);if(!gen)throw notFound("pipeline generation not found");
   const pipeline=await db.pipeline.getQueue(gen.queueId);if(!pipeline||pipeline.projectId!==projectId)throw notFound("pipeline generation not found");
   if(gen.state!=="failed")throw conflict(`pipeline generation must be failed before retrying an eval; current state is ${gen.state}`);
   const item=await db.pipeline.getItem(body.item_id);
   if(!item||item.generationId!==gen.id)throw notFound("pipeline item not found");
   if(item.state!=="failed"||item.errorKind!=="eval")throw conflict("pipeline item is not an eval-stage failure");
   const queueItems=app.queries.listEvalQueueItems(pipeline.evalQueueId).filter(x=>x.enabled);
   const queueItem=queueItems.find(x=>x.taskId===item.evalId);
   if(!queueItem)throw conflict(`enabled eval queue item not found for ${item.evalId}`);
   if(app.queries.getActiveQueueContainer(pipeline.evalQueueId))throw conflict("linked eval queue already has an active generation");
   const pending=queueItems.filter(x=>x.repeats>x.claimedRepeats);
   if(pending.length>0)throw conflict("linked eval queue has unclaimed work; drain or stop it before retrying one pipeline item");
   const priorRepeats=queueItem.repeats;
   app.queries.updateEvalQueueItem(queueItem.id,{repeats:queueItem.claimedRepeats+1});
   let r;
   try{r=await retryFailedEval({db,generationId,itemId:item.id})}
   catch(error){app.queries.updateEvalQueueItem(queueItem.id,{repeats:priorRepeats});throw error}
   if(r.revived.length===0){app.queries.updateEvalQueueItem(queueItem.id,{repeats:priorRepeats});throw conflict("pipeline item changed before the retry could be armed")}
   const a=await advanceProjectPipeline({db,services:makeServices(app,phase1),generationId,trigger:"eval"});
   sendJson(res,202,{revived:r.revived.length,items:r.revived,generation:a.generation,waitingFor:a.waitingFor});
  }finally{await db.close()}
 });
 router.post("/api/projects/:id/runs/:runId/phase1/pause",async(_req,res,ctx)=>{
  const app=appOf(ctx);const runId=ctx.params.runId!;
  // A run id that does not exist answered 200 with paused:false, which reads the
  // same as "the judge was already stopped". A typo must not look like a pause.
  if(!app.queries.getRun(runId))throw notFound("run not found");
  const {pausePiWorkDir}=await import("../judge/pi/runtime.js");
  let out=await pausePiWorkDir(join(app.dataDir,"judge_work",`case_${runId}`,"node4"));
  if(!out.killed)out=await pausePiWorkDir(join(app.dataDir,"judge_work",runId));
  sendJson(res,200,{paused:out.killed,pid:out.pid,run_id:runId,resume:"POST /api/judge/runs/:runId/phase1"});
 });
 /** Every run of this project's pipeline, newest first, for the project page. */
 router.get("/api/projects/:id/pipeline/runs",async(_req,res,ctx)=>{
  const app=appOf(ctx);const db=openPhase2Db(app.dataDir);
  try{
   const q=await db.pipeline.getQueueByProject(ctx.params.id!);
   if(!q){sendJson(res,200,{runs:[],total:0,active:0});return}
   const runs=(await db.pipeline.listGenerations(q.id,{cursor:null,limit:200})).items;
   const ACTIVE=new Set(["draft","ready","eval_running","phase1_running","phase2_ready","phase2_running","finalizing","waiting_retry","paused"]);
   const out=[];
   for(const g of runs){
    const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:1000})).items;
    out.push({...g,evals:items.length,archives:items.filter(i=>i.baseArchiveId).length,
     completedEvals:items.filter(i=>i.state!=="eval_pending"&&i.state!=="eval_running").length});
   }
   sendJson(res,200,{runs:out,total:out.length,active:out.filter(g=>ACTIVE.has(g.state)).length});
  }finally{await db.close()}
 });
 /** Rename one run. An empty name clears it back to the ordinal label. */
 router.patch("/api/projects/:id/pipeline/generation/:generationId",async(req,res,ctx)=>{
  const app=appOf(ctx);const db=openPhase2Db(app.dataDir);
  try{
   const body=await readJsonBody<{name?:string|null}>(req);
   if(body.name!==null&&typeof body.name!=="string")throw badRequest("name must be a string or null");
   const name=typeof body.name==="string"&&body.name.trim()?body.name.trim().slice(0,120):null;
   const g=await db.pipeline.renameGeneration(ctx.params.generationId!,name);
   if(!g)throw notFound("generation not found");
   sendJson(res,200,g);
  }finally{await db.close()}
 });
 router.get("/api/projects/:id/pipeline/generation/:generationId",async(_req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const g=await db.pipeline.getGeneration(ctx.params.generationId!);if(!g)throw notFound("generation not found");const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:1000})).items;const campaign=await db.phase2.getCampaignByGeneration(g.id);sendJson(res,200,{generation:g,items,campaign})}finally{await db.close()}});
 /** Per-stage progress for the run panel: eval counts, Phase-1 node progress
  *  per case, and the Phase-2 board plus which archives it resealed. */
 router.get("/api/projects/:id/pipeline/generation/:generationId/progress",async(_req,res,ctx)=>{
  const app=appOf(ctx);const db=openPhase2Db(app.dataDir);
  try{
   const g=await db.pipeline.getGeneration(ctx.params.generationId!);if(!g)throw notFound("generation not found");
   const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:1000})).items;
   const campaign=await db.phase2.getCampaignByGeneration(g.id);
   let members=0;let running=false;
   if(campaign){
    members=(await db.phase2.listMembers(campaign.id,{cursor:null,limit:1000})).items.length;
    const {getPhase2PiStatus}=await import("../judge/phase2/control.js");
    running=Boolean((await getPhase2PiStatus(app.dataDir,campaign.id)).running);
   }
   sendJson(res,200,await stageProgress({dataDir:app.dataDir,generation:g,items,campaign,campaignMembers:members,phase2Running:running}));
  }finally{await db.close()}
 });
 /** One ordered account of what the run is doing right now, across all three
  *  stages: eval seals, Phase-1 graph nodes, courtroom dispatches and filings,
  *  and the Phase-2 board. This is what the run panel tails. */
 router.get("/api/projects/:id/pipeline/generation/:generationId/activity",async(req,res,ctx)=>{
  const app=appOf(ctx);const db=openPhase2Db(app.dataDir);
  try{
   const g=await db.pipeline.getGeneration(ctx.params.generationId!);if(!g)throw notFound("generation not found");
   const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:1000})).items;
   const events=(await db.pipeline.listEvents(g.id,{cursor:null,limit:1000})).items;
   const campaign=await db.phase2.getCampaignByGeneration(g.id);
   const evalNames:Record<string,string>={};
   for(const it of items){const t=app.queries.getTask(it.evalId);if(t)evalNames[it.evalId]=t.name}
   const raw=new URL(req.url??"",`http://x`).searchParams.get("limit");
   const limit=raw&&Number.isFinite(Number(raw))?Math.min(1000,Math.max(1,Number(raw))):300;
   const entries=await runActivity({dataDir:app.dataDir,projectId:ctx.params.id!,items,events,campaignId:campaign?.id??null,evalNames,limit});
   sendJson(res,200,{entries,generationState:g.state});
  }finally{await db.close()}
 });
 router.get("/api/projects/:id/pipeline/campaign/:campaignId",async(_req,res,ctx)=>{const app=appOf(ctx);const db=openPhase2Db(app.dataDir);try{const c=await db.phase2.getCampaign(ctx.params.campaignId!);if(!c)throw notFound("campaign not found");const records=(await db.phase2.listRecords(c.id,null,{cursor:null,limit:1000})).items;const {getPhase2PiStatus}=await import("../judge/phase2/control.js");const pi=await getPhase2PiStatus(app.dataDir,c.id);sendJson(res,200,{campaign:c,records,pi})}finally{await db.close()}});
 router.get("/api/projects/:id/pipeline/campaign/:campaignId/status",async(_req,res,ctx)=>{const app=appOf(ctx);const campaignId=ctx.params.campaignId!;if(!/^[A-Za-z0-9._-]+$/.test(campaignId))throw badRequest("invalid campaign id");const {getPhase2PiStatus}=await import("../judge/phase2/control.js");sendJson(res,200,await getPhase2PiStatus(app.dataDir,campaignId))});
 router.post("/api/projects/:id/pipeline/campaign/:campaignId/pause",async(_req,res,ctx)=>{
  const app=appOf(ctx);const campaignId=ctx.params.campaignId!;
  if(!/^[A-Za-z0-9._-]+$/.test(campaignId))throw badRequest("invalid campaign id");
  const db=openPhase2Db(app.dataDir);
  try{
   // Pausing an id that was never a campaign used to answer 200 with paused:false,
   // which reads identically to "it was already stopped". A typo in a campaign id
   // must not look like a successful pause.
   if(!await db.phase2.getCampaign(campaignId))throw notFound("campaign not found");
  }finally{await db.close()}
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
    // A finished campaign has nothing to resume. Without this guard a resume on a
    // published campaign relaunched the whole board against an already-sealed
    // artifact set: real model spend, and a second run writing over the exact
    // documents the published archive views were built from.
    if(c.state==="published"||c.state==="cancelled"||c.state==="failed"){
     sendJson(res,409,{error:`campaign is ${c.state}; nothing to resume`,campaign:c,status:await getPhase2PiStatus(app.dataDir,campaignId)});
     return;
    }
    // Resuming must land on the same endpoint the campaign started on. A bare
    // loadGatewayConfig() defaulted to the phase1 stage, so a paused Phase-2
    // campaign silently migrated to the Phase-1 provider on resume; building
    // the connection by hand also dropped apiType.
    const project=app.queries.getProject(c.projectId);
    const r=await resumePhase2Pi({dataDir:app.dataDir,campaignId,projectId:c.projectId,connection:piConnectionFor("phase2",process.env,projectStoredModelConfig(project?.modelConfig)),promptOverrides:project?.promptConfig??null});
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

/** Reusable real Phase-1 service for HTTP routes and unified pipeline wiring. */
import Database from "better-sqlite3";import {mkdir} from "node:fs/promises";import {join} from "node:path";import {ModelGateway as Gateway,type ModelGateway} from "./gateway/client.js";import {runPhase1} from "./graph/graph.js";import {piConnectionFor} from "./pi/runtime.js";import type {StoredModelConfig} from "../config/model-config.js";import type {DbQueries} from "../db/queries.js";import {publishJudgeArchiveView} from "./results/publish-view.js";import {migrate} from "../db/sqlite/migrate.js";import {advanceCurrentPointer} from "../db/sqlite/pointers.js";import {listResultVersionsByRun,upsertResultVersion} from "../db/sqlite/results.js";
export type Phase1ServiceStatus={state:"not_started"|"running"|"paused"|"published"|"failed";resultVersionId?:string;archiveViewId?:string;error?:string};
/** Runs Phase1 asynchronously and persists the immutable result/view. */
export class Phase1Service{private running=new Map<string,Promise<void>>();private errors=new Map<string,string>();constructor(private dataDir:string,private gateway?:ModelGateway,private queries?:DbQueries|null){}
 /** Gateway for one case. An injected gateway wins; otherwise resolve the Phase-1 stage with this project's overrides layered on, so nodes 0-3 and the PI court use the same endpoint. */
 private gw(project?:StoredModelConfig|null){if(this.gateway)return this.gateway;return Gateway.fromEnv(process.env,undefined,"phase1",project)}
 async start(input:{runId:string;archiveDir:string;trackId?:string;projectModelConfig?:StoredModelConfig|null}):Promise<{operationId:string}>{const operationId=`phase1:${input.runId}:${input.trackId??"default"}`;const workDir=join(this.dataDir,"judge_work",`case_${input.runId}`);await mkdir(workDir,{recursive:true});
  // Resume may arrive while the current node is still finishing. Clear the
  // marker before the running check so that in-flight node can pass its next
  // boundary; returning first left every such case paused forever.
  const {clearGraphPause}=await import("./graph/checkpoint.js");await clearGraphPause(workDir);this.errors.delete(input.runId);if(this.running.has(input.runId))return{operationId};const task=(async()=>{const state=await runPhase1({caseId:`case_${input.runId}`,runId:input.runId,archiveDir:input.archiveDir,workDir,gateway:this.gw(input.projectModelConfig),attemptId:`att_${input.runId}_${Date.now()}`,pi:piConnectionFor("phase1",process.env,input.projectModelConfig)});const p=await publishJudgeArchiveView({runId:input.runId,trackId:input.trackId??"default",baseArchiveDir:input.archiveDir,judgeDir:join(workDir,"node4","judge"),traceDir:join(workDir,"node4"),workDir,queries:this.queries??null});const db=new Database(join(this.dataDir,"themis.sqlite"));try{migrate(db);const stored=upsertResultVersion(db,p.result);advanceCurrentPointer(db,{runId:input.runId,trackId:stored.trackId,resultVersionId:stored.id,archiveViewPath:stored.archiveViewPath??input.archiveDir,baseManifestSha256:stored.reportSha256,expectedResultVersionId:null})}finally{db.close()}})().catch(e=>{
   // An operator pause is not a failure. Recording it as one made a paused case
   // read "failed" in the console and let the pipeline retry it against its own
   // pause marker.
   if(e instanceof Error&&e.name==="GraphPaused")return;
   this.errors.set(input.runId,e instanceof Error?e.message:String(e))}).finally(()=>{if(this.running.get(input.runId)===task)this.running.delete(input.runId)});this.running.set(input.runId,task);return{operationId}}
 async status(runId:string):Promise<Phase1ServiceStatus>{if(this.running.has(runId))return{state:"running"};const err=this.errors.get(runId);if(err)return{state:"failed",error:err};
  // The pause marker is read from disk, not from process memory, so a restart
  // during a pause still reports `paused`. In memory it would come back
  // `not_started`, and the pipeline's worker-loss branch would relaunch the very
  // case an operator stopped.
  // The pipeline needs an opaque immutable identity, not the local directory used
  // to materialize that view. Returning archiveViewPath exposed absolute host
  // paths through the generation API and made persisted membership host-bound.
  const db=new Database(join(this.dataDir,"themis.sqlite"));let published:Phase1ServiceStatus|null=null;try{migrate(db);const rows=listResultVersionsByRun(db,runId);const r=rows.at(-1);if(r)published={state:"published",resultVersionId:r.id,archiveViewId:r.id}}finally{db.close()}
  // A published result wins over a standing marker: a pause can land after the
  // last node boundary, and reporting that finished case as paused would strand
  // a complete judgement the operator can never publish.
  if(published)return published;
  const {isGraphPaused}=await import("./graph/checkpoint.js");if(await isGraphPaused(join(this.dataDir,"judge_work",`case_${runId}`)))return{state:"paused"};return{state:"not_started"}}
 /** Pause the PI courtroom for this run. Session jsonl is kept for resume. */
 async pause(runId:string):Promise<{killed:boolean;pid:number|null;workDir:string}>{const {pausePiWorkDir}=await import("./pi/runtime.js");
  // Nodes 0-3 have no PI process to kill, so a pause there used to be a silent
  // no-op while the console reported the judge stopped. The marker halts the
  // graph at its next node boundary, on top of killing a live court.
  const {markGraphPaused}=await import("./graph/checkpoint.js");await markGraphPaused(join(this.dataDir,"judge_work",`case_${runId}`));
  const workDir=join(this.dataDir,"judge_work",`case_${runId}`,"node4");const r=await pausePiWorkDir(workDir);if(!r.killed){const alt=await pausePiWorkDir(join(this.dataDir,"judge_work",runId));return{...alt,workDir:join(this.dataDir,"judge_work",runId)}}return{...r,workDir}}
 /** Resume the same PI session (start() already --continues existing sessions). */
 async resume(input:{runId:string;archiveDir:string;trackId?:string;projectModelConfig?:StoredModelConfig|null}):Promise<{operationId:string}>{return this.start(input)}
}

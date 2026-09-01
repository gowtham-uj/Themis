/**
 * Durable per-project pipeline coordinator.
 *
 * One queue generation advances through real eval execution → Phase 1 per
 * sealed eval → black-box advisory Phase 2 → final immutable archive views.
 * Database rows are the authority; process memory is only a call-local cache.
 */
import {createHash} from "node:crypto";
import type {
  Phase2CampaignMemberRow, Phase2CampaignRow, Phase2Db, PipelineGenerationRow,
  PipelineItemRow, PipelineItemState,
} from "../db/phase2/contracts.js";

export type PipelineTrigger="auto"|"eval"|"phase1"|"phase2"|"finalize";
export interface EvalQueueStartResult{started:boolean}
export interface EvalItemStatus{state:"running"|"completed"|"failed";runId?:string;archiveId?:string;error?:string}
export interface Phase1StartResult{operationId:string}
/** `not_started` means no in-flight run AND no published result — i.e. the worker
 *  that owned this Phase-1 run was lost (crash/restart) and must be re-launched
 *  so its persisted PI session can be resumed. */
export interface Phase1Status{state:"running"|"published"|"failed"|"not_started";resultVersionId?:string;archiveViewId?:string;error?:string}
export interface Phase2RunResult{developerPackSha256:string;developerPackZip:string;artifactDir:string}
export interface FinalViewResult{finalArchiveViewId:string;manifestSha256:string}

/** Real-system seams; server wiring supplies queue/worker/analysis/publisher implementations. */
export interface ProjectPipelineServices{
 /** Ensure the linked eval queue container is running (idempotent). The eval queue
  *  itself owns sequential execution; the pipeline polls item→run mapping. */
 startEvalQueue(generation:PipelineGenerationRow):Promise<EvalQueueStartResult>;
 /** Map one pipeline item to its eval-queue run status and sealed archive. */
 pollEvalItem(item:PipelineItemRow,generation:PipelineGenerationRow):Promise<EvalItemStatus>;
 startPhase1(item:PipelineItemRow,generation:PipelineGenerationRow):Promise<Phase1StartResult>;
 getPhase1Status(runId:string):Promise<Phase1Status>;
 runPhase2(campaign:Phase2CampaignRow,members:readonly Phase2CampaignMemberRow[]):Promise<Phase2RunResult>;
 publishFinalView(input:{campaign:Phase2CampaignRow;member:Phase2CampaignMemberRow;phase2ArtifactDir:string}):Promise<FinalViewResult>;
}

export interface AdvanceResult{generation:PipelineGenerationRow;items:readonly PipelineItemRow[];changed:boolean;waitingFor:string|null}
const PAGE={cursor:null,limit:1000} as const;
/** Bounded retries for a transient Phase-1 failure (e.g. the PI courtroom hit
 *  its context ceiling and ended without evalJudge.yaml). A manual or automatic
 *  re-advance resumes the SAME PI session via the worker's checkpoint recovery. */
const MAX_PHASE1_RETRIES=2;

function shaMembers(items:readonly PipelineItemRow[]):string{return createHash("sha256").update(JSON.stringify(items.map(x=>[x.id,x.runId,x.phase1ResultVersionId,x.phase1ArchiveViewId,x.ordinal]))).digest("hex")}
function isAllowed(trigger:PipelineTrigger,auto:boolean):boolean{return trigger==="auto"?auto:true}

/** Advance a generation by one bounded coordinator tick. */
export async function advanceProjectPipeline(input:{db:Phase2Db;services:ProjectPipelineServices;generationId:string;trigger?:PipelineTrigger}):Promise<AdvanceResult>{
 const trigger=input.trigger??"auto";let gen=await input.db.pipeline.getGeneration(input.generationId);if(!gen)throw new Error(`pipeline generation not found: ${input.generationId}`);
 const queue=await input.db.pipeline.getQueue(gen.queueId);if(!queue)throw new Error(`pipeline queue not found: ${gen.queueId}`);
 let items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];let changed=false;
 if(queue.status==="paused"||gen.state==="paused")return{generation:gen,items,changed:false,waitingFor:"resume"};
 if(["completed","failed","cancelled"].includes(gen.state))return{generation:gen,items,changed:false,waitingFor:null};
 const transition=async(next:PipelineGenerationRow["state"])=>{const n=await input.db.pipeline.transitionGeneration(gen!.id,gen!.state,gen!.fencingToken,next);if(!n)throw new Error(`generation fenced during ${gen!.state}->${next}`);gen=n;changed=true};
 if(gen.state==="draft"){await transition("ready");}
 if(gen.state==="ready")await transition("eval_running");

 // Eval stage: ensure the linked eval queue container is running once, then poll
 // each item's run-to-archive status. The eval queue owns sequential execution.
 if(items.some(x=>x.state==="eval_pending"||x.state==="eval_running")){
  if(isAllowed(trigger,queue.autoEval)&&(trigger==="auto"||trigger==="eval")){await input.services.startEvalQueue(gen);}
  for(const item of items.filter(x=>x.state==="eval_pending"||x.state==="eval_running")){
   const s=await input.services.pollEvalItem(item,gen);
   if(s.runId&&s.runId!==item.runId){await input.db.pipeline.updateItem(item.id,item.state,{runId:s.runId});if(item.state==="eval_pending"){await input.db.pipeline.updateItem(item.id,"eval_pending",{state:"eval_running"});}changed=true;}
   const fresh=(await input.db.pipeline.getItem(item.id))!;
   if(s.state==="completed"&&s.archiveId&&fresh.state==="eval_running"){
    await input.db.pipeline.updateItem(fresh.id,"eval_running",{state:"archive_sealed",baseArchiveId:s.archiveId});
    await input.db.pipeline.appendEvent({generationId:gen.id,itemId:fresh.id,operationId:`archive.sealed:${fresh.id}:${s.archiveId}`,eventType:"archive.sealed",payloadJson:JSON.stringify({runId:s.runId,archiveId:s.archiveId})});changed=true;
   } else if(s.state==="failed"&&fresh.state!=="failed"){
    await input.db.pipeline.updateItem(fresh.id,fresh.state,{state:"failed",errorKind:"eval",errorDetail:s.error??"eval failed"});changed=true;
   }
  }
  items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
  if(items.some(x=>x.state==="eval_pending"||x.state==="eval_running"))return{generation:gen,items,changed,waitingFor:"eval"};
 }
 items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
 // Archive seal makes an item Phase1-eligible.
 for(const item of items.filter(x=>x.state==="archive_sealed")){await input.db.pipeline.updateItem(item.id,"archive_sealed",{state:"phase1_pending"});changed=true}
 items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
 // Poll all running Phase1 jobs (worker concurrency is independent of eval sequentiality).
 for(const item of items.filter(x=>x.state==="phase1_running"&&x.runId)){
  const s=await input.services.getPhase1Status(item.runId!);
  if(s.state==="published"){
   if(!s.resultVersionId||!s.archiveViewId)throw new Error(`published Phase1 ${item.runId} missing ids`);
   await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"phase1_published",phase1ResultVersionId:s.resultVersionId,phase1ArchiveViewId:s.archiveViewId});
   await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.published:${item.id}:${s.resultVersionId}`,eventType:"phase1.result_published",payloadJson:JSON.stringify(s)});changed=true;
  }else if(s.state==="failed"){
   const n=item.retryCount+1;
   if(n<=MAX_PHASE1_RETRIES){
    await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"phase1_pending",errorKind:"phase1",errorDetail:s.error??"Phase1 failed",retryCount:n});
    await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.retry:${item.id}:${n}`,eventType:"phase1.retry",payloadJson:JSON.stringify({error:s.error,retryCount:n})});changed=true;
   }else{
    await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"failed",errorKind:"phase1",errorDetail:s.error??"Phase1 failed"});changed=true;
   }
  }else if(s.state==="not_started"){
   // Worker loss: the run that owned this Phase-1 case is gone (server crash or
   // restart) and no result version exists. Re-launch WITHOUT consuming a retry —
   // this is a resume of the persisted PI session, not a failure retry.
   await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"phase1_pending"});
   await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.resume:${item.id}`,eventType:"phase1.resume",payloadJson:JSON.stringify({runId:item.runId})});changed=true;
  }
 }
 items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
 if(isAllowed(trigger,queue.autoPhase1)&&(trigger==="auto"||trigger==="phase1")){for(const item of items.filter(x=>x.state==="phase1_pending")){await input.services.startPhase1(item,gen);await input.db.pipeline.updateItem(item.id,"phase1_pending",{state:"phase1_running"});changed=true}}
 items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
 if(items.some(x=>x.state==="failed")){if(gen.state!=="failed")await transition("failed");return{generation:gen,items,changed,waitingFor:null}}
 const allPhase1=items.length>0&&items.every(x=>["phase1_published","phase2_attached","final_view_published"].includes(x.state));
 if(!allPhase1)return{generation:gen,items,changed,waitingFor:"phase1"};
 if(gen.state==="eval_running"||gen.state==="phase1_running")await transition("phase2_ready");
 if(gen.state==="phase2_ready"&&isAllowed(trigger,queue.autoPhase2)&&(trigger==="auto"||trigger==="phase2")){
  let campaign=await input.db.phase2.getCampaignByGeneration(gen.id);if(!campaign){campaign=await input.db.phase2.createCampaign({projectId:queue.projectId,pipelineGenerationId:gen.id,sutFingerprint:createHash("sha256").update(gen.configJson).digest("hex"),ontologyVersion:"phase2-v1",membershipSha256:shaMembers(items),configJson:gen.configJson});for(const x of items){await input.db.phase2.addMember({campaignId:campaign.id,pipelineItemId:x.id,runId:x.runId!,phase1ResultVersionId:x.phase1ResultVersionId!,phase1ArchiveViewId:x.phase1ArchiveViewId!,validForAgentLearning:true,ordinal:x.ordinal})}}
  const frozen=campaign.state==="draft"?await input.db.phase2.transitionCampaign(campaign.id,"draft",campaign.fencingToken,"frozen"):campaign;if(!frozen)throw new Error("campaign fenced while freezing");const analyzing=frozen.state==="frozen"?await input.db.phase2.transitionCampaign(frozen.id,"frozen",frozen.fencingToken,"analyzing"):frozen;if(!analyzing)throw new Error("campaign fenced while starting analysis");await transition("phase2_running");const members=(await input.db.phase2.listMembers(analyzing.id,PAGE)).items;const result=await input.services.runPhase2(analyzing,members);await input.db.phase2.upsertRecord({campaignId:analyzing.id,kind:"decision",status:"developer_pack",sourceOperationId:`developer-pack:${analyzing.id}:${result.developerPackSha256}`,payloadJson:JSON.stringify(result)});const reviewing=await input.db.phase2.transitionCampaign(analyzing.id,"analyzing",analyzing.fencingToken,"reviewing");if(!reviewing)throw new Error("campaign fenced while finishing analysis");const published=await input.db.phase2.transitionCampaign(reviewing.id,"reviewing",reviewing.fencingToken,"published");if(!published)throw new Error("campaign fenced while publishing");await transition("finalizing");campaign=published;for(const x of items){await input.db.pipeline.updateItem(x.id,"phase1_published",{state:"phase2_attached"});}
  items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];for(const member of members){const item=items.find(x=>x.id===member.pipelineItemId)!;const final=await input.services.publishFinalView({campaign:published,member,phase2ArtifactDir:result.artifactDir});await input.db.phase2.createPublication({campaignId:published.id,runId:member.runId,phase1ArchiveViewId:member.phase1ArchiveViewId,finalArchiveViewId:final.finalArchiveViewId,manifestSha256:final.manifestSha256});await input.db.pipeline.updateItem(item.id,"phase2_attached",{state:"final_view_published",finalArchiveViewId:final.finalArchiveViewId});}
  await transition("completed");items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];return{generation:gen,items,changed:true,waitingFor:null};
 }
 return{generation:gen,items,changed,waitingFor:"phase2_trigger"};
}

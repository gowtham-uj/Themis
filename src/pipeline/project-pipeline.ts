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
import {isPhase2BoardInterrupted} from "../judge/phase2/errors.js";
import {isArchiveSealFailure} from "../runner/archive-status.js";

export type PipelineTrigger="auto"|"eval"|"phase1"|"phase2"|"finalize";
export interface EvalQueueStartResult{started:boolean}
export interface EvalItemStatus{state:"running"|"completed"|"failed";runId?:string;archiveId?:string;error?:string}

const EVAL_TERMINAL_STATES = new Set(["completed", "done", "failed", "aborted", "timeout"]);

/** Map an eval run to pipeline state without treating agent failure as platform failure. */
export function evalItemStatusFromRun(
  run: {id:string;status:string;error?:string|null},
  archiveId: string|null,
): EvalItemStatus {
  if (EVAL_TERMINAL_STATES.has(run.status)) {
    if (archiveId) return {state:"completed",runId:run.id,archiveId};
    if (isArchiveSealFailure(run.error)) {
      return {state:"failed",runId:run.id,error:run.error ?? "archive seal failed"};
    }
    // finalizeRun is committed before the archive is sealed. Keep polling during
    // that short window for every agent outcome, including timeout and failure.
    return {state:"running",runId:run.id};
  }
  if (run.error) return {state:"failed",runId:run.id,error:run.error};
  return {state:"running",runId:run.id};
}

export interface Phase1StartResult{operationId:string}
/** `not_started` means no in-flight run AND no published result — i.e. the worker
 *  that owned this Phase-1 run was lost (crash/restart) and must be re-launched
 *  so its persisted PI session can be resumed. */
export interface Phase1Status{state:"running"|"paused"|"published"|"blocked"|"failed"|"not_started";resultVersionId?:string;archiveViewId?:string;error?:string}
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
/** Item states with work still owed. A generation holding any of these has not
 *  finished, whatever its own state says. */
const IN_FLIGHT:readonly PipelineItemState[]=["eval_pending","eval_running","archive_sealed","phase1_pending","phase1_running"];
/** Item states holding a published Phase-1 verdict a campaign can analyze. */
const PHASE2_ELIGIBLE:readonly PipelineItemState[]=["phase1_published","phase2_attached","final_view_published"];
/** Bounded retries for a transient Phase-1 failure (e.g. the PI courtroom hit
 *  its context ceiling and ended without evalJudge.yaml). A manual or automatic
 *  re-advance resumes the SAME PI session via the worker's checkpoint recovery. */
const MAX_PHASE1_RETRIES=2;
/** Bounded automatic Phase-2 board attempts per generation, counted from durable
 *  `phase2.attempt_failed` events so a server restart does not reset the budget.
 *  Past this the generation parks in `waiting_retry` instead of letting the 3s
 *  ticker re-run a long, expensive board forever. */
const MAX_PHASE2_ATTEMPTS=3;

/**
 * Revive Phase-1 items that exhausted their automatic retries.
 *
 * Automatic retries are bounded on purpose, but exhausting them is not the same
 * as losing the work: the courtroom's `judge/` tree, its PI session, and every
 * committed report stay on disk. In one live generation, five items sat in
 * terminal `failed` while complete rulings waited in their work directories,
 * and nothing could pick them up again. This clears the retry counter and puts
 * them back in `phase1_pending`, so the next advance resumes the SAME PI session
 * from its checkpoints rather than starting a fresh judgement.
 *
 * Explicit operator action only: `advanceProjectPipeline` never calls it.
 */
export async function retryFailedPhase1(input:{db:Phase2Db;generationId:string}):Promise<{revived:string[]}>{
 const gen=await input.db.pipeline.getGeneration(input.generationId);
 if(!gen)throw new Error(`pipeline generation not found: ${input.generationId}`);
 const items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
 const revived:string[]=[];
 for(const item of items){
  // Only Phase-1 failures are revivable here. An eval that never sealed an
  // archive has nothing for the courtroom to read, so it stays failed.
  if(item.state!=="failed"||item.errorKind!=="phase1")continue;
  await input.db.pipeline.updateItem(item.id,"failed",{state:"phase1_pending",retryCount:0,errorKind:null,errorDetail:null});
  await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.operator_retry:${item.id}:${Date.now()}`,eventType:"phase1.operator_retry",payloadJson:JSON.stringify({priorError:item.errorDetail})});
  revived.push(item.id);
 }
 // A generation parked in `failed` cannot advance, so reopen it to the stage its
 // revived items are actually in. `completed` needs the same treatment: a
 // generation completes on the campaign's frozen membership, so an item revived
 // afterwards sits in phase1_pending while the ticker skips the generation, and
 // its verdict is never produced at all. Reopening runs the judge for it; the
 // Phase-2 block below refuses to re-run an already-published campaign, so this
 // costs a judge pass for the revived item and nothing more.
 if(revived.length>0&&(gen.state==="failed"||gen.state==="completed")){
  await input.db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase1_running");
 }
 return{revived};
}

/**
 * Retry one eval-stage failure inside its existing pipeline generation.
 *
 * The failed agent run remains immutable. The item forgets that run and returns
 * to `eval_pending`; the HTTP layer arms exactly one new queue repeat before it
 * calls this function. Downstream archive and judge IDs are cleared so a new
 * successful run must seal and pass Phase 1 normally.
 */
export async function retryFailedEval(input:{db:Phase2Db;generationId:string;itemId:string}):Promise<{revived:string[]}>{
 const gen=await input.db.pipeline.getGeneration(input.generationId);
 if(!gen)throw new Error(`pipeline generation not found: ${input.generationId}`);
 const item=await input.db.pipeline.getItem(input.itemId);
 if(!item||item.generationId!==gen.id)throw new Error(`pipeline item not found in generation: ${input.itemId}`);
 if(item.state!=="failed"||item.errorKind!=="eval")return{revived:[]};
 const updated=await input.db.pipeline.updateItem(item.id,"failed",{
  state:"eval_pending",runId:null,baseArchiveId:null,phase1ResultVersionId:null,
  phase1ArchiveViewId:null,finalArchiveViewId:null,retryCount:0,errorKind:null,errorDetail:null,
 });
 if(!updated)return{revived:[]};
 await input.db.pipeline.appendEvent({
  generationId:gen.id,itemId:item.id,
  operationId:`eval.operator_retry:${item.id}:${Date.now()}`,
  eventType:"eval.operator_retry",
  payloadJson:JSON.stringify({priorRunId:item.runId,priorError:item.errorDetail}),
 });
 if(gen.state==="failed"){
  const reopened=await input.db.pipeline.transitionGeneration(gen.id,"failed",gen.fencingToken,"eval_running");
  if(!reopened)throw new Error(`pipeline generation fenced during failed->eval_running`);
 }
 return{revived:[item.id]};
}

function shaMembers(items:readonly PipelineItemRow[]):string{return createHash("sha256").update(JSON.stringify(items.map(x=>[x.id,x.runId,x.phase1ResultVersionId,x.phase1ArchiveViewId,x.ordinal]))).digest("hex")}
function isAllowed(trigger:PipelineTrigger,auto:boolean):boolean{return trigger==="auto"?auto:true}

/** Advance a generation by one bounded coordinator tick. */
export async function advanceProjectPipeline(input:{db:Phase2Db;services:ProjectPipelineServices;generationId:string;trigger?:PipelineTrigger}):Promise<AdvanceResult>{
 const trigger=input.trigger??"auto";let gen=await input.db.pipeline.getGeneration(input.generationId);if(!gen)throw new Error(`pipeline generation not found: ${input.generationId}`);
 const queue=await input.db.pipeline.getQueue(gen.queueId);if(!queue)throw new Error(`pipeline queue not found: ${gen.queueId}`);
 let items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];let changed=false;
 if(queue.status==="paused"||gen.state==="paused")return{generation:gen,items,changed:false,waitingFor:"resume"};
 // A completed generation still holding in-flight items is unreachable work: the
 // ticker skips completed generations, and the operator retry route only revives
 // items that are `failed`. Nothing else would ever poll these, so their verdicts
 // are lost. Reopen the generation and let the normal Phase-1 polling below
 // finish them. This converges, because completion now requires an empty
 // in-flight set. `failed` has its own operator retry and `cancelled` is
 // deliberate, so neither reopens here.
 if(gen.state==="completed"&&items.some(x=>IN_FLIGHT.includes(x.state))){
  await input.db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase1_running");
  gen=(await input.db.pipeline.getGeneration(gen.id))!;changed=true;
  await input.db.pipeline.appendEvent({generationId:gen.id,itemId:null,operationId:`pipeline.reopened:${gen.id}:${gen.fencingToken}`,eventType:"pipeline.reopened_in_flight",payloadJson:JSON.stringify({items:items.filter(x=>IN_FLIGHT.includes(x.state)).map(x=>x.id)})});
 }
 // The same unreachable-work problem, one stage later: an item revived after the
 // campaign froze reaches `phase1_published` and the generation settles back to
 // `completed`. It is no longer IN_FLIGHT, so the reopen above does not see it,
 // and the return below skips the follow-up campaign block entirely. That is the
 // live state: eight items analyzed, two holding sealed verdicts no campaign
 // covers. Reopen to phase2_ready and let that block create the follow-up.
 // An uncovered verdict is exactly an item left at `phase1_published`: a covered
 // one is attached and moves on. Checking that first keeps the common case (a
 // settled generation the ticker revisits) to the item read it already does.
 if(gen.state==="completed"&&items.some(x=>x.state==="phase1_published")){
  const covered=new Set<string>();
  for(const c of await input.db.phase2.listCampaignsByGeneration(gen.id))
   for(const m of (await input.db.phase2.listMembers(c.id,PAGE)).items)covered.add(m.pipelineItemId);
  const uncovered=items.filter(x=>PHASE2_ELIGIBLE.includes(x.state)&&!covered.has(x.id));
  // Only reopen when a campaign exists. A generation that completed without one
  // was completed for some other reason and reopening would loop.
  if(uncovered.length>0&&covered.size>0){
   await input.db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase2_ready");
   gen=(await input.db.pipeline.getGeneration(gen.id))!;changed=true;
   await input.db.pipeline.appendEvent({generationId:gen.id,itemId:null,operationId:`pipeline.reopened_uncovered:${gen.id}:${gen.fencingToken}`,eventType:"pipeline.reopened_uncovered",payloadJson:JSON.stringify({items:uncovered.map(x=>x.id)})});
  }
 }
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
    // Same reason as the Phase 1 publish below: a retried eval that then
    // succeeds must not keep the earlier attempt's error.
    await input.db.pipeline.updateItem(fresh.id,"eval_running",{state:"archive_sealed",baseArchiveId:s.archiveId,errorKind:null,errorDetail:null});
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
   // Clear the error a previous attempt recorded. Phase 1 retries stamp
   // errorKind/errorDetail on the way back to `phase1_pending`, and nothing
   // used to remove them, so an item that failed once and then produced a
   // perfectly good verdict stayed marked failed forever. Observed live: a
   // published item still reading "failed Tier A structural validation".
   await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"phase1_published",phase1ResultVersionId:s.resultVersionId,phase1ArchiveViewId:s.archiveViewId,errorKind:null,errorDetail:null});
   await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.published:${item.id}:${s.resultVersionId}`,eventType:"phase1.result_published",payloadJson:JSON.stringify(s)});changed=true;
  }else if(s.state==="failed"){
   const n=item.retryCount+1;
   if(n<=MAX_PHASE1_RETRIES){
    await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"phase1_pending",errorKind:"phase1",errorDetail:s.error??"Phase1 failed",retryCount:n});
    await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.retry:${item.id}:${n}`,eventType:"phase1.retry",payloadJson:JSON.stringify({error:s.error,retryCount:n})});changed=true;
   }else{
    await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"failed",errorKind:"phase1",errorDetail:s.error??"Phase1 failed"});changed=true;
   }
  }else if(s.state==="blocked"){
   // Deployment configuration, not a case verdict: the Phase-1 stage has no base
   // URL or no credential. Park the item back in `phase1_pending` with the reason
   // visible and WITHOUT consuming a retry. Treating this as a case failure once
   // drove all ten items of a generation to terminal `failed` and threw away ten
   // sealed archives; fixing the setting and re-advancing now resumes them.
   await input.db.pipeline.updateItem(item.id,"phase1_running",{state:"phase1_pending",errorKind:"phase1_blocked",errorDetail:s.error??"Phase 1 model is not configured"});
   await input.db.pipeline.appendEvent({generationId:gen.id,itemId:item.id,operationId:`phase1.blocked:${item.id}`,eventType:"phase1.blocked",payloadJson:JSON.stringify({error:s.error})});changed=true;
  }else if(s.state==="paused"){
   // An operator pause holds the item in phase1_running with its checkpoints
   // intact; resume restarts the same case from the last node boundary. This
   // arm exists so the worker-loss branch below can never see a paused case:
   // once the graph halts, the service is no longer "running", and without this
   // the item would fall through to `not_started` and be relaunched against the
   // very pause that stopped it.
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
 // Every eval has sealed and the courtroom owns the run now. Advance the generation
 // so the run panel names the stage that is actually working.
 if(gen.state==="eval_running"&&!items.some(x=>x.state==="eval_pending"||x.state==="eval_running")&&items.some(x=>x.state==="phase1_pending"||x.state==="phase1_running"))await transition("phase1_running");
 // One failed eval must not abandon siblings still in the courtroom.
 const stillGoing=items.some(x=>IN_FLIGHT.includes(x.state));
 // Phase 2 runs on the evals that actually produced a Phase-1 result. A failed
 // sibling is a finding about the tested agent (or an exhausted judge retry),
 // not a reason to throw away every completed judgement in the generation: the
 // campaign proceeds with the published subset and the failed items stay on the
 // run panel with their error, revivable through retryFailedPhase1. Only a
 // generation with nothing published is genuinely failed.
 const eligible=items.filter(x=>PHASE2_ELIGIBLE.includes(x.state));
 if(!stillGoing&&eligible.length===0&&items.some(x=>x.state==="failed")){
  if(gen.state!=="failed")await transition("failed");
  return{generation:gen,items,changed,waitingFor:null};
 }
 if(stillGoing||eligible.length===0)return{generation:gen,items,changed,waitingFor:"phase1"};
 if(gen.state==="eval_running"||gen.state==="phase1_running")await transition("phase2_ready");
 // phase2_running and finalizing are re-entrant on purpose. A server restart or a
 // crashed board leaves the generation in one of them with the campaign half done;
 // re-entering resumes the board's persisted PI session and finishes the sequence.
 // waiting_retry is where a budget-exhausted board parks. An explicit operator
 // trigger reopens it; the automatic ticker leaves it alone.
 if(gen.state==="waiting_retry"&&trigger==="phase2"){
  // Reset the attempt budget too. Without this the reopened generation counts
  // the same exhausted events and parks again on the very next tick.
  await input.db.pipeline.appendEvent({generationId:gen.id,itemId:null,
   operationId:`phase2.budget_reset:${gen.id}:${Date.now()}`,
   eventType:"phase2.budget_reset",payloadJson:"{}"});
  await transition("phase2_ready");
 }
 // A campaign that already published is final: its developer pack is assembled and
 // its members' archives carry a phase2/ layer. An item revived after that point
 // reopens the generation for its own judge pass, and re-entering the board here
 // would spend a full second board run to re-publish what is already sealed. Take
 // the generation straight back to completed instead.
 const priorCampaign=await input.db.phase2.getCampaignByGeneration(gen.id);
 if(priorCampaign?.state==="published"){
  // ...unless that campaign left published Phase-1 verdicts uncovered. An item
  // whose retries were exhausted goes to `failed`, so `stillGoing` is false and
  // the campaign correctly freezes without it; retryFailedPhase1 then revives it
  // and it publishes a complete verdict afterwards. Observed live: two of ten
  // runs judged, sealed, and analyzed by nothing. Cover them with a follow-up
  // campaign rather than completing over them.
  const covered=new Set<string>();
  for(const c of await input.db.phase2.listCampaignsByGeneration(gen.id))
   for(const m of (await input.db.phase2.listMembers(c.id,PAGE)).items)covered.add(m.pipelineItemId);
  const uncovered=eligible.filter(x=>!covered.has(x.id));
  if(uncovered.length===0){
   // `stillGoing` is false here, so nothing is mid-flight and completing is safe.
   if(gen.state!=="completed")await transition("completed");
   return{generation:gen,items,changed,waitingFor:null};
  }
  if(gen.state!=="phase2_ready")await transition("phase2_ready");
  gen=(await input.db.pipeline.getGeneration(gen.id))!;
 }
 if(["phase2_ready","phase2_running","finalizing"].includes(gen.state)&&isAllowed(trigger,queue.autoPhase2)&&(trigger==="auto"||trigger==="phase2")){
  // Phase 2 is one long PI board run. Without a bound, a board that throws on
  // every attempt is retried by the 3s ticker forever, and each retry is real
  // model spend. Count the durable attempt events instead of a process counter,
  // so a server restart does not reset the budget. Past the bound the generation
  // parks in waiting_retry: every Phase-1 result stays published and addressable,
  // and an operator re-triggers Phase 2 explicitly.
  const evs=(await input.db.pipeline.listEvents(gen.id,PAGE)).items;
  const lastReset=evs.filter(e=>e.eventType==="phase2.budget_reset").at(-1)?.createdAt??"";
  const attempts=evs.filter(e=>e.eventType==="phase2.attempt_failed"&&e.createdAt>lastReset).length;
  if(attempts>=MAX_PHASE2_ATTEMPTS){
   if(gen.state!=="waiting_retry")await transition("waiting_retry");
   return{generation:gen,items,changed,waitingFor:"phase2_operator_retry"};
  }
  try{
  let campaign=await input.db.phase2.getCampaignByGeneration(gen.id);
  // A published campaign is final and immutable. Reaching here with one means
  // uncovered verdicts exist (checked above), so start a follow-up over exactly
  // those and leave the published campaign's members and pack untouched.
  if(campaign?.state==="published")campaign=null;
  if(!campaign){
   const covered=new Set<string>();
   for(const c of await input.db.phase2.listCampaignsByGeneration(gen.id))
    for(const m of (await input.db.phase2.listMembers(c.id,PAGE)).items)covered.add(m.pipelineItemId);
   const members=eligible.filter(x=>!covered.has(x.id));
   campaign=await input.db.phase2.createCampaign({projectId:queue.projectId,pipelineGenerationId:gen.id,sutFingerprint:createHash("sha256").update(gen.configJson).digest("hex"),ontologyVersion:"phase2-v1",membershipSha256:shaMembers(members),configJson:gen.configJson});
   for(const x of members){await input.db.phase2.addMember({campaignId:campaign.id,pipelineItemId:x.id,runId:x.runId!,phase1ResultVersionId:x.phase1ResultVersionId!,phase1ArchiveViewId:x.phase1ArchiveViewId!,validForAgentLearning:true,ordinal:x.ordinal})}
  }
  // Every campaign and generation step below is re-entrant: it advances only from
  // the state it expects, so a resumed tick skips whatever the lost run finished.
  const step=async(from:Phase2CampaignRow["state"],to:Phase2CampaignRow["state"],c:Phase2CampaignRow):Promise<Phase2CampaignRow>=>{
   if(c.state!==from)return c;
   const n=await input.db.phase2.transitionCampaign(c.id,from,c.fencingToken,to);
   if(!n)throw new Error(`campaign fenced during ${from}->${to}`);
   return n;
  };
  const analyzing=await step("frozen","analyzing",await step("draft","frozen",campaign));
  if(gen.state==="phase2_ready")await transition("phase2_running");
  const members=(await input.db.phase2.listMembers(analyzing.id,PAGE)).items;
  const result=await input.services.runPhase2(analyzing,members);
  await input.db.phase2.upsertRecord({campaignId:analyzing.id,kind:"decision",status:"developer_pack",sourceOperationId:`developer-pack:${analyzing.id}:${result.developerPackSha256}`,payloadJson:JSON.stringify(result)});
  // Stamp the pack digest on the campaign before it publishes. Without this the
  // column stayed null on every published campaign and a client had no way to
  // tell an assembled pack from a missing one.
  await input.db.phase2.setCampaignDeveloperPackSha256(analyzing.id,result.developerPackSha256);
  const published=await step("reviewing","published",await step("analyzing","reviewing",analyzing));
  if(gen.state==="phase2_running")await transition("finalizing");
  campaign=published;
  // Attach exactly the campaign's frozen membership, not the freshly recomputed
  // eligible set. A revived item whose Phase 1 published after the campaign froze
  // is eligible now but has no member row, so the publish loop below would never
  // reach it: it would sit in `phase2_attached` while the generation completed,
  // stranded in a non-terminal state with no phase2/ layer on its archive. It
  // stays `phase1_published` — a complete, addressable verdict — and the next
  // campaign covers it.
  const memberItemIds=new Set(members.map(m=>m.pipelineItemId));
  for(const x of eligible){if(memberItemIds.has(x.id))await input.db.pipeline.updateItem(x.id,"phase1_published",{state:"phase2_attached"});}
  items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
  for(const member of members){
   const item=items.find(x=>x.id===member.pipelineItemId);
   if(!item||item.state==="final_view_published")continue;
   const final=await input.services.publishFinalView({campaign:published,member,phase2ArtifactDir:result.artifactDir});
   const pub=await input.db.phase2.createPublication({campaignId:published.id,runId:member.runId,phase1ArchiveViewId:member.phase1ArchiveViewId,finalArchiveViewId:final.finalArchiveViewId,manifestSha256:final.manifestSha256});
   // publishFinalView already wrote and verified the phase2/ layer on disk, so
   // the row walks to published here. The archive catalog reads this state to
   // decide whether an archive is sealed at base, phase1, or phase2.
   const verified=await input.db.phase2.transitionPublication(pub.id,"preparing","verified");
   if(!verified)throw new Error(`publication fenced while verifying ${pub.id}`);
   if(!await input.db.phase2.transitionPublication(pub.id,"verified","published"))throw new Error(`publication fenced while publishing ${pub.id}`);
   await input.db.pipeline.updateItem(item.id,"phase2_attached",{state:"final_view_published",finalArchiveViewId:final.finalArchiveViewId});
  }
  // Only finish the generation when nothing is still working. An item revived
  // while the board was running is judging right now, and `completed` is a state
  // the ticker skips: transitioning here would abandon that verdict mid-flight
  // with no route back. Stay in `finalizing` so the next tick keeps polling it.
  items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
  if(items.some(x=>IN_FLIGHT.includes(x.state))){
   return{generation:gen,items,changed:true,waitingFor:"phase1"};
  }
  await transition("completed");items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];return{generation:gen,items,changed:true,waitingFor:null};
  }catch(err){
   // A paused or otherwise interrupted board is NOT a failed attempt. Its frozen
   // PI session and every filed record are on disk, so the generation parks in
   // `paused` with the campaign still `analyzing`: resume continues that exact
   // session, nothing publishes, and no attempt is consumed. Before this, the
   // missing records read as an empty board and the campaign published an empty
   // developer pack over already-sealed archives.
   if(isPhase2BoardInterrupted(err)){
    await input.db.pipeline.appendEvent({generationId:gen.id,itemId:null,
     operationId:`phase2.paused:${gen.id}:${Date.now()}`,
     eventType:"phase2.paused",
     payloadJson:JSON.stringify({filed:err.filed,resumable:err.resumable,detail:err.message})});
    if(String(gen.state)!=="paused")await transition("paused");
    items=[...(await input.db.pipeline.listItems(gen.id,PAGE)).items];
    return{generation:gen,items,changed:true,waitingFor:"phase2_resume"};
   }
   // The board failed. Record why, durably, so the bounded budget above decides
   // whether the next tick tries again. A thrown error out of a coordinator tick
   // is only a log line; this makes it a run-panel fact the operator can read.
   await input.db.pipeline.appendEvent({generationId:gen.id,itemId:null,
    operationId:`phase2.attempt_failed:${gen.id}:${attempts+1}`,
    eventType:"phase2.attempt_failed",
    payloadJson:JSON.stringify({attempt:attempts+1,error:err instanceof Error?err.message:String(err)})});
   throw err;
  }
 }
 return{generation:gen,items,changed,waitingFor:"phase2_trigger"};
}

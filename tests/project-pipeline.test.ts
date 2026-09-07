/** Durable unified project pipeline state-machine tests on real SQLite rows. */
import Database from "better-sqlite3";
import {describe,expect,it} from "vitest";
import {createSqlitePhase2Db} from "../src/db/phase2/sqlite-store.ts";
import {Phase2BoardInterruptedError} from "../src/judge/phase2/errors.ts";
import {advanceProjectPipeline,evalItemStatusFromRun,retryFailedEval,retryFailedPhase1,type ProjectPipelineServices} from "../src/pipeline/project-pipeline.ts";

describe("eval run pipeline mapping",()=>{
 it.each(["completed","failed","aborted","timeout"])(
  "advances a %s agent outcome when its evidence archive sealed",
  (status)=>{
   expect(evalItemStatusFromRun({id:"run-1",status,error:null},"run-1")).toEqual({
    state:"completed",runId:"run-1",archiveId:"run-1",
   });
  },
 );
 it("keeps polling between run finalization and archive sealing",()=>{
  expect(evalItemStatusFromRun({id:"run-1",status:"timeout",error:null},null)).toEqual({
   state:"running",runId:"run-1",
  });
 });
 it("fails explicitly when the platform could not seal the archive",()=>{
  const error="archive seal failed: manifest write failed";
  expect(evalItemStatusFromRun({id:"run-1",status:"failed",error},null)).toEqual({
   state:"failed",runId:"run-1",error,
  });
 });
});

describe("project pipeline coordinator",()=>{
 it("runs evals sequentially, Phase1 per eval, Phase2 once, and finalizes both views",async()=>{
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:'{"agent":"reapercode"}'});
  await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  await db.pipeline.addItem({generationId:g.id,evalId:"e2",ordinal:2});
  const evalPoll=new Map<string,number>(),p1Poll=new Map<string,number>();let started=0,phase2Runs=0;let evalQueueStarted=false;
  const services:ProjectPipelineServices={
   async startEvalQueue(){if(!evalQueueStarted){evalQueueStarted=true;started++}return{started:true}},
   async pollEvalItem(item){const n=(evalPoll.get(item.evalId)??0)+1;evalPoll.set(item.evalId,n);const runId=`run-${item.evalId}`;return n>=1?{state:"completed",runId,archiveId:`archive-${runId}`}:{state:"running",runId}},
   async startPhase1(item){return{operationId:`p1-${item.id}`}},
   async getPhase1Status(runId){const n=(p1Poll.get(runId)??0)+1;p1Poll.set(runId,n);return n>=1?{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}:{state:"running"}},
   async runPhase2(campaign,members){phase2Runs++;expect(members).toHaveLength(2);return{developerPackSha256:"ab".repeat(32),developerPackZip:`/phase2/${campaign.id}/developer-improvement-pack.zip`,artifactDir:`/phase2/${campaign.id}`}},
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  for(let i=0;i<20;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed")break;}
  const final=await db.pipeline.getGeneration(g.id);expect(final?.state).toBe("completed");
  const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:10})).items;
  expect(items.map(x=>x.state)).toEqual(["final_view_published","final_view_published"]);
  expect(started).toBe(1);expect(phase2Runs).toBe(1);
  expect((await db.phase2.getCampaignByGeneration(g.id))?.state).toBe("published");
  expect((await db.phase2.listPublications((await db.phase2.getCampaignByGeneration(g.id))!.id,{cursor:null,limit:10})).items).toHaveLength(2);
  await db.close();
 });
 it("re-launches a Phase1 case whose worker was lost (not_started) without consuming a retry",async()=>{
  // A server crash leaves a phase1_running item with no in-flight run and no
  // result version. getPhase1Status reports not_started; the coordinator must
  // re-arm it (phase1_pending) WITHOUT touching retryCount, then relaunch on the
  // next tick so the persisted PI session is resumed.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p3",evalQueueId:"eq3",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const item=await db.pipeline.addItem({generationId:g.id,evalId:"e",ordinal:1});
  await db.pipeline.updateItem(item.id,"eval_pending",{state:"archive_sealed",baseArchiveId:"a"});
  await db.pipeline.updateItem(item.id,"archive_sealed",{state:"phase1_pending"});
  await db.pipeline.updateItem(item.id,"phase1_pending",{state:"phase1_running",runId:"run-e"});
  const seq={calls:0};let relaunched=0;
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(){return{state:"completed",runId:"run-e",archiveId:"a"}},
   async startPhase1(){relaunched++;return{operationId:"p1"}},
   async getPhase1Status(){seq.calls++;return seq.calls===1?{state:"not_started"}:{state:"published",resultVersionId:"rv",archiveViewId:"v"}},
   async runPhase2(){return{developerPackSha256:"a".repeat(64),developerPackZip:"/p3/developer-improvement-pack.zip",artifactDir:"/p3"}},
   async publishFinalView(){return{finalArchiveViewId:"fv",manifestSha256:"b".repeat(64)}},
  };
  // First tick: sees not_started, re-arms to phase1_pending and relaunches.
  const r1=await advanceProjectPipeline({db,services,generationId:g.id});
  const after=await db.pipeline.getItem(item.id);
  expect(after?.state).toBe("phase1_running");
  expect(after?.retryCount).toBe(0); // crash-resume never consumes a retry
  expect(relaunched).toBe(1);
  // Finish it.
  for(let i=0;i<12;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed")break;}
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  await db.close();
 });
 it("honors manual Phase2 trigger when autoPhase2 is disabled",async()=>{
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p2",evalQueueId:"eq2",name:"q",autoPhase2:false});const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});const item=await db.pipeline.addItem({generationId:g.id,evalId:"e",ordinal:1});
  const services:ProjectPipelineServices={async startEvalQueue(){return{started:true}},async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:`a-${item.evalId}`}},async startPhase1(){return{operationId:"p1"}},async getPhase1Status(){return{state:"published",resultVersionId:"rv",archiveViewId:"v"}},async runPhase2(){return{developerPackSha256:"a".repeat(64),developerPackZip:"/p2/developer-improvement-pack.zip",artifactDir:"/p2"}},async publishFinalView(){return{finalArchiveViewId:"fv",manifestSha256:"b".repeat(64)}}};
  let r;for(let i=0;i<10;i++){r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.waitingFor==="phase2_trigger")break}expect(r?.waitingFor).toBe("phase2_trigger");
  const done=await advanceProjectPipeline({db,services,generationId:g.id,trigger:"phase2"});expect(done.generation.state).toBe("completed");
  // The pack digest must reach the campaign row, not just the record payload:
  // a published campaign with a null digest is indistinguishable from one whose
  // pack was never assembled.
  const campaign=await db.phase2.getCampaignByGeneration(g.id);
  expect(campaign?.developerPackSha256).toBe("a".repeat(64));
  await db.close();
 });
 it("resumes a generation whose Phase2 board died mid-campaign",async()=>{
  // A server restart kills the board process while the generation already says
  // phase2_running and the campaign says analyzing. Nothing outside this tick
  // owns the rest of the sequence, so re-entering must finish it.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p4",evalQueueId:"eq4",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const item=await db.pipeline.addItem({generationId:g.id,evalId:"e",ordinal:1});
  await db.pipeline.updateItem(item.id,"eval_pending",{state:"phase1_published",runId:"run-e",baseArchiveId:"a",phase1ResultVersionId:"rv",phase1ArchiveViewId:"v"});
  const campaign=await db.phase2.createCampaign({projectId:"p4",pipelineGenerationId:g.id,sutFingerprint:"f",ontologyVersion:"phase2-v1",membershipSha256:"m",configJson:"{}"});
  await db.phase2.addMember({campaignId:campaign.id,pipelineItemId:item.id,runId:"run-e",phase1ResultVersionId:"rv",phase1ArchiveViewId:"v",validForAgentLearning:true,ordinal:1});
  const frozen=(await db.phase2.transitionCampaign(campaign.id,"draft",campaign.fencingToken,"frozen"))!;
  await db.phase2.transitionCampaign(frozen.id,"frozen",frozen.fencingToken,"analyzing");
  const gen=(await db.pipeline.getGeneration(g.id))!;
  await db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase2_running");
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(){return{state:"completed",runId:"run-e",archiveId:"a"}},
   async startPhase1(){return{operationId:"p1"}},
   async getPhase1Status(){return{state:"published",resultVersionId:"rv",archiveViewId:"v"}},
   async runPhase2(){return{developerPackSha256:"a".repeat(64),developerPackZip:"/p4/developer-improvement-pack.zip",artifactDir:"/p4"}},
   async publishFinalView(){return{finalArchiveViewId:"fv",manifestSha256:"b".repeat(64)}},
  };
  const r=await advanceProjectPipeline({db,services,generationId:g.id});
  expect(r.generation.state).toBe("completed");
  expect((await db.phase2.getCampaignByGeneration(g.id))?.state).toBe("published");
  expect((await db.pipeline.getItem(item.id))?.state).toBe("final_view_published");
  const pubs=(await db.phase2.listPublications(campaign.id,{cursor:null,limit:10})).items;
  expect(pubs.map(p=>p.state)).toEqual(["published"]);
  await db.close();
 });

 it("revives Phase1 items that exhausted their automatic retries, and leaves eval failures alone",async()=>{
  // Exhausting the bounded retries is not the same as losing the work: the
  // courtroom's judge/ tree and PI session are still on disk. One live
  // generation had five terminal `failed` items holding complete rulings that
  // nothing could pick back up.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p4",evalQueueId:"eq4",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const judged=await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  const neverRan=await db.pipeline.addItem({generationId:g.id,evalId:"e2",ordinal:2});
  await db.pipeline.updateItem(judged.id,"eval_pending",{state:"failed",errorKind:"phase1",errorDetail:"Tier A structural validation",retryCount:2});
  // An eval that never sealed an archive has nothing for the courtroom to read.
  await db.pipeline.updateItem(neverRan.id,"eval_pending",{state:"failed",errorKind:"eval",errorDetail:"the API process stopped"});

  const r=await retryFailedPhase1({db,generationId:g.id});
  expect(r.revived).toEqual([judged.id]);

  const a=await db.pipeline.getItem(judged.id);
  expect(a?.state).toBe("phase1_pending");
  expect(a?.retryCount).toBe(0);
  expect(a?.errorDetail).toBeFalsy();
  expect((await db.pipeline.getItem(neverRan.id))?.state).toBe("failed");
  await db.close();
 });

 it("retries one eval failure in the same generation and clears its stale run",async()=>{
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p5",evalQueueId:"eq5",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const failed=await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  const published=await db.pipeline.addItem({generationId:g.id,evalId:"e2",ordinal:2});
  await db.pipeline.updateItem(failed.id,"eval_pending",{
   state:"failed",runId:"failed-run",errorKind:"eval",errorDetail:"worker stopped",retryCount:1,
  });
  await db.pipeline.updateItem(published.id,"eval_pending",{
   state:"phase1_published",runId:"good-run",baseArchiveId:"archive",phase1ResultVersionId:"rv",phase1ArchiveViewId:"view",
  });
  const gen=(await db.pipeline.getGeneration(g.id))!;
  await db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"failed");

  const r=await retryFailedEval({db,generationId:g.id,itemId:failed.id});

  expect(r.revived).toEqual([failed.id]);
  const retried=await db.pipeline.getItem(failed.id);
  expect(retried).toMatchObject({state:"eval_pending",runId:null,errorKind:null,errorDetail:null,retryCount:0});
  expect((await db.pipeline.getItem(published.id))?.state).toBe("phase1_published");
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("eval_running");
  const events=(await db.pipeline.listEvents(g.id,{cursor:null,limit:10})).items;
  expect(events.at(-1)?.eventType).toBe("eval.operator_retry");
  expect(JSON.parse(events.at(-1)?.payloadJson??"{}")).toMatchObject({priorRunId:"failed-run",priorError:"worker stopped"});
  await db.close();
 });

 it("runs Phase2 on the published subset when a sibling Phase1 case fails",async()=>{
  // Observed live: 8 of 10 evals published Phase 1, 2 exhausted their judge
  // retries, and the whole generation went terminal `failed`. Eight complete
  // judgements were then unreachable and Phase 2 never ran. A failed sibling is
  // a finding, not a reason to discard the rest of the run.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  await db.pipeline.addItem({generationId:g.id,evalId:"ok",ordinal:1});
  await db.pipeline.addItem({generationId:g.id,evalId:"bad",ordinal:2});
  let members=-1;
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:`arch-${item.evalId}`}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(runId){return runId==="run-bad"
    ?{state:"failed",error:"Tier A structural validation"}
    :{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}},
   async runPhase2(campaign,ms){members=ms.length;return{developerPackSha256:"ab".repeat(32),developerPackZip:"/p/pack.zip",artifactDir:`/p/${campaign.id}`}},
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  for(let i=0;i<25;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed")break;}
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  expect(members).toBe(1);
  const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:10})).items;
  expect(items.find(x=>x.evalId==="ok")?.state).toBe("final_view_published");
  // The failed sibling keeps its error and stays revivable.
  const bad=items.find(x=>x.evalId==="bad");
  expect(bad?.state).toBe("failed");
  expect(bad?.errorKind).toBe("phase1");
  await db.close();
 });

 it("never strands an item that published after the campaign froze its membership",async()=>{
  // The board freezes its membership when it starts. An item whose verdict lands
  // after that point is Phase-2 eligible but has no member row, so the publish
  // loop can never reach it. Attaching it anyway left it in phase2_attached while
  // the generation completed: a non-terminal state nothing would ever finish, and
  // an archive with no phase2/ layer that the run panel still counted as attached.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const a=await db.pipeline.addItem({generationId:g.id,evalId:"member",ordinal:1});
  const late=await db.pipeline.addItem({generationId:g.id,evalId:"late",ordinal:2});
  for(const x of [a,late]){
   await db.pipeline.updateItem(x.id,"eval_pending",{state:"phase1_published",runId:`run-${x.evalId}`,
    baseArchiveId:`arch-${x.evalId}`,phase1ResultVersionId:`rv-${x.evalId}`,phase1ArchiveViewId:`view-${x.evalId}`});
  }
  // The campaign froze over `member` only, exactly as it would if `late` were
  // still judging when the board started.
  const campaign=await db.phase2.createCampaign({projectId:"p",pipelineGenerationId:g.id,
   sutFingerprint:"f".repeat(64),ontologyVersion:"phase2-v1",membershipSha256:"e".repeat(64),configJson:"{}"});
  await db.phase2.addMember({campaignId:campaign.id,pipelineItemId:a.id,runId:"run-member",
   phase1ResultVersionId:"rv-member",phase1ArchiveViewId:"view-member",validForAgentLearning:true,ordinal:1});
  const gen=(await db.pipeline.getGeneration(g.id))!;
  await db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase2_ready");

  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:`arch-${item.evalId}`}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(runId){return{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}},
   async runPhase2(c,ms){expect(ms).toHaveLength(1);return{developerPackSha256:"ab".repeat(32),developerPackZip:"/p/pack.zip",artifactDir:`/p/${c.id}`}},
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  for(let i=0;i<25;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed")break;}

  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  expect((await db.pipeline.getItem(a.id))?.state).toBe("final_view_published");
  // The non-member keeps its published verdict instead of being stranded.
  expect((await db.pipeline.getItem(late.id))?.state).toBe("phase1_published");
  await db.close();
 });

 it("reopens a completed generation that still holds in-flight items",async()=>{
  // The live remediation case. A generation completed while two items were mid
  // judgement, and nothing could reach them again: the ticker skips completed
  // generations and the operator retry route only revives `failed` items. Their
  // verdicts were stranded permanently. Advance must reopen that generation and
  // finish the work rather than treating the state word as the truth.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const done=await db.pipeline.addItem({generationId:g.id,evalId:"done",ordinal:1});
  const stuck=await db.pipeline.addItem({generationId:g.id,evalId:"stuck",ordinal:2});
  await db.pipeline.updateItem(done.id,"eval_pending",{state:"final_view_published",runId:"run-done",
   baseArchiveId:"arch-done",phase1ResultVersionId:"rv-done",phase1ArchiveViewId:"view-done",finalArchiveViewId:"final-done"});
  await db.pipeline.updateItem(stuck.id,"eval_pending",{state:"phase1_running",runId:"run-stuck",baseArchiveId:"arch-stuck"});
  const campaign=await db.phase2.createCampaign({projectId:"p",pipelineGenerationId:g.id,
   sutFingerprint:"f".repeat(64),ontologyVersion:"phase2-v1",membershipSha256:"e".repeat(64),configJson:"{}"});
  await db.phase2.addMember({campaignId:campaign.id,pipelineItemId:done.id,runId:"run-done",
   phase1ResultVersionId:"rv-done",phase1ArchiveViewId:"view-done",validForAgentLearning:true,ordinal:1});
  await db.phase2.transitionCampaign(campaign.id,"draft",campaign.fencingToken,"published");
  const gen=(await db.pipeline.getGeneration(g.id))!;
  await db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"completed");

  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:`arch-${item.evalId}`}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(runId){return{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}},
   // The board already published; it must not run a second time.
   async runPhase2(){throw new Error("published campaign must not re-run")},
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  for(let i=0;i<25;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed"&&i>0)break}

  // The stranded verdict landed, and the generation settles back to completed.
  expect((await db.pipeline.getItem(stuck.id))?.state).toBe("phase1_published");
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  expect((await db.pipeline.getItem(done.id))?.state).toBe("final_view_published");
  await db.close();
 });

 it("does not complete a generation while a revived item is still judging",async()=>{
  // Reviving an item while the board runs leaves it judging when Phase 2
  // publishes. Completing there is unrecoverable: the ticker skips completed
  // generations, so that verdict is abandoned mid-flight with no route back.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const a=await db.pipeline.addItem({generationId:g.id,evalId:"member",ordinal:1});
  const late=await db.pipeline.addItem({generationId:g.id,evalId:"late",ordinal:2});
  await db.pipeline.updateItem(a.id,"eval_pending",{state:"phase1_published",runId:"run-member",
   baseArchiveId:"arch-member",phase1ResultVersionId:"rv-member",phase1ArchiveViewId:"view-member"});
  await db.pipeline.updateItem(late.id,"eval_pending",{state:"failed",runId:"run-late",
   baseArchiveId:"arch-late",errorKind:"phase1",errorDetail:"judge exhausted"});
  const campaign=await db.phase2.createCampaign({projectId:"p",pipelineGenerationId:g.id,
   sutFingerprint:"f".repeat(64),ontologyVersion:"phase2-v1",membershipSha256:"e".repeat(64),configJson:"{}"});
  await db.phase2.addMember({campaignId:campaign.id,pipelineItemId:a.id,runId:"run-member",
   phase1ResultVersionId:"rv-member",phase1ArchiveViewId:"view-member",validForAgentLearning:true,ordinal:1});
  const gen=(await db.pipeline.getGeneration(g.id))!;
  await db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase2_ready");

  let lateDone=false;
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:`arch-${item.evalId}`}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(runId){return runId==="run-late"&&!lateDone
    ?{state:"running"}
    :{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}},
   // The board takes minutes. An operator retries the failed item while it runs,
   // so by the time Phase 2 publishes, that item is judging again.
   async runPhase2(c,ms){
    await db.pipeline.updateItem(late.id,"failed",{state:"phase1_running",errorKind:null,errorDetail:null});
    return{developerPackSha256:"ab".repeat(32),developerPackZip:"/p/pack.zip",artifactDir:`/p/${c.id}`};
   },
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  // Phase 2 publishes its members while the revived item is still judging.
  for(let i=0;i<10;i++){await advanceProjectPipeline({db,services,generationId:g.id})}
  expect((await db.pipeline.getItem(a.id))?.state).toBe("final_view_published");
  // The generation must NOT be completed: its live item still needs ticks.
  expect((await db.pipeline.getGeneration(g.id))?.state).not.toBe("completed");
  expect((await db.pipeline.getItem(late.id))?.state).toBe("phase1_running");

  // Once its verdict lands, the generation finishes and the verdict survives.
  lateDone=true;
  for(let i=0;i<10;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed")break}
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  expect((await db.pipeline.getItem(late.id))?.state).toBe("phase1_published");
  await db.close();
 });

 it("fails a generation only when no eval produced a Phase1 result",async()=>{
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:"a"}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(){return{state:"failed",error:"judge exhausted"}},
   async runPhase2(){throw new Error("Phase2 must not run with zero members")},
   async publishFinalView(){throw new Error("no final view without Phase2")},
  };
  for(let i=0;i<25;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(["completed","failed"].includes(r.generation.state))break;}
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("failed");
  await db.close();
 });

 it("parks Phase2 in waiting_retry after its attempt budget, then reopens on an operator trigger",async()=>{
  // A board that throws on every attempt was retried by the 3s ticker forever,
  // and every retry is real model spend. The budget is counted from durable
  // events so a restart does not reset it.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  let boardCalls=0,boardFails=true;
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:"a"}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(runId){return{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}},
   async runPhase2(campaign){boardCalls++;if(boardFails)throw new Error("board ran out of context");return{developerPackSha256:"ab".repeat(32),developerPackZip:"/p/pack.zip",artifactDir:`/p/${campaign.id}`}},
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  for(let i=0;i<20;i++){
   const r=await advanceProjectPipeline({db,services,generationId:g.id}).catch(()=>null);
   if(r?.generation.state==="waiting_retry")break;
  }
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("waiting_retry");
  expect(boardCalls).toBe(3);
  // The ticker's own trigger must not reopen it.
  await advanceProjectPipeline({db,services,generationId:g.id});
  expect(boardCalls).toBe(3);
  // An explicit operator trigger does, and clears the exhausted budget.
  boardFails=false;
  for(let i=0;i<20;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id,trigger:"phase2"});if(r.generation.state==="completed")break;}
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  expect(boardCalls).toBe(4);
  await db.close();
 });

 it("parks the generation when a paused board stopped mid-filing, and never publishes it",async()=>{
  // Pausing Phase 2 SIGKILLs the PI tree and freezes its session. Reading the
  // unwritten YAML as an empty board published an empty developer pack over ten
  // sealed archives, marked the generation completed, and locked resume out
  // behind the published-campaign 409 — while the investigator's transcript sat
  // on disk. An interrupted board must park, not publish.
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  let interrupted=true,boardCalls=0;
  const services:ProjectPipelineServices={
   async startEvalQueue(){return{started:true}},
   async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:"a"}},
   async startPhase1(){return{operationId:"op"}},
   async getPhase1Status(runId){return{state:"published",resultVersionId:`rv-${runId}`,archiveViewId:`view-${runId}`}},
   async runPhase2(campaign){
    boardCalls++;
    if(interrupted)throw new Phase2BoardInterruptedError("board stopped before filing every record",["phase2-hypotheses.yaml"],true);
    return{developerPackSha256:"ab".repeat(32),developerPackZip:"/p/pack.zip",artifactDir:`/p/${campaign.id}`};
   },
   async publishFinalView({member}){return{finalArchiveViewId:`final-${member.runId}`,manifestSha256:"cd".repeat(32)}},
  };
  for(let i=0;i<10;i++){
   const r=await advanceProjectPipeline({db,services,generationId:g.id});
   if(r.generation.state==="paused")break;
  }
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("paused");
  // The campaign stays analyzing so a resume continues the same session.
  const campaign=await db.phase2.getCampaignByGeneration(g.id);
  expect(campaign?.state).toBe("analyzing");
  expect(campaign?.developerPackSha256??null).toBeNull();
  // Nothing attached, nothing published.
  const items=(await db.pipeline.listItems(g.id,{cursor:null,limit:100})).items;
  expect(items.map(i=>i.state)).toEqual(["phase1_published"]);
  // A pause is not a failed attempt, so it must not burn the Phase-2 budget.
  const evs=(await db.pipeline.listEvents(g.id,{cursor:null,limit:100})).items;
  expect(evs.filter(e=>e.eventType==="phase2.attempt_failed")).toHaveLength(0);
  expect(evs.filter(e=>e.eventType==="phase2.paused")).toHaveLength(1);
  // The parked generation is left alone by the ticker until it is reopened.
  await advanceProjectPipeline({db,services,generationId:g.id});
  expect(boardCalls).toBe(1);
  // Resuming reopens it, and the board that now files everything publishes.
  interrupted=false;
  const gen=(await db.pipeline.getGeneration(g.id))!;
  await db.pipeline.transitionGeneration(gen.id,gen.state,gen.fencingToken,"phase2_running");
  for(let i=0;i<10;i++){const r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.generation.state==="completed")break;}
  expect((await db.pipeline.getGeneration(g.id))?.state).toBe("completed");
  expect((await db.phase2.getCampaignByGeneration(g.id))?.state).toBe("published");
  await db.close();
 });
});

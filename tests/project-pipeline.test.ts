/** Durable unified project pipeline state-machine tests on real SQLite rows. */
import Database from "better-sqlite3";
import {describe,expect,it} from "vitest";
import {createSqlitePhase2Db} from "../src/db/phase2/sqlite-store.ts";
import {advanceProjectPipeline,type ProjectPipelineServices} from "../src/pipeline/project-pipeline.ts";

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
   async runPhase2(campaign,members){phase2Runs++;expect(members).toHaveLength(2);return{developerPackSha256:"ab".repeat(32),artifactDir:`/phase2/${campaign.id}`}},
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
 it("honors manual Phase2 trigger when autoPhase2 is disabled",async()=>{
  const db=createSqlitePhase2Db(new Database(":memory:"));
  const q=await db.pipeline.createQueue({projectId:"p2",evalQueueId:"eq2",name:"q",autoPhase2:false});const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});const item=await db.pipeline.addItem({generationId:g.id,evalId:"e",ordinal:1});
  const services:ProjectPipelineServices={async startEvalQueue(){return{started:true}},async pollEvalItem(item){return{state:"completed",runId:`run-${item.evalId}`,archiveId:`a-${item.evalId}`}},async startPhase1(){return{operationId:"p1"}},async getPhase1Status(){return{state:"published",resultVersionId:"rv",archiveViewId:"v"}},async runPhase2(){return{developerPackSha256:"a".repeat(64),artifactDir:"/p2"}},async publishFinalView(){return{finalArchiveViewId:"fv",manifestSha256:"b".repeat(64)}}};
  let r;for(let i=0;i<10;i++){r=await advanceProjectPipeline({db,services,generationId:g.id});if(r.waitingFor==="phase2_trigger")break}expect(r?.waitingFor).toBe("phase2_trigger");
  const done=await advanceProjectPipeline({db,services,generationId:g.id,trigger:"phase2"});expect(done.generation.state).toBe("completed");
  await db.close();
 });
});

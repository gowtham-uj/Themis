/** Unified project pipeline + black-box Phase-2 persistence round trips. */
import Database from "better-sqlite3";
import {describe,expect,it} from "vitest";
import {createSqlitePhase2Db} from "../src/db/phase2/sqlite-store.ts";

describe("Phase2 SQLite persistence",()=>{
 it("persists one project queue, ordered items, campaign membership and records",async()=>{
  const raw=new Database(":memory:"); const db=createSqlitePhase2Db(raw);
  const q=await db.pipeline.createQueue({projectId:"p1",evalQueueId:"eq1",name:"project-pipeline"});
  expect((await db.pipeline.getQueueByProject("p1"))?.id).toBe(q.id);
  const g=await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  const i1=await db.pipeline.addItem({generationId:g.id,evalId:"e1",ordinal:1});
  const i2=await db.pipeline.addItem({generationId:g.id,evalId:"e2",ordinal:2});
  expect((await db.pipeline.listItems(g.id,{cursor:null,limit:10})).items.map(x=>x.evalId)).toEqual(["e1","e2"]);
  const running=await db.pipeline.transitionGeneration(g.id,"draft",0,"eval_running");
  expect(running?.fencingToken).toBe(1);
  expect(await db.pipeline.transitionGeneration(g.id,"draft",0,"failed")).toBeNull();
  const sealed=await db.pipeline.updateItem(i1.id,"eval_pending",{state:"archive_sealed",runId:"r1",baseArchiveId:"a1"});
  expect(sealed?.runId).toBe("r1");
  const ev1=await db.pipeline.appendEvent({generationId:g.id,itemId:i1.id,operationId:"op1",eventType:"archive.sealed",payloadJson:"{}"});
  const ev2=await db.pipeline.appendEvent({generationId:g.id,itemId:i1.id,operationId:"op1",eventType:"archive.sealed",payloadJson:"{}"});
  expect(ev1.created).toBe(true); expect(ev2.created).toBe(false);
  const c=await db.phase2.createCampaign({projectId:"p1",pipelineGenerationId:g.id,sutFingerprint:"ab".repeat(32),ontologyVersion:"v1",membershipSha256:"cd".repeat(32),configJson:"{}"});
  await db.phase2.addMember({campaignId:c.id,pipelineItemId:i1.id,runId:"r1",phase1ResultVersionId:"rv1",phase1ArchiveViewId:"view1",validForAgentLearning:true,ordinal:1});
  await db.phase2.addMember({campaignId:c.id,pipelineItemId:i2.id,runId:"r2",phase1ResultVersionId:"rv2",phase1ArchiveViewId:"view2",validForAgentLearning:false,ordinal:2});
  expect((await db.phase2.listMembers(c.id,{cursor:null,limit:10})).items).toHaveLength(2);
  const rec1=await db.phase2.upsertRecord({campaignId:c.id,kind:"observation",signature:"TOOL_SEARCH_SELF_CONTEXT",owner:"agent_tooling",sourceOperationId:"obs1",payloadJson:"{}"});
  const rec2=await db.phase2.upsertRecord({campaignId:c.id,kind:"observation",sourceOperationId:"obs1",payloadJson:"{}"});
  expect(rec1.created).toBe(true);expect(rec2.created).toBe(false);
  expect((await db.phase2.listRecords(c.id,"observation",{cursor:null,limit:10})).items[0]?.signature).toBe("TOOL_SEARCH_SELF_CONTEXT");
  await db.close();
 });
 it("enforces one queue per project and one active generation",async()=>{
  const raw=new Database(":memory:");const db=createSqlitePhase2Db(raw);
  const q=await db.pipeline.createQueue({projectId:"p",evalQueueId:"eq",name:"q"});
  await expect(db.pipeline.createQueue({projectId:"p",evalQueueId:"eq2",name:"q2"})).rejects.toThrow();
  await db.pipeline.createGeneration({queueId:q.id,configJson:"{}"});
  await expect(db.pipeline.createGeneration({queueId:q.id,configJson:"{}"})).rejects.toThrow();
  await db.close();
 });
});

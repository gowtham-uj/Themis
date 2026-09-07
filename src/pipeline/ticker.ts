/**
 * Background pipeline driver.
 *
 * `advanceProjectPipeline` is a single bounded tick: it polls eval runs, starts
 * Phase 1 for sealed archives, and runs Phase 2 once every eval is judged.
 * Nothing called it on a schedule, so a started run stayed in `eval_running`
 * until someone POSTed `/advance` by hand. This ticks every project's current
 * generation so the console shows a run that actually moves.
 */
import {advanceProjectPipeline,type ProjectPipelineServices,type PipelineTrigger} from "./project-pipeline.js";
import type {Phase2Db} from "../db/phase2/contracts.js";

export interface PipelineTicker{stop():void}

/** Start a non-overlapping tick loop over every project's current generation. */
export function startPipelineTicker(input:{
 listProjectIds:()=>readonly string[];
 openDb:()=>Phase2Db;
 services:ProjectPipelineServices;
 intervalMs?:number;
 trigger?:PipelineTrigger;
 onError?:(err:unknown)=>void;
}):PipelineTicker{
 let stopped=false;
 // One generation at a time: Phase 2 runs a real model board inside advance,
 // so an overlapping tick would start a second campaign on the same rows.
 const inFlight=new Set<string>();
 const tick=async():Promise<void>=>{
  if(stopped)return;
  const db=input.openDb();
  try{
   for(const projectId of input.listProjectIds()){
    if(stopped)break;
    const queue=await db.pipeline.getQueueByProject(projectId);
    if(!queue||queue.status!=="running")continue;
    const gen=await db.pipeline.getCurrentGeneration(queue.id);
    if(!gen)continue;
    if(["completed","failed","cancelled","paused"].includes(gen.state))continue;
    if(inFlight.has(gen.id))continue;
    inFlight.add(gen.id);
    try{
     await advanceProjectPipeline({db,services:input.services,generationId:gen.id,trigger:input.trigger??"auto"});
    }catch(err){
     input.onError?.(err);
    }finally{
     inFlight.delete(gen.id);
    }
   }
  }catch(err){
   input.onError?.(err);
  }finally{
   await db.close().catch(()=>undefined);
  }
 };
 const timer=setInterval(()=>{void tick()},input.intervalMs??3000);
 timer.unref?.();
 void tick();
 return{stop(){stopped=true;clearInterval(timer)}};
}

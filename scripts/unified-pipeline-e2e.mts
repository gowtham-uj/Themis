/**
 * API-only unified pipeline E2E: project -> adapter (reapercode builtin) ->
 * two complex canonical evals -> eval queue -> start -> pipeline -> Phase1 ->
 * Phase2 -> final phase2/ archive views.
 *
 * Everything goes through the HTTP API (127.0.0.1:8080), exactly as a
 * developer would use the platform.
 */
const BASE = "http://127.0.0.1:8080";
function j(res:Response):Promise<any>{return res.json().catch(()=>({rawStatus:res.status}))}
async function api(method:string,path:string,body?:unknown){const r=await fetch(BASE+path,{method,headers:body?{"content-type":"application/json"}:undefined,body:body?JSON.stringify(body):undefined});return{status:r.status,body:await j(r)}}
function ok(r:{status:number;body:any},ctx:string){if(r.status<200||r.status>=300)throw new Error(`${ctx} -> ${r.status}: ${JSON.stringify(r.body).slice(0,400)}`);return r.body}

// Two deterministic canonical eval packages in the CURRENT platform schema.
const {pipelineEvalOne,pipelineEvalTwo}=await import("/work/agenteval/tests/helpers/pipeline-evals.ts");

const suffix=Date.now().toString(36);
const projectName=`unified-e2e-${suffix}`;
const proj=ok(await api("POST","/api/projects",{name:projectName,slug:`unified-e2e-${suffix}`,default_model:"deepseek-v4-flash",default_provider:"openai-compatible"}),"create project");
const projectId=proj.id;
console.log("project",projectId);

// Two canonical complex evals via the import-archive route (tar.gz, single-file layout).
const {decodePackageFiles}=await import("/work/agenteval/src/evals/package.js");
const {create:tarCreate}=await import("tar");
async function importEval(pkg:any,label:string){const files=decodePackageFiles(pkg);const {mkdtemp}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const {writeFile,readFile}=await import("node:fs/promises");const dir=await mkdtemp(join(tmpdir(),"pkg-import-"));const {mkdir}=await import("node:fs/promises");const {dirname}=await import("node:path");for(const [path,content] of files){const target=join(dir,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,content)}const tgz=join(tmpdir(),`${label}.tar.gz`);await tarCreate({gzip:true,file:tgz,cwd:dir},["."]);const buf=await readFile(tgz);const r=await fetch(`${BASE}/api/projects/${projectId}/evals:import-archive?format=tar.gz`,{method:"POST",body:buf});const body=await r.json().catch(()=>({rawStatus:r.status}));if(r.status<200||r.status>=300)throw new Error(`${label} import -> ${r.status}: ${JSON.stringify(body).slice(0,400)}`);return body}
const eval1=await importEval(pipelineEvalOne(),"eval1");
const eval2=await importEval(pipelineEvalTwo(),"eval2");
console.log("evals",eval1.id,eval2.id);

// ReaperCode is a built-in adapter.
const queueResp=ok(await api("POST",`/api/projects/${projectId}/queues`,{name:"unified-eval-queue",builtin_adapter_id:"reapercode",model:"deepseek-v4-flash",provider:"openai-compatible"}),"create eval queue");
const queueId=queueResp.queue.id;
console.log("eval queue",queueId);
await api("POST",`/api/projects/${projectId}/queues/${queueId}/items`,{task_id:eval1.id});
await api("POST",`/api/projects/${projectId}/queues/${queueId}/items`,{task_id:eval2.id});

// Create the unified pipeline bound to this eval queue.
const pipeline=ok(await api("POST",`/api/projects/${projectId}/pipeline`,{eval_queue_id:queueId,name:"unified-pipeline"}),"create pipeline");
console.log("pipeline queue",pipeline.id);

// Materialize a generation from the eval queue items.
const gen=ok(await api("POST",`/api/projects/${projectId}/pipeline/generation`,{}),"create generation");
console.log("generation",gen.id);

// Advance until completed or terminal.
for(let i=0;i<120;i++){
  const r=await api("POST",`/api/projects/${projectId}/pipeline/generation/${gen.id}/advance`,{trigger:"auto"});
  const b=r.body;
  if(b.generation?.state==="completed"||b.generation?.state==="failed"||b.generation?.state==="cancelled"){console.log("final",b.generation.state,b.waitingFor??"");break}
  if(i%5===0)console.log("tick",i,b.generation?.state,b.items?.map((x:any)=>`${x.evalId}:${x.state}`).join(","));
  await new Promise(x=>setTimeout(x,1500));
}

const status=ok(await api("GET",`/api/projects/${projectId}/pipeline/generation/${gen.id}`),"get generation");
console.log("STATUS",JSON.stringify(status,null,2).slice(0,2000));
if(status.campaign){const campaign=ok(await api("GET",`/api/projects/${projectId}/pipeline/campaign/${status.campaign.id}`),"get campaign");console.log("CAMPAIGN",JSON.stringify(campaign,null,2).slice(0,3000))}

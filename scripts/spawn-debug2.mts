import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { loadPromptAsset } from "../src/judge/pi/runtime.js";

const orch = await loadPromptAsset("themis-orchestrator.md");
const piBin = "/work/agenteval/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const workDir = "/tmp/claude/spawn2-work";
const agentDir = "/tmp/claude/spawn2-agent";
await mkdir(workDir, {recursive:true}); await mkdir(agentDir,{recursive:true});
// fresh models.json
import { writePiModelsJson, writePiSubagentDefs } from "../src/judge/pi/runtime.js";
await writePiModelsJson(agentDir, { baseUrl: process.env.OPENAI_BASE_URL!, apiKey: process.env.OPENAI_API_KEY!, model: "deepseek-v4-flash", reasoningEffort: "medium" });
const [k,l,m] = await Promise.all([loadPromptAsset("kratos.md"),loadPromptAsset("logos.md"),loadPromptAsset("minos.md")]);
await writePiSubagentDefs(agentDir, {kratos:k,logos:l,minos:m});

const argv = [
  piBin,"--mode","json","-p",`${orch}\n\nCASE BRIEF:\nReply OK`,
  "--provider","themis-proxy","--model","deepseek-v4-flash","--thinking","medium",
  "--tools","subagent,read_evidence,write_to_yaml_template,read_scratchpad,file_tangent,petition,grant,channel,web_search",
  "--extension","/work/agenteval/node_modules/pi-subagents/index.ts",
  "--extension","/work/agenteval/node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts",
  "--extension","/work/agenteval/src/judge/tools/themis-tools-extension.ts",
  "--session-dir", join(workDir,".pi"), "--offline","--no-context-files",
];
const env = {...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE:"1", THEMIS_JUDGE_DIR:workDir, THEMIS_ARCHIVE_DIR:"/tmp"};
const child = spawn(process.execPath, argv, {env});
let out="", err="";
child.stdout.on("data", c=>{out+=c});
child.stderr.on("data", c=>{err+=c; process.stderr.write("STDERR: "+c.toString().slice(0,200)+"\n");});
child.on("close", code=>{ console.log("CLOSE",code); console.log("OUTLEN",out.length); });

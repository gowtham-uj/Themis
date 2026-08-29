import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

const piBin = "/work/agenteval/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const subagentsExt = "/work/agenteval/node_modules/pi-subagents/index.ts";
const dynamicExt = "/work/agenteval/node_modules/@quintinshaw/pi-dynamic-workflows/extensions/workflow.ts";
const toolsExt = "/work/agenteval/src/judge/tools/themis-tools-extension.ts";
const workDir = "/tmp/claude/spawn-debug-work";
const agentDir = "/tmp/claude/spawn-debug-agent";
await mkdir(workDir, { recursive: true });
await mkdir(agentDir, { recursive: true });

const argv = [
  piBin, "--mode","json","-p","Reply OK","--provider","themis-proxy","--model","deepseek-v4-flash",
  "--thinking","medium","--system-prompt","You are a test orchestrator. Be brief.",
  "--tools","subagent,read_evidence,write_to_yaml_template,read_scratchpad,file_tangent,petition,grant,channel,web_search",
  "--extension",subagentsExt,"--extension",dynamicExt,"--extension",toolsExt,
  "--session-dir", join(workDir,".pi"), "--offline","--no-context-files",
];
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", THEMIS_JUDGE_DIR: workDir, THEMIS_ARCHIVE_DIR: "/tmp" };
const outS = createWriteStream(join(workDir,"pi-stdout.jsonl"));
const errS = createWriteStream(join(workDir,"pi-stderr.log"));
const child = spawn(process.execPath, argv, { env });
let outBuf="", errBuf="";
child.stdout.on("data", c => { outBuf += c; outS.write(c); });
child.stderr.on("data", c => { errBuf += c; errS.write(c); });
child.on("close", code => {
  console.log("EXIT", code);
  console.log("ERR", JSON.stringify(errBuf.slice(0,400)));
  console.log("OUT", JSON.stringify(outBuf.slice(0,200)));
});
child.on("error", e => console.log("SPAWN_ERR", e.message));

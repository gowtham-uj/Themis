/**
 * Suite-format E2E: create each eval one-by-one via the API, build the
 * reaperCode_eval project + reaper adapter, run a representative subset of the
 * 10 simple coding-agent evals through the real queue, then auto-judge and
 * produce the report. Exercises the real eval-creation flow per eval.
 *
 * Run:
 *   NEURALWATT_API_KEY=... AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 \
 *   npx tsx tests/suite-e2e-reapercode-api.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { createServer } from "../src/api/server.js";
import { decodeEvalArchiveFile, splitSuiteTasks } from "../src/evals/archive.js";
import { AGENT_TASK_WORKSPACE } from "../src/evals/package.js";

setGlobalDispatcher(new Agent({ headersTimeout: 60 * 60_000, bodyTimeout: 60 * 60_000, connectTimeout: 60_000 }));

const MODEL = "deepseek-v4-flash";
const PROVIDER = "nuralwatt";
const REAPER_REPO = process.env.REAPERCODE_REPO ?? "/work/_inspect/reaper";
const REAPER_REF = process.env.REAPERCODE_REF ?? "2d6aa072084476746bcf287c8c0004e94799248e";
const SUITE_ZIP = "/work/reaper-simple-coding-agent-evals.zip";

if (!process.env.NEURALWATT_API_KEY) throw new Error("NEURALWATT_API_KEY required; the real E2E never substitutes a mock");

const dataDir = await mkdtemp(join(tmpdir(), "agenteval-suite-e2e-"));
const api = createServer({ dataDir, outboundDispatcher: null });
const port = await api.listen(0);
const base = `http://127.0.0.1:${port}`;

// Decode the suite into per-task file maps.
const decodedUpload = await decodeEvalArchiveFile(SUITE_ZIP, "zip");
const decoded = new Map(Object.entries(decodedUpload.files).map(([k, v]) => [k, Buffer.from(typeof v === "string" ? v : v.content, "base64")]));
const taskFiles = splitSuiteTasks(decoded);

try {
  const project = await json("POST", "/api/projects", {
    name: "reaperCode_eval",
    slug: `reapercode-eval-${Date.now().toString(36)}`,
    description: "Suite-format eval project per-project eval store",
    default_model: MODEL,
    default_provider: PROVIDER,
  });
  const projectId = string(project.id, "project.id");

  // ---- reaper adapter (project-owned) ----
  const image = "localhost/agenteval-reapercode-suite-e2e:latest";
  const adapterCreated = await json("POST", `/api/projects/${projectId}/adapters`, {
    agent_id: "reapercode",
    name: "ReaperCode CLI",
    description: "Real ReaperCode git source built and driven as a CLI tool",
    format_version: 1,
    image,
    source_repo: REAPER_REPO,
    source_ref: REAPER_REF,
    containerfile: reaperContainerfile(),
    default_provider: PROVIDER,
    default_model: MODEL,
    command: reaperCommandTemplate(),
    connection_check: reaperConnectionTemplate(),
    provider_config: { credentialEnv: { nuralwatt: { NURALWATT_API_KEY: "NEURALWATT_API_KEY" } } },
    parser_kind: "reapercode-jsonl",
    evidence: {
      paths: ["task/.reaper", "task/.agenteval/reaper-result.json", "task/.agenteval/reaper-stderr.log"],
      required_paths: ["task/.reaper/runs", "task/.agenteval/reaper-result.json"],
    },
  });
  const adapterId = string(object(adapterCreated.adapter, "adapter").id, "adapter.id");
  const built = await json("POST", `/api/projects/${projectId}/adapters/${adapterId}/build`);
  const builtAdapter = object(built.adapter, "built.adapter");
  assert(builtAdapter.buildStatus === "ready", "adapter build must be ready");

  // ---- create each eval one-by-one via the API (real creation flow) ----
  const createdIds: string[] = [];
  for (const [key, files] of taskFiles) {
    const upload = { files: {} as Record<string, unknown> };
    for (const [path, buf] of files) upload.files[path] = { encoding: "base64", content: buf.toString("base64") };
    const created = await json("POST", `/api/projects/${projectId}/evals`, upload);
    createdIds.push(string(created.id, "eval.id"));
    const taskId = string(created.id, "created.id");
    assert(string(created.category_name, "category_name") === "simple", `eval ${key} must be category simple`);
    assert(string(created.agent_category, "agent_category") === "coding", `eval ${key} must be coding`);
    console.log("created eval", key, taskId, "category=simple");
  }
  // Confirm the queue exercises multiple languages (heterogeneous suite evals
  // sharing one persistent container — the core of the fat-base model).
  const languages = new Set<string>();
  for (const [, files] of taskFiles) {
    const toml = files.get("task.toml")?.toString("utf8") ?? "";
    const m = toml.match(/^language\s*=\s*"([^"]+)"/m);
    if (m) languages.add(m[1]);
  }
  console.log("queue language heterogeneity:", [...languages].join(", "));
  assert(languages.size >= 2, `expected >=2 languages for heterogeneity, got ${languages.size}`);
  assert(createdIds.length === taskFiles.size, `expected ${taskFiles.size} evals, got ${createdIds.length}`);

  // ---- queue + add a representative subset ----
  const queueView = await json("POST", `/api/projects/${projectId}/queues`, {
    name: "simple coding evals",
    description: "Suite-format coding evals through reaper",
    model: MODEL,
    provider: PROVIDER,
    judge_model: MODEL,
    judge_provider: "neuralwatt",
    auto_judge: true,
    network_policy: "allow",
  });
  const queueId = string(object(queueView.queue, "queue").id, "queue.id");
  for (const createdId of createdIds) {
    await json("POST", `/api/projects/${projectId}/queues/${queueId}/items`, { eval_id: createdId, repeats: 1 });
  }

  // ---- spawn container; run evals sequentially; auto-judge on drain ----
  const spawned = await json("PUT", `/api/projects/${projectId}/queues/${queueId}/container`);
  const runtimeContainerId = string(spawned.runtime_container_id, "runtime_container_id");
  const batchId = string(spawned.batch_id, "batch_id");
  const completed = await waitForQueue(projectId, queueId, 30 * 60_000);
  assert(completed.queue.status === "completed", `queue status ${String(completed.queue.status)}`);
  assert(object(completed.container, "container").runtimeContainerId === runtimeContainerId, "one persistent container");
  const runs = array(completed.runs, "runs");
  assert(runs.length === taskFiles.size, `expected ${taskFiles.size} runs`);
  for (const rawRun of runs) {
    const run = object(rawRun, "run");
    assert(run.status === "completed", `run ${run.id} status=${run.status}`);
    const archive = await json("GET", `/api/evals/${string(run.id, "run.id")}/archive`);
    assert(object(archive.verification, "verification").ok === true, `archive verification failed for ${run.id}`);
  }

  // ---- auto-judge produces the report ----
  const analyses = await json("GET", `/api/projects/${projectId}/queues/${queueId}/analyses`);
  const analysisList = array(analyses.analyses, "analyses");
  assert(analysisList.length >= 1, "auto-judge must have run at least one analysis");
  const analysis = object(analysisList[analysisList.length - 1], "analysis");
  assert(analysis.status === "completed", `analysis status ${String(analysis.status)} ${String(analysis.error ?? "")}`);
  const analysisId = string(analysis.id, "analysis.id");
  const report = await (await fetch(`${base}/api/projects/${projectId}/queues/${queueId}/analyses/${analysisId}/report`)).text();
  assert(report.length > 8_000, `report too thin (${report.length})`);
  for (const section of ["Cross-eval themes", "Per-eval verdicts and narratives", "Owner backlogs", "agent backlog", "platform backlog", "judge backlog", "eval backlog"]) {
    assert(report.includes(section), `report missing ${section}`);
  }

  console.log(JSON.stringify({
    ok: true,
    projectId,
    queueId,
    batchId,
    runtimeContainerId,
    evalCount: createdIds.length,
    analysisId,
    reportBytes: report.length,
  }, null, 2));
} finally {
  await api.close().catch(() => undefined);
  if (process.env.KEEP_AGENTEVAL_E2E_DATA !== "1") await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  else console.log(`kept E2E data at ${dataDir}`);
}

async function json(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${path} failed ${res.status}: ${text.slice(0, 2000)}`);
  return parsed;
}

async function waitForQueue(projectId, queueId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await json("GET", `/api/projects/${projectId}/queues/${queueId}`);
    if (["completed", "failed", "tainted", "stopped"].includes(String(view.queue.status))) return view;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`queue ${queueId} did not become terminal in ${timeoutMs}ms`);
}

function reaperStreamingScript() {
  return `set -uo pipefail
mkdir -p /workspace/task/.agenteval
rm -rf /workspace/task/.reaper /workspace/task/.agenteval/reaper-result.json /workspace/task/.agenteval/reaper-stderr.log
reaper exec run --prompt "$1" --workspace /workspace/task --provider "$2" --model "$3" --max-tokens 12000 --timeout-ms 600000 --json > /workspace/task/.agenteval/reaper-result.json 2> /workspace/task/.agenteval/reaper-stderr.log &
agent=$!
trajectory=""
for _ in $(seq 1 1200); do
  trajectory=$(find /workspace/task/.reaper -name reaper-trajectory.jsonl -type f 2>/dev/null | head -1)
  [ -n "$trajectory" ] && break
  kill -0 "$agent" 2>/dev/null || break
  sleep 0.25
done
if [ -n "$trajectory" ]; then
  tail --pid="$agent" -n +1 -F "$trajectory" & tailer=$!
  wait "$agent"; rc=$?
  wait "$tailer" 2>/dev/null || true
else
  wait "$agent"; rc=$?
  trajectory=$(find /workspace/task/.reaper -name reaper-trajectory.jsonl -type f 2>/dev/null | head -1)
  [ -n "$trajectory" ] && cat "$trajectory"
fi
exit "$rc"`;
}

function reaperCommandTemplate() {
  return { argv: ["/bin/bash", "-lc", reaperStreamingScript(), "--", "{{prompt}}", "{{provider}}", "{{model}}"], env: { REAPER_DEV: "1" } };
}
function reaperConnectionTemplate() {
  return { argv: ["/bin/bash", "-lc", reaperStreamingScript(), "--", "Reply with exactly AGENTEVAL_CONNECTION_OK. Do not use tools.", "{{provider}}", "{{model}}"], env: { REAPER_DEV: "1" }, cwd: "/workspace", timeout_ms: 180_000 };
}
function reaperContainerfile() {
  return `FROM docker.io/library/node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/reapercode
COPY . .
RUN node -e "const fs=require('fs');const p='src/model/provider/catalog.ts';let s=fs.readFileSync(p,'utf8');s=s.replace(/(id: \"nuralwatt\"[\\s\\S]*?models: \\[)/,'$1\"deepseek-v4-flash\", ');fs.writeFileSync(p,s);"
RUN npm ci && npm run build && ln -s /opt/reapercode/bin/reaper /usr/local/bin/reaper
CMD ["reaper", "--help"]`;
}

function object(v, n) { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${n} not an object`); return v; }
function array(v, n) { if (!Array.isArray(v)) throw new Error(`${n} not an array`); return v; }
function string(v, n) { if (typeof v !== "string" || !v) throw new Error(`${n} not a string`); return v; }
function assert(c, m) { if (!c) throw new Error(m); }

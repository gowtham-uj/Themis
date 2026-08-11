/**
 * Required acceptance flow: API-only, real ReaperCode, real NeuralWatt
 * deepseek-v4-flash for both agent and queue judge, no mocks or intervention.
 *
 * Run:
 *   NEURALWATT_API_KEY=... AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 \
 *   npx tsx tests/e2e-reapercode-api.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { createServer } from "../src/api/server.js";
import type { EvalPackageUpload } from "../src/evals/package.js";
import {
  evalOnePackage,
  evalTwoPackage,
} from "./helpers/reapercode-e2e-packages.js";

// The queue-container spawn endpoint blocks while it starts the persistent
// Podman container and runs the real adapter connection check (real reaper +
// real NeuralWatt model). That can exceed undici's default ~300s headers
// timeout, so give every E2E fetch a long headers/body timeout.
setGlobalDispatcher(
  new Agent({
    headersTimeout: 60 * 60_000,
    bodyTimeout: 60 * 60_000,
    connectTimeout: 60_000,
  }),
);

const MODEL = "deepseek-v4-flash";
const PROVIDER = "nuralwatt";
const REAPER_REPO = process.env.REAPERCODE_REPO ?? "/work/_inspect/reaper";
const REAPER_REF = process.env.REAPERCODE_REF ?? "2d6aa072084476746bcf287c8c0004e94799248e";

if (!process.env.NEURALWATT_API_KEY) {
  throw new Error(
    "NEURALWATT_API_KEY is required by /work/model_setup.md; the real E2E never substitutes a mock",
  );
}

const dataDir = await mkdtemp(join(tmpdir(), "agenteval-reapercode-api-e2e-"));
const api = createServer({ dataDir, outboundDispatcher: null });
const port = await api.listen(0);
const base = `http://127.0.0.1:${port}`;

try {
  const project = await json("POST", "/api/projects", {
    name: "ReaperCode DeepSeek V4 Flash acceptance",
    slug: `reapercode-dsv4-${Date.now().toString(36)}`,
    description: "API-only real-agent queue acceptance project",
    default_model: MODEL,
    default_provider: PROVIDER,
  });
  const projectId = string(project.id, "project.id");

  // Stable image tag so podman reuses the build cache across runs (the
  // Containerfile + source ref are identical), making iteration fast.
  const image = "localhost/agenteval-reapercode-e2e:latest";
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
    provider_config: {
      credentialEnv: {
        nuralwatt: {
          NURALWATT_API_KEY: "NEURALWATT_API_KEY",
        },
      },
    },
    parser_kind: "reapercode-jsonl",
    evidence: {
      paths: [".reaper", ".agenteval/reaper-result.json", ".agenteval/reaper-stderr.log"],
      required_paths: [".reaper/runs", ".agenteval/reaper-result.json"],
    },
  });
  const adapter = object(adapterCreated.adapter, "adapter");
  const adapterId = string(adapter.id, "adapter.id");

  const built = await json(
    "POST",
    `/api/projects/${projectId}/adapters/${adapterId}/build`,
  );
  const builtAdapter = object(built.adapter, "built.adapter");
  assert(builtAdapter.buildStatus === "ready", "adapter build must be ready");
  assert(typeof builtAdapter.builtCommit === "string", "adapter build must pin git commit");
  assert(typeof builtAdapter.builtImageId === "string", "adapter build must record image id");

  const evalOne = await json("POST", `/api/projects/${projectId}/evals`, evalOneSpec());
  const evalTwo = await json("POST", `/api/projects/${projectId}/evals`, evalTwoSpec());
  const evalOneId = string(evalOne.id, "evalOne.id");
  const evalTwoId = string(evalTwo.id, "evalTwo.id");

  const queueView = await json("POST", `/api/projects/${projectId}/queues`, {
    name: "two coding evals",
    description: "Sequential same-pod ReaperCode acceptance queue",
    model: MODEL,
    provider: PROVIDER,
    judge_model: MODEL,
    judge_provider: "neuralwatt",
    auto_judge: false,
    network_policy: "allow",
  });
  const queue = object(queueView.queue, "queue");
  const queueId = string(queue.id, "queue.id");
  const loaded = await json(
    "POST",
    `/api/projects/${projectId}/queues/${queueId}/items:load-category`,
    { category_name: "reapercode-acceptance", repeats: 1, enabled: true },
  );
  assert(array(loaded.added, "category load added").length === 2, "category loading must add both evals");
  assert(
    array(loaded.added, "category load added").map((entry) => string(object(entry, "queue item").taskId, "queue item.taskId")).includes(evalOneId),
    "category loading must include eval one",
  );
  assert(
    array(loaded.added, "category load added").map((entry) => string(object(entry, "queue item").taskId, "queue item.taskId")).includes(evalTwoId),
    "category loading must include eval two",
  );

  const spawned = await json(
    "PUT",
    `/api/projects/${projectId}/queues/${queueId}/container`,
  );
  const runtimeContainerId = string(
    spawned.runtime_container_id,
    "spawned.runtime_container_id",
  );
  const batchId = string(spawned.batch_id, "spawned.batch_id");

  const completed = await waitForQueue(projectId, queueId, 30 * 60_000);
  const finalQueue = object(completed.queue, "completed.queue");
  assert(finalQueue.status === "completed", `queue status is ${String(finalQueue.status)}`);
  const container = object(completed.container, "completed.container");
  assert(
    container.runtimeContainerId === runtimeContainerId,
    "both evals must use the same persistent runtime container",
  );
  const runs = array(completed.runs, "completed.runs");
  assert(runs.length === 2, `expected 2 runs, got ${runs.length}`);
  for (const rawRun of runs) {
    const run = object(rawRun, "run");
    assert(run.status === "completed", `run ${String(run.id)} status=${String(run.status)}`);
    assert(
      run.queueContainerId === spawned.queue_container_id,
      "every run must point to the same queue container row",
    );
    const runId = string(run.id, "run.id");
    const archive = await json("GET", `/api/evals/${runId}/archive`);
    const verification = object(archive.verification, "archive.verification");
    assert(verification.ok === true, `archive verification failed for ${runId}`);
    const manifest = object(verification.manifest, "archive.verification.manifest");
    const files = array(manifest.files, "archive.verification.manifest.files")
      .map((entry) => string(object(entry, "archive file").path, "archive file.path"));
    for (const required of [
      "run.json",
      "run-metrics.json",
      "evidence-integrity.json",
      "verifier.json",
      "diff.patch",
      "events.jsonl",
    ]) {
      assert(files.includes(required), `archive ${runId} missing ${required}`);
    }
    assert(
      !files.some((path) => path.startsWith("solution/") || path.startsWith("tests/") || path.startsWith("validation/")),
      `archive ${runId} leaked protected eval package content`,
    );
  }

  // Privileged bridge remains live after drain. Decode exact framed stdout/stderr.
  const bridge = await execBridge(projectId, queueId, "id -u; printf bridge-out; printf bridge-err >&2");
  assert(bridge.stdout.includes("0\nbridge-out"), "introspection must execute as root and stream stdout");
  assert(bridge.stderr === "bridge-err", "introspection must preserve exact stderr bytes");
  assert(
    bridge.control.exit_code === 0,
    `introspection command must exit 0: ${JSON.stringify(bridge.control)}`,
  );

  const analysisCreate = await fetch(
    `${base}/api/projects/${projectId}/queues/${queueId}/analyses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch_id: batchId,
        all: true,
        judge_model: MODEL,
        judge_provider: "neuralwatt",
        judge_prompt:
          "Be exacting. Evaluate whether ReaperCode solved and verified each task, identify cross-eval reliability defects, and propose concrete agent-level fixes with verification sets.",
        judge_params: { maxTokens: 16384 },
      }),
    },
  );
  const analysisCreateText = await analysisCreate.text();
  assert(
    analysisCreate.status === 202,
    `analysis create must be async 202 (got ${analysisCreate.status}): ${analysisCreateText}`,
  );
  const analysisCreateBody = JSON.parse(analysisCreateText) as { analysis: { id: string } };
  const analysisId = string(analysisCreateBody.analysis.id, "analysis.id");

  // Poll the analysis detail endpoint until it reaches terminal state; the 202
  // must have returned immediately (judge runs detached in the background).
  const analysis = await waitForAnalysis(projectId, queueId, analysisId, 10 * 60 * 1000);
  assert(analysis.status === "completed", `queue judge did not complete: ${String(analysis.status)} ${String(analysis.error ?? "")}`);
  const analysesBase = `/api/projects/${projectId}/queues/${queueId}/analyses`;
  const analysisRoot = `${analysesBase}/${analysisId}`;

  assert(
    string(analysis.systemPromptVersion, "analysis.systemPromptVersion").startsWith("2-queue-pi-"),
    "queue analysis must use the versioned custom judge prompt through PI",
  );
  const judgeEventsResponse = await fetch(`${base}${analysisRoot}/events`);
  assert(judgeEventsResponse.status === 200, `judge events HTTP ${judgeEventsResponse.status}`);
  const judgeEvents = await judgeEventsResponse.text();
  assert(judgeEvents.includes('"type":"agent_start"'), "PI judge trace must contain agent_start");
  assert(judgeEvents.includes('"type":"tool_execution_start"'), "PI judge must use custom tools");
  assert(judgeEvents.includes("preflight_queue_analysis"), "PI judge must preflight the complete v2 payload");
  assert(judgeEvents.includes("submit_queue_analysis"), "PI judge must submit the preflight token");
  assert(
    judgeEvents.split("submit_queue_analysis").length - 1 >= 1,
    "PI judge must perform token-based final submission",
  );

  const transcriptResponse = await fetch(`${base}${analysisRoot}/transcript`);
  assert(transcriptResponse.status === 200, `PI transcript HTTP ${transcriptResponse.status}`);
  const transcript = object(await transcriptResponse.json(), "PI transcript");
  assert(transcript.engine === "pi", "queue judge transcript must identify PI as its engine");
  assert(Array.isArray(transcript.messages), "PI transcript must retain the complete message history");

  const verdictResponse = await fetch(`${base}${analysisRoot}/verdict`);
  assert(verdictResponse.status === 200, `verdict HTTP ${verdictResponse.status}`);
  const verdict = object(await verdictResponse.json(), "queue verdict");
  assert(Array.isArray(verdict.perEval) && verdict.perEval.length === 2, "judge must emit both eval verdicts");
  for (const rawEntry of verdict.perEval) {
    const entry = object(rawEntry, "per-eval verdict");
    const narrative = object(entry.narrative, "per-eval narrative");
    assert(narrative.schemaVersion === 1, "every eval narrative must use schema v1");
    assert(array(narrative.executionAnalysis, "narrative.executionAnalysis").length > 0, "narrative must explain execution");
  }
  const queueAnalysis = object(verdict.queueAnalysis, "queueAnalysis");
  assert(queueAnalysis.schemaVersion === 2, "queue analysis must use schema v2");
  assert(Array.isArray(queueAnalysis.improvementPlan), "queue analysis must contain the improvement plan");

  for (const rawRun of runs) {
    const runId = string(object(rawRun, "run").id, "run.id");
    const metrics = await json("GET", `/api/evals/${runId}/metrics`);
    assert(metrics.schema_version === 1, `metrics ${runId} must use schema v1`);
    const execution = object(metrics.execution, "metrics.execution");
    assert(object(execution.measurements, "metrics.execution.measurements").tool_calls !== undefined, "execution metrics must include tool_calls");
    const outcome = object(metrics.outcome, "metrics.outcome");
    const reward = outcome.officialReward as number;
    assert(reward === 0 || reward === 1, `run ${runId} officialReward must be binary (got ${String(reward)})`);
  }

  const reportResponse = await fetch(`${base}${analysisRoot}/report`);
  assert(reportResponse.status === 200, `report HTTP ${reportResponse.status}`);
  const report = await reportResponse.text();
  assert(report.length > 8_000, `report is too thin (${report.length} bytes)`);
  for (const required of [
    "Cross-eval themes",
    "Reliability",
    "Ranked observed defects",
    "Subsystem attribution",
    "Per-eval verdicts and narratives",
    "Execution timeline",
    "Evidence boundaries",
    "Owner backlogs",
    "agent backlog",
    "platform backlog",
    "judge backlog",
    "eval backlog",
  ]) {
    assert(report.includes(required), `report missing quality section: ${required}`);
  }

  // Standalone invocation: analyze a single eval by explicit run_ids (judge can
  // be driven directly from a chosen archive set, independent of the queue link).
  const twoRunIds = array(completed.runs, "completed.runs").map((rawRun) => string(object(rawRun, "run").id, "run.id"));
  const standaloneCreate = await fetch(`${base}${analysesBase}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      batch_id: batchId,
      run_ids: [twoRunIds[0]!],
      judge_model: MODEL,
      judge_provider: "neuralwatt",
      judge_prompt: "Exact single-eval judge. Did ReaperCode repair and verify the arithmetic task?",
      judge_params: { maxTokens: 12288, timeoutMs: 5 * 60 * 1000 },
    }),
  });
  assert(standaloneCreate.status === 202, `standalone analysis create must be 202`);
  const standaloneId = string(((await standaloneCreate.json()) as { analysis: { id: string } }).analysis.id, "standalone analysis.id");
  const standaloneView = await waitForAnalysis(projectId, queueId, standaloneId, 10 * 60 * 1000);
  assert(
    standaloneView.status === "completed",
    `standalone judge did not complete: ${String(standaloneView.status)} ${String(standaloneView.error ?? "")}`,
  );
  const standaloneResponse = await fetch(`${base}${analysesBase}/${standaloneId}/verdict`);
  assert(standaloneResponse.status === 200, `standalone verdict HTTP ${standaloneResponse.status}`);
  const standaloneVerdict = object(await standaloneResponse.json(), "standalone verdict");
  assert(Array.isArray(standaloneVerdict.perEval) && standaloneVerdict.perEval.length === 1, "standalone judge must emit exactly one verdict");

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId,
        adapterId,
        queueId,
        batchId,
        runtimeContainerId,
        runIds: runs.map((entry) => object(entry, "run").id),
        analysisId,
        reportBytes: report.length,
      },
      null,
      2,
    ),
  );
} finally {
  await api.close().catch(() => undefined);
  if (process.env.KEEP_AGENTEVAL_E2E_DATA !== "1") {
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    console.log(`kept E2E data at ${dataDir}`);
  }
}

async function json(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 2000)}`);
  }
  return parsed;
}

async function waitForAnalysis(
  projectId: string,
  queueId: string,
  analysisId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/api/projects/${projectId}/queues/${queueId}/analyses/${analysisId}`,
    );
    assert(response.status === 200, `analysis detail HTTP ${response.status}`);
    const view = object((await response.json()).analysis, "analysis");
    if (["completed", "failed"].includes(String(view.status))) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`analysis ${analysisId} did not become terminal within ${timeoutMs}ms`);
}

async function waitForQueue(
  projectId: string,
  queueId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await json("GET", `/api/projects/${projectId}/queues/${queueId}`);
    const queue = object(view.queue, "queue");
    if (["completed", "failed", "tainted", "stopped"].includes(String(queue.status))) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`queue ${queueId} did not become terminal within ${timeoutMs}ms`);
}

async function execBridge(projectId: string, queueId: string, command: string) {
  const response = await fetch(
    `${base}/api/projects/${projectId}/queues/${queueId}/container/exec`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, timeout_ms: 30_000 }),
    },
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(
    response.status === 200,
    `bridge HTTP ${response.status}: ${bytes.toString("utf8").slice(0, 500)}`,
  );
  let offset = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let control: Record<string, unknown> = {};
  while (offset < bytes.length) {
    assert(offset + 5 <= bytes.length, "truncated bridge frame header");
    const channel = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    offset += 5;
    assert(offset + length <= bytes.length, "truncated bridge frame payload");
    const payload = bytes.subarray(offset, offset + length);
    offset += length;
    if (channel === 1) stdout.push(payload);
    else if (channel === 2) stderr.push(payload);
    else if (channel === 3) control = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    else if (channel === 4) throw new Error(`bridge stream error: ${payload.toString("utf8")}`);
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    control,
  };
}

function reaperCommandTemplate() {
  return {
    argv: [
      "/bin/bash",
      "-lc",
      reaperStreamingScript(),
      "--",
      "{{prompt}}",
      "{{provider}}",
      "{{model}}",
    ],
    env: {
      REAPER_DEV: "1",
    },
  };
}

function reaperConnectionTemplate() {
  return {
    argv: [
      "/bin/bash",
      "-lc",
      reaperStreamingScript(),
      "--",
      "Reply with exactly AGENTEVAL_CONNECTION_OK. Do not use tools.",
      "{{provider}}",
      "{{model}}",
    ],
    env: {
      REAPER_DEV: "1",
    },
    cwd: "/workspace",
    timeout_ms: 180_000,
  };
}

function reaperStreamingScript(): string {
  return `set -uo pipefail
mkdir -p /workspace/.agenteval
rm -rf /workspace/.reaper /workspace/.agenteval/reaper-result.json /workspace/.agenteval/reaper-stderr.log
reaper exec run --prompt "$1" --workspace /workspace --provider "$2" --model "$3" --max-tokens 12000 --timeout-ms 600000 --json > /workspace/.agenteval/reaper-result.json 2> /workspace/.agenteval/reaper-stderr.log &
agent=$!
trajectory=""
for _ in $(seq 1 1200); do
  trajectory=$(find /workspace/.reaper -name reaper-trajectory.jsonl -type f 2>/dev/null | head -1)
  [ -n "$trajectory" ] && break
  kill -0 "$agent" 2>/dev/null || break
  sleep 0.25
done
if [ -n "$trajectory" ]; then
  tail --pid="$agent" -n +1 -F "$trajectory" &
  tailer=$!
  wait "$agent"; rc=$?
  wait "$tailer" 2>/dev/null || true
else
  wait "$agent"; rc=$?
  trajectory=$(find /workspace/.reaper -name reaper-trajectory.jsonl -type f 2>/dev/null | head -1)
  [ -n "$trajectory" ] && cat "$trajectory"
fi
exit "$rc"`;
}

function reaperContainerfile(): string {
  return `FROM docker.io/library/node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/reapercode
COPY . .
# The nuralwatt provider catalog does not list deepseek-v4-flash; register it
# as the first model of that provider before building so reaper can select it.
RUN node -e "const fs=require('fs');const p='src/model/provider/catalog.ts';let s=fs.readFileSync(p,'utf8');s=s.replace(/(id: \"nuralwatt\"[\\s\\S]*?models: \\[)/,'$1\"deepseek-v4-flash\", ');fs.writeFileSync(p,s);"
RUN npm ci && npm run build && ln -s /opt/reapercode/bin/reaper /usr/local/bin/reaper
CMD ["reaper", "--help"]
`;
}

function evalOneSpec(): EvalPackageUpload {
  return evalOnePackage();
}

function evalTwoSpec(): EvalPackageUpload {
  return evalTwoPackage();
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is not an array`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is not a string`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

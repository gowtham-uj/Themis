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
import { createServer } from "../src/api/server.js";

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

  const image = `localhost/agenteval-reapercode-e2e:${Date.now().toString(36)}`;
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
  await json("POST", `/api/projects/${projectId}/queues/${queueId}/items`, {
    eval_id: evalOneId,
    repeats: 1,
  });
  await json("POST", `/api/projects/${projectId}/queues/${queueId}/items`, {
    eval_id: evalTwoId,
    repeats: 1,
  });

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
    const archive = await json("GET", `/api/evals/${string(run.id, "run.id")}/archive`);
    const verification = object(archive.verification, "archive.verification");
    assert(verification.ok === true, `archive verification failed for ${String(run.id)}`);
  }

  // Privileged bridge remains live after drain. Decode exact framed stdout/stderr.
  const bridge = await execBridge(projectId, queueId, "id -u; printf bridge-out; printf bridge-err >&2");
  assert(bridge.stdout.includes("0\nbridge-out"), "introspection must execute as root and stream stdout");
  assert(bridge.stderr === "bridge-err", "introspection must preserve exact stderr bytes");
  assert(bridge.control.exit_code === 0, "introspection command must exit 0");

  const analysisResult = await json(
    "POST",
    `/api/projects/${projectId}/queues/${queueId}/analyses`,
    {
      batch_id: batchId,
      all: true,
      judge_model: MODEL,
      judge_provider: "neuralwatt",
      judge_prompt:
        "Be exacting. Evaluate whether ReaperCode solved and verified each task, identify cross-eval reliability defects, and propose concrete agent-level fixes with verification sets.",
      judge_params: { maxTokens: 16384 },
    },
  );
  assert(analysisResult.status === "completed", `analysis failed: ${String(analysisResult.error)}`);
  const analysis = object(analysisResult.analysis, "analysis");
  const analysisId = string(analysis.id, "analysis.id");

  assert(
    string(analysis.systemPromptVersion, "analysis.systemPromptVersion").startsWith("2-queue-pi-"),
    "queue analysis must use the versioned custom judge prompt through PI",
  );
  const analysisRoot = `/api/projects/${projectId}/queues/${queueId}/analyses/${analysisId}`;
  const judgeEventsResponse = await fetch(`${base}${analysisRoot}/events`);
  assert(judgeEventsResponse.status === 200, `judge events HTTP ${judgeEventsResponse.status}`);
  const judgeEvents = await judgeEventsResponse.text();
  assert(judgeEvents.includes('"type":"agent_start"'), "PI judge trace must contain agent_start");
  assert(judgeEvents.includes('"type":"tool_execution_start"'), "PI judge must use custom tools");

  const transcriptResponse = await fetch(`${base}${analysisRoot}/transcript`);
  assert(transcriptResponse.status === 200, `PI transcript HTTP ${transcriptResponse.status}`);
  const transcript = object(await transcriptResponse.json(), "PI transcript");
  assert(transcript.engine === "pi", "queue judge transcript must identify PI as its engine");
  assert(Array.isArray(transcript.messages), "PI transcript must retain the complete message history");

  const verdictResponse = await fetch(`${base}${analysisRoot}/verdict`);
  assert(verdictResponse.status === 200, `verdict HTTP ${verdictResponse.status}`);
  const verdict = object(await verdictResponse.json(), "queue verdict");
  assert(Array.isArray(verdict.perEval) && verdict.perEval.length === 2, "judge must emit both eval verdicts");

  const reportResponse = await fetch(`${base}${analysisRoot}/report`);
  assert(reportResponse.status === 200, `report HTTP ${reportResponse.status}`);
  const report = await reportResponse.text();
  assert(report.length > 8_000, `report is too thin (${report.length} bytes)`);
  for (const required of [
    "Cross-eval themes",
    "Reliability",
    "Ranked defects",
    "Per-eval verdicts",
    "Improvement plan",
    "ReaperCode",
  ]) {
    assert(report.includes(required), `report missing quality section: ${required}`);
  }

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
  assert(response.status === 200, `bridge HTTP ${response.status}: ${await response.text()}`);
  const bytes = Buffer.from(await response.arrayBuffer());
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
RUN sed -i '/id: "nuralwatt"/,/id: "nuralwatt2"/ s/models: \[/models: ["deepseek-v4-flash", /' src/model/provider/catalog.ts \\
 && npm ci \\
 && npm run build \\
 && ln -s /opt/reapercode/bin/reaper /usr/local/bin/reaper
CMD ["reaper", "--help"]
`;
}

function evalOneSpec() {
  return {
    id: "repair-addition",
    name: "Repair addition and verify edge cases",
    prompt:
      "Fix the add function so all tests pass. Inspect the existing code, make the smallest correct change, run the complete test suite after the final edit, and leave the workspace in a verified state.",
    agentCategory: "coding",
    workspace: { source: "empty" },
    tags: ["coding", "javascript", "verification"],
    env: {
      kind: "greenfield",
      setupScript: `mkdir -p src test
cat > package.json <<'JSON'
{"name":"eval-add","type":"module","scripts":{"test":"node --test"}}
JSON
cat > src/math.js <<'JS'
export function add(a, b) { return a - b; }
JS
cat > test/math.test.js <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';
test('positive', () => assert.equal(add(2, 3), 5));
test('negative', () => assert.equal(add(-2, -3), -5));
test('zero', () => assert.equal(add(0, 7), 7));
JS
touch /tmp/agenteval-eval-one`,
      setupTimeoutSec: 120,
      commitBaseline: true,
      cleanupScript: "rm -f /tmp/agenteval-eval-one; pkill -f 'node.*src' 2>/dev/null || true",
      cleanupTimeoutSec: 60,
      cleanupVerifyScript: "test ! -e /tmp/agenteval-eval-one",
      cleanupVerifyTimeoutSec: 30,
    },
    checks: [
      { id: "tests", kind: "test_suite", command: "npm test" },
      { id: "status", kind: "command", command: "git status --short" },
    ],
    rubric: codingRubric("addition"),
  };
}

function evalTwoSpec() {
  return {
    id: "repair-slugify",
    name: "Repair slugify without breaking punctuation behavior",
    prompt:
      "Repair slugify to satisfy every test. Preserve the intended behavior, avoid hard-coding examples, run all tests after the final change, and explain success only after verification.",
    agentCategory: "coding",
    workspace: { source: "empty" },
    tags: ["coding", "javascript", "robustness"],
    env: {
      kind: "greenfield",
      setupScript: `mkdir -p src test
cat > package.json <<'JSON'
{"name":"eval-slug","type":"module","scripts":{"test":"node --test"}}
JSON
cat > src/slug.js <<'JS'
export function slugify(value) { return value.trim().replace(/\\s+/g, '_'); }
JS
cat > test/slug.test.js <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.js';
test('spaces', () => assert.equal(slugify('Hello World'), 'hello-world'));
test('punctuation', () => assert.equal(slugify(' API, Design! '), 'api-design'));
test('repeated separators', () => assert.equal(slugify('a---b   c'), 'a-b-c'));
JS
touch /tmp/agenteval-eval-two`,
      setupTimeoutSec: 120,
      commitBaseline: true,
      cleanupScript: "rm -f /tmp/agenteval-eval-two; pkill -f 'node.*src' 2>/dev/null || true",
      cleanupTimeoutSec: 60,
      cleanupVerifyScript: "test ! -e /tmp/agenteval-eval-two",
      cleanupVerifyTimeoutSec: 30,
    },
    checks: [
      { id: "tests", kind: "test_suite", command: "npm test" },
      { id: "diff", kind: "command", command: "git diff --check" },
    ],
    rubric: codingRubric("slugification"),
  };
}

function codingRubric(label: string) {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      {
        id: "correctness",
        axis: "A",
        label: `${label} correctness`,
        weight: 0.55,
        appliesTo: "coding",
        anchors: { full: "all tests pass", partial: "some cases pass", none: "tests fail" },
      },
      {
        id: "verification",
        axis: "B",
        label: "verification discipline",
        weight: 0.3,
        appliesTo: "coding",
        anchors: {
          full: "complete tests run after final edit",
          partial: "incomplete or stale verification",
          none: "no verification",
        },
      },
      {
        id: "quality",
        axis: "C",
        label: "change quality",
        weight: 0.15,
        appliesTo: "coding",
        anchors: {
          full: "minimal general solution",
          partial: "works with avoidable issues",
          none: "hard-coded or damaging change",
        },
      },
    ],
  };
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

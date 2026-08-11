import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import type { QueueImprovementStep } from "../src/judge/queue-schema.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-v2-api-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  api.queries.registerAgent({ id: "agent", displayName: "Agent" });
  const project = api.queries.createProject({ name: "P", slug: `v2-${Date.now()}` });
  const task = api.queries.createTask(project.id, {
    name: "E", prompt: "Do", workspace: { source: "empty" },
    rubric: { version: 1, profile: "general", criteria: [] },
  });
  const queue = api.queries.createEvalQueue(project.id, {
    name: "Q", agentId: "agent", model: "deepseek-v4-flash", provider: "nuralwatt",
  });
  const batch = api.queries.createBatch({
    taskId: task.id, projectId: project.id, agentId: "agent", model: "deepseek-v4-flash",
    provider: "nuralwatt", params: {}, repeats: 1, queueId: queue.id,
  });
  const run = api.queries.createRun({
    batchId: batch.id, taskId: task.id, projectId: project.id, queueId: queue.id,
    agentId: "agent", model: "deepseek-v4-flash", provider: "nuralwatt", repeatIndex: 0,
  });
  const analysis = api.queries.createQueueAnalysis({
    queueId: queue.id, projectId: project.id, batchId: batch.id, selectedRunIds: [run.id],
    evidenceHashes: { [run.id]: "hash" }, judgeModel: "deepseek-v4-flash",
    judgeProvider: "nuralwatt", systemPromptVersion: "v2",
  });
  const step: QueueImprovementStep = {
    id: "platform-integrity", rank: 1, class: "platform", priority: 0, confidence: 0.95,
    defectIds: ["d1"], subsystem: "archive", problem: "Metadata is stale.",
    evidence: [{ kind: "trace", runId: run.id, seqs: [0, 0] }],
    target: { kind: "code", paths: ["src/runner/queue-worker.ts"] },
    change: "Finalize metadata before sealing.", acceptanceCriteria: ["run.json is terminal"],
    tests: [{ name: "archive", kind: "integration", expected: "terminal snapshot" }],
    verifyTaskIds: [task.id], regressionTaskIds: [task.id], dependencies: [], nonGoals: [],
    preventive: false, status: "ready",
  };
  api.queries.storeImprovementSteps(analysis.id, project.id, queue.id, [step]);
  api.queries.upsertEvalMetrics({
    runId: run.id, projectId: project.id, schemaVersion: 1,
    execution: { measurements: { tool_calls: { value: 2, provenance: "exact" } } },
    outcome: { officialReward: 1 },
  });
  return { api, base, project, queue, analysis, run };
}

describe("judge v2 API", () => {
  it("filters and transitions improvement-step lifecycle without mutating content", async () => {
    const { base, project, queue, analysis } = await fixture();
    const path = `/api/projects/${project.id}/queues/${queue.id}/analyses/${analysis.id}/improvement-steps`;
    const list = await fetch(`${base}${path}?class=platform&status=ready`);
    expect(list.status).toBe(200);
    const listed = await list.json() as { improvement_steps: Array<Record<string, unknown>> };
    expect(listed.improvement_steps).toEqual([
      expect.objectContaining({ id: "platform-integrity", class: "platform", status: "ready" }),
    ]);

    const patch = await fetch(`${base}${path}/platform-integrity`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({
      improvement_step: expect.objectContaining({
        id: "platform-integrity",
        status: "in_progress",
        problem: "Metadata is stale.",
      }),
    });

    const invalid = await fetch(`${base}${path}/platform-integrity`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "proposed" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("serves versioned per-eval execution and outcome metrics", async () => {
    const { base, run } = await fixture();
    const response = await fetch(`${base}/api/evals/${run.id}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      run_id: run.id,
      schema_version: 1,
      execution: expect.objectContaining({ measurements: expect.any(Object) }),
      outcome: { officialReward: 1 },
    }));
  });
});

/**
 * REST API tests (P3c-API) — pure API/persistence surface.
 *
 * Boots the real API server on an ephemeral port. No agent or judge execution
 * is involved: runs that the run-lifecycle endpoints need are seeded as
 * persisted rows directly through queries, and SSE/ndjson replay reads from
 * the persisted events.jsonl on disk.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listProjects,
  listTasks,
  listRuns,
} from "../src/ui/lib/api.ts";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { runDirPath } from "../src/api/run-controller-bridge.ts";
import type { Rubric } from "../src/domain.ts";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.close();
    } catch {
      // best-effort
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-api-"));
  tempDirs.push(dir);
  return dir;
}

function sampleRubric(version = 1, label = "correctness"): Rubric {
  return {
    version,
    profile: "bugfix",
    criteria: [
      {
        id: "A1",
        axis: "A",
        label,
        weight: 1,
        appliesTo: "coding",
        anchors: {
          full: "fully correct",
          partial: "partially correct",
          none: "incorrect",
        },
      },
    ],
  };
}

interface HttpResult {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
}

async function http(
  base: string,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    raw?: boolean;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  if (!opts.raw) {
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function collectSse(
  base: string,
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events: unknown[] = [];
    for (const block of text.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            // ignore non-json
          }
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

async function collectNdjson(
  base: string,
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

async function boot(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

/** Seed a project + agent + task + batch + a completed run via queries. */
async function seedCompletedRun(
  api: ApiServer,
): Promise<{ projectId: string; taskId: string; runId: string }> {
  const project = api.queries.createProject({
    name: "Demo",
    slug: `demo-${Date.now().toString(36)}`,
    defaultModel: "deepseek-v4-flash",
    defaultProvider: "nuralwatt",
  });
  const agent = api.queries.registerAgent({
    id: `api-agent-${Date.now()}`,
    displayName: "API Agent",
  });
  const task = api.queries.createTask(project.id, {
    name: "Fix off-by-one",
    prompt: "Fix the bug",
    workspace: { source: "empty" },
    rubric: sampleRubric(1),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
  });
  const batch = api.queries.createBatch({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    repeats: 1,
  });
  const run = api.queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    repeatIndex: 0,
    status: "completed",
  });
  // Write the run.start event to the persisted events.jsonl so SSE/ndjson
  // replay has something to stream.
  const dir = runDirPath(api.app.dataDir, project.id, run.id);
  await mkdir(dir, { recursive: true });
  const lines = [
    { seq: 0, type: "run.start", agent: "api-agent" },
    { seq: 1, type: "run.end", status: "completed" },
  ];
  await writeFile(
    join(dir, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
  return { projectId: project.id, taskId: task.id, runId: run.id };
}

describe("REST API (P3c)", () => {
  it("project + task CRUD, rubric_version bump rules, 404 problem shape", async () => {
    const { base } = await boot();

    const created = await http(base, "POST", "/api/projects", {
      body: { name: "Demo", slug: "demo", description: "test project" },
    });
    expect(created.status).toBe(201);
    const project = created.json as { id: string; name: string; slug: string };
    expect(project.name).toBe("Demo");
    expect(project.slug).toBe("demo");
    expect(project.id).toBeTruthy();

    const list = await http(base, "GET", "/api/projects");
    expect(list.status).toBe(200);
    expect((list.json as { projects: unknown[] }).projects.length).toBeGreaterThanOrEqual(1);

    const taskRes = await http(base, "POST", `/api/projects/${project.id}/tasks`, {
      body: {
        name: "Fix off-by-one",
        prompt: "Fix the bug in main.ts",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
        profile: "bugfix",
        agentCategory: "coding",
        tags: ["smoke"],
      },
    });
    expect(taskRes.status).toBe(201);
    const task = taskRes.json as { id: string; name: string; rubric_version: number };
    expect(task.name).toBe("Fix off-by-one");
    expect(task.rubric_version).toBe(1);

    const namePatch = await http(
      base,
      "PATCH",
      `/api/projects/${project.id}/tasks/${task.id}`,
      { body: { name: "Fix off-by-one (renamed)" } },
    );
    expect(namePatch.status).toBe(200);
    const renamed = namePatch.json as { name: string; rubric_version: number };
    expect(renamed.name).toBe("Fix off-by-one (renamed)");
    expect(renamed.rubric_version).toBe(1);

    const rubricPatch = await http(
      base,
      "PATCH",
      `/api/projects/${project.id}/tasks/${task.id}`,
      { body: { rubric: sampleRubric(1, "correctness-v2") } },
    );
    expect(rubricPatch.status).toBe(200);
    const bumped = rubricPatch.json as { rubric_version: number; rubric: Rubric };
    expect(bumped.rubric_version).toBe(2);
    expect(bumped.rubric.criteria[0]!.label).toBe("correctness-v2");

    const missing = await http(base, "GET", "/api/runs/does-not-exist");
    expect(missing.status).toBe(404);
    const problem = missing.json as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(problem.status).toBe(404);
    expect(problem.title).toBe("Not Found");
    expect(typeof problem.type).toBe("string");
    expect(typeof problem.detail).toBe("string");
    expect(problem.detail.length).toBeGreaterThan(0);
  });

  it("GET /api/runs/:id returns detail envelope for a persisted run", async () => {
    const { base, api } = await boot();
    const { runId } = await seedCompletedRun(api);

    const detail = await http(base, "GET", `/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    const body = detail.json as {
      id: string;
      status: string;
      control_state: string | null;
      usage: unknown;
      provenance: unknown;
    };
    expect(body.id).toBe(runId);
    expect(body.usage).toBeTruthy();
    expect(body.provenance).toBeTruthy();
  });

  it("report is 404 when no completed judgement exists (P5b)", async () => {
    const { base, api } = await boot();
    const { runId } = await seedCompletedRun(api);

    const report = await http(base, "GET", `/api/runs/${runId}/report?partial=1`);
    expect(report.status).toBe(404);
  });

  it("405 returns Allow + problem details", async () => {
    const { base } = await boot();
    const res = await http(base, "PUT", "/api/projects");
    expect(res.status).toBe(405);
    const problem = res.json as { status: number; title: string; detail: string };
    expect(problem.status).toBe(405);
    expect(problem.title).toBe("Method Not Allowed");
  });

  it("SSE replay includes run.start (since=0) from persisted events.jsonl", async () => {
    const { base, api } = await boot();
    const { runId } = await seedCompletedRun(api);

    const events = await collectSse(base, `/api/runs/${runId}/events?since=0`, {
      timeoutMs: 8_000,
    });
    const types = events.map((e) => (e as { type?: string }).type);
    expect(types).toContain("run.start");
    expect(types).toContain("run.end");
  });

  it("ndjson replay includes run.start", async () => {
    const { base, api } = await boot();
    const { runId } = await seedCompletedRun(api);

    const events = await collectNdjson(
      base,
      `/api/runs/${runId}/events?since=0&stream=ndjson`,
      { timeoutMs: 5_000 },
    );
    const types = events.map((e) => (e as { type?: string }).type);
    expect(types).toContain("run.start");
  });

  // Integration (not mocked): the REAL UI api client against the REAL server.
  it("UI client list accessors unwrap the real server's envelopes", async () => {
    const { api, base } = await boot();
    const { projectId, taskId, runId } = await seedCompletedRun(api);

    const projects = await listProjects({ baseUrl: base });
    expect(projects.some((p) => p.id === projectId)).toBe(true);

    const tasks = await listTasks(projectId, { baseUrl: base });
    expect(tasks.some((t) => t.id === taskId)).toBe(true);

    const runs = await listRuns(projectId, { baseUrl: base });
    expect(runs.some((r) => r.id === runId)).toBe(true);
  });
});

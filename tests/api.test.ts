/**
 * REST API tests (P3c-API).
 *
 * Spins createServer on an ephemeral port with a temp dataDir + openDb.
 * Uses createFixtureAdapter so runs exit promptly without model calls.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listProjects,
  listTasks,
  listRuns,
} from "../src/ui/lib/api.ts";
import {
  createFixtureAdapter,
  createServer,
  type ApiServer,
} from "../src/api/server.ts";
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
  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
  };
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

/** Collect SSE data: frames until the connection ends (or timeout). */
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

/** Collect ndjson stream. */
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

async function boot(opts: {
  holdMs?: number;
  messages?: string[];
} = {}): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const adapter = createFixtureAdapter({
    holdMs: opts.holdMs ?? 80,
    messages: opts.messages ?? ["fixture-hello"],
  });
  const api = createServer({
    dataDir,
    adapter,
    concurrency: 1,
    startOpts: { timeoutMs: 15_000 },
  });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

describe("REST API (P3c)", () => {
  it("project + task CRUD, rubric_version bump rules, 404 problem shape", async () => {
    const { base } = await boot();

    // Create project
    const created = await http(base, "POST", "/api/projects", {
      body: { name: "Demo", slug: "demo", description: "test project" },
    });
    expect(created.status).toBe(201);
    const project = created.json as { id: string; name: string; slug: string };
    expect(project.name).toBe("Demo");
    expect(project.slug).toBe("demo");
    expect(project.id).toBeTruthy();

    // List projects
    const list = await http(base, "GET", "/api/projects");
    expect(list.status).toBe(200);
    expect((list.json as { projects: unknown[] }).projects.length).toBeGreaterThanOrEqual(1);

    // Create task
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
    const task = taskRes.json as {
      id: string;
      name: string;
      rubric_version: number;
    };
    expect(task.name).toBe("Fix off-by-one");
    expect(task.rubric_version).toBe(1);

    // Update task name only → rubric_version unchanged
    const namePatch = await http(
      base,
      "PATCH",
      `/api/projects/${project.id}/tasks/${task.id}`,
      { body: { name: "Fix off-by-one (renamed)" } },
    );
    expect(namePatch.status).toBe(200);
    const renamed = namePatch.json as {
      name: string;
      rubric_version: number;
    };
    expect(renamed.name).toBe("Fix off-by-one (renamed)");
    expect(renamed.rubric_version).toBe(1);

    // Update rubric → bumps rubric_version
    const rubricPatch = await http(
      base,
      "PATCH",
      `/api/projects/${project.id}/tasks/${task.id}`,
      { body: { rubric: sampleRubric(1, "correctness-v2") } },
    );
    expect(rubricPatch.status).toBe(200);
    const bumped = rubricPatch.json as {
      rubric_version: number;
      rubric: Rubric;
    };
    expect(bumped.rubric_version).toBe(2);
    expect(bumped.rubric.criteria[0]!.label).toBe("correctness-v2");

    // RFC-7807 404
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

  it("starts a run (202), streams run.start, network control, pause+abort", async () => {
    // Longer hold so we can control mid-flight before the fixture exits.
    const { base, api } = await boot({ holdMs: 8_000, messages: ["hello-run"] });

    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "RunProj", slug: "run-proj" },
    });
    const projectId = (proj.json as { id: string }).id;

    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      body: {
        name: "Quick task",
        prompt: "Say hello",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
        profile: "general",
      },
    });
    const taskId = (taskRes.json as { id: string }).id;

    // Start run
    const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: {
        taskId,
        agent: "fixture",
        model: "fixture-model",
        provider: "fixture",
        repeats: 1,
      },
    });
    expect(start.status).toBe(202);
    const startBody = start.json as {
      batch_id: string;
      run_ids: string[];
    };
    expect(startBody.batch_id).toBeTruthy();
    expect(startBody.run_ids.length).toBe(1);
    const runId = startBody.run_ids[0]!;
    expect(start.headers.get("location") || start.headers.get("Location")).toMatch(
      new RegExp(`/api/runs/${runId}`),
    );

    // Wait until live + run.start has been written
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !api.liveRuns.has(runId)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(api.liveRuns.has(runId)).toBe(true);
    await new Promise((r) => setTimeout(r, 80));

    // Network cutoff while still running
    const net = await http(base, "POST", `/api/runs/${runId}/control`, {
      body: { action: "network", enabled: false },
    });
    expect(net.status).toBe(200);
    const netBody = net.json as { egressEnabled: boolean };
    expect(netBody.egressEnabled).toBe(false);

    // Pause then abort (must happen before the fixture's holdMs elapses)
    const pause = await http(base, "POST", `/api/runs/${runId}/pause?mode=soft`);
    expect(pause.status).toBe(200);
    expect((pause.json as { status: string }).status).toBe("paused");

    const abort = await http(base, "POST", `/api/runs/${runId}/abort`);
    expect(abort.status).toBe(200);
    const aborted = abort.json as { status: string; control_state: string };
    expect(aborted.status).toBe("aborted");

    // Terminal control returns 409
    const again = await http(base, "POST", `/api/runs/${runId}/abort`);
    expect(again.status).toBe(409);
    const conflictBody = again.json as {
      type: string;
      title: string;
      status: number;
      detail: string;
    };
    expect(conflictBody.status).toBe(409);
    expect(conflictBody.title).toBe("Conflict");

    // After abort, events stream (ndjson) must include run.start
    const events = await collectNdjson(
      base,
      `/api/runs/${runId}/events?since=0&stream=ndjson`,
      { timeoutMs: 5_000 },
    );
    const types = events.map((e) => (e as { type?: string }).type);
    expect(types).toContain("run.start");
  }, 20_000);

  it("Idempotency-Key does not double-create runs", async () => {
    const { base, api } = await boot({ holdMs: 30 });

    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "Idem", slug: "idem" },
    });
    const projectId = (proj.json as { id: string }).id;
    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      body: {
        name: "T",
        prompt: "p",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
      },
    });
    const taskId = (taskRes.json as { id: string }).id;

    const key = "ci-retry-key-1";
    const a = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: { taskId, agent: "fixture", model: "m", provider: "p", repeats: 1 },
      headers: { "Idempotency-Key": key },
    });
    expect(a.status).toBe(202);
    const bodyA = a.json as { batch_id: string; run_ids: string[] };

    const b = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: { taskId, agent: "fixture", model: "m", provider: "p", repeats: 1 },
      headers: { "Idempotency-Key": key },
    });
    expect(b.status).toBe(202);
    const bodyB = b.json as { batch_id: string; run_ids: string[] };
    expect(bodyB.batch_id).toBe(bodyA.batch_id);
    expect(bodyB.run_ids).toEqual(bodyA.run_ids);

    // Only one run in the project
    const listed = await http(base, "GET", `/api/projects/${projectId}/runs`);
    expect(listed.status).toBe(200);
    expect((listed.json as { runs: unknown[] }).runs.length).toBe(1);

    // Drain live run so afterEach close is clean.
    const runId = bodyA.run_ids[0]!;
    const live = api.liveRuns.get(runId);
    if (live) await live.done.catch(() => undefined);
  });

  it("GET /api/runs/:id returns detail envelope", async () => {
    const { base, api } = await boot({ holdMs: 20 });
    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "D", slug: "d" },
    });
    const projectId = (proj.json as { id: string }).id;
    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      body: {
        name: "T",
        prompt: "p",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
      },
    });
    const taskId = (taskRes.json as { id: string }).id;
    const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: { taskId, agent: "fixture", model: "m", provider: "p" },
    });
    const runId = (start.json as { run_ids: string[] }).run_ids[0]!;

    // Brief wait for start
    await new Promise((r) => setTimeout(r, 100));

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

    const live = api.liveRuns.get(runId);
    if (live) await live.done.catch(() => undefined);
  });

  it("report is 404 when no completed judgement exists (P5b)", async () => {
    const { base, api } = await boot({ holdMs: 20 });
    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "R", slug: "r" },
    });
    const projectId = (proj.json as { id: string }).id;
    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      body: {
        name: "T",
        prompt: "p",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
      },
    });
    const taskId = (taskRes.json as { id: string }).id;
    const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: { taskId, agent: "fixture", model: "m", provider: "p" },
    });
    const runId = (start.json as { run_ids: string[] }).run_ids[0]!;

    // Full HTML report is P5b: without a completed judgement + report.html → 404.
    const report = await http(base, "GET", `/api/runs/${runId}/report?partial=1`);
    expect(report.status).toBe(404);

    const live = api.liveRuns.get(runId);
    if (live) await live.done.catch(() => undefined);
  });

  it("405 returns Allow + problem details", async () => {
    const { base } = await boot();
    const res = await http(base, "PUT", "/api/projects");
    expect(res.status).toBe(405);
    const problem = res.json as {
      status: number;
      title: string;
      detail: string;
    };
    expect(problem.status).toBe(405);
    expect(problem.title).toBe("Method Not Allowed");
  });

  it("SSE replay includes run.start (since=0)", async () => {
    const { base, api } = await boot({ holdMs: 50, messages: ["sse-hi"] });
    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "S", slug: "s" },
    });
    const projectId = (proj.json as { id: string }).id;
    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      body: {
        name: "T",
        prompt: "p",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
      },
    });
    const taskId = (taskRes.json as { id: string }).id;
    const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: { taskId, agent: "fixture", model: "m", provider: "p" },
    });
    const runId = (start.json as { run_ids: string[] }).run_ids[0]!;

    // Wait for live + run.start written
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !api.liveRuns.has(runId)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Give record() a tick
    await new Promise((r) => setTimeout(r, 50));

    const events = await collectSse(base, `/api/runs/${runId}/events?since=0`, {
      timeoutMs: 8_000,
    });
    const types = events.map((e) => (e as { type?: string }).type);
    expect(types).toContain("run.start");

    const live = api.liveRuns.get(runId);
    if (live) await live.done.catch(() => undefined);
  }, 15_000);

  // Integration (not mocked): the REAL UI api client against the REAL server.
  // Regression for the envelope-unwrap bug — the server wraps list responses
  // in {projects/tasks/runs:[...]}; the client must unwrap, else list pages
  // crash with ".map is not a function". Mocked-fetch tests alone masked this.
  it("UI client list accessors unwrap the real server's envelopes", async () => {
    const { api, base } = await boot();

    // Seed: a project, a task, and a run — all via the documented API.
    const projectRes = await http(base, "POST", "/api/projects", {
      body: { name: "Envelope Project", slug: "env-proj" },
    });
    const projectId = (projectRes.json as { id: string }).id;

    const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      body: {
        name: "Env Task",
        prompt: "do the thing",
        workspace: { source: "empty" },
        rubric: sampleRubric(1),
      },
    });
    const taskId = (taskRes.json as { id: string }).id;

    const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
      body: { taskId, agent: "fixture", model: "m", provider: "p" },
    });
    const runId = (start.json as { run_ids: string[] }).run_ids[0]!;
    const live = api.liveRuns.get(runId);
    if (live) await live.done.catch(() => undefined);

    // Now exercise the REAL client against the REAL server (baseUrl + fetch).
    const projects = await listProjects({ baseUrl: base });
    expect(projects.some((p) => p.id === projectId)).toBe(true);

    const tasks = await listTasks(projectId, { baseUrl: base });
    expect(tasks.some((t) => t.id === taskId)).toBe(true);

    const runs = await listRuns(projectId, { baseUrl: base });
    expect(runs.some((r) => r.id === runId)).toBe(true);

    // include_archived query path against the real server (no throw, returns array).
    const archived = await listTasks(projectId, { baseUrl: base, includeArchived: true });
    expect(Array.isArray(archived)).toBe(true);
  }, 15_000);
});

/**
 * Eval-queue HTTP routes (P8b-routes).
 *
 * Boots the real ApiServer on a temp dataDir with createFixtureAdapter.
 * OFFLINE — no real LLM / container.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureAdapter,
  createServer,
  type ApiServer,
} from "../src/api/server.ts";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import type { QueueEntry } from "../src/db/queries.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-queue-routes-"));
  tempDirs.push(dir);
  return dir;
}

function sampleRubric(): Rubric {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      {
        id: "A1",
        axis: "A",
        label: "correctness",
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

function sampleTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "ext-task-1",
    name: "Fix the bug",
    prompt: "Please fix the off-by-one error",
    workspace: { source: "empty" },
    rubric: sampleRubric(),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
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

interface Seeded {
  api: ApiServer;
  base: string;
  projectId: string;
  taskId: string;
  agentId: string;
}

async function seedWorld(): Promise<Seeded> {
  const dataDir = await tempDataDir();
  const api = createServer({
    dataDir,
    adapter: createFixtureAdapter(),
    // Keep concurrency high enough that promote can start runs.
    concurrency: 2,
  });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  const agent = api.queries.registerAgent({
    id: "pi",
    displayName: "Pi",
    defaultModel: "claude",
    defaultProvider: "anthropic",
  });
  const project = api.queries.createProject({
    name: "Queue Routes",
    slug: `queue-routes-${Date.now()}`,
    defaultAgentId: agent.id,
    defaultModel: "claude",
    defaultProvider: "anthropic",
  });
  const task = api.queries.createTask(
    project.id,
    sampleTask({ id: "t1", tags: ["smoke"] }),
  );
  // Second task for task_set tests if needed.
  api.queries.createTask(
    project.id,
    sampleTask({ id: "t2", name: "T2", tags: ["regression"] }),
  );

  return {
    api,
    base,
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
  };
}

describe("queue routes — add / list / reorder / remove", () => {
  it("POST add 202 + position; GET list ordered; PATCH reorder; DELETE 204", async () => {
    const { base, projectId, taskId, agentId } = await seedWorld();

    const a = await http(base, "POST", `/api/projects/${projectId}/queue`, {
      body: {
        taskId,
        agent: agentId,
        ref: "v1",
        priority: 10,
        source: "api",
      },
    });
    expect(a.status).toBe(202);
    const aBody = a.json as { entry: QueueEntry; position: number };
    expect(aBody.entry.id).toBeTruthy();
    expect(typeof aBody.position).toBe("number");
    expect(aBody.entry.status).toBe("queued");
    expect(aBody.entry.triggerRef).toBe("v1");
    expect(aBody.entry.targetKind).toBe("task");

    const b = await http(base, "POST", `/api/projects/${projectId}/queue`, {
      body: {
        taskId,
        agent: agentId,
        ref: "v2",
        priority: 20,
        source: "api",
      },
    });
    expect(b.status).toBe(202);
    const bBody = b.json as { entry: QueueEntry };

    const c = await http(base, "POST", `/api/projects/${projectId}/queue`, {
      body: {
        taskId,
        agent: agentId,
        ref: "v3",
        priority: 5,
        source: "api",
      },
    });
    expect(c.status).toBe(202);
    const cBody = c.json as { entry: QueueEntry };

    // GET list — ordered priority DESC then position ASC
    const listed = await http(base, "GET", `/api/projects/${projectId}/queue`);
    expect(listed.status).toBe(200);
    const listBody = listed.json as { queue: QueueEntry[] };
    expect(listBody.queue.length).toBe(3);
    // priority 20 first
    expect(listBody.queue[0]!.id).toBe(bBody.entry.id);
    expect(listBody.queue[0]!.priority).toBe(20);

    // PATCH reorder by priority
    const reordered = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/queue/${cBody.entry.id}`,
      { body: { priority: 100 } },
    );
    expect(reordered.status).toBe(200);
    const rBody = reordered.json as { entry: QueueEntry };
    expect(rBody.entry.priority).toBe(100);

    const listed2 = await http(base, "GET", `/api/projects/${projectId}/queue`);
    const q2 = (listed2.json as { queue: QueueEntry[] }).queue;
    expect(q2[0]!.id).toBe(cBody.entry.id);

    // PATCH after
    const after = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/queue/${aBody.entry.id}`,
      { body: { after: cBody.entry.id, priority: 100 } },
    );
    expect(after.status).toBe(200);

    // DELETE 204
    const del = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/queue/${aBody.entry.id}`,
    );
    expect(del.status).toBe(204);

    // Idempotent soft-remove still 204 (entry exists as removed)
    const del2 = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/queue/${aBody.entry.id}`,
    );
    expect(del2.status).toBe(204);

    // Missing entry → 404
    const missing = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/queue/no-such-entry`,
    );
    expect(missing.status).toBe(404);

    // Missing project → 404
    const noProj = await http(base, "GET", `/api/projects/nope/queue`);
    expect(noProj.status).toBe(404);
  });
});

describe("queue routes — promote + drain", () => {
  it("promote 202 + runIds + entry promoted; second promote 409; drain removes queued", async () => {
    const { api, base, projectId, taskId, agentId } = await seedWorld();

    const added = await http(base, "POST", `/api/projects/${projectId}/queue`, {
      body: {
        taskId,
        agent: agentId,
        ref: "main",
        repeats: 1,
        source: "api",
      },
    });
    expect(added.status).toBe(202);
    const entry = (added.json as { entry: QueueEntry }).entry;

    // Extra queued entries for drain later
    const extra1 = await http(base, "POST", `/api/projects/${projectId}/queue`, {
      body: { taskId, agent: agentId, ref: "x1", source: "api" },
    });
    const extra2 = await http(base, "POST", `/api/projects/${projectId}/queue`, {
      body: { taskId, agent: agentId, ref: "x2", source: "api" },
    });
    expect(extra1.status).toBe(202);
    expect(extra2.status).toBe(202);

    const promoted = await http(
      base,
      "POST",
      `/api/projects/${projectId}/queue/${entry.id}/promote`,
    );
    expect(promoted.status).toBe(202);
    const pBody = promoted.json as {
      batchId: string;
      runIds: string[];
      entry: QueueEntry;
    };
    expect(pBody.batchId).toBeTruthy();
    expect(pBody.runIds.length).toBeGreaterThan(0);
    expect(pBody.entry.status).toBe("promoted");
    expect(pBody.entry.promotedBatchId).toBe(pBody.batchId);

    // Runs exist and are not stuck as a missing batch
    for (const runId of pBody.runIds) {
      const run = api.queries.getRun(runId);
      expect(run).toBeTruthy();
      // With fixture adapter + enqueueStart, status should leave pure "queued"
      // eventually — but at minimum the entry is promoted with non-empty runIds.
      expect(run!.status).toBeTruthy();
    }

    // Second promote → 409 conflict
    const again = await http(
      base,
      "POST",
      `/api/projects/${projectId}/queue/${entry.id}/promote`,
    );
    expect(again.status).toBe(409);

    // Drain remaining queued (extra1 + extra2; promoted entry left alone)
    const drained = await http(
      base,
      "POST",
      `/api/projects/${projectId}/queue/drain`,
    );
    expect(drained.status).toBe(200);
    const dBody = drained.json as { removed: number };
    expect(dBody.removed).toBe(2);

    // Promoted entry still present as promoted
    const still = api.queries.getQueueEntry(entry.id);
    expect(still?.status).toBe("promoted");
  });

  it("promote missing entry → 404", async () => {
    const { base, projectId } = await seedWorld();
    const r = await http(
      base,
      "POST",
      `/api/projects/${projectId}/queue/nope/promote`,
    );
    expect(r.status).toBe(404);
  });
});

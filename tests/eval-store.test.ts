/**
 * Eval-store decoupling: /evals is the canonical surface, /tasks is gone,
 * evals report the queues that reference them, and deletion is guarded.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { validEvalPackageUpload } from "./helpers/eval-package.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-evalstore-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

async function makeEval(base: string, projectId: string): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/projects/${projectId}/evals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validEvalPackageUpload()),
  });
  const body = (await res.json()) as { id?: string; type?: string };
  if (!body.id) throw new Error(`eval POST failed: ${JSON.stringify(body)}`);
  return body as { id: string };
}

describe("eval store", () => {
  it("lists evals with used_by_queues and removes the legacy /tasks surface", async () => {
    const { api, base } = await boot();
    const project = api.queries.createProject({ name: "P", slug: "evalstore" });
    const eval1 = await makeEval(base, project.id);

    // no queues reference it yet
    let list = await fetch(`${base}/api/projects/${project.id}/evals`).then((r) => r.json());
    expect((list as { evals: { used_by_queues: unknown[] }[] }).evals[0].used_by_queues).toEqual([]);

    // create a queue referencing it
    const queue = api.queries.createEvalQueue(project.id, {
      name: "q1",
      agentId: "reapercode",
      model: "deepseek-v4-flash",
      provider: "openai",
      builtinAdapterId: "reapercode",
    });
    api.queries.createEvalQueueItem(queue.id, { taskId: eval1.id });

    list = await fetch(`${base}/api/projects/${project.id}/evals`).then((r) => r.json());
    const usedBy = (list as { evals: { used_by_queues: { id: string }[] }[] }).evals[0].used_by_queues;
    expect(usedBy.map((u) => u.id)).toContain(queue.id);

    // legacy /tasks is gone
    const legacy = await fetch(`${base}/api/projects/${project.id}/tasks`);
    expect(legacy.status).toBe(404);
  });

  it("guards eval deletion when a live queue references it", async () => {
    const { api, base } = await boot();
    const project = api.queries.createProject({ name: "P", slug: "evalstore-guard" });
    const eval1 = await makeEval(base, project.id);

    // no queue → delete succeeds
    const ok = await fetch(`${base}/api/projects/${project.id}/evals/${eval1.id}`, { method: "DELETE" });
    expect(ok.status).toBe(200);

    // fresh project so the fixed SIMPLE-TEST external id does not collide
    const project2 = api.queries.createProject({ name: "P2", slug: "evalstore-guard-2" });
    const eval2 = await makeEval(base, project2.id);
    const queue = api.queries.createEvalQueue(project2.id, {
      name: "q1",
      agentId: "reapercode",
      model: "deepseek-v4-flash",
      provider: "openai",
      builtinAdapterId: "reapercode",
    });
    api.queries.createEvalQueueItem(queue.id, { taskId: eval2.id });

    // referenced → 409
    const conflict = await fetch(`${base}/api/projects/${project2.id}/evals/${eval2.id}`, { method: "DELETE" });
    expect(conflict.status).toBe(409);

    // remove the item, then delete succeeds
    const item = api.queries.listEvalQueueItems(queue.id)[0]!;
    api.queries.deleteEvalQueueItem(item.id);
    const ok2 = await fetch(`${base}/api/projects/${project2.id}/evals/${eval2.id}`, { method: "DELETE" });
    expect(ok2.status).toBe(200);
  });

  it("exposes a standalone /api/evals namespace across projects", async () => {
    const { api, base } = await boot();
    const p1 = api.queries.createProject({ name: "P1", slug: "p1" });
    const p2 = api.queries.createProject({ name: "P2", slug: "p2" });
    const e1 = await makeEval(base, p1.id);
    const e2 = await makeEval(base, p2.id);

    const all = await fetch(`${base}/api/evals`).then((r) => r.json());
    expect((all as { evals: { id: string }[] }).evals.map((e) => e.id)).toEqual(
      expect.arrayContaining([e1.id, e2.id]),
    );

    // global lookup by id
    const one = await fetch(`${base}/api/evals/${e1.id}`).then((r) => r.json());
    expect((one as { id: string }).id).toBe(e1.id);
  });
});

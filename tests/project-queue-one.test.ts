/** One project, one queue. Across-evals cannot run without the judge. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "one-queue-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

async function http(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

describe("one project queue", () => {
  it("GET /queue creates the project's queue from eval-stage model", async () => {
    const { base } = await boot();
    const created = await http(base, "POST", "/api/projects", {
      name: "Solo",
      model_config: { eval: { baseUrl: "https://eval.example/v1", model: "from-eval-stage" } },
      default_model: "from-eval-stage",
      default_provider: "openai",
    });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    const first = await http(base, "GET", `/api/projects/${id}/queue`);
    expect(first.status).toBe(200);
    const q1 = first.json as { queue: { id: string; model: string; builtinAdapterId: string | null } };
    expect(q1.queue.model).toBe("from-eval-stage");
    expect(q1.queue.builtinAdapterId).toBe("pi");
    const second = await http(base, "GET", `/api/projects/${id}/queue`);
    expect((second.json as { queue: { id: string } }).queue.id).toBe(q1.queue.id);
  });

  it("rejects looking across evals when the judge is off", async () => {
    const { base } = await boot();
    const created = await http(base, "POST", "/api/projects", {
      name: "Stages",
      default_model: "m",
      default_provider: "openai",
    });
    const id = (created.json as { id: string }).id;
    await http(base, "GET", `/api/projects/${id}/queue`);
    const pipe = await http(base, "GET", `/api/projects/${id}/pipeline`);
    expect(pipe.status).toBe(200);
    expect((pipe.json as { queue: { autoPhase2: boolean } }).queue).toBeTruthy();
    const bad = await http(base, "PATCH", `/api/projects/${id}/pipeline`, {
      auto_phase1: false,
      auto_phase2: true,
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toMatch(/judge|phase1|across/i);
  });
});

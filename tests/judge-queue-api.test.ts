/**
 * Linked judge-queue lookup used by the console pause/resume controls.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function request(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("GET /api/projects/:id/judge-queue", () => {
  it("returns null before a judge queue is linked, then the linked row", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-judge-queue-api-"));
    dirs.push(dataDir);
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;

    const missing = await request(base, "GET", "/api/projects/no-such/judge-queue");
    expect(missing.status).toBe(404);

    const project = await request(base, "POST", "/api/projects", {
      name: "Judge queue project",
      slug: "judge-queue-project",
    });
    expect(project.status).toBe(201);
    const projectId = project.body.id as string;

    const empty = await request(base, "GET", `/api/projects/${projectId}/judge-queue`);
    expect(empty.status).toBe(200);
    expect(empty.body.queue).toBeNull();

    const adapter = await request(base, "POST", `/api/projects/${projectId}/adapters`, {
      agent_id: "cli",
      name: "CLI",
      image: "registry.example/cli@sha256:abc",
      default_provider: "openai",
      default_model: "test-model",
      command: { argv: ["cli", "run", "--prompt", "{{prompt}}"] },
      parser_kind: "canonical-jsonl",
      evidence: { paths: [".cli"] },
    });
    expect(adapter.status).toBe(201);

    const evalQueue = await request(base, "POST", `/api/projects/${projectId}/queues`, {
      name: "main",
    });
    expect(evalQueue.status).toBe(201);
    const evalQueueId = (evalQueue.body.queue as { id: string }).id;

    const linked = await request(base, "POST", "/api/judge/queues", {
      name: "judge",
      project_id: projectId,
      linked_eval_queue_id: evalQueueId,
      auto_judge: true,
    });
    expect(linked.status).toBe(200);

    const found = await request(base, "GET", `/api/projects/${projectId}/judge-queue`);
    expect(found.status).toBe(200);
    expect((found.body.queue as { id: string }).id).toBe(
      (linked.body.judge_queue as { id: string }).id,
    );
    expect(found.body.eval_queue_id).toBe(evalQueueId);
    expect(found.body.status).toBeTruthy();
  });
});

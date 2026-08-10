/** Project-bound real CLI adapter CRUD API. */

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

function adapterBody() {
  return {
    agent_id: "my-cli-agent",
    name: "My CLI Agent",
    image: "registry.example/my-agent@sha256:abc",
    default_provider: "anthropic",
    default_model: "claude-opus-5",
    command: {
      argv: [
        "my-agent",
        "run",
        "--prompt",
        "{{prompt}}",
        "--provider",
        "{{provider}}",
        "--model",
        "{{model}}",
      ],
    },
    connection_check: {
      argv: ["my-agent", "run", "--prompt", "connection"],
      timeout_ms: 60_000,
    },
    provider_config: {
      credentialEnv: {
        anthropic: { ANTHROPIC_AUTH_TOKEN: "ANTHROPIC_AUTH_TOKEN" },
      },
    },
    parser_kind: "canonical-jsonl",
    evidence: {
      paths: [".my-agent/logs"],
      required_paths: [".my-agent/logs"],
    },
  };
}

describe("project agent adapter API", () => {
  it("enforces one CRUD-able CLI agent per project and binds queues to it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-adapter-api-"));
    dirs.push(dataDir);
    const api = createServer({ dataDir, outboundDispatcher: null });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;

    const projectResponse = await request(base, "POST", "/api/projects", {
      name: "Adapter project",
      slug: "adapter-project",
    });
    expect(projectResponse.status).toBe(201);
    const projectId = projectResponse.body.id as string;

    const created = await request(
      base,
      "POST",
      `/api/projects/${projectId}/adapters`,
      adapterBody(),
    );
    expect(created.status).toBe(201);
    const adapter = created.body.adapter as Record<string, unknown>;
    expect(adapter.agentId).toBe("my-cli-agent");

    const duplicate = await request(
      base,
      "POST",
      `/api/projects/${projectId}/adapters`,
      { ...adapterBody(), agent_id: "another-agent" },
    );
    expect(duplicate.status).toBe(409);

    const patched = await request(
      base,
      "PATCH",
      `/api/projects/${projectId}/adapters/${adapter.id as string}`,
      { image: "registry.example/my-agent@sha256:def" },
    );
    expect(patched.status).toBe(200);
    expect((patched.body.adapter as Record<string, unknown>).image).toContain("sha256:def");

    const queue = await request(base, "POST", `/api/projects/${projectId}/queues`, {
      name: "main",
    });
    expect(queue.status).toBe(201);
    expect((queue.body.queue as Record<string, unknown>).agentId).toBe("my-cli-agent");

    const wrongAgent = await request(base, "POST", `/api/projects/${projectId}/queues`, {
      name: "wrong",
      agent_id: "another-agent",
    });
    expect(wrongAgent.status).toBe(400);
  });
});

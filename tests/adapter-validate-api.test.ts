/** Validate / dry-run endpoint: render command template without execution. */

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

async function boot(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-validate-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

interface HttpResult {
  status: number;
  json: unknown;
}

async function http(base: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  return { status: res.status, json: await res.json() };
}

describe("adapter validate (dry-run)", () => {
  it("renders command argv + env with placeholders substituted", async () => {
    const { api, base } = await boot();
    const project = api.queries.createProject({ name: "Validate", slug: `validate-${Date.now()}` });
    api.queries.registerAgent({ id: `agent-${Date.now()}`, displayName: "A" });

    const created = await http(base, "POST", `/api/projects/${project.id}/adapters`, {
      agent_id: "my-agent",
      name: "My Agent",
      image: "localhost/my-agent:latest",
      command: {
        argv: ["my-agent", "run", "--prompt", "{{prompt}}", "--provider", "{{provider}}", "--model", "{{model}}", "--workspace", "{{workspace}}"],
        env: { RUN_ID: "{{run_id}}" },
        cwd: "/workspace",
        timeout_ms: 600000,
      },
      derive_connection_check: true,
      configure: {
        argv: ["my-agent", "configure", "--model", "{{model}}"],
        env: { CONFIG_RUN: "{{run_id}}" },
        cwd: "/workspace",
        timeout_ms: 120000,
      },
      evidence: {
        paths: [".runs"],
        manifest: [
          {
            id: "trace",
            role: "trace",
            path: ".runs/*.jsonl",
            format: "jsonl",
            primary: true,
            select: "latest_mtime",
            record: { kindField: "type", tsField: "timestamp", idField: "id" },
          },
        ],
      },
      parser_kind: "canonical-jsonl",
      default_provider: "nuralwatt",
      default_model: "deepseek-v4-flash",
    });
    expect(created.status).toBe(201);
    const adapterId = (created.json as { adapter: { id: string } }).adapter.id;

    const result = await http(base, "POST", `/api/projects/${project.id}/adapters/${adapterId}/validate`);
    expect(result.status).toBe(200);
    const body = result.json as {
      command: { argv: string[]; env: Record<string, string>; cwd: string; timeout_ms: number };
      connection_check: { argv: string[] };
      configure: { argv: string[]; env: Record<string, string>; cwd: string; timeout_ms: number };
      evidence: { paths: string[]; manifest: Array<{ id: string; role: string }> };
    };
    expect(body.command.argv).toContain("sample-model");
    expect(body.command.argv).toContain("sample-provider");
    expect(body.command.argv).toContain("sample eval prompt");
    expect(body.command.argv).toContain("/workspace");
    expect(body.command.env.RUN_ID).toBe("sample-run-id");
    expect(body.command.cwd).toBe("/workspace");
    expect(body.command.timeout_ms).toBe(600000);
    expect(body.configure.argv).toContain("sample-model");
    expect(body.configure.env.CONFIG_RUN).toBe("sample-run-id");
    expect(body.configure.timeout_ms).toBe(120000);

    // Derived connection check uses the command template with the probe prompt.
    expect(body.connection_check.argv).toContain("Reply with exactly AGENTEVAL_CONNECTION_OK. Do not use tools.");

    // The evidence manifest is round-tripped into the declarative adapter and
    // surfaced on the validate response so a judge can bind roles by id.
    expect(body.evidence.manifest).toHaveLength(1);
    expect(body.evidence.manifest[0].id).toBe("trace");
    expect(body.evidence.manifest[0].role).toBe("trace");
  });

  it("renders the generator contract discovery endpoint", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/adapters/generator-contract`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inputEnv: string[]; examples: { bash: string | { bash: string } } };
    expect(body.inputEnv.some((e) => e.startsWith("AGENTEVAL_WORKSPACE_DIR"))).toBe(true);
    const bashExample = typeof body.examples === "string" ? body.examples : body.examples.bash;
    expect(bashExample).toContain("#!/bin/bash");
  });
});

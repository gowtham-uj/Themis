/** Adapter generator API: POST .../from-generator runs a user script that emits the adapter contract. */

import { execSync } from "node:child_process";
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

/** Create a real local git repo as the generator's source_repo target. */
async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-gen-repo-"));
  dirs.push(dir);
  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('echo \'{"name":"test-agent","bin":"./cli.js"}\' > package.json', { cwd: dir });
  execSync("git add -A && git commit -m init", { cwd: dir });
  return dir;
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

const TRIVIAL_CONTAINERFILE =
  "FROM docker.io/library/busybox:latest\nRUN echo ok\nCMD [\"sh\"]";

/** A generator that detects the entrypoint from package.json and emits a valid adapter. */
const GENERATOR_SCRIPT = `#!/bin/bash
set -euo pipefail
WS="$AGENTEVAL_WORKSPACE_DIR"
ENTRY=$(jq -r '.bin' "$WS/package.json")
cat <<JSON
{
  "agent_id": "$AGENTEVAL_AGENT_ID",
  "name": "Generated Agent",
  "image": "localhost/gen-agent:latest",
  "source_repo": "$AGENTEVAL_SOURCE_REPO",
  "containerfile": "${TRIVIAL_CONTAINERFILE.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}",
  "default_provider": "$AGENTEVAL_PROVIDER",
  "default_model": "$AGENTEVAL_MODEL",
  "command": {
    "argv": ["agent", "run", "--jsonl", "--prompt", "{{prompt}}", "--provider", "{{provider}}", "--model", "{{model}}", "--workspace", "{{workspace}}"],
    "cwd": "/workspace",
    "timeout_ms": 60000
  },
  "derive_connection_check": true,
  "provider_config": { "credentialEnv": { "default": { "AGENT_API_KEY": "ANTHROPIC_API_KEY" } } },
  "parser_kind": "canonical-jsonl",
  "evidence": { "paths": [".agent-runs"], "required_paths": [".agent-runs"] },
  "enabled": true
}
JSON`;

describe("adapter from-generator API", () => {
  it("runs the generator, validates + stores the emitted adapter, persists the script", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-gen-api-"));
    dirs.push(dataDir);
    const api = createServer({ dataDir, outboundDispatcher: null });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const project = api.queries.createProject({ name: "Gen", slug: `gen-${Date.now()}` });
    const repo = await makeGitRepo();

    const res = await http(base, "POST", `/api/projects/${project.id}/adapters/from-generator`, {
      agent_id: "gen-agent",
      name: "Generated Agent",
      generator: GENERATOR_SCRIPT,
      source_repo: repo,
      source_ref: "HEAD",
      default_provider: "nuralwatt",
      default_model: "deepseek-v4-flash",
      build: false, // skip the real podman build in this test — just verify create + script persisted
    });

    expect(res.status).toBe(201);
    const body = res.json as {
      adapter: {
        id: string;
        agentId: string;
        generatorScript: string | null;
        connectionCheckDerived: boolean;
        command: { argv: string[] };
        image: string;
      };
      generator: { stdout: string };
    };
    expect(body.adapter.agentId).toBe("gen-agent");
    expect(body.adapter.generatorScript).toContain("#!/bin/bash");
    expect(body.adapter.connectionCheckDerived).toBe(true);
    expect(body.adapter.command.argv).toContain("{{prompt}}");
    expect(body.adapter.image).toBe("localhost/gen-agent:latest");
    expect(body.generator.stdout).toContain("gen-agent");

    // The adapter is retrievable.
    const get = await http(base, "GET", `/api/projects/${project.id}/adapters`);
    expect(get.status).toBe(200);
    const listBody = get.json as { adapters: Array<{ id: string; generatorScript: string | null }> };
    expect(listBody.adapters).toHaveLength(1);
    expect(listBody.adapters[0]!.generatorScript).toContain("#!/bin/bash");
  });

  it("rejects a generator that emits invalid JSON", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-gen-bad-"));
    dirs.push(dataDir);
    const api = createServer({ dataDir, outboundDispatcher: null });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const project = api.queries.createProject({ name: "Bad", slug: `bad-${Date.now()}` });
    const repo = await makeGitRepo();

    const res = await http(base, "POST", `/api/projects/${project.id}/adapters/from-generator`, {
      agent_id: "bad-agent",
      name: "Bad Agent",
      generator: "#!/bin/bash\necho 'not json'",
      source_repo: repo,
      default_provider: "nuralwatt",
      default_model: "deepseek-v4-flash",
      build: false,
    });
    expect(res.status).toBe(500);
  }, 30000);
});

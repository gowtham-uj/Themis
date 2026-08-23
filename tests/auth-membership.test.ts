/** Project membership + non-admin token scoping. */

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { loginUser, registerUser } from "../src/api/auth-users.ts";
import { MemoryQueries } from "../src/db/queries.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const apis: ApiServer[] = [];

afterEach(async () => {
  for (const api of apis.splice(0)) await api.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-membership-"));
  dirs.push(dataDir);
  const queries = new MemoryQueries(dataDir);
  const api = createServer({ dataDir, queries, authEnabled: true });
  apis.push(api);
  const port = await api.listen(0);
  return { api, queries, base: `http://127.0.0.1:${port}` };
}

async function http(
  base: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

describe("project membership scoping", () => {
  it("forces project-scoped mints onto the caller's project (never global)", async () => {
    const { base, queries } = await boot();
    const project = queries.createProject({ name: "A", slug: "proj-a" });
    const scoped = queries.createApiToken({ projectId: project.id, label: "scoped" });
    const minted = await http(base, "POST", "/api/tokens", {
      headers: { Authorization: `Bearer ${scoped.token}` },
      body: { label: "same-project" },
    });
    expect(minted.status).toBe(201);
    expect((minted.json as { project_id: string | null }).project_id).toBe(project.id);

    const other = queries.createProject({ name: "B", slug: "proj-b" });
    const denied = await http(base, "POST", "/api/tokens", {
      headers: { Authorization: `Bearer ${scoped.token}` },
      body: { label: "cross", project_id: other.id },
    });
    expect(denied.status).toBe(403);
  });

  it("non-admin login tokens are membership-scoped", async () => {
    const { queries } = await boot();
    registerUser(queries, { username: "admin", password: "pw", role: "admin" });
    const user = registerUser(queries, { username: "member", password: "pw", role: "user" });
    const project = queries.createProject({ name: "P", slug: "p-member" });
    queries.addProjectMember(project.id, user.id);

    const memberLogin = await loginUser(queries, "member", "pw");
    expect(memberLogin).not.toBeNull();
    expect(memberLogin!.tokens).toHaveLength(1);
    expect(memberLogin!.tokens[0]!.projectId).toBe(project.id);

    const adminLogin = await loginUser(queries, "admin", "pw");
    expect(adminLogin!.tokens).toHaveLength(1);
    expect(adminLogin!.tokens[0]!.projectId).toBeNull();
  });

  it("non-admin without memberships cannot login-token", async () => {
    const { queries } = await boot();
    registerUser(queries, { username: "admin", password: "pw", role: "admin" });
    registerUser(queries, { username: "lonely", password: "pw", role: "user" });
    const result = await loginUser(queries, "lonely", "pw");
    expect(result).not.toBeNull();
    expect(result!.tokens).toEqual([]);
  });
});

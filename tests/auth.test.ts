/**
 * P8b-auth — API token store + Bearer gate.
 *
 * Boots the real API server with authentication enabled; no agent run is involved.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { hashToken } from "../src/api/auth.ts";
import { validEvalPackageUpload } from "./helpers/eval-package.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-auth-"));
  tempDirs.push(dir);
  return dir;
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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function bootAuth(authEnabled: boolean): Promise<{
  api: ApiServer;
  base: string;
}> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir, authEnabled });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

describe("API auth (P8b)", () => {
  it("createApiToken returns plaintext once; row stores hash only", async () => {
    const { api } = await bootAuth(true);
    const created = api.queries.createApiToken({ label: "seed" });
    expect(created.token).toMatch(/^aev_[A-Za-z0-9_-]{32}$/);
    expect(created.tokenHash).toBe(hashToken(created.token));
    expect(created.tokenHash).toHaveLength(64);

    const row = api.queries.getApiToken(created.tokenHash);
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(created.tokenHash);
    // No plaintext column / field on the durable row.
    expect(row).not.toHaveProperty("token");
    expect(JSON.stringify(row)).not.toContain(created.token);

    const listed = api.queries.listApiTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.tokenHash).toBe(created.tokenHash);
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("GET /api/projects requires Bearer when authEnabled; accepts valid token", async () => {
    const { api, base } = await bootAuth(true);
    const seed = api.queries.createApiToken({ label: "admin" });

    const denied = await http(base, "GET", "/api/projects");
    expect(denied.status).toBe(401);

    const ok = await http(base, "GET", "/api/projects", {
      headers: { Authorization: `Bearer ${seed.token}` },
    });
    expect(ok.status).toBe(200);
    expect((ok.json as { projects: unknown[] }).projects).toEqual([]);
  });

  it("revoked token returns 401", async () => {
    const { api, base } = await bootAuth(true);
    const seed = api.queries.createApiToken({ label: "temp" });
    api.queries.revokeApiToken(seed.tokenHash);

    const res = await http(base, "GET", "/api/projects", {
      headers: { Authorization: `Bearer ${seed.token}` },
    });
    expect(res.status).toBe(401);
  });

  it("read-only token: GET ok, POST runs forbidden", async () => {
    const { api, base } = await bootAuth(true);
    const admin = api.queries.createApiToken({ label: "admin" });
    const ro = api.queries.createApiToken({ label: "ro", readOnly: true });

    // Seed a project + task with the admin token.
    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "P", slug: "p-ro" },
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(proj.status).toBe(201);
    const projectId = (proj.json as { id: string }).id;

    const task = await http(base, "POST", `/api/projects/${projectId}/evals`, {
      body: validEvalPackageUpload(),
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(task.status).toBe(201);
    const taskId = (task.json as { id: string }).id;

    const getOk = await http(base, "GET", "/api/projects", {
      headers: { Authorization: `Bearer ${ro.token}` },
    });
    expect(getOk.status).toBe(200);

    const postDenied = await http(
      base,
      "POST",
      `/api/projects/${projectId}/runs`,
      {
        body: { taskId, agent: "fixture", model: "m", provider: "p" },
        headers: { Authorization: `Bearer ${ro.token}` },
      },
    );
    expect(postDenied.status).toBe(403);

    // Token management also forbidden for read-only.
    const mintDenied = await http(base, "POST", "/api/tokens", {
      body: { label: "nope" },
      headers: { Authorization: `Bearer ${ro.token}` },
    });
    expect(mintDenied.status).toBe(403);
  });

  it("project-scoped token on a different project returns 401", async () => {
    const { api, base } = await bootAuth(true);
    const admin = api.queries.createApiToken({ label: "admin" });

    const a = await http(base, "POST", "/api/projects", {
      body: { name: "A", slug: "proj-a" },
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const b = await http(base, "POST", "/api/projects", {
      body: { name: "B", slug: "proj-b" },
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const projectA = (a.json as { id: string }).id;
    const projectB = (b.json as { id: string }).id;

    const scoped = api.queries.createApiToken({
      label: "scoped-a",
      projectId: projectA,
    });

    const okA = await http(base, "GET", `/api/projects/${projectA}`, {
      headers: { Authorization: `Bearer ${scoped.token}` },
    });
    expect(okA.status).toBe(200);

    const badB = await http(base, "GET", `/api/projects/${projectB}`, {
      headers: { Authorization: `Bearer ${scoped.token}` },
    });
    expect(badB.status).toBe(401);

    // Global list is not project-scoped path — allowed (no path project id).
    const list = await http(base, "GET", "/api/projects", {
      headers: { Authorization: `Bearer ${scoped.token}` },
    });
    expect(list.status).toBe(200);
  });

  it("authEnabled:false (default) allows unauthenticated access", async () => {
    // Contract: existing suite boots without authEnabled → no 401.
    const { base } = await bootAuth(false);
    const proj = await http(base, "POST", "/api/projects", {
      body: { name: "Local", slug: "local-dev" },
    });
    expect(proj.status).toBe(201);
    expect((proj.json as { id: string }).id).toBeTruthy();

    const list = await http(base, "GET", "/api/projects");
    expect(list.status).toBe(200);
  });

  it("GET /api/health is public even when authEnabled", async () => {
    const { base } = await bootAuth(true);
    const res = await http(base, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect((res.json as { ok: boolean }).ok).toBe(true);
  });

  it("token routes: create (plaintext once), list (hashes), revoke", async () => {
    const { api, base } = await bootAuth(true);
    const seed = api.queries.createApiToken({ label: "seed" });

    const created = await http(base, "POST", "/api/tokens", {
      body: { label: "via-api", read_only: false },
      headers: { Authorization: `Bearer ${seed.token}` },
    });
    expect(created.status).toBe(201);
    const body = created.json as {
      token: string;
      token_hash: string;
      label: string;
    };
    expect(body.token).toMatch(/^aev_/);
    expect(body.token_hash).toBe(
      createHash("sha256").update(body.token, "utf8").digest("hex"),
    );

    const listed = await http(base, "GET", "/api/tokens", {
      headers: { Authorization: `Bearer ${seed.token}` },
    });
    expect(listed.status).toBe(200);
    const tokens = (listed.json as { tokens: Array<{ token_hash: string; token?: string }> })
      .tokens;
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    for (const t of tokens) {
      expect(t.token).toBeUndefined();
      expect(t.token_hash).toMatch(/^[a-f0-9]{64}$/);
    }

    const revoked = await http(
      base,
      "DELETE",
      `/api/tokens/${body.token_hash}`,
      { headers: { Authorization: `Bearer ${seed.token}` } },
    );
    expect(revoked.status).toBe(200);

    const useRevoked = await http(base, "GET", "/api/projects", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(useRevoked.status).toBe(401);
  });
});

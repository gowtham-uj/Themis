/**
 * Watcher HTTP routes (P8b-routes).
 *
 * Boots the real ApiServer on a temp dataDir with a FAKE refResolver +
 * createFixtureAdapter. OFFLINE — no real git, no real LLM.
 * HMAC tests use node crypto to sign payloads with the once-surfaced secret.
 */
import { createHmac } from "node:crypto";
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
import type { RefResolver } from "../src/watcher/engine.ts";
import type { WatcherRule } from "../src/db/queries.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-watcher-routes-"));
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

class FakeRefResolver implements RefResolver {
  constructor(
    private readonly map: Record<string, { sha: string; imageTag?: string }> = {},
  ) {}

  async resolveRef(
    repo: string,
    ref: string,
  ): Promise<{ sha: string; imageTag?: string }> {
    const key = `${repo}|${ref}`;
    const hit = this.map[key] ?? this.map[ref];
    if (hit) return hit;
    return { sha: `sha-of-${ref}`, imageTag: ref };
  }
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
    rawBody?: string;
    raw?: boolean;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
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

function signBody(secret: string, rawBody: string): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")
  );
}

/**
 * Clear a rule's webhook secret so getRawWatcherSecret returns null.
 * Works for MemoryQueries (private field is still runtime-accessible) and
 * SqliteQueries (via update if present). Used only for the 401-no-secret case.
 */
function clearWebhookSecret(api: ApiServer, ruleId: string): void {
  const q = api.queries as unknown as {
    watcherRules?: Map<string, WatcherRule>;
    db?: {
      update?: (table: unknown) => {
        set: (v: unknown) => {
          where: (c: unknown) => { run: () => void };
        };
      };
    };
  };
  // MemoryQueries path
  if (q.watcherRules && q.watcherRules.has(ruleId)) {
    const rule = q.watcherRules.get(ruleId)!;
    q.watcherRules.set(ruleId, { ...rule, webhookSecret: null });
    return;
  }
  // Sqlite path — try raw SQL via better-sqlite3 handle if available
  const raw = (api.queries as unknown as { raw?: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).raw;
  // SqliteQueries stores drizzle db; try a simple approach via any update
  try {
    // Access internal drizzle + schema is hard; use getRawWatcherSecret check after
    // poking through mapWatcher if present. Fallback: monkey-patch method.
    const original = api.queries.getRawWatcherSecret.bind(api.queries);
    api.queries.getRawWatcherSecret = (id: string) => {
      if (id === ruleId) return null;
      return original(id);
    };
    void raw;
  } catch {
    api.queries.getRawWatcherSecret = () => null;
  }
}

interface Seeded {
  api: ApiServer;
  base: string;
  projectId: string;
  taskId: string;
  agentId: string;
}

async function seedWorld(
  resolver: RefResolver = new FakeRefResolver(),
): Promise<Seeded> {
  const dataDir = await tempDataDir();
  const api = createServer({
    dataDir,
    adapter: createFixtureAdapter(),
    refResolver: resolver,
  });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  // Register agent BEFORE createProject so default_agent_id FK succeeds (sqlite).
  const agent = api.queries.registerAgent({
    id: `pi-${Date.now()}`,
    displayName: "Pi",
    defaultModel: "claude",
    defaultProvider: "anthropic",
  });
  const project = api.queries.createProject({
    name: "Watcher Routes",
    slug: `watcher-routes-${Date.now()}`,
    defaultAgentId: agent.id,
    defaultModel: "claude",
    defaultProvider: "anthropic",
  });
  const task = api.queries.createTask(project.id, sampleTask());

  return {
    api,
    base,
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
  };
}

describe("watcher routes — CRUD", () => {
  it("POST create surfaces secret once + X-Agenteval-Secret-Once; GET strips secrets", async () => {
    const { base, projectId } = await seedWorld();

    const created = await http(base, "POST", `/api/projects/${projectId}/watchers`, {
      body: {
        role: "agent",
        repo: "owner/name",
        trigger: "tag",
        ref: "v*",
        action: { enqueue: "all", repeats: 1 },
      },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("x-agenteval-secret-once")).toBe("true");
    const body = created.json as {
      watcher: WatcherRule;
    };
    expect(body.watcher.id).toBeTruthy();
    expect(body.watcher.webhookSecret).toBeTruthy();
    expect(typeof body.watcher.webhookSecret).toBe("string");
    const secretOnce = body.watcher.webhookSecret!;

    const listed = await http(base, "GET", `/api/projects/${projectId}/watchers`);
    expect(listed.status).toBe(200);
    const listBody = listed.json as { watchers: WatcherRule[] };
    expect(listBody.watchers).toHaveLength(1);
    expect(listBody.watchers[0]!.webhookSecret).toBeNull();
    // Secret from create is not echoed back in list.
    expect(listBody.watchers[0]!.id).toBe(body.watcher.id);
    void secretOnce;
  });

  it("PATCH updates without secret; DELETE 204; 404 missing project/rule", async () => {
    const { base, projectId } = await seedWorld();

    const created = await http(base, "POST", `/api/projects/${projectId}/watchers`, {
      body: {
        role: "agent",
        repo: "owner/name",
        trigger: "commit",
        ref: "main",
        action: { enqueue: "all" },
      },
    });
    const rule = (created.json as { watcher: WatcherRule }).watcher;

    const patched = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/watchers/${rule.id}`,
      { body: { enabled: false, ref: "develop" } },
    );
    expect(patched.status).toBe(200);
    const pBody = patched.json as { watcher: WatcherRule };
    expect(pBody.watcher.enabled).toBe(false);
    expect(pBody.watcher.ref).toBe("develop");
    expect(pBody.watcher.webhookSecret).toBeNull();

    const del = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/watchers/${rule.id}`,
    );
    expect(del.status).toBe(204);

    const delAgain = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/watchers/${rule.id}`,
    );
    expect(delAgain.status).toBe(404);

    const missingProject = await http(
      base,
      "GET",
      `/api/projects/does-not-exist/watchers`,
    );
    expect(missingProject.status).toBe(404);

    const missingRule = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/watchers/no-such-rule`,
      { body: { enabled: true } },
    );
    expect(missingRule.status).toBe(404);
  });
});

describe("watcher routes — manual fire", () => {
  it("POST .../run → 202 + batchIds when tasks exist", async () => {
    const resolver = new FakeRefResolver({
      "v1.0.0": { sha: "abc123", imageTag: "v1.0.0" },
    });
    const { base, projectId } = await seedWorld(resolver);

    const created = await http(base, "POST", `/api/projects/${projectId}/watchers`, {
      body: {
        role: "agent",
        repo: "owner/name",
        trigger: "tag",
        ref: "v*",
        action: { enqueue: "all", repeats: 1 },
      },
    });
    const rule = (created.json as { watcher: WatcherRule }).watcher;

    const fired = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watchers/${rule.id}/run`,
      { body: { ref: "v1.0.0" } },
    );
    expect(fired.status).toBe(202);
    const fBody = fired.json as {
      batchIds: string[];
      watcherEventId: string | null;
      status: string;
    };
    expect(fBody.batchIds.length).toBeGreaterThan(0);
    expect(fBody.status).toBe("enqueued");
    expect(fBody.watcherEventId).toBeTruthy();
  });

  it("manual fire 404 for missing rule", async () => {
    const { base, projectId } = await seedWorld();
    const r = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watchers/nope/run`,
      { body: {} },
    );
    expect(r.status).toBe(404);
  });
});

describe("watcher routes — webhook ingress HMAC", () => {
  it("valid signature → 202 matched; last-byte-tampered → 401; no secret → 401", async () => {
    const resolver = new FakeRefResolver({
      "v2.3.0": { sha: "deadbeef", imageTag: "v2.3.0" },
    });
    const { api, base, projectId } = await seedWorld(resolver);

    const created = await http(base, "POST", `/api/projects/${projectId}/watchers`, {
      body: {
        role: "agent",
        repo: "owner/name",
        trigger: "tag",
        ref: "v*",
        action: { enqueue: "all" },
        webhookSecret: "super-secret-test-key",
      },
    });
    expect(created.status).toBe(201);
    const rule = (created.json as { watcher: WatcherRule }).watcher;
    const secret = rule.webhookSecret!;
    expect(secret).toBe("super-secret-test-key");

    const payload = JSON.stringify({
      ref: "refs/tags/v2.3.0",
      ref_type: "tag",
      repository: { full_name: "owner/name" },
    });
    const goodSig = signBody(secret, payload);

    // Valid signature → 202
    const ok = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watcher/hooks/${rule.id}`,
      {
        rawBody: payload,
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": goodSig,
          "X-GitHub-Event": "create",
          "X-GitHub-Ref": "refs/tags/v2.3.0",
        },
      },
    );
    expect(ok.status).toBe(202);
    const okBody = ok.json as {
      matched: boolean;
      results: Array<{ ruleId: string; status: string }>;
    };
    expect(okBody.results.length).toBeGreaterThan(0);
    // enqueued (or deduped if re-run); not ignored due to signature
    expect(
      ["enqueued", "deduped", "matched", "failed"].includes(
        okBody.results[0]!.status,
      ),
    ).toBe(true);

    // Tamper last byte of signature → still 401 (timingSafeEqual full compare)
    const tampered =
      goodSig.slice(0, -1) + (goodSig.endsWith("a") ? "b" : "a");
    expect(tampered).not.toBe(goodSig);
    expect(tampered.length).toBe(goodSig.length);
    const bad = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watcher/hooks/${rule.id}`,
      {
        rawBody: payload,
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": tampered,
          "X-GitHub-Event": "create",
        },
      },
    );
    expect(bad.status).toBe(401);

    // Missing signature → 401
    const missing = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watcher/hooks/${rule.id}`,
      {
        rawBody: payload,
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "create",
        },
      },
    );
    expect(missing.status).toBe(401);

    // Rule with no secret configured → 401
    const created2 = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watchers`,
      {
        body: {
          role: "agent",
          repo: "owner/other",
          trigger: "tag",
          action: { enqueue: "all" },
        },
      },
    );
    const rule2 = (created2.json as { watcher: WatcherRule }).watcher;
    clearWebhookSecret(api, rule2.id);
    expect(api.queries.getRawWatcherSecret(rule2.id)).toBeNull();

    const noSecret = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watcher/hooks/${rule2.id}`,
      {
        rawBody: payload,
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": goodSig,
          "X-GitHub-Event": "create",
        },
      },
    );
    expect(noSecret.status).toBe(401);

    // 404 missing rule
    const notFound = await http(
      base,
      "POST",
      `/api/projects/${projectId}/watcher/hooks/no-such-rule`,
      {
        rawBody: payload,
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": goodSig,
        },
      },
    );
    expect(notFound.status).toBe(404);
  });
});

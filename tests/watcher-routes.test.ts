/**
 * Per-project agent-commit queue watcher routes (P8b-routes).
 *
 * Boots the real API server on a temp dataDir with an offline resolver + a fake
 * generation launcher (no network git, no container backend). HMAC tests sign
 * payloads with the once-surfaced secret. Watch a queue watcher bound to a
 * source adapter; the queue must have a source-built adapter whose source_repo
 * equals the watcher repo.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import type { RefResolver, WatcherSeams } from "../src/watcher/engine.ts";
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
        anchors: { full: "full", partial: "partial", none: "none" },
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

/** Offline ref resolver — deterministic, no network git. */
class OfflineRefResolver implements RefResolver {
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

/** Fake generation launcher + active-generation control. Mints a real run_batches row (FK). */
function fakeSeams(
  resolver: RefResolver,
  api: Pick<ApiServer, "queries">,
  opts: { activeQueueIds?: Set<string> } = {},
): { seams: WatcherSeams; launches: Array<{ queueId: string; commit: string }> } {
  const launches: Array<{ queueId: string; commit: string }> = [];
  return {
    launches,
    seams: {
      async resolveSha(repo, ref) {
        const r = await resolver.resolveRef(repo, ref);
        return { sha: r.sha };
      },
      hasActiveGeneration(queueId) {
        return opts.activeQueueIds?.has(queueId) ?? false;
      },
      async launch(queueId, commit) {
        launches.push({ queueId, commit });
        const queue = api.queries.getEvalQueue(queueId)!;
        const batch = api.queries.createBatch({
          taskId: null,
          projectId: queue.projectId,
          agentId: queue.agentId,
          model: queue.model,
          provider: queue.provider,
          params: {},
          repeats: 0,
          trigger: "watcher",
          agentCommit: commit,
          queueId,
          queueRevision: queue.revision,
        });
        return { launched: true, batchId: batch.id };
      },
    },
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

interface Seeded {
  api: ApiServer;
  base: string;
  projectId: string;
  taskId: string;
  queueId: string;
  ruleId: string;
  webhookSecret: string;
}

/**
 * Seed a project with a source-built agent adapter whose sourceRepo is
 * "owner/name" and one queue pinned to a commit, plus a watcher bound to that
 * queue. Returns the ids needed for route calls.
 */
async function seedWorld(
  resolver: RefResolver = new OfflineRefResolver(),
  opts: { activeQueueIds?: Set<string> } = {},
  apiOverride?: ApiServer,
): Promise<Seeded & { launches: Array<{ queueId: string; commit: string }> }> {
  const dataDir = await tempDataDir();
  let api = apiOverride;
  if (!api) {
    api = createServer({ dataDir, refResolver: resolver });
    servers.push(api);
  }
  // Build seams against the real query store so the launcher can mint a real
  // run_batches row (FK on watcher_events.batch_id) and wire into the app.
  const { seams, launches } = fakeSeams(resolver, api, opts);
  api.app.watcherSeams = seams;
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const q = api.queries;

  const project = q.createProject({
    name: "Watcher Routes",
    slug: `watcher-routes-${Date.now()}`,
  });
  const adapter = q.createProjectAgentAdapter(project.id, {
    agentId: "my-cli",
    name: "My CLI",
    image: "localhost/agent:latest",
    sourceRepo: "owner/name",
    sourceRef: "main",
    installType: "source-build",
    containerfile: "FROM node:22-bookworm\n",
    command: { argv: ["my-cli", "run"] },
    connectionCheck: { argv: ["my-cli", "check"] },
    evidence: { paths: [] },
    parserKind: "canonical-jsonl",
  });
  const task = q.createTask(project.id, sampleTask());
  const queue = q.createEvalQueue(project.id, {
    name: "Q",
    agentId: adapter.agentId,
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    agentCommit: "cccccccccccccccccccccccccccccccccccccccc",
  });
  q.createEvalQueueItem(queue.id, { taskId: task.id, repeats: 1 });

  // Create a watcher bound to the queue via the API (validates repo identity).
  const created = await http(base, "POST", `/api/projects/${project.id}/watchers`, {
    body: {
      queueId: queue.id,
      repo: "owner/name",
      trigger: "tag",
      ref: "v*",
      webhookSecret: "super-secret-test-key",
    },
  });
  expect(created.status).toBe(201);
  const rule = (created.json as { watcher: WatcherRule }).watcher;

  return {
    api,
    base,
    projectId: project.id,
    taskId: task.id,
    queueId: queue.id,
    ruleId: rule.id,
    webhookSecret: rule.webhookSecret!,
    launches,
  };
}

describe("watcher routes — CRUD (queue-bound, repo-validated)", () => {
  it("POST requires a project queue whose source repo matches; secret surfaced once", async () => {
    const { base, projectId, ruleId, webhookSecret } = await seedWorld();
    expect(ruleId).toBeTruthy();
    expect(typeof webhookSecret).toBe("string");

    const listed = await http(base, "GET", `/api/projects/${projectId}/watchers`);
    expect(listed.status).toBe(200);
    const listBody = listed.json as { watchers: WatcherRule[] };
    expect(listBody.watchers).toHaveLength(1);
    expect(listBody.watchers[0]!.webhookSecret).toBeNull();
    expect(listBody.watchers[0]!.queueId).toBeTruthy();
  });

  it("POST rejects a watcher whose repo does not equal the queue source repo (400)", async () => {
    const dataDir = await tempDataDir();
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const q = api.queries;
    const project = q.createProject({ name: "P", slug: "p-repo" });
    const adapter = q.createProjectAgentAdapter(project.id, {
      agentId: "cli", name: "C", image: "localhost/c",
      sourceRepo: "owner/name", sourceRef: "main", installType: "source-build",
      containerfile: "FROM node\n", command: { argv: ["c"] },
      connectionCheck: { argv: ["c"] }, evidence: { paths: [] },
      parserKind: "canonical-jsonl",
    });
    const queue = q.createEvalQueue(project.id, {
      name: "Q", agentId: adapter.agentId, model: "m", provider: "p",
    });

    const wrong = await http(base, "POST", `/api/projects/${project.id}/watchers`, {
      body: { queueId: queue.id, repo: "other/thing", trigger: "tag" },
    });
    expect(wrong.status).toBe(400);
  });

  it("POST rejects a queueId from a different project (400)", async () => {
    const dataDir = await tempDataDir();
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const q = api.queries;
    const p1 = q.createProject({ name: "P1", slug: "p1" });
    const p2 = q.createProject({ name: "P2", slug: "p2" });
    const adapter = q.createProjectAgentAdapter(p1.id, {
      agentId: "c1", name: "C", image: "localhost/c", sourceRepo: "a/b",
      sourceRef: "main", installType: "source-build", containerfile: "FROM node\n",
      command: { argv: ["c"] }, connectionCheck: { argv: ["c"] },
      evidence: { paths: [] }, parserKind: "canonical-jsonl",
    });
    const queue = q.createEvalQueue(p1.id, {
      name: "Q", agentId: adapter.agentId, model: "m", provider: "p",
    });
    const r = await http(base, "POST", `/api/projects/${p2.id}/watchers`, {
      body: { queueId: queue.id, repo: "a/b", trigger: "tag" },
    });
    expect(r.status).toBe(400);
  });
});

describe("watcher routes — manual fire (same engine path)", () => {
  it("POST .../run → 202 + launches queue with the commit override", async () => {
    const resolver = new OfflineRefResolver({
      "v1.0.0": { sha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" },
    });
    const { base, projectId, ruleId, launches } = await seedWorld(resolver);

    const fired = await http(base, "POST", `/api/projects/${projectId}/watchers/${ruleId}/run`, {
      body: { ref: "v1.0.0" },
    });
    expect(fired.status).toBe(202);
    const fBody = fired.json as { status: string; watcherEventId: string };
    expect(fBody.status).toBe("launched");
    expect(fBody.watcherEventId).toBeTruthy();
    expect(launches).toEqual([
      { queueId: expect.any(String), commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" },
    ]);
  });

  it("manual fire is idempotent: same ref+sha fires once, second deduped", async () => {
    const resolver = new OfflineRefResolver({ "v1.0.0": { sha: "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef" } });
    const { base, projectId, ruleId, launches } = await seedWorld(resolver);

    const first = await http(base, "POST", `/api/projects/${projectId}/watchers/${ruleId}/run`, { body: { ref: "v1.0.0" } });
    const second = await http(base, "POST", `/api/projects/${projectId}/watchers/${ruleId}/run`, { body: { ref: "v1.0.0" } });
    expect(first.status).toBe(202);
    expect((first.json as { status: string }).status).toBe("launched");
    expect((second.json as { status: string }).status).toBe("deduped");
    expect(launches).toHaveLength(1);
  });

  it("manual fire 404 for missing rule", async () => {
    const { base, projectId } = await seedWorld();
    const r = await http(base, "POST", `/api/projects/${projectId}/watchers/nope/run`, { body: {} });
    expect(r.status).toBe(404);
  });
});

describe("watcher routes — webhook ingress HMAC + repo identity", () => {
  it("valid signed hook → 202 launched; tampered signature → 401; missing sig → 401", async () => {
    const resolver = new OfflineRefResolver({
      "v2.3.0": { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    const { base, projectId, ruleId, webhookSecret, launches } = await seedWorld(resolver);

    const payload = JSON.stringify({
      ref: "refs/tags/v2.3.0",
      repository: { full_name: "owner/name" },
    });
    const goodSig = signBody(webhookSecret, payload);

    const ok = await http(base, "POST", `/api/projects/${projectId}/watcher/hooks/${ruleId}`, {
      rawBody: payload,
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": goodSig,
        "X-GitHub-Event": "create",
        "X-GitHub-Ref": "refs/tags/v2.3.0",
      },
    });
    expect(ok.status).toBe(202);
    const okBody = ok.json as { status: string; resolvedSha: string };
    expect(okBody.status).toBe("launched");
    expect(okBody.resolvedSha).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(launches).toHaveLength(1);

    const tampered = goodSig.slice(0, -1) + (goodSig.endsWith("a") ? "b" : "a");
    const bad = await http(base, "POST", `/api/projects/${projectId}/watcher/hooks/${ruleId}`, {
      rawBody: payload,
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": tampered, "X-GitHub-Event": "create" },
    });
    expect(bad.status).toBe(401);

    const missing = await http(base, "POST", `/api/projects/${projectId}/watcher/hooks/${ruleId}`, {
      rawBody: payload,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "create" },
    });
    expect(missing.status).toBe(401);
  });

  it("signed hook with mismatched repository → ignored (not launched) + record event", async () => {
    const resolver = new OfflineRefResolver({
      "v2.3.0": { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    const { base, projectId, ruleId, webhookSecret, launches } = await seedWorld(resolver);

    const payload = JSON.stringify({
      ref: "refs/tags/v2.3.0",
      repository: { full_name: "other/repo" },
    });
    const sig = signBody(webhookSecret, payload);
    const res = await http(base, "POST", `/api/projects/${projectId}/watcher/hooks/${ruleId}`, {
      rawBody: payload,
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig, "X-GitHub-Event": "create" },
    });
    expect(res.status).toBe(200);
    const body = res.json as { status: string };
    expect(body.status).toBe("ignored");
    expect(launches).toHaveLength(0);
  });

  it("active generation → webhook commit stays PENDING; event list shows it", async () => {
    // Seed once, marking the queue active so no launch happens.
    const { base, projectId, ruleId, webhookSecret, launches } = await seedWorld(
      new OfflineRefResolver({ "v2.3.0": { sha: "dddddddddddddddddddddddddddddddddddddddd" } }),
      { activeQueueIds: undefined },
    );
    // The queue has NO active generation in the seam by default, so force it:
    // re-point the app seams to treat every queue as active.
    const api = servers[servers.length - 1]!;
    const fs = await import("../src/watcher/engine.ts");
    const sh: WatcherSeams = {
      resolveSha: async (_r, _ref) => ({ sha: "dddddddddddddddddddddddddddddddddddddddd" }),
      hasActiveGeneration: () => true,
      launch: async () => ({ launched: true, batchId: "b" }),
    };
    void fs;
    api.app.watcherSeams = sh;

    const payload = JSON.stringify({ ref: "refs/tags/v2.3.0", repository: { full_name: "owner/name" } });
    const sig = signBody(webhookSecret, payload);
    const res = await http(base, "POST", `/api/projects/${projectId}/watcher/hooks/${ruleId}`, {
      rawBody: payload,
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig, "X-GitHub-Event": "create" },
    });
    expect(res.status).toBe(202);
    expect((res.json as { status: string }).status).toBe("pending");
    expect(launches).toHaveLength(0);

    const events = await http(base, "GET", `/api/projects/${projectId}/watchers/${ruleId}/events`);
    expect(events.status).toBe(200);
    const evList = events.json as { events: Array<{ status: string; fifoSeq: number }> };
    expect(evList.events[0]!.status).toBe("pending");
    expect(evList.events[0]!.fifoSeq).toBe(1);
  });

  it("rule with no secret → 401", async () => {
    const dataDir = await tempDataDir();
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const q = api.queries;
    const project = q.createProject({ name: "P", slug: "pp-nosec" });
    const adapter = q.createProjectAgentAdapter(project.id, {
      agentId: "cc", name: "C", image: "localhost/c", sourceRepo: "a/b",
      sourceRef: "main", installType: "source-build", containerfile: "FROM node\n",
      command: { argv: ["c"] }, connectionCheck: { argv: ["c"] },
      evidence: { paths: [] }, parserKind: "canonical-jsonl",
    });
    const queue = q.createEvalQueue(project.id, { name: "Q", agentId: adapter.agentId, model: "m", provider: "p" });
    const rule = q.createWatcherRule(project.id, { queueId: queue.id, repo: "a/b", trigger: "tag" });
    // Clear the secret so HMAC verification cannot pass.
    const raw = api.queries as unknown as { getRawWatcherSecret: () => string | null };
    const original = raw.getRawWatcherSecret.bind(api.queries);
    api.queries.getRawWatcherSecret = () => null;
    void original;

    const res = await http(base, "POST", `/api/projects/${project.id}/watcher/hooks/${rule.id}`, {
      rawBody: "{}",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=abcd" },
    });
    expect(res.status).toBe(401);
  });
});

describe("watcher routes — auth scoping (bearer-exempt hook, protected CRUD/manual)", () => {
  async function bootAuthWorld(opts: { authEnabled: boolean }) {
    const dataDir = await tempDataDir();
    const api = createServer({ dataDir, authEnabled: opts.authEnabled });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const q = api.queries;
    const project = q.createProject({ name: "P", slug: `auth-${Date.now()}` });
    const adapter = q.createProjectAgentAdapter(project.id, {
      agentId: "cli", name: "C", image: "localhost/c", sourceRepo: "owner/name",
      sourceRef: "main", installType: "source-build", containerfile: "FROM node\n",
      command: { argv: ["c"] }, connectionCheck: { argv: ["c"] },
      evidence: { paths: [] }, parserKind: "canonical-jsonl",
    });
    const queue = q.createEvalQueue(project.id, { name: "Q", agentId: adapter.agentId, model: "m", provider: "p" });
    const token = q.createApiToken({ label: "admin" });
    const other = q.createProject({ name: "Other", slug: `other-${Date.now()}` });
    return { api, base, projectId: project.id, queueId: queue.id, token: token.token, otherProjectId: other.id };
  }

  it("signed hook is bearer-exempt even when auth is enabled", async () => {
    const { api, base, projectId, queueId } = await bootAuthWorld({ authEnabled: true });
    const rule = api.queries.createWatcherRule(projectId, { queueId, repo: "owner/name", trigger: "tag" });
    const secret = api.queries.getRawWatcherSecret(rule.id)!;

    const payload = JSON.stringify({ ref: "refs/tags/v1.0.0", repository: { full_name: "owner/name" } });
    const sig = signBody(secret, payload);
    const res = await http(base, "POST", `/api/projects/${projectId}/watcher/hooks/${rule.id}`, {
      rawBody: payload,
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig, "X-GitHub-Event": "create" },
    });
    // Without a Bearer, the signed hook is still allowed (HMAC is the auth).
    // A real resolver/launcher is not wired here, so the handler records a
    // non-launched status — but crucially it is NOT a 401 auth rejection.
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(202);
  });

  it("CRUD/manual/event-list are bearer-protected when auth is enabled", async () => {
    const { api, base, projectId, queueId } = await bootAuthWorld({ authEnabled: true });
    const rule = api.queries.createWatcherRule(projectId, { queueId, repo: "owner/name", trigger: "tag" });

    // No bearer → 401 for CRUD + manual + event list.
    const list = await http(base, "GET", `/api/projects/${projectId}/watchers`);
    expect(list.status).toBe(401);
    const manual = await http(base, "POST", `/api/projects/${projectId}/watchers/${rule.id}/run`, { body: {} });
    expect(manual.status).toBe(401);
    const events = await http(base, "GET", `/api/projects/${projectId}/watchers/${rule.id}/events`);
    expect(events.status).toBe(401);
    const create = await http(base, "POST", `/api/projects/${projectId}/watchers`, { body: { queueId, repo: "owner/name", trigger: "tag" } });
    expect(create.status).toBe(401);
  });

  it("project-scoped token cannot access a different project's watchers", async () => {
    const { api, base, projectId, queueId, token, otherProjectId } = await bootAuthWorld({ authEnabled: true });
    // Issue a token scoped to projectId.
    const scoped = api.queries.createApiToken({ label: "scoped", projectId });
    const rule = api.queries.createWatcherRule(projectId, { queueId, repo: "owner/name", trigger: "tag" });

    // Accessing the OTHER project's watchers with this token → 401 scope check.
    const other = await http(base, "GET", `/api/projects/${otherProjectId}/watchers`, {
      headers: { Authorization: `Bearer ${scoped.token}` },
    });
    expect(other.status).toBe(401);

    // Accessing its OWN project → allowed.
    const own = await http(base, "GET", `/api/projects/${projectId}/watchers`, {
      headers: { Authorization: `Bearer ${scoped.token}` },
    });
    expect(own.status).toBe(200);
    void rule;
    void token;
  });
});

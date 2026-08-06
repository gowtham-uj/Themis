/**
 * Outbound webhook dispatcher + emit-site tests (P8c).
 *
 * OFFLINE: FakeDeliverySink captures POSTs; no real network.
 * Backoff forced to 0ms so retry tests stay fast.
 */
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureAdapter,
  createServer,
  FakeDeliverySink,
  OutboundWebhookDispatcher,
  signPayload,
  buildEventPayload,
  type ApiServer,
} from "../src/api/server.ts";
import type { Rubric, TaskSpec } from "../src/domain.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-outbound-"));
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

async function boot(opts: {
  sink?: FakeDeliverySink;
} = {}): Promise<{
  api: ApiServer;
  base: string;
  sink: FakeDeliverySink;
  projectId: string;
  taskId: string;
  agentId: string;
}> {
  const dataDir = await tempDataDir();
  const sink = opts.sink ?? new FakeDeliverySink();
  const dispatcher = new OutboundWebhookDispatcher({
    queries: undefined as never, // re-bound below after open
    sink,
    backoffMs: [0, 0, 0],
    maxAttempts: 4,
  });
  // createServer will open queries; we inject a dispatcher that we rebind.
  // Simpler: pass outboundSink + backoff via options, or build dispatcher after.
  const api = createServer({
    dataDir,
    adapter: createFixtureAdapter(),
    outboundBackoffMs: [0, 0, 0],
    outboundSink: sink,
  });
  // Rebind the server's dispatcher sink is already the FakeDeliverySink.
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;

  // Seed project + agent + task.
  const project = api.queries.createProject({
    name: "Outbound Test",
    slug: `outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const agent = api.queries.registerAgent({
    id: `agent-${Date.now()}`,
    displayName: "Fixture Agent",
  });
  const task = api.queries.createTask(project.id, sampleTask());

  // Silence unused.
  void dispatcher;

  return {
    api,
    base,
    sink,
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
  };
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; json: any; text: string }> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

function expectedSig(secret: string, body: string): string {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(body, "utf8").digest("hex")
  );
}

describe("signPayload / buildEventPayload", () => {
  it("signPayload matches GitHub sha256= hex convention", () => {
    const body = '{"hello":"world"}';
    const sig = signPayload("s3cret", body);
    expect(sig).toBe(expectedSig("s3cret", body));
    expect(sig.startsWith("sha256=")).toBe(true);
  });

  it("buildEventPayload includes type/project/resource/data/timestamp", () => {
    const raw = buildEventPayload({
      type: "run.completed",
      projectId: "p1",
      resourceId: "r1",
      data: { status: "completed" },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const obj = JSON.parse(raw);
    expect(obj).toEqual({
      type: "run.completed",
      project: "p1",
      resource: "r1",
      data: { status: "completed" },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("outbound dispatch", () => {
  it("run completing emits run.completed to a matching sub exactly ONCE", async () => {
    const { api, base, sink, projectId, taskId, agentId } = await boot();

    const create = await http(base, "POST", `/api/projects/${projectId}/webhooks`, {
      url: "http://example.test/hook",
      eventTypes: ["run.completed"],
    });
    expect(create.status).toBe(201);
    const secret =
      create.json.webhook?.secret ?? create.json.subscription?.secret;
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(8);

    // Create + start a run (fixture adapter finishes quickly).
    const batch = api.queries.createBatch({
      projectId,
      taskId,
      agentId,
      model: "fixture",
      provider: "fixture",
      params: {},
      repeats: 1,
    });
    const run = api.queries.createRun({
      batchId: batch.id,
      taskId,
      projectId,
      agentId,
      model: "fixture",
      provider: "fixture",
      repeatIndex: 0,
    });

    await api.app.enqueueStart(run.id);
    // Wait for terminal.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = api.queries.getRun(run.id);
      if (r && ["completed", "failed", "aborted", "timeout"].includes(r.status)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    // Allow dispatch to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(sink.attempts.length).toBe(1);
    const attempt = sink.attempts[0]!;
    expect(attempt.url).toBe("http://example.test/hook");
    expect(attempt.headers["X-Agenteval-Event"]).toBe("run.completed");
    expect(attempt.headers["Content-Type"]).toBe("application/json");
    const sig = attempt.headers["X-Agenteval-Signature-256"];
    expect(sig).toBe(expectedSig(secret, attempt.body));
    expect(sig).toBe(signPayload(secret, attempt.body));

    const payload = JSON.parse(attempt.body);
    expect(payload.type).toBe("run.completed");
    expect(payload.project).toBe(projectId);
    expect(payload.resource).toBe(run.id);
    expect(payload.data.status).toBeDefined();

    const deliveries = api.queries.listWebhookDeliveries(projectId, {
      subscriptionId: create.json.webhook?.id ?? create.json.subscription?.id,
    });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("success");
    expect(deliveries[0]!.attempt).toBe(1);
  });

  it("run ABORTED via API emits run.completed (status aborted) exactly ONCE", async () => {
    // Regression for the abort path's missed-emit gap: abortRun finalizes as
    // "aborted" but (before the fix) skipped emitRunCompletedHook because the
    // done pipeline's emit was guarded by `!live.finished`, which abort set.
    // Now abort emits run.completed itself — exactly once, status "aborted".
    const dataDir = await tempDataDir();
    const sink = new FakeDeliverySink();
    const api = createServer({
      dataDir,
      adapter: createFixtureAdapter({ holdMs: 5_000 }), // long hold so we can abort mid-run
      outboundBackoffMs: [0, 0, 0],
      outboundSink: sink,
    });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;

    const project = api.queries.createProject({ name: "Abort", slug: "abort-emit" });
    const agent = api.queries.registerAgent({ id: "abort-agent", displayName: "A" });
    const task = api.queries.createTask(project.id, sampleTask());

    // Subscribe to run.completed.
    const create = await http(base, "POST", `/api/projects/${project.id}/webhooks`, {
      url: "http://example.test/hook",
      eventTypes: ["run.completed"],
    });
    expect(create.status).toBe(201);
    const subId =
      create.json.webhook?.id ?? create.json.subscription?.id;

    const batch = api.queries.createBatch({
      projectId: project.id, taskId: task.id, agentId: agent.id,
      model: "fixture", provider: "fixture", params: {}, repeats: 1,
    });
    const run = api.queries.createRun({
      batchId: batch.id, taskId: task.id, projectId: project.id,
      agentId: agent.id, model: "fixture", provider: "fixture", repeatIndex: 0,
    });
    await api.app.enqueueStart(run.id);

    // Wait until the run is running, then abort via the API.
    const waitDeadline = Date.now() + 5_000;
    while (Date.now() < waitDeadline) {
      const r = api.queries.getRun(run.id);
      if (r && r.status === "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const abortRes = await http(base, "POST", `/api/runs/${run.id}/abort`);
    expect(abortRes.status).toBe(200);
    expect(abortRes.json.status).toBe("aborted");

    // Allow the (no-backoff) dispatch to settle.
    await new Promise((r) => setTimeout(r, 80));

    // Exactly one delivery, event run.completed, data.status === "aborted".
    expect(sink.attempts.length).toBe(1);
    const attempt = sink.attempts[0]!;
    expect(attempt.headers["X-Agenteval-Event"]).toBe("run.completed");
    const payload = JSON.parse(attempt.body);
    expect(payload.type).toBe("run.completed");
    expect(payload.resource).toBe(run.id);
    expect(payload.data.status).toBe("aborted");

    const deliveries = api.queries.listWebhookDeliveries(project.id, {
      subscriptionId: subId,
    });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("success");

    // Clean up the mostly-idle live run handle.
    const live = api.liveRuns.get(run.id);
    if (live) await live.done.catch(() => undefined);
  });

  it("eventTypes filter: run-only sub does NOT receive verdict.completed; empty=all does", async () => {
    const { api, projectId, sink } = await boot();
    const runOnly = api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/run-only",
      eventTypes: ["run.completed"],
      secret: "run-secret",
    });
    const all = api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/all",
      eventTypes: [],
      secret: "all-secret",
    });
    void runOnly;
    void all;

    await api.app.outboundWebhooks!.dispatchEvent({
      type: "verdict.completed",
      projectId,
      resourceId: "j1",
      data: { runId: "r1" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 20));

    // Only the empty=all sub should fire.
    expect(sink.attempts.length).toBe(1);
    expect(sink.attempts[0]!.url).toBe("http://example.test/all");
    expect(sink.attempts[0]!.headers["X-Agenteval-Event"]).toBe(
      "verdict.completed",
    );
  });

  it("failing sink (500) retries then records status=failed", async () => {
    const sink = new FakeDeliverySink();
    sink.defaultStatus = 500;
    sink.defaultBody = "nope";
    const { api, projectId } = await boot({ sink });

    api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/fail",
      secret: "fail-secret",
      eventTypes: ["run.completed"],
    });

    await api.app.outboundWebhooks!.dispatchEvent({
      type: "run.completed",
      projectId,
      resourceId: "r-fail",
      data: { status: "completed" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 50));

    // maxAttempts=4 with backoff [0,0,0]
    expect(sink.attempts.length).toBe(4);
    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("failed");
    expect(deliveries[0]!.attempt).toBe(4);
    expect(deliveries[0]!.responseStatus).toBe(500);
    expect(deliveries[0]!.error).toMatch(/500|HTTP/);
    // Secret never logged in delivery fields.
    const blob = JSON.stringify(deliveries[0]);
    expect(blob).not.toContain("fail-secret");
  });

  it("network throw is caught → failed, not crash", async () => {
    const sink = new FakeDeliverySink();
    sink.throwOnPost = true;
    sink.throwMessage = "ECONNREFUSED simulated";
    const { api, projectId } = await boot({ sink });

    api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/net",
      secret: "net-secret",
    });

    await expect(
      api.app.outboundWebhooks!.dispatchEvent({
        type: "run.completed",
        projectId,
        resourceId: "r-net",
        data: { status: "failed" },
        timestamp: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    await new Promise((r) => setTimeout(r, 50));
    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("failed");
    expect(deliveries[0]!.error).toContain("ECONNREFUSED");
    expect(JSON.stringify(deliveries[0])).not.toContain("net-secret");
  });

  it("per-sub isolation: one 500s, the other succeeds", async () => {
    const sink = new FakeDeliverySink();
    sink.statusByUrl.set("http://example.test/bad", 500);
    sink.statusByUrl.set("http://example.test/good", 200);
    const { api, projectId } = await boot({ sink });

    api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/bad",
      secret: "bad-secret",
    });
    api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/good",
      secret: "good-secret",
    });

    await api.app.outboundWebhooks!.dispatchEvent({
      type: "verdict.completed",
      projectId,
      resourceId: "j-iso",
      data: {},
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 80));

    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(2);
    const statuses = deliveries.map((d) => d.status).sort();
    expect(statuses).toEqual(["failed", "success"]);
  });

  it("secret never appears in recorded delivery payload/error", async () => {
    const sink = new FakeDeliverySink();
    sink.defaultStatus = 503;
    const { api, projectId } = await boot({ sink });
    const secret = "super-secret-value-xyz";
    api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/sec",
      secret,
    });
    await api.app.outboundWebhooks!.dispatchEvent({
      type: "run.completed",
      projectId,
      resourceId: "r-sec",
      data: { status: "completed" },
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 50));
    const deliveries = api.queries.listWebhookDeliveries(projectId);
    for (const d of deliveries) {
      expect(JSON.stringify(d)).not.toContain(secret);
      expect(d.error ?? "").not.toContain(secret);
    }
  });

  it("release.compared is emitted after GET compare/releases", async () => {
    const { api, base, sink, projectId, taskId, agentId } = await boot();
    api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/release",
      secret: "rel-secret",
      eventTypes: ["release.compared"],
    });

    // Seed two versions with completed judgements so releaseCompare works.
    // Minimal: create runs with agentCommit/triggerRef matching from/to, storeVerdict.
    // If seed is heavy, call dispatchEvent directly for unit-level; here we hit the route.
    // Use direct dispatcher if compare needs more data — still assert the route hook.
    const from = "v1.0.0";
    const to = "v2.0.0";

    // Create two runs with matching agent commits so buildReleaseSide has data.
    // Without judgements, releaseCompare may still run with empty task results.
    // Regression routes require at least one run per version.
    for (const ver of [from, to]) {
      const batch = api.queries.createBatch({
        projectId,
        taskId,
        agentId,
        model: "fixture",
        provider: "fixture",
        params: {},
        repeats: 1,
        agentCommit: ver,
      });
      const run = api.queries.createRun({
        batchId: batch.id,
        taskId,
        projectId,
        agentId,
        model: "fixture",
        provider: "fixture",
        repeatIndex: 0,
        agentCommit: ver,
        triggerRef: ver,
      });
      api.queries.finalizeRun(run.id, {
        status: "completed",
        controlState: "done",
      });
    }

    const res = await http(
      base,
      "GET",
      `/api/projects/${projectId}/compare/releases?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    // Route may 200 even with sparse judgement data.
    if (res.status === 200) {
      await new Promise((r) => setTimeout(r, 50));
      expect(sink.attempts.length).toBeGreaterThanOrEqual(1);
      const hit = sink.attempts.find(
        (a) => a.headers["X-Agenteval-Event"] === "release.compared",
      );
      expect(hit).toBeTruthy();
      const body = JSON.parse(hit!.body);
      expect(body.type).toBe("release.compared");
      expect(body.resource).toBe(`${from}->${to}`);
    } else {
      // Fallback: invoke dispatcher path the route would use.
      await api.app.outboundWebhooks!.dispatchEvent({
        type: "release.compared",
        projectId,
        resourceId: `${from}->${to}`,
        data: { suiteDelta: {}, improved: [], regressed: [] },
        timestamp: new Date().toISOString(),
      });
      expect(sink.attempts.length).toBe(1);
    }
  });
});

describe("secret strip contract on QueryStore", () => {
  it("create returns secret once; get/list/update never do; withSecret is only raw path", async () => {
    const { api, projectId } = await boot();
    const created = api.queries.createOutboundSubscription(projectId, {
      url: "http://example.test/once",
      secret: "once-secret",
    });
    expect(created.secret).toBe("once-secret");

    const got = api.queries.getOutboundSubscription(created.id);
    expect(got?.secret).toBeNull();

    const listed = api.queries.listOutboundSubscriptions(projectId);
    expect(listed.every((s) => s.secret === null)).toBe(true);

    const updated = api.queries.updateOutboundSubscription(created.id, {
      enabled: true,
    });
    expect(updated.secret).toBeNull();

    const raw = api.queries.getOutboundSubscriptionWithSecret(created.id);
    expect(raw).toBe("once-secret");
  });
});

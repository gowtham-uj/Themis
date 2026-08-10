/**
 * Outbound webhook dispatcher + emit-site tests (P8c) — real HTTP delivery.
 *
 * Subscriptions point at a REAL local HTTP server (Node http.createServer) that
 * records received POSTs, so delivery, retries, isolation, and signing are
 * exercised over real HTTP. No FakeDeliverySink. Events are dispatched
 * directly through the real dispatcher (the emit seam runs/judgements use);
 * no agent run is involved.
 */
import { createHmac } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createServer,
  OutboundWebhookDispatcher,
  signPayload,
  buildEventPayload,
  type ApiServer,
} from "../src/api/server.ts";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];
const captureServers: Server[] = [];

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
  for (const srv of captureServers.splice(0)) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-outbound-"));
  tempDirs.push(dir);
  return dir;
}

interface Attempt {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** A real local HTTP server capturing POSTs. Configurable per-URL status/throw. */
class CaptureServer {
  attempts: Attempt[] = [];
  statusByUrl = new Map<string, number>();
  throwUrls = new Set<string>();
  server: Server;
  url = "";
  port = 0;

  constructor() {
    this.server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(",");
        }
        const url = `http://127.0.0.1:${this.port}${req.url}`;
        this.attempts.push({ url, body: Buffer.concat(chunks).toString("utf8"), headers });
        if (this.throwUrls.has(url)) {
          res.socket?.destroy();
          return;
        }
        const status = this.statusByUrl.get(url) ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 200 ? '{"ok":true}' : "nope");
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.url = `http://127.0.0.1:${this.port}`;
        }
        resolve();
      }),
    );
    captureServers.push(this.server);
  }

  urlFor(path: string): string {
    return `${this.url}${path}`;
  }
}

async function boot(): Promise<{ api: ApiServer; base: string; projectId: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir, outboundBackoffMs: [0, 0, 0] });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const project = api.queries.createProject({
    name: "Outbound Test",
    slug: `outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { api, base, projectId: project.id };
}

async function waitForAttempts(capture: CaptureServer, count: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (capture.attempts.length >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function expectedSig(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
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

describe("outbound dispatch (real HTTP)", () => {
  it("dispatchEvent delivers run.completed to a matching sub exactly ONCE over HTTP", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    await capture.start();

    const sub = api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/hook"),
      eventTypes: ["run.completed"],
    });
    expect(typeof sub.secret).toBe("string");

    await api.app.outboundWebhooks!.dispatchEvent({
      type: "run.completed",
      projectId,
      resourceId: "run-1",
      data: { status: "completed" },
      timestamp: new Date().toISOString(),
    });
    await waitForAttempts(capture, 1);

    expect(capture.attempts.length).toBe(1);
    const attempt = capture.attempts[0]!;
    expect(attempt.url).toBe(capture.urlFor("/hook"));
    expect(attempt.headers["x-agenteval-event"]).toBe("run.completed");
    expect(attempt.headers["content-type"]).toBe("application/json");
    const sig = attempt.headers["x-agenteval-signature-256"];
    expect(sig).toBe(expectedSig(sub.secret, attempt.body));
    expect(sig).toBe(signPayload(sub.secret, attempt.body));

    const payload = JSON.parse(attempt.body);
    expect(payload.type).toBe("run.completed");
    expect(payload.project).toBe(projectId);
    expect(payload.resource).toBe("run-1");
    expect(payload.data.status).toBe("completed");

    const deliveries = api.queries.listWebhookDeliveries(projectId, {
      subscriptionId: sub.id,
    });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("success");
    expect(deliveries[0]!.attempt).toBe(1);
  });

  it("eventTypes filter: run-only sub does NOT receive verdict.completed; empty=all does", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    await capture.start();

    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/run-only"),
      eventTypes: ["run.completed"],
      secret: "run-secret",
    });
    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/all"),
      eventTypes: [],
      secret: "all-secret",
    });

    await api.app.outboundWebhooks!.dispatchEvent({
      type: "verdict.completed",
      projectId,
      resourceId: "j1",
      data: { runId: "r1" },
      timestamp: new Date().toISOString(),
    });
    await waitForAttempts(capture, 1);

    expect(capture.attempts.length).toBe(1);
    expect(capture.attempts[0]!.url).toBe(capture.urlFor("/all"));
    expect(capture.attempts[0]!.headers["x-agenteval-event"]).toBe(
      "verdict.completed",
    );
  });

  it("failing sink (500) retries then records status=failed", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    capture.statusByUrl.set(capture.urlFor("/fail") as never, 500);
    await capture.start();

    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/fail"),
      secret: "fail-secret",
      eventTypes: ["run.completed"],
    });

    // Build a fresh dispatcher with maxAttempts=4 + no backoff so the retry
    // count is deterministic, dispatched directly (the real emit path).
    const dispatcher = new OutboundWebhookDispatcher({
      queries: api.queries,
      backoffMs: [0, 0, 0],
      maxAttempts: 4,
    });
    await dispatcher.dispatchEvent({
      type: "run.completed",
      projectId,
      resourceId: "r-fail",
      data: { status: "completed" },
      timestamp: new Date().toISOString(),
    });
    await waitForAttempts(capture, 4);

    expect(capture.attempts.length).toBe(4);
    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("failed");
    expect(deliveries[0]!.attempt).toBe(4);
    expect(deliveries[0]!.responseStatus).toBe(500);
    expect(deliveries[0]!.error).toMatch(/500|HTTP/);
    expect(JSON.stringify(deliveries[0])).not.toContain("fail-secret");
  });

  it("network throw (socket destroyed) is caught → failed, not crash", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    await capture.start();
    const badUrl = capture.urlFor("/net");
    capture.throwUrls.add(badUrl);

    api.queries.createOutboundSubscription(projectId, {
      url: badUrl,
      secret: "net-secret",
    });

    const dispatcher = new OutboundWebhookDispatcher({
      queries: api.queries,
      backoffMs: [0, 0, 0],
      maxAttempts: 1,
    });
    await expect(
      dispatcher.dispatchEvent({
        type: "run.completed",
        projectId,
        resourceId: "r-net",
        data: { status: "failed" },
        timestamp: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    await waitForAttempts(capture, 1);
    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.status).toBe("failed");
    expect(JSON.stringify(deliveries[0])).not.toContain("net-secret");
  });

  it("per-sub isolation: one 500s, the other succeeds", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    capture.statusByUrl.set(capture.urlFor("/bad") as never, 500);
    capture.statusByUrl.set(capture.urlFor("/good") as never, 200);
    await capture.start();

    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/bad"),
      secret: "bad-secret",
    });
    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/good"),
      secret: "good-secret",
    });

    const dispatcher = new OutboundWebhookDispatcher({
      queries: api.queries,
      backoffMs: [0, 0, 0],
      maxAttempts: 1,
    });
    await dispatcher.dispatchEvent({
      type: "verdict.completed",
      projectId,
      resourceId: "j-iso",
      data: {},
      timestamp: new Date().toISOString(),
    });
    await waitForAttempts(capture, 2);

    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(2);
    const statuses = deliveries.map((d) => d.status).sort();
    expect(statuses).toEqual(["failed", "success"]);
  });

  it("secret never appears in recorded delivery payload/error", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    capture.statusByUrl.set(capture.urlFor("/sec") as never, 503);
    await capture.start();
    const secret = "super-secret-value-xyz";
    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/sec"),
      secret,
    });

    const dispatcher = new OutboundWebhookDispatcher({
      queries: api.queries,
      backoffMs: [0, 0, 0],
      maxAttempts: 1,
    });
    await dispatcher.dispatchEvent({
      type: "run.completed",
      projectId,
      resourceId: "r-sec",
      data: { status: "completed" },
      timestamp: new Date().toISOString(),
    });
    await waitForAttempts(capture, 1);

    const deliveries = api.queries.listWebhookDeliveries(projectId);
    expect(deliveries.length).toBe(1);
    for (const d of deliveries) {
      expect(JSON.stringify(d)).not.toContain(secret);
      expect(d.error ?? "").not.toContain(secret);
    }
  });

  it("release.compared is dispatched over HTTP", async () => {
    const { api, projectId } = await boot();
    const capture = new CaptureServer();
    await capture.start();
    api.queries.createOutboundSubscription(projectId, {
      url: capture.urlFor("/release"),
      secret: "rel-secret",
      eventTypes: ["release.compared"],
    });

    await api.app.outboundWebhooks!.dispatchEvent({
      type: "release.compared",
      projectId,
      resourceId: "v1.0.0->v2.0.0",
      data: { suiteDelta: {}, improved: [], regressed: [] },
      timestamp: new Date().toISOString(),
    });
    await waitForAttempts(capture, 1);

    expect(capture.attempts.length).toBe(1);
    const hit = capture.attempts[0]!;
    expect(hit.headers["x-agenteval-event"]).toBe("release.compared");
    const body = JSON.parse(hit.body);
    expect(body.type).toBe("release.compared");
    expect(body.resource).toBe("v1.0.0->v2.0.0");
    expect(hit.headers["x-agenteval-signature-256"]).toBe(
      expectedSig("rel-secret", hit.body),
    );
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

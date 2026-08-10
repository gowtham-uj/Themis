/**
 * Outbound webhook HTTP routes (P8c) — CRUD + test fire against a real sink.
 *
 * The subscription CRUD + secret-strip tests boot the real API server with no
 * sink. The test-fire test points a subscription at a REAL local HTTP server
 * (Node http.createServer on an ephemeral port) that records received POSTs,
 * so delivery is exercised over real HTTP — no fake sink.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-webhooks-routes-"));
  tempDirs.push(dir);
  return dir;
}

async function boot(): Promise<{ api: ApiServer; base: string; projectId: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({
    dataDir,
    outboundBackoffMs: [0, 0, 0],
  });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const project = api.queries.createProject({
    name: "Webhooks Routes",
    slug: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { api, base, projectId: project.id };
}

/** A real local HTTP server that records every POST it receives. */
interface CaptureServer {
  server: Server;
  url: string;
  attempts: Array<{
    body: string;
    headers: Record<string, string>;
  }>;
  status: number;
}

async function startCapture(status = 200): Promise<CaptureServer> {
  const attempts: CaptureServer["attempts"] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(",");
      }
      attempts.push({ body: Buffer.concat(chunks).toString("utf8"), headers });
      res.writeHead(status, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  captureServers.push(server);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, attempts, status };
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

describe("webhooks routes", () => {
  it("GET list (stripped), POST create (secret once), PATCH (no secret), DELETE 204", async () => {
    const { base, projectId } = await boot();

    const empty = await http(base, "GET", `/api/projects/${projectId}/webhooks`);
    expect(empty.status).toBe(200);
    const list0 = empty.json.webhooks ?? empty.json.subscriptions;
    expect(Array.isArray(list0)).toBe(true);
    expect(list0.length).toBe(0);

    const created = await http(
      base,
      "POST",
      `/api/projects/${projectId}/webhooks`,
      {
        url: "https://hooks.example.com/agenteval",
        eventTypes: ["run.completed", "verdict.completed"],
      },
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("X-Agenteval-Secret-Once")).toBe("true");
    const sub = created.json.webhook ?? created.json.subscription;
    expect(sub.url).toBe("https://hooks.example.com/agenteval");
    expect(typeof sub.secret).toBe("string");
    expect(sub.secret.length).toBeGreaterThan(8);
    expect(sub.eventTypes ?? sub.event_types).toEqual([
      "run.completed",
      "verdict.completed",
    ]);
    const subId = sub.id as string;
    const onceSecret = sub.secret as string;

    const listed = await http(base, "GET", `/api/projects/${projectId}/webhooks`);
    expect(listed.status).toBe(200);
    const list1 = listed.json.webhooks ?? listed.json.subscriptions;
    expect(list1.length).toBe(1);
    expect(list1[0].secret).toBeNull();
    expect(JSON.stringify(list1)).not.toContain(onceSecret);

    const patched = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/webhooks/${subId}`,
      { enabled: false, url: "https://hooks.example.com/v2" },
    );
    expect(patched.status).toBe(200);
    const psub = patched.json.webhook ?? patched.json.subscription;
    expect(psub.secret).toBeNull();
    expect(psub.enabled).toBe(false);
    expect(psub.url).toBe("https://hooks.example.com/v2");
    expect(JSON.stringify(patched.json)).not.toContain(onceSecret);

    const badPatch = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/webhooks/${subId}`,
      { secret: "new-secret" },
    );
    expect(badPatch.status).toBe(400);

    const del = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/webhooks/${subId}`,
    );
    expect(del.status).toBe(204);

    const listed2 = await http(base, "GET", `/api/projects/${projectId}/webhooks`);
    const list2 = listed2.json.webhooks ?? listed2.json.subscriptions;
    expect(list2.length).toBe(0);
  });

  it("POST rejects bad url; 404s for missing project/sub", async () => {
    const { base, projectId } = await boot();

    const bad = await http(base, "POST", `/api/projects/${projectId}/webhooks`, {
      url: "not-a-url",
    });
    expect(bad.status).toBe(400);

    const missingProj = await http(
      base,
      "GET",
      `/api/projects/does-not-exist/webhooks`,
    );
    expect(missingProj.status).toBe(404);

    const missingSub = await http(
      base,
      "DELETE",
      `/api/projects/${projectId}/webhooks/nope`,
    );
    expect(missingSub.status).toBe(404);
  });

  it("GET deliveries + POST test fires a real delivery over HTTP (202 + deliveryId)", async () => {
    const { base, projectId } = await boot();
    const capture = await startCapture(200);

    const created = await http(
      base,
      "POST",
      `/api/projects/${projectId}/webhooks`,
      { url: `${capture.url}/test-hook` },
    );
    expect(created.status).toBe(201);
    const subId = (created.json.webhook ?? created.json.subscription).id as string;

    const empty = await http(
      base,
      "GET",
      `/api/projects/${projectId}/webhooks/${subId}/deliveries`,
    );
    expect(empty.status).toBe(200);
    expect(empty.json.deliveries).toEqual([]);

    const test = await http(
      base,
      "POST",
      `/api/projects/${projectId}/webhooks/${subId}/test`,
    );
    expect(test.status).toBe(202);
    expect(test.json.deliveryId ?? test.json.delivery_id).toBeTruthy();
    expect(test.json.status).toBe("success");

    // The dispatcher delivered to the real local server asynchronously.
    const delivered = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (capture.attempts.length >= 1) return resolve(true);
        if (Date.now() - start > 5000) return resolve(false);
        setTimeout(tick, 25);
      };
      tick();
    });
    expect(delivered).toBe(true);
    expect(capture.attempts.length).toBe(1);
    expect(capture.attempts[0]!.headers["x-agenteval-event"]).toBe(
      "verdict.completed",
    );
    expect(
      capture.attempts[0]!.headers["x-agenteval-signature-256"]?.startsWith(
        "sha256=",
      ),
    ).toBe(true);

    const deliveries = await http(
      base,
      "GET",
      `/api/projects/${projectId}/webhooks/${subId}/deliveries`,
    );
    expect(deliveries.status).toBe(200);
    expect(deliveries.json.deliveries.length).toBe(1);
    expect(deliveries.json.deliveries[0].status).toBe("success");
    expect(deliveries.json.deliveries[0].eventType ?? deliveries.json.deliveries[0].event_type).toBe(
      "verdict.completed",
    );
  });

  it("secret never returned after create", async () => {
    const { api, base, projectId } = await boot();
    const created = await http(
      base,
      "POST",
      `/api/projects/${projectId}/webhooks`,
      { url: "https://example.com/h", secret: "route-secret-abc" },
    );
    const subId = (created.json.webhook ?? created.json.subscription).id as string;
    expect(
      (created.json.webhook ?? created.json.subscription).secret,
    ).toBe("route-secret-abc");

    const got = api.queries.getOutboundSubscription(subId);
    expect(got?.secret).toBeNull();
    const listed = api.queries.listOutboundSubscriptions(projectId);
    expect(listed[0]?.secret).toBeNull();
    expect(api.queries.getOutboundSubscriptionWithSecret(subId)).toBe(
      "route-secret-abc",
    );
  });
});

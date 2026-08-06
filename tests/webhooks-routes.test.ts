/**
 * Outbound webhook HTTP routes (P8c).
 *
 * Boots the real ApiServer with FakeDeliverySink. OFFLINE.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureAdapter,
  createServer,
  FakeDeliverySink,
  type ApiServer,
} from "../src/api/server.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-webhooks-routes-"));
  tempDirs.push(dir);
  return dir;
}

async function boot(): Promise<{
  api: ApiServer;
  base: string;
  sink: FakeDeliverySink;
  projectId: string;
}> {
  const dataDir = await tempDataDir();
  const sink = new FakeDeliverySink();
  const api = createServer({
    dataDir,
    adapter: createFixtureAdapter(),
    outboundSink: sink,
    outboundBackoffMs: [0, 0, 0],
  });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const project = api.queries.createProject({
    name: "Webhooks Routes",
    slug: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { api, base, sink, projectId: project.id };
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

    // Empty list.
    const empty = await http(base, "GET", `/api/projects/${projectId}/webhooks`);
    expect(empty.status).toBe(200);
    const list0 = empty.json.webhooks ?? empty.json.subscriptions;
    expect(Array.isArray(list0)).toBe(true);
    expect(list0.length).toBe(0);

    // Create.
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

    // List strips secret.
    const listed = await http(base, "GET", `/api/projects/${projectId}/webhooks`);
    expect(listed.status).toBe(200);
    const list1 = listed.json.webhooks ?? listed.json.subscriptions;
    expect(list1.length).toBe(1);
    expect(list1[0].secret).toBeNull();
    expect(JSON.stringify(list1)).not.toContain(onceSecret);

    // PATCH — no secret in body/response.
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

    // PATCH rejecting secret rotation.
    const badPatch = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/webhooks/${subId}`,
      { secret: "new-secret" },
    );
    expect(badPatch.status).toBe(400);

    // DELETE.
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

  it("GET deliveries + POST test fires synthetic delivery (202 + deliveryId)", async () => {
    const { base, projectId, sink } = await boot();

    const created = await http(
      base,
      "POST",
      `/api/projects/${projectId}/webhooks`,
      { url: "http://example.test/test-hook" },
    );
    expect(created.status).toBe(201);
    const subId = (created.json.webhook ?? created.json.subscription).id as string;

    // Empty deliveries.
    const empty = await http(
      base,
      "GET",
      `/api/projects/${projectId}/webhooks/${subId}/deliveries`,
    );
    expect(empty.status).toBe(200);
    expect(empty.json.deliveries).toEqual([]);

    // Synthetic test fire.
    const test = await http(
      base,
      "POST",
      `/api/projects/${projectId}/webhooks/${subId}/test`,
    );
    expect(test.status).toBe(202);
    expect(test.json.deliveryId ?? test.json.delivery_id).toBeTruthy();
    expect(test.json.status).toBe("success");

    expect(sink.attempts.length).toBe(1);
    expect(sink.attempts[0]!.headers["X-Agenteval-Event"]).toBe(
      "verdict.completed",
    );
    expect(
      sink.attempts[0]!.headers["X-Agenteval-Signature-256"]?.startsWith(
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
    // Only withSecret path returns it.
    expect(api.queries.getOutboundSubscriptionWithSecret(subId)).toBe(
      "route-secret-abc",
    );
  });
});

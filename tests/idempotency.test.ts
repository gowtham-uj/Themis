/**
 * P8b-auth — Idempotency-Key dedup for POST create/run endpoints.
 *
 * Boots the real API server (auth off). The runs-route dedup tests assert the
 * synchronous 202 + dedup invariant at POST time; they do not wait for the run
 * to complete (no real agent is involved). The store/middleware primitives are
 * unit-tested directly with a plain handler thunk (no model).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import {
  IdempotencyStore,
  withIdempotency,
  idempotencyStoreKey,
} from "../src/api/middleware.ts";
import { Router, sendJson, type RequestContext } from "../src/api/router.ts";
import type { Rubric } from "../src/domain.ts";
import { createServer as createHttpServer } from "node:http";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];
const rawServers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.close();
    } catch {
      // best-effort
    }
  }
  for (const s of rawServers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-idem-"));
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

interface HttpResult {
  status: number;
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
  return { status: res.status, json, text };
}

async function boot(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

describe("Idempotency-Key (P8b)", () => {
  it("IdempotencyStore TTL expiry re-executes (unit)", () => {
    let now = 1_000_000;
    const store = new IdempotencyStore({
      ttlMs: 1000,
      maxSize: 10,
      now: () => now,
    });
    store.set("k", { status: 200, body: { n: 1 } });
    expect(store.get("k")?.body).toEqual({ n: 1 });
    now += 1001;
    expect(store.get("k")).toBeUndefined();
  });

  it("IdempotencyStore LRU evicts oldest when over capacity", () => {
    const store = new IdempotencyStore({ maxSize: 2, ttlMs: 60_000 });
    store.set("a", { status: 200, body: 1 });
    store.set("b", { status: 200, body: 2 });
    store.set("c", { status: 200, body: 3 });
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
  });

  it("withIdempotency wrapper replays captured response", async () => {
    let executions = 0;
    const store = new IdempotencyStore();
    const router = new Router();
    router.post(
      "/echo",
      withIdempotency(async (_req, res, _ctx: RequestContext) => {
        executions += 1;
        sendJson(res, 201, { n: executions });
      }),
    );

    const server = createHttpServer((req, res) => {
      void router
        .handle(req, res, { idempotency: store })
        .catch(() => undefined);
    });
    rawServers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("bind failed"));
      });
    });
    const base = `http://127.0.0.1:${port}`;

    const a = await http(base, "POST", "/echo", {
      headers: { "Idempotency-Key": "wrap-1" },
      body: {},
    });
    const b = await http(base, "POST", "/echo", {
      headers: { "Idempotency-Key": "wrap-1" },
      body: {},
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json).toEqual({ n: 1 });
    expect(b.json).toEqual({ n: 1 });
    expect(executions).toBe(1);

    // Store key includes caller + method+path.
    expect(
      store.has(idempotencyStoreKey("POST", "/echo", "wrap-1", "remote:127.0.0.1")),
    ).toBe(true);
  });

  it("reserve() blocks concurrent same-key execution (TOCTOU primitive, deterministic)", () => {
    // The TOCTOU fix is a SYNCHRONOUS reservation primitive on the store:
    // reserve() claims the key before the handler runs; a second reservation
    // against the same in-flight key returns false. This is what lets
    // withIdempotency emit 409 (or replay) for a concurrent request instead of
    // double-executing. Tested deterministically here (no event-loop timing).
    const store = new IdempotencyStore();

    // First caller claims the key synchronously.
    expect(store.reserve("k")).toBe(true);

    // A concurrent caller (same key, still in flight) cannot also claim it.
    expect(store.reserve("k")).toBe(false);

    // The held value is a pending marker, not a completed response.
    const ref = store.getReference("k");
    expect(ref && "pending" in ref).toBe(true);
    // get() deliberately does NOT surface in-flight entries (no response yet).
    expect(store.get("k")).toBeUndefined();

    // First caller completes the response.
    store.set("k", { status: 202, body: { batch_id: "b1" } });
    // Now get() returns the completed response; a new reserve replays, not 409.
    expect(store.get("k")?.body).toEqual({ batch_id: "b1" });
    expect(store.reserve("k")).toBe(false);

    // release() clears a pending reservation so a retry executes fresh.
    expect(store.reserve("k2")).toBe(true);
    store.release("k2");
    expect(store.reserve("k2")).toBe(true); // claimable again after release
  });

  it("reserve() does not collide across method+path (no cross-route keying bug)", () => {
    // The OLD inline cache keyed on the raw header alone → a key reused on two
    // different routes would replay the wrong response. withIdempotency keys on
    // method+path+key (idempotencyStoreKey); reserve() operates on that same
    // scoped key. Same raw key, two routes → two independent reservations.
    const store = new IdempotencyStore();
    const ka = idempotencyStoreKey("POST", "/api/projects/p/runs", "shared");
    const kb = idempotencyStoreKey("POST", "/api/projects/p/queue", "shared");
    expect(ka).not.toBe(kb);
    expect(store.reserve(ka)).toBe(true);
    expect(store.reserve(kb)).toBe(true); // different route → independent
  });

  it("withIdempotency: handler throw releases the reservation (retry executes)", async () => {
    const store = new IdempotencyStore();
    const router = new Router();
    let attempts = 0;
    router.post(
      "/flaky",
      withIdempotency(async (_req, res, _ctx: RequestContext) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        sendJson(res, 201, { ok: true });
      }),
    );

    const server = createHttpServer((req, res) => {
      void router
        .handle(req, res, { idempotency: store })
        .catch(() => {
          // errors surface as 500 from the router; swallow for the test
        });
    });
    rawServers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("bind failed"));
      });
    });
    const base = `http://127.0.0.1:${port}`;

    const headers = { "Idempotency-Key": "retry-after-throw" };
    // First attempt throws — the reservation is released.
    const a = await http(base, "POST", "/flaky", { headers, body: {} });
    expect(a.status).toBe(500);
    // Second attempt with the SAME key executes again (released) and succeeds.
    const b = await http(base, "POST", "/flaky", { headers, body: {} });
    expect(b.status).toBe(201);
    expect(attempts).toBe(2);
  });

  it("concurrent same-key against a POST route never double-executes the handler", async () => {
    // End-to-end invariant: two simultaneous requests sharing an
    // Idempotency-Key produce AT MOST one handler execution. Depending on timing
    // the second response is either a replay (same body) or a 409 in-flight
    // conflict — either way, exactly one execution. This is the flaky-CI
    // double-enqueue primitive, tested on a plain handler (no agent/model).
    const store = new IdempotencyStore();
    let executions = 0;
    const router = new Router();
    router.post(
      "/create",
      withIdempotency(async (_req, res, _ctx: RequestContext) => {
        executions += 1;
        // Simulate a tiny bit of work so the in-flight window is real.
        await new Promise((r) => setTimeout(r, 20));
        sendJson(res, 202, { n: executions });
      }),
    );

    const server = createHttpServer((req, res) => {
      void router.handle(req, res, { idempotency: store }).catch(() => undefined);
    });
    rawServers.push(server);
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("bind failed"));
      });
    });
    const base = `http://127.0.0.1:${port}`;

    const headers = { "Idempotency-Key": "concurrent-1" };
    const [a, b] = await Promise.all([
      http(base, "POST", "/create", { headers, body: {} }),
      http(base, "POST", "/create", { headers, body: {} }),
    ]);
    for (const r of [a, b]) {
      expect(r.status === 202 || r.status === 409).toBe(true);
    }
    const ok = [a, b].find((r) => r.status === 202);
    expect(ok).toBeDefined();
    expect((ok!.json as { n: number }).n).toBe(1);
    expect(executions).toBe(1);
  });
});

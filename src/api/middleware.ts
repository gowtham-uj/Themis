/**
 * Shared HTTP middleware helpers (P8b-auth).
 *
 * - Bearer extraction (Authorization: Bearer <token>)
 * - Idempotency-Key dedup store (LRU + TTL) for POST create endpoints
 *
 * Spec: plan/api.md §Conventions — Idempotency-Key on create/run so flaky
 * clients do not double-enqueue.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson, type RequestContext, type RouteHandler } from "./router.js";

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/** Read a single header value (first wins if multi). */
export function header(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Extract a Bearer token from `Authorization: Bearer <token>`.
 * Returns null when missing or not Bearer.
 */
export function extractBearer(req: IncomingMessage): string | null {
  const raw = header(req, "authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(raw);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Idempotency store (in-memory LRU + TTL)
// ---------------------------------------------------------------------------

export interface IdempotencyEntry {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * In-flight reservation marker. Set synchronously (before the handler runs) so
 * that a TRULY concurrent second request sharing the same key cannot pass the
 * has() check, execute the handler, and double-create. The second request
 * either replays the completed response (once `complete` is set) or gets a 409
 * Conflict while the first is still running. This closes the check-then-act
 * TOCTOU window that sequential-only dedup leaves open.
 */
export interface IdempotencyPending {
  pending: true;
  storedAt: number;
}

interface StoredEntry extends IdempotencyEntry {
  storedAt: number;
}

type StoredValue = StoredEntry | IdempotencyPending;

/** Default cap — ~1000 recent keys. */
export const IDEMPOTENCY_MAX_SIZE = 1000;
/** Default TTL — 10 minutes (Date.now is fine in the server runtime). */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory LRU map of Idempotency-Key → cached response.
 * Evicts oldest on size overflow; entries older than TTL are treated as miss.
 *
 * Keyed by the caller (typically `${method} ${route}\0${key}`).
 * Map-compatible has/get/set so AppCtx.idempotency can host this instance.
 */
export class IdempotencyStore {
  private readonly map = new Map<string, StoredValue>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  /** Injectable clock for tests. */
  private readonly now: () => number;

  constructor(
    opts: {
      maxSize?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.maxSize = opts.maxSize ?? IDEMPOTENCY_MAX_SIZE;
    this.ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** True if a non-expired completed response exists for key. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Lookup a cached completed response. Expired entries are deleted and treated
   * as miss. Touches the entry for LRU ordering. In-flight reservations are NOT
   * returned here (they are inspected via {@link getReference}).
   */
  get(key: string): IdempotencyEntry | undefined {
    const e = this.map.get(key);
    if (!e || "pending" in e) return undefined;
    if (this.now() - e.storedAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch: re-insert at end.
    this.map.delete(key);
    this.map.set(key, e);
    const out: IdempotencyEntry = {
      status: e.status,
      body: e.body,
    };
    if (e.headers) out.headers = e.headers;
    return out;
  }

  /**
   * Synchronously claim a key as in-flight BEFORE executing the handler. This
   * is the TOCTOU fix: because reserve() runs to completion in one event-loop
   * turn and JS is single-threaded, no concurrent request can slip past a
   * pending reservation and also reach the handler. Returns true when this
   * caller won the claim (must later `set` the response), false when the key is
   * already claimed/completed (caller should replay or 409).
   */
  reserve(key: string): boolean {
    const e = this.map.get(key);
    if (e && this.now() - e.storedAt <= this.ttlMs) return false;
    this.map.delete(key);
    const pending: IdempotencyPending = { pending: true, storedAt: this.now() };
    this.map.set(key, pending);
    return true;
  }

  /** Release a pending reservation without storing a response (on failure). */
  release(key: string): void {
    const e = this.map.get(key);
    if (e && "pending" in e) this.map.delete(key);
  }

  /** Inspect the raw stored value (pending or complete) without LRU touch. */
  getReference(key: string): StoredValue | undefined {
    return this.map.get(key);
  }

  /** Store (or replace) a response; evict oldest when over capacity. */
  set(key: string, value: IdempotencyEntry): this {
    if (this.map.has(key)) this.map.delete(key);
    const stored: StoredEntry = {
      status: value.status,
      body: value.body,
      storedAt: this.now(),
    };
    if (value.headers) stored.headers = value.headers;
    this.map.set(key, stored);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return this;
  }
}

/** Process-wide default store (also used when AppCtx is not yet available). */
export const dedupStore = new IdempotencyStore();

/**
 * Build a stable store key for (route, method, Idempotency-Key).
 */
export function idempotencyStoreKey(
  method: string,
  routeOrPath: string,
  key: string,
): string {
  return `${method.toUpperCase()} ${routeOrPath}\0${key}`;
}

/**
 * Wrap a route handler so that an `Idempotency-Key` header replays a prior
 * response (same status/headers/body) without re-executing the handler.
 *
 * Concurrency model (closes the check-then-act TOCTOU):
 * 1. Raw key present → compute a method+path scoped store key.
 * 2. If a completed response is cached (non-expired) → replay it.
 * 3. Otherwise synchronously try to RESERVE the key as in-flight.
 *    - Reservation won (first caller): run the handler; capture its
 *      response via an `res.end` shim and store it on success. On throw,
 *      release the reservation so a retry can execute fresh.
 *    - Reservation lost (a concurrent caller already holds it): reply 409
 *      Conflict — the client should retry the SAME key, which will then hit
 *      the completed response (step 2) once the first caller finishes.
 *
 * Keys are optional: no header → normal execution every time.
 * The store is looked up from `ctx.app.idempotency` when present (AppCtx),
 * else falls back to the module {@link dedupStore}.
 *
 * Capture strategy: intercept `res.end` after the handler runs so any
 * `sendJson` / raw write is cached. Only successful captures (ended with a
 * body) are stored.
 */
export function withIdempotency(handler: RouteHandler): RouteHandler {
  return async (req, res, ctx) => {
    const rawKey = header(req, "idempotency-key");
    if (!rawKey) {
      await handler(req, res, ctx);
      return;
    }

    const store = resolveStore(ctx);
    const storeKey = idempotencyStoreKey(ctx.method, ctx.path, rawKey);

    // (2) Replay a completed cached response.
    const cached = store.get(storeKey);
    if (cached) {
      sendJson(res, cached.status, cached.body, cached.headers);
      return;
    }

    // (3) Reserve synchronously; if the key is already in-flight, 409.
    // IdempotencyStore.reserve is sync + single-threaded → no race window.
    const storeLike = store as IdempotencyStore;
    const canReserve = typeof storeLike.reserve === "function";
    if (canReserve && !storeLike.reserve(storeKey)) {
      const ref = storeLike.getReference(storeKey);
      // If a completed response landed between our get() and reserve(), replay
      // it instead of erroring (treat as a hit).
      if (ref && !("pending" in ref)) {
        const entry: IdempotencyEntry = { status: ref.status, body: ref.body };
        if (ref.headers) entry.headers = ref.headers;
        sendJson(res, entry.status, entry.body, entry.headers);
        return;
      }
      sendJson(
        res,
        409,
        {
          error: "idempotency_conflict",
          detail:
            "a request with this Idempotency-Key is already in flight; retry the same key",
        },
        { "Content-Type": "application/problem+json" },
      );
      return;
    }

    // Capture the response body written via res.end (sendJson uses end).
    // Use a box so assignments inside the end-shim are visible to TS control flow.
    const box: { buf: Buffer | null } = { buf: null };
    const origEnd = res.end.bind(res);
    // Overload-compatible end shim.
    (res as ServerResponse).end = ((
      chunk?: unknown,
      encodingOrCb?: unknown,
      cb?: unknown,
    ) => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
        if (Buffer.isBuffer(chunk)) {
          box.buf = chunk;
        } else if (typeof chunk === "string") {
          const enc =
            typeof encodingOrCb === "string" ? encodingOrCb : "utf8";
          box.buf = Buffer.from(chunk, enc as BufferEncoding);
        }
      }
      // Restore before calling through so nested ends see the real method.
      res.end = origEnd;
      if (typeof encodingOrCb === "function") {
        return origEnd(chunk as never, encodingOrCb as never);
      }
      if (typeof cb === "function") {
        return origEnd(chunk as never, encodingOrCb as never, cb as never);
      }
      return origEnd(chunk as never, encodingOrCb as never);
    }) as typeof res.end;

    try {
      await handler(req, res, ctx);
    } catch (err) {
      // Release the reservation so the client can retry the same key fresh.
      if (canReserve) storeLike.release(storeKey);
      throw err;
    } finally {
      res.end = origEnd;
    }

    // Only cache if the handler produced a finished JSON-ish response.
    if (box.buf && res.statusCode >= 200 && res.statusCode < 500) {
      let body: unknown = box.buf.toString("utf8");
      try {
        body = JSON.parse(body as string);
      } catch {
        // keep raw string
      }
      const headers: Record<string, string> = {};
      const loc = res.getHeader("Location");
      if (typeof loc === "string") headers.Location = loc;
      store.set(storeKey, {
        status: res.statusCode,
        body,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  };
}

function resolveStore(ctx: RequestContext): IdempotencyStore | IdempotencyMapLike {
  const app = ctx.app as { idempotency?: IdempotencyMapLike } | undefined;
  if (app?.idempotency) return app.idempotency;
  return dedupStore;
}

/**
 * Body-aware idempotency for idempotent *start/run* endpoints (e.g. queue
 * generation start).
 *
 * The request body digest is folded into the store key, so a retry with the SAME
 * Idempotency-Key but a DIFFERENT body is not silently replayed as the original:
 * it resolves to a distinct key that is not yet present, and the handler runs
 * again the way it would for any fresh key. Callers who want strict dedup of
 * "the same logical start" must send the same body (and the same key). This keeps
 * TOCTOU safety identical to {@link withIdempotency} (reserve runs synchronously
 * before the handler) while making a digest mismatch not collide with a prior
 * successful start.
 *
 * `digest` is the caller-owned body SHA-256 hex. Returns a wrapped handler that
 * replays a cached completed response for (method,path,key,digest) or runs the
 * handler and caches its JSON response.
 */
export function withBodyIdempotency(
  digest: string,
  handler: RouteHandler,
): RouteHandler {
  return async (req, res, ctx) => {
    const rawKey = header(req, "idempotency-key");
    if (!rawKey) {
      await handler(req, res, ctx);
      return;
    }

    const store = resolveStore(ctx);
    // Fold the body digest into the store key so a same-key/different-body retry
    // is treated as a fresh logical request, never a stale replay.
    const storeKey = idempotencyStoreKey(ctx.method, ctx.path, `${rawKey}\0${digest}`);

    // Replay a completed response.
    const cached = store.get(storeKey);
    if (cached) {
      sendJson(res, cached.status, cached.body, cached.headers);
      return;
    }

    const storeLike = store as IdempotencyStore;
    const canReserve = typeof storeLike.reserve === "function";
    if (canReserve && !storeLike.reserve(storeKey)) {
      const ref = storeLike.getReference(storeKey);
      if (ref && !("pending" in ref)) {
        const entry: IdempotencyEntry = { status: ref.status, body: ref.body };
        if (ref.headers) entry.headers = ref.headers;
        sendJson(res, entry.status, entry.body, entry.headers);
        return;
      }
      sendJson(
        res,
        409,
        {
          error: "idempotency_conflict",
          detail: "a queue start with this Idempotency-Key + body is already in flight; retry the same key + body",
        },
        { "Content-Type": "application/problem+json" },
      );
      return;
    }

    const box: { buf: Buffer | null } = { buf: null };
    const origEnd = res.end.bind(res);
    (res as ServerResponse).end = ((
      chunk?: unknown,
      encodingOrCb?: unknown,
      cb?: unknown,
    ) => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
        if (Buffer.isBuffer(chunk)) {
          box.buf = chunk;
        } else if (typeof chunk === "string") {
          const enc = typeof encodingOrCb === "string" ? encodingOrCb : "utf8";
          box.buf = Buffer.from(chunk, enc as BufferEncoding);
        }
      }
      res.end = origEnd;
      if (typeof encodingOrCb === "function") return origEnd(chunk as never, encodingOrCb as never);
      if (typeof cb === "function") return origEnd(chunk as never, encodingOrCb as never, cb as never);
      return origEnd(chunk as never, encodingOrCb as never);
    }) as typeof res.end;

    try {
      await handler(req, res, ctx);
    } catch (err) {
      if (canReserve) storeLike.release(storeKey);
      throw err;
    } finally {
      res.end = origEnd;
    }

    if (box.buf && res.statusCode >= 200 && res.statusCode < 500) {
      let body: unknown = box.buf.toString("utf8");
      try {
        body = JSON.parse(body as string);
      } catch {
        // keep raw string
      }
      const headers: Record<string, string> = {};
      const loc = res.getHeader("Location");
      if (typeof loc === "string") headers.Location = loc;
      store.set(storeKey, {
        status: res.statusCode,
        body,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    }
  };
}

/** Minimal Map-like surface AppCtx.idempotency satisfies. */
export type IdempotencyMapLike = {
  has(key: string): boolean;
  get(key: string): IdempotencyEntry | undefined;
  set(key: string, value: IdempotencyEntry): unknown;
};

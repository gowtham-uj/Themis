/**
 * Outbound webhook dispatcher (P8c).
 *
 * Delivers project events to subscribed URLs with HMAC-SHA256 signatures
 * (GitHub X-Hub-Signature-256 convention: "sha256=<hex>"), exponential-backoff
 * retries, and a durable delivery log via QueryStore.
 *
 * Spec: plan/api.md §Streaming "webhooks outbound option".
 *
 * Tests inject a FakeDeliverySink so no real network is used. Production uses
 * RealDeliverySink (global fetch).
 */

import { createHmac } from "node:crypto";
import type {
  DbQueries,
  OutboundEventType,
} from "../../db/queries.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable HTTP sink so tests capture instead of real fetch. */
export interface DeliverySink {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }>;
}

/** Default sink backed by Node 22 global fetch. */
export class RealDeliverySink implements DeliverySink {
  async post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, body: text };
  }
}

/**
 * Capturing sink for tests. Controllable per-URL / default response, and can
 * throw to simulate network failure.
 */
export class FakeDeliverySink implements DeliverySink {
  /** Captured POST attempts in call order. */
  readonly attempts: Array<{
    url: string;
    body: string;
    headers: Record<string, string>;
  }> = [];

  /** Default status returned for every post (overridable). */
  defaultStatus = 200;
  defaultBody = "ok";
  /** When true, post() throws (network error). */
  throwOnPost = false;
  throwMessage = "network error";
  /** Per-URL status override. */
  statusByUrl = new Map<string, number>();
  /** Call-count-based status sequence (shifts each post). */
  statusSequence: number[] = [];

  async post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    this.attempts.push({ url, body, headers });
    if (this.throwOnPost) {
      throw new Error(this.throwMessage);
    }
    let status = this.defaultStatus;
    if (this.statusSequence.length > 0) {
      status = this.statusSequence.shift()!;
    } else if (this.statusByUrl.has(url)) {
      status = this.statusByUrl.get(url)!;
    }
    return { status, body: this.defaultBody };
  }

  reset(): void {
    this.attempts.length = 0;
    this.defaultStatus = 200;
    this.defaultBody = "ok";
    this.throwOnPost = false;
    this.throwMessage = "network error";
    this.statusByUrl.clear();
    this.statusSequence = [];
  }
}

/** Event object passed to dispatch. Timestamp is caller-supplied. */
export interface OutboundEvent {
  type: OutboundEventType | string;
  projectId: string;
  resourceId: string;
  data: Record<string, unknown>;
  /** ISO timestamp; passed in so dispatcher does not call Date.now(). */
  timestamp: string;
}

export interface DispatchOpts {
  /**
   * Backoff delays (ms) BETWEEN attempts. Length+1 = max attempts.
   * Default [1000, 2000, 4000] → 4 attempts. Tests pass [0,0,0] for speed.
   */
  backoffMs?: number[];
  /** Max attempts (overrides backoff length+1 when set). Default 4. */
  maxAttempts?: number;
}

export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
export const DEFAULT_MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Crypto + payload helpers
// ---------------------------------------------------------------------------

/**
 * Sign a payload body with HMAC-SHA256.
 * Returns "sha256=<hex>" matching the GitHub X-Hub-Signature-256 convention
 * so receivers can verify with the same constant-time compare used for inbound.
 *
 * Sender-side signing need not be constant-time (no secret-compare here).
 */
export function signPayload(secret: string, body: string): string {
  const hex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hex}`;
}

/**
 * Build the JSON body for an outbound webhook delivery.
 * Shape: {type, project, resource, data, timestamp}.
 */
export function buildEventPayload(event: OutboundEvent): string {
  return JSON.stringify({
    type: event.type,
    project: event.projectId,
    resource: event.resourceId,
    data: event.data,
    timestamp: event.timestamp,
  });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Allow the process to exit while waiting (tests).
    t.unref?.();
  });
}

function subscriptionMatches(
  eventTypes: string[],
  eventType: string,
): boolean {
  // Empty filter = match-all.
  if (eventTypes.length === 0) return true;
  return eventTypes.includes(eventType);
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

/**
 * Fan-out `event` to every enabled subscription matching its type.
 * Per-subscription isolation: one failure does not abort others.
 * Records one webhook_delivery row per subscription (final outcome).
 */
export async function dispatch(
  queries: DbQueries,
  sink: DeliverySink,
  event: OutboundEvent,
  opts: DispatchOpts = {},
): Promise<void> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxAttempts =
    opts.maxAttempts ??
    Math.max(1, backoff.length + 1, DEFAULT_MAX_ATTEMPTS);

  const subs = queries.listOutboundSubscriptions(event.projectId);
  // Re-fetch with secret only for matching enabled subs at deliver time.
  const candidates = subs.filter(
    (s) => s.enabled && subscriptionMatches(s.eventTypes, event.type),
  );

  const payload = buildEventPayload(event);

  for (const sub of candidates) {
    // Isolate per subscription — never let one abort the fan-out.
    try {
      await deliverToSubscription(queries, sink, sub.id, event, payload, {
        backoff,
        maxAttempts,
      });
    } catch {
      // deliverToSubscription already records failures; swallow to keep going.
    }
  }
}

async function deliverToSubscription(
  queries: DbQueries,
  sink: DeliverySink,
  subscriptionId: string,
  event: OutboundEvent,
  payload: string,
  cfg: { backoff: number[]; maxAttempts: number },
): Promise<void> {
  // Secret-bearing path — NEVER log.
  const secret = queries.getOutboundSubscriptionWithSecret(subscriptionId);
  if (secret == null) {
    queries.recordWebhookDelivery({
      subscriptionId,
      projectId: event.projectId,
      eventType: event.type,
      payload: safeParse(payload),
      status: "failed",
      attempt: 0,
      error: "subscription secret unavailable",
    });
    return;
  }

  const sub = queries.getOutboundSubscription(subscriptionId);
  const url = sub?.url ?? "";
  if (!url) {
    queries.recordWebhookDelivery({
      subscriptionId,
      projectId: event.projectId,
      eventType: event.type,
      payload: safeParse(payload),
      status: "failed",
      attempt: 0,
      error: "subscription url missing",
    });
    return;
  }

  const signature = signPayload(secret, payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agenteval-Event": event.type,
    "X-Agenteval-Signature-256": signature,
  };

  let lastStatus: number | null = null;
  let lastBody: string | null = null;
  let lastError: string | null = null;
  /** Attempts actually performed (do not use for-loop post-increment value). */
  let attemptsMade = 0;
  let succeeded = false;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      const res = await sink.post(url, payload, headers);
      lastStatus = res.status;
      lastBody = res.body;
      lastError = null;
      if (res.status >= 200 && res.status < 300) {
        succeeded = true;
        break;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = null;
      lastBody = null;
    }

    // Backoff before next attempt (if any).
    if (attempt < cfg.maxAttempts) {
      const delay = cfg.backoff[attempt - 1] ?? cfg.backoff[cfg.backoff.length - 1] ?? 0;
      await sleep(delay);
    }
  }

  const deliveredAt = succeeded ? event.timestamp : null;
  queries.recordWebhookDelivery({
    subscriptionId,
    projectId: event.projectId,
    eventType: event.type,
    payload: safeParse(payload),
    status: succeeded ? "success" : "failed",
    attempt: attemptsMade,
    responseStatus: lastStatus,
    responseBody: lastBody,
    error: succeeded ? null : lastError,
    deliveredAt,
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher class (bound to queries + sink + default opts)
// ---------------------------------------------------------------------------

export interface OutboundWebhookDispatcherOptions {
  queries: DbQueries;
  sink?: DeliverySink;
  backoffMs?: number[];
  maxAttempts?: number;
}

/**
 * Bound dispatcher held on AppCtx. Hooks call `dispatchEvent` once per emit.
 * No-ops are handled by callers when the dispatcher is undefined.
 */
export class OutboundWebhookDispatcher {
  private queries: DbQueries;
  private sink: DeliverySink;
  private backoffMs: number[];
  private maxAttempts: number;

  constructor(opts: OutboundWebhookDispatcherOptions) {
    this.queries = opts.queries;
    this.sink = opts.sink ?? new RealDeliverySink();
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Replace the sink (tests). */
  setSink(sink: DeliverySink): void {
    this.sink = sink;
  }

  /** Replace backoff schedule (tests pass [0,0,0]). */
  setBackoffMs(ms: number[]): void {
    this.backoffMs = ms;
  }

  /** Expose the current sink (tests). */
  getSink(): DeliverySink {
    return this.sink;
  }

  /**
   * Fan-out one event to matching enabled subscriptions.
   * Errors are swallowed per-sub so hooks never crash the caller.
   */
  async dispatchEvent(event: OutboundEvent): Promise<void> {
    try {
      await dispatch(this.queries, this.sink, event, {
        backoffMs: this.backoffMs,
        maxAttempts: this.maxAttempts,
      });
    } catch {
      // Top-level safety: never let webhook delivery break the emit site.
    }
  }
}

/**
 * Fire-and-forget helper for emit sites. No-ops when dispatcher is undefined.
 * Does not await, so hooks stay non-blocking; callers may still await if desired.
 */
export function emitOutbound(
  dispatcher: OutboundWebhookDispatcher | undefined | null,
  event: OutboundEvent,
): void {
  if (!dispatcher) return;
  void dispatcher.dispatchEvent(event);
}

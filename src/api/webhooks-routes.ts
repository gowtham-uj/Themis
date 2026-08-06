/**
 * Outbound webhook subscription CRUD + deliveries list + synthetic test fire (P8c).
 *
 * Routes:
 *   GET    /api/projects/:id/webhooks
 *   POST   /api/projects/:id/webhooks
 *   PATCH  /api/projects/:id/webhooks/:subId
 *   DELETE /api/projects/:id/webhooks/:subId
 *   GET    /api/projects/:id/webhooks/:subId/deliveries
 *   POST   /api/projects/:id/webhooks/:subId/test
 *
 * Secrets: surfaced once on create (X-Agenteval-Secret-Once); never in get/list/update.
 */

import type {
  CreateOutboundSubscriptionInput,
  DbQueries,
  OutboundSubscription,
  Project,
  UpdateOutboundSubscriptionPatch,
  WebhookDelivery,
} from "../db/queries.js";
import { badRequest, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";
import {
  buildEventPayload,
  signPayload,
  type OutboundWebhookDispatcher,
} from "./webhooks/outbound.js";

// ---------------------------------------------------------------------------
// Minimal AppCtx surface (structural; avoids circular import with server.ts)
// ---------------------------------------------------------------------------

export interface WebhooksAppCtx {
  queries: DbQueries;
  dataDir: string;
  outboundWebhooks?: OutboundWebhookDispatcher;
}

function appOf(ctx: RequestContext): WebhooksAppCtx {
  return ctx.app as WebhooksAppCtx;
}

function requireProject(queries: DbQueries, id: string): Project {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

function requireSubscription(
  queries: DbQueries,
  projectId: string,
  subId: string,
): OutboundSubscription {
  const sub = queries.getOutboundSubscription(subId);
  if (!sub || sub.projectId !== projectId) {
    throw notFound(`webhook subscription not found: ${subId}`);
  }
  return sub;
}

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const ALLOWED_EVENT_TYPES = new Set([
  "run.completed",
  "verdict.completed",
  "release.compared",
]);

function normalizeEventTypes(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw badRequest("eventTypes must be an array of strings");
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      throw badRequest("eventTypes entries must be non-empty strings");
    }
    const t = item.trim();
    if (!ALLOWED_EVENT_TYPES.has(t)) {
      throw badRequest(
        `eventTypes entry '${t}' is not supported (run.completed|verdict.completed|release.compared)`,
      );
    }
    out.push(t);
  }
  return out;
}

function subscriptionJson(s: OutboundSubscription) {
  return {
    id: s.id,
    project_id: s.projectId,
    projectId: s.projectId,
    url: s.url,
    // Secret: only present (string) on create response; otherwise null/omitted.
    secret: s.secret,
    event_types: s.eventTypes,
    eventTypes: s.eventTypes,
    enabled: s.enabled,
    created_at: s.createdAt,
    createdAt: s.createdAt,
    updated_at: s.updatedAt,
    updatedAt: s.updatedAt,
  };
}

function deliveryJson(d: WebhookDelivery) {
  return {
    id: d.id,
    subscription_id: d.subscriptionId,
    subscriptionId: d.subscriptionId,
    project_id: d.projectId,
    projectId: d.projectId,
    event_type: d.eventType,
    eventType: d.eventType,
    payload: d.payload,
    status: d.status,
    attempt: d.attempt,
    response_status: d.responseStatus,
    responseStatus: d.responseStatus,
    response_body: d.responseBody,
    responseBody: d.responseBody,
    error: d.error,
    delivered_at: d.deliveredAt,
    deliveredAt: d.deliveredAt,
    created_at: d.createdAt,
    createdAt: d.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register outbound webhook subscription + delivery routes on an existing Router.
 * Called from createServer next to registerWatcherRoutes / registerQueueRoutes.
 */
export function registerWebhooksRoutes(router: Router): void {
  // GET /api/projects/:id/webhooks — list (secrets stripped)
  router.get("/api/projects/:id/webhooks", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const subs = app.queries.listOutboundSubscriptions(projectId);
    // Defensive: ensure secrets are null even if a backend regresses.
    const stripped = subs.map((s) => ({ ...s, secret: null }));
    sendJson(res, 200, {
      webhooks: stripped.map(subscriptionJson),
      subscriptions: stripped.map(subscriptionJson),
    });
  });

  // POST /api/projects/:id/webhooks — create (secret surfaced once)
  router.post("/api/projects/:id/webhooks", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const body = await readJsonBody<{
      url?: string;
      secret?: string;
      eventTypes?: unknown;
      event_types?: unknown;
      enabled?: boolean;
    }>(req);

    if (!isHttpUrl(body.url)) {
      throw badRequest("url must be a valid http(s) URL");
    }

    const eventTypes = normalizeEventTypes(
      body.eventTypes ?? body.event_types,
    );

    const input: CreateOutboundSubscriptionInput = {
      url: body.url.trim(),
    };
    if (body.secret !== undefined && body.secret !== "") {
      input.secret = body.secret;
    }
    if (eventTypes !== undefined) input.eventTypes = eventTypes;
    if (body.enabled !== undefined) input.enabled = body.enabled;

    const sub = app.queries.createOutboundSubscription(projectId, input);
    // Surface secret exactly once; document via response header.
    sendJson(
      res,
      201,
      {
        webhook: subscriptionJson(sub),
        subscription: subscriptionJson(sub),
      },
      { "X-Agenteval-Secret-Once": "true" },
    );
  });

  // PATCH /api/projects/:id/webhooks/:subId — update (secret never in patch/response)
  router.patch(
    "/api/projects/:id/webhooks/:subId",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const subId = ctx.params.subId!;
      requireProject(app.queries, projectId);
      requireSubscription(app.queries, projectId, subId);

      const body = await readJsonBody<{
        url?: string;
        eventTypes?: unknown;
        event_types?: unknown;
        enabled?: boolean;
        secret?: unknown;
      }>(req);

      // Explicitly reject secret rotation via PATCH.
      if ("secret" in body && body.secret !== undefined) {
        throw badRequest("secret cannot be updated via PATCH");
      }

      const patch: UpdateOutboundSubscriptionPatch = {};
      if (body.url !== undefined) {
        if (!isHttpUrl(body.url)) {
          throw badRequest("url must be a valid http(s) URL");
        }
        patch.url = body.url.trim();
      }
      const eventTypes = normalizeEventTypes(
        body.eventTypes ?? body.event_types,
      );
      if (eventTypes !== undefined) patch.eventTypes = eventTypes;
      if (body.enabled !== undefined) patch.enabled = body.enabled;

      const updated = app.queries.updateOutboundSubscription(subId, patch);
      // Defensive strip.
      sendJson(res, 200, {
        webhook: subscriptionJson({ ...updated, secret: null }),
        subscription: subscriptionJson({ ...updated, secret: null }),
      });
    },
  );

  // DELETE /api/projects/:id/webhooks/:subId — 204
  router.delete("/api/projects/:id/webhooks/:subId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const subId = ctx.params.subId!;
    requireProject(app.queries, projectId);
    requireSubscription(app.queries, projectId, subId);
    app.queries.deleteOutboundSubscription(subId);
    res.statusCode = 204;
    res.end();
  });

  // GET /api/projects/:id/webhooks/:subId/deliveries — newest first
  router.get(
    "/api/projects/:id/webhooks/:subId/deliveries",
    (_req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const subId = ctx.params.subId!;
      requireProject(app.queries, projectId);
      requireSubscription(app.queries, projectId, subId);

      const limitRaw = ctx.query.limit ? Number(ctx.query.limit) : undefined;
      const deliveries = app.queries.listWebhookDeliveries(projectId, {
        subscriptionId: subId,
        ...(ctx.query.status ? { status: ctx.query.status } : {}),
        ...(ctx.query.eventType || ctx.query.event_type
          ? { eventType: ctx.query.eventType ?? ctx.query.event_type }
          : {}),
        ...(limitRaw !== undefined && Number.isFinite(limitRaw)
          ? { limit: limitRaw }
          : {}),
      });
      sendJson(res, 200, {
        deliveries: deliveries.map(deliveryJson),
      });
    },
  );

  // POST /api/projects/:id/webhooks/:subId/test — synthetic fire (202)
  router.post(
    "/api/projects/:id/webhooks/:subId/test",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const subId = ctx.params.subId!;
      requireProject(app.queries, projectId);
      const sub = requireSubscription(app.queries, projectId, subId);

      const timestamp = new Date().toISOString();
      // Synthetic verdict.completed-shaped test payload (no real run required).
      const event = {
        type: "verdict.completed" as const,
        projectId,
        resourceId: `test-${subId}`,
        data: {
          test: true,
          runId: null,
          overallScore: null,
          verdictVersion: "test",
        },
        timestamp,
      };

      // Deliver only to THIS subscription (not full fan-out).
      // Use the dispatcher sink when available; otherwise record a pending row
      // so the API stays useful even if outbound is off.
      if (app.outboundWebhooks) {
        // Temporarily filter by delivering a one-sub synthetic via the sink.
        const sink = app.outboundWebhooks.getSink();
        const secret = app.queries.getOutboundSubscriptionWithSecret(subId);
        if (!secret) {
          throw badRequest("subscription secret unavailable");
        }
        const payload = buildEventPayload(event);
        const signature = signPayload(secret, payload);
        let status = "failed";
        let attempt = 1;
        let responseStatus: number | null = null;
        let responseBody: string | null = null;
        let error: string | null = null;
        try {
          const resPost = await sink.post(sub.url, payload, {
            "Content-Type": "application/json",
            "X-Agenteval-Event": event.type,
            "X-Agenteval-Signature-256": signature,
          });
          responseStatus = resPost.status;
          responseBody = resPost.body;
          if (resPost.status >= 200 && resPost.status < 300) {
            status = "success";
          } else {
            error = `HTTP ${resPost.status}`;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const delivery = app.queries.recordWebhookDelivery({
          subscriptionId: subId,
          projectId,
          eventType: event.type,
          payload: JSON.parse(payload),
          status,
          attempt,
          responseStatus,
          responseBody,
          error,
          deliveredAt: status === "success" ? timestamp : null,
        });
        sendJson(res, 202, {
          deliveryId: delivery.id,
          delivery_id: delivery.id,
          status: delivery.status,
        });
        return;
      }

      // No dispatcher configured — still record a synthetic pending delivery.
      const delivery = app.queries.recordWebhookDelivery({
        subscriptionId: subId,
        projectId,
        eventType: event.type,
        payload: {
          type: event.type,
          project: projectId,
          resource: event.resourceId,
          data: event.data,
          timestamp,
        },
        status: "pending",
        attempt: 0,
        error: "outbound dispatcher not configured",
      });
      sendJson(res, 202, {
        deliveryId: delivery.id,
        delivery_id: delivery.id,
        status: delivery.status,
      });
    },
  );
}


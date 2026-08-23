/**
 * Per-project agent-commit queue watcher routes.
 *
 * A watcher belongs to a project and exactly one eval queue. Its repo must equal
 * that queue's source adapter's source repo. A signed inbound webhook verifies
 * HMAC + repository identity, resolves the full SHA, deduplicates watcher+SHA,
 * and records a durable pending FIFO event. If the queue has no active generation
 * it launches with that commit as an immutable generation override; otherwise the
 * commit stays pending and is auto-launched FIFO when the generation closes.
 *
 * Routes:
 *   GET    /api/projects/:id/watchers
 *   POST   /api/projects/:id/watchers
 *   GET    /api/projects/:id/watchers/:ruleId/events   (event list)
 *   PATCH  /api/projects/:id/watchers/:ruleId
 *   DELETE /api/projects/:id/watchers/:ruleId
 *   POST   /api/projects/:id/watchers/:ruleId/run               (manual fire)
 *   POST   /api/projects/:id/watcher/hooks/:ruleId               (signed hook, bearer-exempt)
 *
 * Auth is a wrapping concern (p8b-auth / server gate). Only the exact signed-hook
 * route is bearer-exempt when auth is enabled; CRUD/manual/event-list remain
 * bearer-protected and project-scoped.
 *
 * Spec: plan/api.md §/watchers, plan/watcher.md §Ingress.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  DbQueries,
  WatcherRule,
} from "../db/queries.js";
import {
  handleWatcherCommit,
  repoMatches,
  type WatcherSeams,
} from "../watcher/engine.js";
import { requireAdminRequest } from "./auth.js";
import { badRequest, HttpError, notFound } from "./errors.js";
import {
  readBody,
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal AppCtx surface for watcher routes. */
export interface WatcherAppCtx {
  queries: DbQueries;
  dataDir: string;
  authEnabled: boolean;
  /** Seams: SHA resolution + queue-generation launch. Wired in createServer. */
  watcherSeams?: WatcherSeams;
  /**
   * Production resolver seam. Injected from AppCtx.watcherSeams when present;
   * tests may inject directly. Kept for backward API.
   */
  refResolver?: WatcherSeams["resolveSha"];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appOf(ctx: RequestContext): WatcherAppCtx {
  return ctx.app as WatcherAppCtx;
}

function requireProject(queries: DbQueries, id: string) {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

/**
 * Load a watcher rule for a project. 404 when missing or wrong project.
 * Secrets are already stripped by getWatcherRule.
 */
function requireWatcherRule(
  queries: DbQueries,
  projectId: string,
  ruleId: string,
): WatcherRule {
  const rule = queries.getWatcherRule(ruleId);
  if (!rule || rule.projectId !== projectId) {
    throw notFound(`watcher rule not found: ${ruleId}`);
  }
  return rule;
}

/** Resolve the AppCtx seams, falling back to a throwing stub. */
function resolveSeams(app: WatcherAppCtx): WatcherSeams {
  const s = app.watcherSeams;
  if (s) return s;
  const resolver =
    app.refResolver ??
    (async () => {
      throw new Error("ref resolution not configured");
    });
  const seams: WatcherSeams = {
    async resolveSha(repo, ref) {
      const r = await resolver(repo, ref);
      return { sha: r.sha };
    },
    hasActiveGeneration(queueId) {
      return app.queries.getActiveQueueContainer(queueId) != null;
    },
    async launch(queueId, commit) {
      throw new Error("watcher generation launch not configured");
    },
  };
  return seams;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Constant-time HMAC-SHA256 verify of a GitHub-style signature header
 * (`sha256=<hex>`). Uses Node crypto.timingSafeEqual; never short-circuits
 * on first-byte mismatch. Does not log the secret.
 */
export function verifyHubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Normalize a git ref (`refs/tags/v2.3.0`, `refs/heads/main`) to a short
 * name (`v2.3.0`, `main`). Bare refs pass through.
 */
export function normalizeGitRef(ref: string | null | undefined): string | undefined {
  if (ref == null || ref === "") return undefined;
  let s = ref.trim();
  if (s.startsWith("refs/tags/")) s = s.slice("refs/tags/".length);
  else if (s.startsWith("refs/heads/")) s = s.slice("refs/heads/".length);
  else if (s.startsWith("refs/remotes/")) {
    s = s.slice("refs/remotes/".length);
    const slash = s.indexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
  }
  return s || undefined;
}

/**
 * Extract the short ref from a GitHub payload / headers.
 * Prefers the X-GitHub-Ref header, then payload.ref, then PR head ref.
 */
export function extractGitHubRef(
  headers: { githubRef?: string },
  payload: Record<string, unknown>,
): string | undefined {
  if (headers.githubRef) return normalizeGitRef(headers.githubRef);
  if (typeof payload.ref === "string") return normalizeGitRef(payload.ref);
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (pr) {
    const head = pr.head as Record<string, unknown> | undefined;
    if (head && typeof head.ref === "string") return normalizeGitRef(head.ref);
    if (head && typeof head.sha === "string") return head.sha;
  }
  if (typeof payload.ref === "string") return normalizeGitRef(payload.ref);
  return undefined;
}

/** Extract owner/name repo id from a GitHub push payload. */
export function extractGitHubRepo(
  payload: Record<string, unknown>,
): string | undefined {
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (repo && typeof repo.full_name === "string") return repo.full_name;
  if (repo && typeof repo.name === "string" && typeof repo.owner === "object") {
    const owner = repo.owner as Record<string, unknown> | undefined;
    if (owner && typeof owner.name === "string") {
      return `${owner.name}/${repo.name}`;
    }
  }
  return undefined;
}

/**
 * Parse a raw webhook body. Supports JSON and form-urlencoded
 * (`payload=<json>` GitHub style).
 */
export function parseWebhookPayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (
    trimmed.includes("payload=") &&
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[")
  ) {
    try {
      const params = new URLSearchParams(trimmed);
      const payload = params.get("payload");
      if (payload) {
        const parsed = JSON.parse(payload) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // fall through to JSON attempt
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function unauthorized(detail: string): HttpError {
  return new HttpError(401, "Unauthorized", detail, {
    type: "https://agenteval.dev/errors/unauthorized",
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register watcher rule + webhook ingress routes on an existing Router.
 */
export function registerWatcherRoutes(router: Router): void {
  // GET /api/projects/:id/watchers — list (secrets stripped)
  router.get("/api/projects/:id/watchers", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const watchers = app.queries.listWatcherRules(projectId, {
      includeDisabled: true,
    });
    const stripped = watchers.map((w) => ({ ...w, webhookSecret: null }));
    sendJson(res, 200, { watchers: stripped });
  });

  // GET /api/projects/:id/watchers/:ruleId/events — durable event list
  router.get("/api/projects/:id/watchers/:ruleId/events", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    requireWatcherRule(app.queries, projectId, ctx.params.ruleId!);
    const events = app.queries.listWatcherEvents(projectId, {
      ruleId: ctx.params.ruleId,
      limit: undefined,
    });
    sendJson(res, 200, { events });
  });

  // POST /api/projects/:id/watchers — create (secret surfaced once)
  router.post("/api/projects/:id/watchers", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    // A watcher clones + builds a caller-named repository and launches
    // generations from it; creation is an admin operation.
    requireAdminRequest(req, app.queries, app.authEnabled);

    const body = await readJsonBody<{
      repo?: string;
      trigger?: string;
      ref?: string | null;
      semverFilter?: string | null;
      queueId?: string;
      queue_id?: string;
      webhookSecret?: string;
      enabled?: boolean;
    }>(req);

    if (!body.repo || !String(body.repo).trim()) {
      throw badRequest("repo is required");
    }
    if (!body.trigger || !String(body.trigger).trim()) {
      throw badRequest("trigger is required");
    }
    const queueId = String(body.queueId ?? body.queue_id ?? "");
    if (!queueId) {
      throw badRequest("queueId is required (a watcher fires one queue)");
    }
    const queue = app.queries.getEvalQueue(queueId);
    if (!queue || queue.projectId !== projectId) {
      throw badRequest("queueId must reference a queue in this project");
    }
    // Repo must equal the queue's source adapter source repo.
    const adapter = queue.sharedAdapterId
      ? app.queries.getProjectAgentAdapter(queue.sharedAdapterId)
      : app.queries.getProjectAgentAdapterByAgentId(projectId, queue.agentId);
    if (!adapter?.sourceRepo) {
      throw badRequest(
        "the selected queue has no source-built adapter with a source_repo; a queue watcher requires one",
      );
    }
    if (!repoMatches(String(body.repo).trim(), adapter.sourceRepo)) {
      throw badRequest(
        `watcher repo '${body.repo}' must equal the queue adapter source repo '${adapter.sourceRepo}'`,
      );
    }

    const input: {
      repo: string;
      trigger: string;
      queueId: string;
      ref?: string | null;
      semverFilter?: string | null;
      webhookSecret?: string;
      enabled?: boolean;
    } = {
      repo: String(body.repo).trim(),
      trigger: String(body.trigger).trim(),
      queueId,
    };
    if (body.ref !== undefined) input.ref = body.ref;
    if (body.semverFilter !== undefined) input.semverFilter = body.semverFilter;
    if (body.webhookSecret !== undefined) input.webhookSecret = body.webhookSecret;
    if (body.enabled !== undefined) input.enabled = body.enabled;

    const rule = app.queries.createWatcherRule(projectId, input);
    sendJson(
      res,
      201,
      { watcher: rule },
      { "X-Agenteval-Secret-Once": "true" },
    );
  });

  // PATCH /api/projects/:id/watchers/:ruleId — update (secret never in patch/response)
  router.patch("/api/projects/:id/watchers/:ruleId", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const ruleId = ctx.params.ruleId!;
    requireProject(app.queries, projectId);
    requireWatcherRule(app.queries, projectId, ruleId);

    const body = await readJsonBody<{
      ref?: string | null;
      semverFilter?: string | null;
      enabled?: boolean;
      repo?: string;
      queueId?: string;
      queue_id?: string;
      webhookSecret?: unknown;
    }>(req);

    if ("webhookSecret" in body && body.webhookSecret !== undefined) {
      throw badRequest("webhookSecret cannot be updated via PATCH");
    }

    const patch: {
      ref?: string | null;
      semverFilter?: string | null;
      enabled?: boolean;
      repo?: string;
      queueId?: string | null;
    } = {};
    if (body.ref !== undefined) patch.ref = body.ref;
    if (body.semverFilter !== undefined) patch.semverFilter = body.semverFilter;
    if (body.enabled !== undefined) patch.enabled = body.enabled;

    const queueId = body.queueId ?? body.queue_id;
    if (queueId !== undefined) {
      if (queueId === null) {
        throw badRequest("a watcher must own exactly one queue");
      }
      const queue = app.queries.getEvalQueue(String(queueId));
      if (!queue || queue.projectId !== projectId) {
        throw badRequest("queueId must reference a queue in this project");
      }
      const adapter = queue.sharedAdapterId
        ? app.queries.getProjectAgentAdapter(queue.sharedAdapterId)
        : app.queries.getProjectAgentAdapterByAgentId(projectId, queue.agentId);
      const repo = body.repo ?? requireWatcherRule(app.queries, projectId, ruleId).repo;
      if (!adapter?.sourceRepo) {
        throw badRequest("the selected queue has no source-built adapter with a source_repo");
      }
      if (!repoMatches(repo, adapter.sourceRepo)) {
        throw badRequest(
          `watcher repo '${repo}' must equal the queue adapter source repo '${adapter.sourceRepo}'`,
        );
      }
      patch.queueId = String(queueId);
    }
    if (body.repo !== undefined) patch.repo = body.repo;

    const updated = app.queries.updateWatcherRule(ruleId, {
      ref: patch.ref,
      semverFilter: patch.semverFilter,
      enabled: patch.enabled,
      repo: patch.repo,
      queueId: patch.queueId,
    });
    sendJson(res, 200, { watcher: { ...updated, webhookSecret: null } });
  });

  // DELETE /api/projects/:id/watchers/:ruleId — 204
  router.delete("/api/projects/:id/watchers/:ruleId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const ruleId = ctx.params.ruleId!;
    requireProject(app.queries, projectId);
    requireWatcherRule(app.queries, projectId, ruleId);
    app.queries.deleteWatcherRule(ruleId);
    res.statusCode = 204;
    res.end();
  });

  // POST /api/projects/:id/watchers/:ruleId/run — manual fire (same engine path)
  router.post(
    "/api/projects/:id/watchers/:ruleId/run",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const ruleId = ctx.params.ruleId!;
      requireProject(app.queries, projectId);
      const rule = requireWatcherRule(app.queries, projectId, ruleId);

      const body = await readJsonBody<{
        ref?: string;
        queueId?: string;
      }>(req);

      if (!rule.enabled) {
        throw badRequest("watcher rule is disabled");
      }
      if (!rule.queueId) {
        throw badRequest("watcher rule has no queue");
      }

      const seams = resolveSeams(app);
      const result = await handleWatcherCommit({
        queries: app.queries,
        seams,
        rule,
        queueId: body.queueId ?? rule.queueId,
        ref: body.ref ?? undefined,
        eventRepo: rule.repo,
      });

      const events = app.queries.listWatcherEvents(projectId, {
        ruleId,
        limit: 1,
      });
      const watcherEventId = events[0]?.id ?? result.event.id;
      sendJson(res, 202, {
        status: result.status,
        watcherEventId,
        queueId: rule.queueId,
      });
    },
  );

  // POST /api/projects/:id/watcher/hooks/:ruleId — signed git-host webhook ingress.
  // BEARER-EXEMPT: GitHub signs the payload; a shared GitHub secret is the auth.
  router.post(
    "/api/projects/:id/watcher/hooks/:ruleId",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const ruleId = ctx.params.ruleId!;
      requireProject(app.queries, projectId);
      const rule = requireWatcherRule(app.queries, projectId, ruleId);

      // Raw body for HMAC — do not parse first.
      const rawBody = await readBody(req);

      const secret = app.queries.getRawWatcherSecret(ruleId);
      if (!secret) {
        throw unauthorized("watcher rule has no webhook_secret configured");
      }

      const signature = header(req, "x-hub-signature-256");
      if (!verifyHubSignature(rawBody, signature, secret)) {
        throw unauthorized("invalid or missing webhook signature");
      }

      const payload = parseWebhookPayload(rawBody);
      const ghEvent = header(req, "x-github-event");
      const ghRefHeader = header(req, "x-github-ref");
      const ref = extractGitHubRef({ githubRef: ghRefHeader }, payload);
      const eventRepo = extractGitHubRepo(payload);

      // Skip pure delete events (no enqueue).
      if (ghEvent?.toLowerCase() === "delete") {
        const ev = app.queries.recordWatcherEvent({
          ruleId,
          projectId,
          queueId: rule.queueId ?? null,
          trigger: rule.trigger,
          ref: ref ?? null,
          status: "ignored",
        });
        sendJson(res, 202, {
          matched: false,
          status: "ignored",
          watcherEventId: ev.id,
        });
        return;
      }

      if (!rule.queueId) {
        throw badRequest("watcher rule has no queue");
      }
      if (!rule.enabled) {
        const ev = app.queries.recordWatcherEvent({
          ruleId,
          projectId,
          queueId: rule.queueId,
          trigger: rule.trigger,
          ref: ref ?? null,
          status: "ignored",
        });
        sendJson(res, 202, {
          matched: false,
          status: "ignored",
          watcherEventId: ev.id,
        });
        return;
      }

      // Repository identity: the hook repo must equal the watcher's repo.
      if (!eventRepo) {
        throw badRequest("webhook payload did not include repository identity");
      }
      if (!repoMatches(rule.repo, eventRepo)) {
        const ev = app.queries.recordWatcherEvent({
          ruleId,
          projectId,
          queueId: rule.queueId,
          trigger: rule.trigger,
          ref: ref ?? null,
          status: "ignored",
          error: `webhook repo ${eventRepo} does not match watcher repo ${rule.repo}`,
        });
        sendJson(res, 200, {
          matched: false,
          status: "ignored",
          watcherEventId: ev.id,
        });
        return;
      }

      const seams = resolveSeams(app);
      let result;
      try {
        result = await handleWatcherCommit({
          queries: app.queries,
          seams,
          rule,
          queueId: rule.queueId,
          ref: ref ?? undefined,
          eventRepo,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ev = app.queries.recordWatcherEvent({
          ruleId,
          projectId,
          queueId: rule.queueId,
          trigger: rule.trigger,
          ref: ref ?? null,
          status: "failed",
          error: message,
        });
        sendJson(res, 202, {
          matched: false,
          status: "failed",
          watcherEventId: ev.id,
          error: message,
        });
        return;
      }

      sendJson(res, 202, {
        matched: result.status === "launched" || result.status === "pending",
        status: result.status,
        watcherEventId: result.event.id,
        resolvedSha: result.event.resolvedSha,
        processedSha: result.event.processedSha,
        fifoSeq: result.event.fifoSeq,
        ...(result.status === "launched" && result.event.batchId
          ? { batchId: result.event.batchId }
          : {}),
      });
    },
  );
}

/**
 * Watcher rule CRUD + manual fire + git-host webhook ingress (P8b-routes).
 *
 * GET    /api/projects/:id/watchers
 * POST   /api/projects/:id/watchers
 * PATCH  /api/projects/:id/watchers/:ruleId
 * DELETE /api/projects/:id/watchers/:ruleId
 * POST   /api/projects/:id/watchers/:ruleId/run
 * POST   /api/projects/:id/watcher/hooks/:ruleId
 *
 * Auth is a wrapping concern (p8b-auth); these handlers do not check tokens.
 * Spec: plan/api.md §/watchers, plan/watcher.md §Ingress.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  CreateWatcherRuleInput,
  DbQueries,
  UpdateWatcherRulePatch,
  WatcherAction,
  WatcherRole,
  WatcherRule,
} from "../db/queries.js";
import {
  handleWatcherEvent,
  type RefResolver,
  type WatcherInboundEvent,
} from "../watcher/engine.js";
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
  /** Injected ref resolver (tests + production git host). */
  refResolver?: RefResolver;
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

/** Resolve the AppCtx refResolver, falling back to a throwing stub. */
function resolveRefResolver(app: WatcherAppCtx): RefResolver {
  if (app.refResolver) return app.refResolver;
  return {
    async resolveRef() {
      throw new Error("ref resolution not configured");
    },
  };
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
    // refs/remotes/origin/main → origin/main then take last segment if remote-prefixed
    s = s.slice("refs/remotes/".length);
    const slash = s.indexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
  }
  return s || undefined;
}

/**
 * Map a GitHub X-GitHub-Event (and payload) to a watcher trigger.
 * push → commit; create (tag) → tag; pull_request → pr; else webhook.
 */
export function mapGitHubEventToTrigger(
  eventName: string | undefined,
  payload: Record<string, unknown>,
): string {
  const name = (eventName ?? "").toLowerCase();
  if (name === "push") return "commit";
  if (name === "create") {
    const refType = String(payload.ref_type ?? payload.refType ?? "");
    if (refType === "tag") return "tag";
    // branch create still treated as commit-ish for rules watching branches
    return "commit";
  }
  if (name === "pull_request" || name === "pull_request_target") return "pr";
  if (name === "delete") {
    // Deleting refs should not enqueue; callers treat as no-op.
    return "webhook";
  }
  return "webhook";
}

/**
 * Extract the short ref from a GitHub-style payload / headers.
 * Prefers X-GitHub-Ref header, then payload.ref, then PR head ref.
 */
export function extractGitHubRef(
  headers: { githubRef?: string },
  payload: Record<string, unknown>,
): string | undefined {
  if (headers.githubRef) return normalizeGitRef(headers.githubRef);
  if (typeof payload.ref === "string") return normalizeGitRef(payload.ref);
  // pull_request payloads
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (pr) {
    const head = pr.head as Record<string, unknown> | undefined;
    if (head && typeof head.ref === "string") return normalizeGitRef(head.ref);
    if (head && typeof head.sha === "string") return head.sha;
  }
  // create event: ref is bare tag/branch name
  if (typeof payload.ref === "string") return normalizeGitRef(payload.ref);
  return undefined;
}

/**
 * Parse a raw webhook body. Supports JSON and form-urlencoded
 * (`payload=<json>` GitHub style).
 */
export function parseWebhookPayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  // form-urlencoded with payload=
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

function isWatcherRole(v: unknown): v is WatcherRole {
  return v === "agent" || v === "workspace";
}

function isWatcherAction(v: unknown): v is WatcherAction {
  if (!v || typeof v !== "object") return false;
  const a = v as WatcherAction;
  return a.enqueue === "all" || a.enqueue === "subset";
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register watcher rule + webhook ingress routes on an existing Router.
 * Called from createServer next to registerFindingsRoutes.
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
    // Defensive: ensure secrets are null even if a backend regresses.
    const stripped = watchers.map((w) => ({ ...w, webhookSecret: null }));
    sendJson(res, 200, { watchers: stripped });
  });

  // POST /api/projects/:id/watchers — create (secret surfaced once)
  router.post("/api/projects/:id/watchers", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const body = await readJsonBody<{
      role?: string;
      repo?: string;
      trigger?: string;
      ref?: string | null;
      semverFilter?: string | null;
      action?: WatcherAction;
      webhookSecret?: string;
      enabled?: boolean;
    }>(req);

    if (!isWatcherRole(body.role)) {
      throw badRequest("role must be 'agent' or 'workspace'");
    }
    if (!body.repo || !String(body.repo).trim()) {
      throw badRequest("repo is required");
    }
    if (!body.trigger || !String(body.trigger).trim()) {
      throw badRequest("trigger is required");
    }
    if (!isWatcherAction(body.action)) {
      throw badRequest("action.enqueue must be 'all' or 'subset'");
    }

    const input: CreateWatcherRuleInput = {
      role: body.role,
      repo: String(body.repo).trim(),
      trigger: String(body.trigger).trim(),
      action: body.action,
    };
    if (body.ref !== undefined) input.ref = body.ref;
    if (body.semverFilter !== undefined) input.semverFilter = body.semverFilter;
    if (body.webhookSecret !== undefined) input.webhookSecret = body.webhookSecret;
    if (body.enabled !== undefined) input.enabled = body.enabled;

    const rule = app.queries.createWatcherRule(projectId, input);
    // Surface secret exactly once; document via response header.
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
      action?: WatcherAction;
      enabled?: boolean;
      repo?: string;
      webhookSecret?: unknown;
    }>(req);

    // Explicitly reject secret rotation via PATCH (separate flow if ever needed).
    if ("webhookSecret" in body && body.webhookSecret !== undefined) {
      throw badRequest("webhookSecret cannot be updated via PATCH");
    }

    const patch: UpdateWatcherRulePatch = {};
    if (body.ref !== undefined) patch.ref = body.ref;
    if (body.semverFilter !== undefined) patch.semverFilter = body.semverFilter;
    if (body.action !== undefined) {
      if (!isWatcherAction(body.action)) {
        throw badRequest("action.enqueue must be 'all' or 'subset'");
      }
      patch.action = body.action;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.repo !== undefined) patch.repo = body.repo;

    const updated = app.queries.updateWatcherRule(ruleId, patch);
    // Defensive strip.
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

  // POST /api/projects/:id/watchers/:ruleId/run — manual fire
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
        agentId?: string;
        model?: string;
        provider?: string;
      }>(req);

      const event: WatcherInboundEvent = {
        projectId,
        trigger: "manual",
        // Prefer body.ref, then rule.ref, then HEAD (engine also falls back).
        ref: body.ref ?? rule.ref ?? "HEAD",
        // For matchRules the rule.trigger must equal event.trigger. Manual fire
        // uses trigger="manual", so the rule itself must be a manual-trigger rule
        // OR we temporarily match by forcing trigger to the rule's trigger when
        // the rule is not "manual". Spec: manual fire always works for any rule —
        // build event with the rule's own trigger so matchRules finds it, while
        // provenance still records trigger as the rule's trigger (engine records
        // event.trigger). Prefer rule.trigger so non-manual rules still fire.
        // Actually plan says trigger="manual" for manual fire. For matchRules to
        // hit, the rule must have trigger=manual OR we override. Use the rule's
        // trigger for matching so any rule can be manually fired.
        role: rule.role,
        repo: rule.repo,
      };
      // Match against the rule's configured trigger (manual fire of a tag rule
      // should still enqueue). Overwrite trigger for match.
      event.trigger = rule.trigger === "manual" ? "manual" : String(rule.trigger);
      // Keep body overrides for agent/model when provided.
      if (body.agentId) event.agentId = body.agentId;
      if (body.model) event.model = body.model;
      if (body.provider) event.provider = body.provider;
      // Prefer body.ref when given; otherwise rule.ref or HEAD.
      if (body.ref !== undefined) event.ref = body.ref;
      else if (rule.ref) event.ref = rule.ref;
      else event.ref = "HEAD";

      // Force-match: if the rule is not enabled, still allow manual fire by
      // matching only this rule via handleWatcherEvent after ensuring it matches.
      // handleWatcherEvent only lists enabled rules. For disabled rules return 400.
      if (!rule.enabled) {
        throw badRequest("watcher rule is disabled");
      }

      // When rule.trigger is not "manual", event.trigger is set to rule.trigger
      // above so matchRules finds it. Record provenance uses that trigger.

      const resolver = resolveRefResolver(app);
      let result;
      try {
        result = await handleWatcherEvent(app.queries, resolver, event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/no tasks to enqueue/i.test(message)) {
          throw badRequest("no tasks to enqueue");
        }
        throw err;
      }

      const mine = result.results.find((r) => r.ruleId === ruleId);
      if (!mine) {
        throw badRequest("watcher rule did not match manual fire event");
      }
      if (mine.status === "failed") {
        const errMsg = mine.error ?? "watcher fire failed";
        if (/no tasks to enqueue/i.test(errMsg)) {
          throw badRequest("no tasks to enqueue");
        }
        throw badRequest(errMsg);
      }

      // Newest event for this rule is the one we just recorded.
      const events = app.queries.listWatcherEvents(projectId, {
        ruleId,
        limit: 1,
      });
      const watcherEventId = events[0]?.id ?? null;

      sendJson(res, 202, {
        batchIds: mine.batchIds ?? [],
        watcherEventId,
        status: mine.status,
      });
    },
  );

  // POST /api/projects/:id/watcher/hooks/:ruleId — git-host webhook ingress
  router.post(
    "/api/projects/:id/watcher/hooks/:ruleId",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const ruleId = ctx.params.ruleId!;
      requireProject(app.queries, projectId);
      // Rule must exist (404) before HMAC (401) so callers can distinguish.
      const rule = requireWatcherRule(app.queries, projectId, ruleId);

      // Raw body for HMAC — do not parse first.
      const rawBody = await readBody(req);

      // Secret must be configured.
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
      const trigger = mapGitHubEventToTrigger(ghEvent, payload);
      const ref = extractGitHubRef({ githubRef: ghRefHeader }, payload);

      // Skip pure delete events (no enqueue).
      if (ghEvent?.toLowerCase() === "delete") {
        const ev = app.queries.recordWatcherEvent({
          ruleId,
          projectId,
          trigger,
          ref: ref ?? null,
          status: "ignored",
        });
        sendJson(res, 202, {
          matched: false,
          results: [{ ruleId, status: "ignored", watcherEventId: ev.id }],
        });
        return;
      }

      // Align event trigger with the rule when GitHub mapping differs from the
      // rule's configured trigger (e.g. tag-push often arrives as create/push).
      // Prefer the mapped trigger; if the rule won't match, fall back to rule.trigger
      // only when the mapped type is a superset (webhook) — otherwise let matchRules decide.
      let eventTrigger = trigger;
      if (rule.trigger === "tag" && (trigger === "commit" || trigger === "webhook")) {
        // create(tag) already maps to tag; push of a tag ref may map to commit.
        if (ref && /^v?\d+\.\d+/.test(ref)) eventTrigger = "tag";
      }
      // For exact-rule webhook URL, force trigger to the rule's trigger so this
      // specific hook always targets its rule when ref/repo/role match.
      eventTrigger = String(rule.trigger);

      const event: WatcherInboundEvent = {
        projectId,
        trigger: eventTrigger,
        ref,
        role: rule.role,
        repo: rule.repo,
      };

      const resolver = resolveRefResolver(app);
      const result = await handleWatcherEvent(app.queries, resolver, event);
      const filtered = result.results.filter((r) => r.ruleId === ruleId);

      if (filtered.length === 0) {
        // Rule did not match (disabled mid-flight, ref glob miss, etc.).
        const ev = app.queries.recordWatcherEvent({
          ruleId,
          projectId,
          trigger: eventTrigger,
          ref: ref ?? null,
          status: "ignored",
        });
        sendJson(res, 202, {
          matched: false,
          results: [{ ruleId, status: "ignored", watcherEventId: ev.id }],
        });
        return;
      }

      const matched = filtered.some(
        (r) =>
          r.status === "enqueued" ||
          r.status === "deduped" ||
          r.status === "failed" ||
          r.status === "matched",
      );
      sendJson(res, 202, {
        matched,
        results: filtered.map((r) => ({
          ruleId: r.ruleId,
          status: r.status,
          ...(r.batchIds ? { batchIds: r.batchIds } : {}),
          ...(r.error ? { error: r.error } : {}),
        })),
      });
    },
  );
}

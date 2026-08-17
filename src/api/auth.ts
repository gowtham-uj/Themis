/**
 * Public-API authentication layer (P8b-auth).
 *
 * Tokens: `Authorization: Bearer <token>` where token is `aev_` + 32 url-safe
 * base64 chars. Only the sha256 hex of the plaintext is stored (api_tokens).
 *
 * Loopback / local-dev bypass:
 *   When `authEnabled` is false (the createServer default), no bearer is
 *   required. This keeps the existing test suite + local API clients working
 *   unauthenticated on 127.0.0.1/::1. When `authEnabled: true`, every /api/*
 *   route (except GET /api/health) requires a valid non-revoked token — even
 *   from loopback. There is intentionally no silent loopback bypass in the
 *   auth-enabled path.
 *
 * Spec: plan/api.md §Auth.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbQueries } from "../db/queries.js";
import { apiError } from "./errors.js";
import { extractBearer, header } from "./middleware.js";
import type { RequestContext } from "./router.js";

// Re-export for consumers that import auth helpers from this module.
export { extractBearer, header };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verified bearer identity attached after auth succeeds. */
export interface AuthInfo {
  tokenHash: string;
  userId: string | null;
  projectId: string | null;
  readOnly: boolean;
  /** Token row id (for diagnostics; never the plaintext). */
  id: string;
  label: string | null;
}

export interface AuthMiddlewareOpts {
  /**
   * When true, a read-only token is allowed even on write methods.
   * Default false: read-only tokens get 403 on POST/PATCH/PUT/DELETE.
   */
  requireReadOnly?: boolean;
  /**
   * When set, the token's project_id (if non-null) MUST equal
   * `ctx.params[projectIdParam]`, else 401 (scope check).
   */
  projectIdParam?: string;
  /**
   * When true (createServer authEnabled path), enforce verification.
   * When false, always allow (local-dev default).
   */
  authEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Token crypto
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext API token to the sha256 hex stored in api_tokens.token_hash.
 * NEVER log the plaintext.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Generate a fresh plaintext token: `aev_` + 32 url-safe base64 chars.
 * Caller must hash before persisting; plaintext is returned only at create.
 */
export function generatePlaintextToken(): string {
  // 24 bytes → 32 base64url chars.
  return `aev_${randomBytes(24).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Extract Bearer, hash it, look up the token row.
 * Returns null when missing, unknown, or revoked.
 * NEVER logs the plaintext token.
 */
export async function verifyToken(
  queries: DbQueries,
  req: IncomingMessage,
): Promise<AuthInfo | null> {
  const plaintext = extractBearer(req);
  if (!plaintext) return null;
  const tokenHash = hashToken(plaintext);
  const row = queries.getApiToken(tokenHash);
  if (!row) return null;
  if (row.revokedAt) return null;
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    projectId: row.projectId,
    readOnly: row.readOnly,
    id: row.id,
    label: row.label,
  };
}

/** HTTP methods that mutate state (read-only tokens may not call these). */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteMethod(method: string | undefined): boolean {
  return WRITE_METHODS.has((method ?? "GET").toUpperCase());
}

/**
 * True when the remote address is loopback (IPv4 or IPv6).
 * Used only for documentation / diagnostics of the default-off local path —
 * when authEnabled is false we skip auth entirely (not just for loopback).
 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  // Node may prefix IPv4-mapped IPv6 as ::ffff:127.0.0.1
  const a = addr.replace(/^::ffff:/i, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Auth gate middleware.
 *
 * Returns true when the request is allowed to proceed.
 * Returns false when a 401/403 has already been written to `res`.
 *
 * Behavior:
 * - `authEnabled === false` (default local path): always allow.
 * - Missing/invalid/revoked bearer → 401.
 * - read_only token on a write method → 403 (unless requireReadOnly).
 * - projectIdParam set + token.projectId non-null + mismatch → 401.
 */
export function authMiddleware(
  opts: AuthMiddlewareOpts = {},
): (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
) => boolean | Promise<boolean> {
  const authEnabled = opts.authEnabled === true;
  return async (req, res, ctx) => {
    if (!authEnabled) {
      // Local-dev / test default: no bearer required (loopback API clients + suite).
      return true;
    }

    const queries = (ctx.app as { queries?: DbQueries } | undefined)?.queries;
    if (!queries) {
      apiError(res, 500, {
        title: "Internal Server Error",
        detail: "auth middleware: queries missing from app context",
        type: "https://agenteval.dev/errors/internal",
      });
      return false;
    }

    const auth = await verifyToken(queries, req);
    if (!auth) {
      apiError(res, 401, {
        title: "Unauthorized",
        detail: "valid Bearer token required",
        type: "https://agenteval.dev/errors/unauthorized",
      });
      return false;
    }

    // Scope check: project-scoped tokens may only hit their project.
    if (opts.projectIdParam) {
      const want = ctx.params[opts.projectIdParam];
      if (
        auth.projectId != null &&
        want != null &&
        auth.projectId !== want
      ) {
        apiError(res, 401, {
          title: "Unauthorized",
          detail: "token is not scoped to this project",
          type: "https://agenteval.dev/errors/unauthorized",
        });
        return false;
      }
    }

    // Read-only tokens cannot mutate (unless explicitly allowed).
    if (
      auth.readOnly &&
      isWriteMethod(ctx.method) &&
      opts.requireReadOnly !== true
    ) {
      apiError(res, 403, {
        title: "Forbidden",
        detail: "read-only token cannot perform write operations",
        type: "https://agenteval.dev/errors/forbidden",
      });
      return false;
    }

    // Stash for handlers (token routes, etc.). Request-scoped via req.
    setRequestAuth(req, auth);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Request-scoped auth stash (avoids racing concurrent requests on AppCtx)
// ---------------------------------------------------------------------------

const AUTH_KEY = Symbol.for("agenteval.api.auth");

type ReqWithAuth = IncomingMessage & { [AUTH_KEY]?: AuthInfo };

/** Attach verified auth to the request object. */
export function setRequestAuth(req: IncomingMessage, auth: AuthInfo): void {
  (req as ReqWithAuth)[AUTH_KEY] = auth;
}

/** Read auth previously attached by the gate / authMiddleware. */
export function getRequestAuth(req: IncomingMessage): AuthInfo | undefined {
  return (req as ReqWithAuth)[AUTH_KEY];
}

// ---------------------------------------------------------------------------
// Pre-dispatch gate used by createServer when authEnabled
// ---------------------------------------------------------------------------

/**
 * Paths that stay public even when authEnabled is true.
 * Currently: GET /api/health + POST /api/auth/login (password bootstrap).
 */
export function isPublicApiPath(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" && (path === "/api/health" || path === "/api/health/")) {
    return true;
  }
  // Login must work without a prior bearer (P9 password auth).
  if (
    m === "POST" &&
    (path === "/api/auth/login" || path === "/api/auth/login/")
  ) {
    return true;
  }
  // The signed inbound git webhook is bearer-exempt: GitHub signs the payload
  // with the watcher's shared secret, which IS the authentication. Only the
  // exact signed hook route is exempt — all watcher CRUD, manual fire, and the
  // event list remain bearer-protected and project-scoped.
  if (m === "POST" && /^\/api\/projects\/[^/]+\/watcher\/hooks\/[^/]+$/.test(path)) {
    return true;
  }
  return false;
}

/**
 * Extract a project id from common /api/projects/:id/... paths for scope checks.
 * Returns null when the path is not project-scoped.
 */
export function projectIdFromPath(path: string): string | null {
  const m = /^\/api\/projects\/([^/]+)/.exec(path);
  return m?.[1] ?? null;
}

/**
 * Server-level pre-dispatch auth check.
 *
 * When `authEnabled` is false → always allow (existing suite contract).
 * When true → require a valid Bearer for every /api/* path except public ones;
 * enforce read-only + project scope.
 *
 * Returns true to continue dispatch; false if a response was already written.
 */
export async function gateRequest(opts: {
  authEnabled: boolean;
  queries: DbQueries;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
}): Promise<boolean> {
  const { authEnabled, queries, req, res, method, path } = opts;

  if (!authEnabled) return true;
  if (!path.startsWith("/api/")) return true;
  if (isPublicApiPath(method, path)) return true;

  const auth = await verifyToken(queries, req);
  if (!auth) {
    apiError(res, 401, {
      title: "Unauthorized",
      detail: "valid Bearer token required",
      type: "https://agenteval.dev/errors/unauthorized",
    });
    return false;
  }

  // Project scope: token.projectId set → must match path project.
  const pathProjectId = projectIdFromPath(path);
  if (
    auth.projectId != null &&
    pathProjectId != null &&
    auth.projectId !== pathProjectId
  ) {
    apiError(res, 401, {
      title: "Unauthorized",
      detail: "token is not scoped to this project",
      type: "https://agenteval.dev/errors/unauthorized",
    });
    return false;
  }

  // Read-only tokens: no writes.
  if (auth.readOnly && isWriteMethod(method)) {
    // Token management is always a write for create/revoke; list is GET.
    apiError(res, 403, {
      title: "Forbidden",
      detail: "read-only token cannot perform write operations",
      type: "https://agenteval.dev/errors/forbidden",
    });
    return false;
  }

  setRequestAuth(req, auth);
  return true;
}

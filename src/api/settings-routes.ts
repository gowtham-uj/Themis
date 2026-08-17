/**
 * Settings + auth-user + project-export routes (P9-settings).
 *
 * - GET/PUT /api/settings — global settings (keys, limits, models).
 *   Secret key VALUES are never returned — only a list of key NAMES.
 * - POST /api/auth/login — username/password → mint Bearer token.
 * - GET /api/auth/me — identity for the current bearer.
 * - POST /api/auth/users — admin-only user create.
 * - GET /api/auth/users — list users (admin-preferred; open when auth off).
 * - DELETE /api/auth/users/:id — admin-only delete.
 * - POST /api/projects/:id/export — portable JSON bundle (rows + path manifest).
 *
 * Spec: plan/api.md §Auth / §Projects export + plan/ui.md §Settings.
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbQueries, Project, User } from "../db/queries.js";
import { resolveProjectDir } from "../db/index.js";
import {
  getRequestAuth,
  isPublicApiPath,
} from "./auth.js";
import {
  isAdmin,
  loginUser,
  registerUser,
  toPublicUser,
  userFromAuth,
} from "./auth-users.js";
import { badRequest, conflict, HttpError, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";

// ---------------------------------------------------------------------------
// Settings shape
// ---------------------------------------------------------------------------

/** Well-known setting keys stored in the settings table. */
export const SETTINGS_KEYS = {
  defaultModels: "defaults.models",
  limits: "limits",
  /** List of secret key NAMES only (never values). */
  keyNames: "keys.names",
} as const;

/** Public GET /api/settings response. Secrets are name-only. */
export interface SettingsResponse {
  defaultModels?: unknown;
  limits?: unknown;
  /** Names of configured secret keys — NEVER secret values. */
  keys?: string[];
}

/** PUT /api/settings body. */
export interface SettingsPutBody {
  defaultModels?: unknown;
  limits?: unknown;
  /**
   * Replace the list of secret key NAMES. Values themselves are never
   * accepted/stored via this API (env-side or out-of-band).
   */
  keys?: string[];
}

function readSettings(queries: DbQueries): SettingsResponse {
  const out: SettingsResponse = {};
  const models = queries.getSetting(SETTINGS_KEYS.defaultModels);
  if (models !== null && models !== undefined) {
    out.defaultModels = models;
  }
  const limits = queries.getSetting(SETTINGS_KEYS.limits);
  if (limits !== null && limits !== undefined) {
    out.limits = limits;
  }
  const keyNames = queries.getSetting(SETTINGS_KEYS.keyNames);
  if (Array.isArray(keyNames)) {
    out.keys = keyNames.map(String);
  } else {
    out.keys = [];
  }
  return out;
}

function writeSettings(queries: DbQueries, body: SettingsPutBody): SettingsResponse {
  if ("defaultModels" in body) {
    queries.setSetting(SETTINGS_KEYS.defaultModels, body.defaultModels ?? null);
  }
  if ("limits" in body) {
    queries.setSetting(SETTINGS_KEYS.limits, body.limits ?? null);
  }
  if ("keys" in body) {
    const names = Array.isArray(body.keys)
      ? body.keys.map(String).filter((s) => s.length > 0)
      : [];
    queries.setSetting(SETTINGS_KEYS.keyNames, names);
  }
  return readSettings(queries);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function appOf(ctx: RequestContext): {
  queries: DbQueries;
  dataDir: string;
  authEnabled: boolean;
} {
  return ctx.app as {
    queries: DbQueries;
    dataDir: string;
    authEnabled: boolean;
  };
}

/**
 * Require an admin user when auth is enabled.
 * When authEnabled is false (local-dev default), allow — mirrors the rest of
 * the suite so tests without tokens still exercise the route.
 */
function requireAdmin(
  req: IncomingMessage,
  queries: DbQueries,
  authEnabled: boolean,
): User | null {
  if (!authEnabled) return null;
  const auth = getRequestAuth(req);
  const user = userFromAuth(queries, auth);
  if (!user || !isAdmin(user)) {
    throw new HttpError(
      403,
      "Forbidden",
      "admin role required",
      { type: "https://agenteval.dev/errors/forbidden" },
    );
  }
  return user;
}

/**
 * Paths that stay public even when authEnabled is true — login must work
 * without a prior bearer.
 */
export function isAuthPublicPath(method: string, path: string): boolean {
  if (isPublicApiPath(method, path)) return true;
  const m = method.toUpperCase();
  if (m === "POST" && (path === "/api/auth/login" || path === "/api/auth/login/")) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Export bundle
// ---------------------------------------------------------------------------

/**
 * Walk a project data subtree and return relative path list (files only).
 * Best-effort: missing dir → empty list.
 */
export function listProjectSubtreePaths(
  dataDir: string,
  projectId: string,
): string[] {
  const root = join(dataDir, "projects", projectId);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        out.push(relative(dataDir, full).split("\\").join("/"));
      }
    }
  };
  walk(root);
  out.sort();
  return out;
}

/**
 * Build a portable JSON export bundle for a project.
 * Strips webhook secrets + api tokens. Includes a signed (sha256) path manifest.
 */
export function buildExportBundle(
  queries: DbQueries,
  dataDir: string,
  projectId: string,
): {
  version: 1;
  exportedAt: string;
  project: Project;
  tasks: unknown[];
  runs: unknown[];
  watchers: unknown[];
  paths: string[];
  manifest: { algorithm: "sha256"; digest: string; pathCount: number };
} {
  // Ensure project dir exists for path listing (no-op if already present).
  try {
    resolveProjectDir(dataDir, projectId);
  } catch {
    // ignore
  }
  const rows = queries.exportRows(projectId);

  // Defensive second-pass strip: never emit secret / token_hash fields.
  const watchers = rows.watchers.map((w) => {
    const { webhookSecret: _ws, ...rest } = w as typeof w & {
      webhookSecret?: unknown;
    };
    void _ws;
    return { ...rest, webhookSecret: null };
  });
  const paths = listProjectSubtreePaths(dataDir, projectId);
  const manifestBody = JSON.stringify({ projectId, paths });
  const digest = createHash("sha256").update(manifestBody, "utf8").digest("hex");

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: rows.project,
    tasks: rows.tasks,
    runs: rows.runs,
    watchers,
    paths,
    manifest: {
      algorithm: "sha256",
      digest,
      pathCount: paths.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register settings, auth-user, and project-export routes on the router.
 */
export function registerSettingsRoutes(router: Router): void {
  // ---- Global settings ----

  router.get("/api/settings", (_req, res, ctx) => {
    const app = appOf(ctx);
    sendJson(res, 200, readSettings(app.queries));
  });

  router.put("/api/settings", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const body = await readJsonBody<SettingsPutBody>(req);
    const updated = writeSettings(app.queries, body ?? {});
    sendJson(res, 200, updated);
  });

  // ---- Auth: login / me / users ----

  router.post("/api/auth/login", async (req, res, ctx) => {
    const app = appOf(ctx);
    const body = await readJsonBody<{
      username?: string;
      password?: string;
    }>(req);
    const username = body.username;
    const password = body.password;
    if (!username || !password) {
      throw badRequest("username and password are required");
    }
    const result = loginUser(app.queries, username, password);
    if (!result) {
      throw new HttpError(401, "Unauthorized", "invalid username or password", {
        type: "https://agenteval.dev/errors/unauthorized",
      });
    }
    sendJson(res, 200, {
      token: result.token,
      user: toPublicUser(result.user),
    });
  });

  router.get("/api/auth/me", (req, res, ctx) => {
    const app = appOf(ctx);
    const auth = getRequestAuth(req);
    if (!auth?.userId) {
      // When auth is off, there is no identity — return 401 so clients know.
      if (!app.authEnabled && !auth) {
        throw new HttpError(
          401,
          "Unauthorized",
          "no bearer identity (auth disabled or token not user-bound)",
          { type: "https://agenteval.dev/errors/unauthorized" },
        );
      }
      throw new HttpError(
        401,
        "Unauthorized",
        "token is not bound to a user",
        { type: "https://agenteval.dev/errors/unauthorized" },
      );
    }
    const user = app.queries.getUser(auth.userId);
    if (!user) {
      throw notFound(`user not found: ${auth.userId}`);
    }
    sendJson(res, 200, {
      userId: user.id,
      username: user.username,
      role: user.role,
    });
  });

  router.get("/api/auth/users", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const list = app.queries.listUsers().map(toPublicUser);
    sendJson(res, 200, { users: list });
  });

  router.post("/api/auth/users", async (req, res, ctx) => {
    const app = appOf(ctx);
    // Admin-only when auth is on. First-user bootstrap still works via
    // registerUser when the table is empty and auth is off (local seed).
    if (app.authEnabled) {
      requireAdmin(req, app.queries, true);
    } else if (app.queries.countUsers() > 0) {
      // Soft gate even with auth off: after bootstrap, prefer explicit admin.
      // Still allow for local-dev convenience (tests + CLI seed).
    }
    const body = await readJsonBody<{
      username?: string;
      password?: string;
      role?: string;
      email?: string | null;
    }>(req);
    if (!body.username || !body.password) {
      throw badRequest("username and password are required");
    }
    try {
      const user = registerUser(app.queries, {
        username: body.username,
        password: body.password,
        ...(body.role ? { role: body.role } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      });
      sendJson(res, 201, toPublicUser(user));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already taken")) {
        throw conflict(msg);
      }
      throw badRequest(msg);
    }
  });

  router.delete("/api/auth/users/:id", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const id = ctx.params.id!;
    const existing = app.queries.getUser(id);
    if (!existing) throw notFound(`user not found: ${id}`);
    app.queries.deleteUser(id);
    sendJson(res, 200, { deleted: true, id });
  });

  // ---- Project export ----

  router.post(
    "/api/projects/:id/export",
    (_req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const project = app.queries.getProject(projectId);
      if (!project || project.archived) {
        throw notFound(`project not found: ${projectId}`);
      }
      const bundle = buildExportBundle(app.queries, app.dataDir, projectId);
      // Final safety: serialized bundle must not contain secret values /
      // token_hash plaintext (asserted in tests).
      sendJson(res, 200, bundle);
    },
  );
}

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
  MODEL_STAGES,
  ModelConfigError,
  mergeStoredModelConfig,
  parseStoredStageConfig,
  setStoredModelConfig,
  viewModelConfig,
  type ModelStage,
  type StoredModelConfig,
} from "../config/model-config.js";
import { checkModelHealth } from "../config/model-health.js";
import { deleteSecret, listSecrets, putSecret } from "../config/secret-vault.js";
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

/** In-process brute-force guard for the public login endpoint. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BASE_LOCK_MS = 1_000;
const LOGIN_MAX_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_ENTRIES = 10_000;

type LoginFailureState = { failures: number; firstFailureAt: number; lockedUntil: number };
const loginFailures = new Map<string, LoginFailureState>();

function loginAttemptKey(req: IncomingMessage, username: string): string {
  return `${req.socket.remoteAddress ?? "unknown"}\0${username.trim().toLowerCase()}`;
}

function loginRetryAfterMs(key: string, now = Date.now()): number {
  const state = loginFailures.get(key);
  if (!state) return 0;
  if (now - state.firstFailureAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return 0;
  }
  return Math.max(0, state.lockedUntil - now);
}

function recordLoginFailure(key: string, now = Date.now()): void {
  let state = loginFailures.get(key);
  if (!state || now - state.firstFailureAt > LOGIN_WINDOW_MS) {
    state = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
  }
  state.failures += 1;
  // First four failures are allowed without a lock; subsequent failures use
  // exponential backoff capped at 15 minutes.
  if (state.failures >= 5) {
    const lockMs = Math.min(
      LOGIN_MAX_LOCK_MS,
      LOGIN_BASE_LOCK_MS * 2 ** Math.min(20, state.failures - 5),
    );
    state.lockedUntil = now + lockMs;
  }
  loginFailures.delete(key);
  loginFailures.set(key, state);
  while (loginFailures.size > LOGIN_MAX_ENTRIES) {
    const oldest = loginFailures.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    loginFailures.delete(oldest);
  }
}

function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

/** Well-known setting keys stored in the settings table. */
export const SETTINGS_KEYS = {
  defaultModels: "defaults.models",
  limits: "limits",
  /** List of secret key NAMES only (never values). */
  keyNames: "keys.names",
  /** Per-stage provider config. Holds env var names, never key values. */
  modelStages: "models.stages",
} as const;

/**
 * Load the stored per-stage model config from the settings table into this
 * process. Call at startup and after every save so worker paths that have no
 * QueryStore in scope still resolve what the operator configured.
 */
export function loadStoredModelConfig(queries: DbQueries): StoredModelConfig {
  const raw = queries.getSetting(SETTINGS_KEYS.modelStages);
  const out: StoredModelConfig = {};
  if (raw && typeof raw === "object") {
    for (const stage of MODEL_STAGES) {
      const patch = (raw as Record<string, unknown>)[stage];
      if (patch) {
        try {
          out[stage] = parseStoredStageConfig(patch, stage);
        } catch {
          // A stored value that no longer parses must not stop the server.
          // viewModelConfig reports the stage as unconfigured instead.
        }
      }
    }
  }
  setStoredModelConfig(out);
  return out;
}

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
  // Strip host-absolute storage paths (events/diff/package) from exported rows —
  // they are internal deployment details, never part of a portable bundle.
  const stripHostPaths = (row: Record<string, unknown> | null | undefined) => {
    if (!row || typeof row !== "object") return row;
    const { eventsPath, diffPath, packagePath, manifestPath, workspaceDir, buildLogPath, logPath, ...rest } =
      row as Record<string, unknown>;
    void eventsPath; void diffPath; void packagePath;
    void manifestPath; void workspaceDir; void buildLogPath; void logPath;
    return rest;
  };
  const runs = rows.runs.map((r) => stripHostPaths(r as unknown as Record<string, unknown>));
  const tasks = rows.tasks.map((t) => stripHostPaths(t as unknown as Record<string, unknown>));
  const paths = listProjectSubtreePaths(dataDir, projectId);
  const manifestBody = JSON.stringify({ projectId, paths });
  const digest = createHash("sha256").update(manifestBody, "utf8").digest("hex");

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    project: rows.project,
    tasks,
    runs,
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

  // ---- Per-stage model config ----

  // Views only. Every response names the env var holding each stage's key and
  // says whether that variable is set; the value itself never leaves the host.
  router.get("/api/settings/models", (_req, res, ctx) => {
    const app = appOf(ctx);
    loadStoredModelConfig(app.queries);
    sendJson(res, 200, { stages: MODEL_STAGES.map((s) => viewModelConfig(s)) });
  });

  router.put("/api/settings/models", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const body = await readJsonBody<Record<string, unknown>>(req);
    const stored: StoredModelConfig = {};
    try {
      for (const stage of MODEL_STAGES) {
        if (body && stage in body) stored[stage] = parseStoredStageConfig(body[stage], stage);
      }
    } catch (err) {
      if (err instanceof ModelConfigError) throw badRequest(err.message);
      throw err;
    }
    app.queries.setSetting(SETTINGS_KEYS.modelStages, stored);
    setStoredModelConfig(stored);
    sendJson(res, 200, { stages: MODEL_STAGES.map((s) => viewModelConfig(s)) });
  });

  // ---- Credential values ----
  //
  // The console can accept a key value directly instead of asking the operator
  // to export it before starting the server. The value is encrypted at rest and
  // decrypted into this process's environment, so every queue, adapter, and
  // judge stage keeps resolving it by variable name exactly as before. Reads
  // return names and write times only.

  router.get("/api/settings/secrets", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    sendJson(res, 200, { secrets: listSecrets(app.queries) });
  });

  router.put("/api/settings/secrets/:name", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const name = ctx.params.name ?? "";
    const body = await readJsonBody<{ value?: unknown }>(req);
    const value = typeof body?.value === "string" ? body.value.trim() : "";
    if (!value) throw badRequest("value is required");
    try {
      putSecret(app.queries, name, value);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    sendJson(res, 200, { secrets: listSecrets(app.queries) });
  });

  router.delete("/api/settings/secrets/:name", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const name = ctx.params.name ?? "";
    if (!deleteSecret(app.queries, name)) throw notFound(`no stored value for "${name}"`);
    sendJson(res, 200, { secrets: listSecrets(app.queries) });
  });

  // Real request against the configured endpoint. Config presence is not
  // health: this catches a dead URL, a revoked key, a model the provider does
  // not serve, and an API compatibility type that does not match the endpoint.
  //
  // An optional body carries an unsaved stage patch, so the project creation
  // form can test what the operator just typed before anything is stored.
  router.post("/api/settings/models/:stage/health", async (req, res, ctx) => {
    const app = appOf(ctx);
    const stage = ctx.params.stage as ModelStage;
    if (!MODEL_STAGES.includes(stage)) {
      throw badRequest(`unknown stage "${stage}"; expected one of ${MODEL_STAGES.join(", ")}`);
    }
    const base = loadStoredModelConfig(app.queries);
    const body = await readJsonBody<Record<string, unknown>>(req).catch(() => ({}));
    let patch: StoredModelConfig = {};
    try {
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        patch = { [stage]: parseStoredStageConfig(body, stage) };
      }
    } catch (err) {
      if (err instanceof ModelConfigError) throw badRequest(err.message);
      throw err;
    }
    sendJson(res, 200, await checkModelHealth(stage, { stored: mergeStoredModelConfig(patch, base) }));
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
    const attemptKey = loginAttemptKey(req, username);
    const retryAfterMs = loginRetryAfterMs(attemptKey);
    if (retryAfterMs > 0) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)));
      throw new HttpError(429, "Too Many Requests", "too many login attempts; retry later", {
        type: "https://agenteval.dev/errors/rate-limited",
      });
    }
    const result = await loginUser(app.queries, username, password, {
      allowGlobalForAnyUser: !app.authEnabled,
    });
    if (!result) {
      recordLoginFailure(attemptKey);
      throw new HttpError(401, "Unauthorized", "invalid username or password", {
        type: "https://agenteval.dev/errors/unauthorized",
      });
    }
    if (result.tokens.length === 0) {
      throw new HttpError(
        403,
        "Forbidden",
        "user has no project memberships; ask an admin to grant access",
        { type: "https://agenteval.dev/errors/forbidden" },
      );
    }
    clearLoginFailures(attemptKey);
    // Backward-compatible: expose the first token as `token`, and the full set
    // as `tokens` for multi-project members.
    sendJson(res, 200, {
      token: result.tokens[0]!.token,
      tokens: result.tokens.map((t) => ({
        token: t.token,
        project_id: t.projectId,
      })),
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
      // Only honor a caller-supplied role when auth is enabled (an admin has
      // already been verified by requireAdmin). With auth off, ignore it so an
      // unauthenticated caller cannot self-register an admin account; the store's
      // bootstrap rule (first user → admin) still allows local seeding.
      const role = app.authEnabled && typeof body.role === "string" ? body.role : undefined;
      const user = registerUser(app.queries, {
        username: body.username,
        password: body.password,
        ...(role !== undefined ? { role } : {}),
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

  // ---- Project membership ----

  router.get("/api/projects/:id/members", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const projectId = ctx.params.id!;
    if (!app.queries.getProject(projectId) || app.queries.getProject(projectId)?.archived) {
      throw notFound(`project not found: ${projectId}`);
    }
    sendJson(res, 200, { members: app.queries.listProjectMembers(projectId) });
  });

  router.put("/api/projects/:id/members/:userId", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const projectId = ctx.params.id!;
    const userId = ctx.params.userId!;
    if (!app.queries.getProject(projectId) || app.queries.getProject(projectId)?.archived) {
      throw notFound(`project not found: ${projectId}`);
    }
    if (!app.queries.getUser(userId)) throw notFound(`user not found: ${userId}`);
    app.queries.addProjectMember(projectId, userId);
    sendJson(res, 200, { project_id: projectId, user_id: userId, member: true });
  });

  router.delete("/api/projects/:id/members/:userId", (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdmin(req, app.queries, app.authEnabled);
    const projectId = ctx.params.id!;
    const userId = ctx.params.userId!;
    app.queries.removeProjectMember(projectId, userId);
    sendJson(res, 200, { project_id: projectId, user_id: userId, member: false });
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

/**
 * REST API server — project/task/run CRUD + persistent eval queues + SSE events.
 *
 * Bootstraps a tiny zero-dep router with a shared AppCtx. Routes follow
 * plan/api.md (project-scoped). Auth is optional via CreateServerOptions.authEnabled
 * (default false for local-dev + existing tests; see src/api/auth.ts).
 *
 * Evals execute through persistent queue-owned containers (queue-worker.ts).
 * GET project runs, run detail/events/diff, and queue-backed pause/resume/abort
 * are read-only or queue-scoped surfaces; there is no ad-hoc in-memory runner.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, watch as fsWatch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDb as defaultOpenDb, resolveProjectDir, type OpenDbResult } from "../db/index.js";
import {
  type DbQueries,
  type Project,
  type Run,
  type Task,
  type UpdateProjectInput,
} from "../db/queries.js";
import {
  decodeEvalArchiveFile,
  detectEvalLayout,
  splitSuiteTasks,
  type EvalArchiveFormat,
} from "../evals/archive.js";
import {
  materializeEvalPackage,
  type EvalPackageUpload,
} from "../evals/package.js";
import { readFromSeq } from "../schema/jsonl.js";
import { isTerminalStatus } from "../runner/status.js";
import {
  resolveDiffPath,
  resolveEventsPath,
} from "../runner/run-layout.js";
import { Router, readJsonBody, sendJson, type RequestContext } from "./router.js";
import {
  badRequest,
  conflict,
  handleError,
  HttpError,
  notFound,
} from "./errors.js";
import { registerWatcherRoutes } from "./watcher-routes.js";
import { registerQueueRoutes } from "./queue-routes.js";
import { registerAdapterRoutes } from "./adapter-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerArchiveRoutes } from "./archive-routes.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import { registerGitHubRoutes } from "./github-routes.js";
import {
  createLiveQueueContainersMap,
  startQueueContainer,
  type LiveQueueContainersMap,
  type StartQueueContainerOptions,
} from "../runner/queue-worker.js";
import type { GitHubClient } from "./github.js";

import {
  type RefResolver,
  type WatcherSeams,
} from "../watcher/engine.js";
import {
  gateRequest,
  getRequestAuth,
  hashToken,
} from "./auth.js";
import {
  IdempotencyStore,
  type IdempotencyEntry,
} from "./middleware.js";

// ---------------------------------------------------------------------------
// App context
// ---------------------------------------------------------------------------

export interface AppCtx {
  queries: DbQueries;
  dataDir: string;
  /** Queue-id keyed persistent queue containers. */
  liveQueueContainers: LiveQueueContainersMap;
  /** Queue worker options forwarded by the API lifecycle routes. */
  queueStartOpts?: StartQueueContainerOptions;
  /**
   * In-memory Idempotency-Key → response body.
   * Backed by {@link IdempotencyStore} (LRU + TTL); Map-compatible surface.
   */
  idempotency: {
    has(key: string): boolean;
    get(key: string): IdempotencyEntry | undefined;
    set(key: string, value: IdempotencyEntry): unknown;
  };
  /**
   * When true, every /api/* route (except GET /api/health) requires a valid
   * Bearer token. Default false so local-dev + the existing unauthenticated
   * test suite keep working (loopback API clients included).
   */
  authEnabled: boolean;
  /**
   * Watcher seams (SHA resolution + queue-generation launch). Wired to resolve
   * refs against the real source repo and to launch queue generations pinned to a
   * commit override. Tests inject a fake.
   */
  watcherSeams?: WatcherSeams;
  /**
   * Read-only GitHub client for browsing live repo state (commits, refs, PRs)
   * and resolving a ref to a concrete sha. Tests inject a stubbed transport;
   * production builds one from settings/env on first use.
   */
  githubClient?: GitHubClient;
}

export interface CreateServerOptions {
  dataDir: string;
  /** Pre-opened queries; when omitted, openDb(dataDir) is used. */
  queries?: DbQueries;
  /** Override openDb (tests / custom backends). */
  openDb?: (dataDir: string) => OpenDbResult;
  /** Options for persistent queue-container execution. */
  queueStartOpts?: StartQueueContainerOptions;
  /**
   * Gate /api/* behind Bearer tokens. Default **false** (local-dev path):
   * existing tests that hit routes unauthenticated MUST keep working.
   * When true, require a valid non-revoked token except GET /api/health.
   * See src/api/auth.ts for the loopback/default-off contract.
   */
  authEnabled?: boolean;
  /**
   * Optional ref resolver for watcher routes. Tests inject a fake.
   * Backward-compatible; preferred to pass `watcherSeams` directly.
   */
  refResolver?: RefResolver;
  /**
   * Watcher seams (SHA resolution + queue-generation launch). When omitted but
   * `refResolver` is set, resolution is derived from it and launching stays a
   * throwing stub (absent a real queue runtime). Tests inject a fake.
   */
  watcherSeams?: WatcherSeams;
  /**
   * Read-only GitHub client. Inject a stubbed transport in tests so browsing
   * live repo state never depends on the network.
   */
  githubClient?: GitHubClient;
}

export interface ApiServer {
  server: Server;
  queries: DbQueries;
  liveQueueContainers: LiveQueueContainersMap;
  app: AppCtx;
  /** Listen on an ephemeral port (or given port). Resolves with the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  /** Close the HTTP server and best-effort stop live queue containers. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function projectJson(p: Project) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    task_source: p.taskSource,
    default_agent_id: p.defaultAgentId,
    default_model: p.defaultModel,
    default_provider: p.defaultProvider,
    workspace_image: p.workspaceImage,
    check_runners: p.checkRunners,
    adapter_overrides: p.adapterOverrides,
    network_policy: p.networkPolicy,
    retention_runs: p.retentionRuns,
    sandbox: p.sandbox,
    archived: p.archived,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function taskJson(t: Task, usedByQueues?: { id: string; name: string }[]) {
  return {
    id: t.id,
    project_id: t.projectId,
    external_id: t.externalId,
    name: t.name,
    prompt: t.prompt,
    workspace: t.workspace,
    rubric: t.rubric,
    version: t.version,
    rubric_version: t.rubricVersion,
    agent_category: t.agentCategory,
    category_name: t.categoryName,
    profile: t.profile,
    reference_solution: t.referenceSolution,
    checks: t.checks,
    env: t.env,
    tags: t.tags,
    source_kind: t.sourceKind,
    package_digest: t.packageDigest,
    package_manifest: t.packageManifest,
    package_validation: t.packageValidation,
    archived: t.archived,
    used_by_queues: usedByQueues ?? [],
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

async function createCanonicalEval(
  app: AppCtx,
  project: Project,
  upload: EvalPackageUpload,
): Promise<Task> {
  const map = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(upload.files)) {
    const encoded = typeof value === "string" ? { encoding: "utf8" as const, content: value } : value;
    map.set(path, Buffer.from(encoded.content, encoded.encoding === "base64" ? "base64" : "utf8"));
  }
  return createSingleEvalFromFiles(app, project, map);
}

/** Materialize one eval package from a decoded file map and create its task row. */
async function createSingleEvalFromFiles(
  app: AppCtx,
  project: Project,
  files: Map<string, Buffer>,
): Promise<Task> {
  const id = randomUUID();
  const packagePath = join(
    app.dataDir,
    "projects",
    project.id,
    "evals",
    id,
    "package",
  );
  const uploadFiles: EvalPackageUpload["files"] = {};
  for (const [path, content] of files) {
    uploadFiles[path] = { encoding: "base64", content: content.toString("base64") };
  }
  const materialized = await materializeEvalPackage({
    upload: { files: uploadFiles },
    destination: packagePath,
  });
  try {
    return app.queries.createTask(project.id, materialized.taskSpec, {
      id,
      sourceKind: "eval-package",
      packagePath: materialized.packagePath,
      packageDigest: materialized.packageDigest,
      packageManifest: materialized.manifest as unknown as Record<string, unknown>,
      packageValidation: materialized.validation as unknown as Record<string, unknown>,
    });
  } catch (err) {
    await rm(join(packagePath, ".."), { recursive: true, force: true });
    throw err;
  }
}

/** Materialize each task in a decoded suite into its own eval row. */
async function createSuiteEvals(
  app: AppCtx,
  project: Project,
  decoded: Map<string, Buffer>,
): Promise<Task[]> {
  const byTask = splitSuiteTasks(decoded);
  const created: Task[] = [];
  for (const [, taskFiles] of byTask) {
    created.push(await createSingleEvalFromFiles(app, project, taskFiles));
  }
  return created;
}

async function readBinaryBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limitBytes) throw badRequest(`request body exceeds ${limitBytes} bytes`);
    chunks.push(bytes);
  }
  if (total === 0) throw badRequest("archive request body is empty");
  return Buffer.concat(chunks);
}

function runJson(r: Run) {
  return {
    id: r.id,
    batch_id: r.batchId,
    task_id: r.taskId,
    project_id: r.projectId,
    agent_id: r.agentId,
    model: r.model,
    provider: r.provider,
    repeat_index: r.repeatIndex,
    status: r.status,
    control_state: r.controlState,
    workspace_commit: r.workspaceCommit,
    agent_image: r.agentImage,
    agent_commit: r.agentCommit,
    agent_image_source: r.agentImageSource,
    trigger: r.trigger,
    trigger_ref: r.triggerRef,
    paused_at: r.pausedAt,
    resumed_at: r.resumedAt,
    pause_count: r.pauseCount,
    started_at: r.startedAt,
    ended_at: r.endedAt,
    duration_ms: r.durationMs,
    usage: {
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      reasoning_tokens: r.reasoningTokens,
      total_cost: r.totalCost,
    },
    provenance: {
      workspace_commit: r.workspaceCommit,
      agent_image: r.agentImage,
      agent_commit: r.agentCommit,
      agent_image_source: r.agentImageSource,
      trigger: r.trigger,
      trigger_ref: r.triggerRef,
    },
    // Deliberately NOT serialized: events_path / diff_path are absolute
    // host filesystem locations — internal storage paths never leak to clients
    // (the streamer/diff routes resolve them server-side from the DB row).
    error: r.error,
  };
}

function appOf(ctx: RequestContext): AppCtx {
  return ctx.app as AppCtx;
}

function requireProject(queries: DbQueries, id: string): Project {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

function requireTask(queries: DbQueries, projectId: string, taskId: string): Task {
  const t = queries.getTask(taskId);
  if (!t || t.projectId !== projectId || t.archived) {
    throw notFound(`task not found: ${taskId}`);
  }
  return t;
}

function requireRun(queries: DbQueries, id: string): Run {
  const r = queries.getRun(id);
  if (!r) throw notFound(`run not found: ${id}`);
  return r;
}

/** Enforce project-token scope on an ID-addressed resource (run/events/diff/etc.). */
function assertResourceScope(
  req: IncomingMessage,
  queries: DbQueries,
  resource: { runId: string },
): void {
  const run = queries.getRun(resource.runId);
  if (!run) return; // notFound handled by caller after requireRun
  const auth = getRequestAuth(req);
  if (auth?.projectId != null && auth.projectId !== run.projectId) {
    throw new HttpError(401, "Unauthorized", "token is not scoped to this project", {
      type: "https://agenteval.dev/errors/unauthorized",
    });
  }
}

// ---------------------------------------------------------------------------
// SSE / ndjson event streaming
// ---------------------------------------------------------------------------

async function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  app: AppCtx,
  run: Run,
  since: number,
  mode: "sse" | "ndjson",
): Promise<void> {
  const eventsPath = resolveEventsPath(
    app.dataDir,
    run.projectId,
    run.id,
    run.eventsPath,
  );

  if (mode === "sse") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Flush headers.
    res.write(`: ok\n\n`);
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
  }

  let lastSeq = since;
  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on("close", onClose);
  res.on("close", onClose);

  const writeEvent = (obj: unknown) => {
    if (closed || res.writableEnded) return;
    if (mode === "sse") {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } else {
      res.write(`${JSON.stringify(obj)}\n`);
    }
    if (obj && typeof obj === "object" && "seq" in obj) {
      const s = (obj as { seq: unknown }).seq;
      if (typeof s === "number" && s > lastSeq) lastSeq = s;
    }
  };

  // Replay existing events.
  try {
    for await (const obj of readFromSeq(eventsPath, lastSeq)) {
      if (closed) break;
      writeEvent(obj);
    }
  } catch {
    // missing file is fine — live tail will pick up new events
  }

  // If already terminal and nothing more is expected, end after replay.
  const fresh = app.queries.getRun(run.id);
  if (fresh && isTerminalStatus(fresh.status)) {
    // One more pass in case the final events just landed.
    try {
      for await (const obj of readFromSeq(eventsPath, lastSeq)) {
        if (closed) break;
        writeEvent(obj);
      }
    } catch {
      // ignore
    }
    if (!closed && !res.writableEnded) res.end();
    req.off("close", onClose);
    res.off("close", onClose);
    return;
  }

  // Live-tail: poll the file for new lines (portable across container backends).
  const pollMs = 50;
  const maxWaitMs = 120_000;
  const started = Date.now();

  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let watcher: ReturnType<typeof fsWatch> | undefined;

    const cleanup = () => {
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      req.off("close", onClose);
      res.off("close", onClose);
    };

    const tick = async () => {
      if (closed || res.writableEnded) {
        cleanup();
        resolve();
        return;
      }
      try {
        for await (const obj of readFromSeq(eventsPath, lastSeq)) {
          if (closed) break;
          writeEvent(obj);
        }
      } catch {
        // ignore transient read errors
      }

      const r = app.queries.getRun(run.id);
      const terminal = r != null && isTerminalStatus(r.status);

      if (terminal || Date.now() - started > maxWaitMs) {
        // Final drain.
        try {
          for await (const obj of readFromSeq(eventsPath, lastSeq)) {
            if (closed) break;
            writeEvent(obj);
          }
        } catch {
          // ignore
        }
        if (!closed && !res.writableEnded) res.end();
        cleanup();
        resolve();
      }
    };

    timer = setInterval(() => {
      void tick();
    }, pollMs);
    timer.unref?.();

    // Also wake on fs changes when the file exists.
    try {
      if (existsSync(eventsPath)) {
        watcher = fsWatch(eventsPath, () => {
          void tick();
        });
      }
    } catch {
      // polling only
    }

    // Immediate first poll.
    void tick();
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

function registerRoutes(router: Router): void {
  // ---- health (public even when authEnabled) ----
  router.get("/api/health", (_req, res) => {
    sendJson(res, 200, { ok: true });
  });

  // ---- API tokens (P8b-auth). Bootstrap first token via queries.createApiToken. ----
  registerTokenRoutes(router);

  // ---- projects ----

  router.post("/api/projects", async (req, res, ctx) => {
    const app = appOf(ctx);
    const body = await readJsonBody<{
      name?: string;
      slug?: string;
      description?: string;
      task_source?: { kind: string; params?: Record<string, unknown> };
      taskSource?: { kind: string; params?: Record<string, unknown> };
      default_agent_id?: string;
      default_model?: string;
      default_provider?: string;
      network_policy?: string;
    }>(req);

    if (!body.name || !String(body.name).trim()) {
      throw badRequest("name is required");
    }
    const slug =
      body.slug?.trim() ||
      String(body.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") ||
      "project";

    const project = app.queries.createProject({
      name: String(body.name).trim(),
      slug,
      description: body.description,
      taskSource: body.task_source ?? body.taskSource ?? { kind: "ui-builder" },
      defaultAgentId: body.default_agent_id,
      defaultModel: body.default_model,
      defaultProvider: body.default_provider,
      networkPolicy: body.network_policy,
    });
    resolveProjectDir(app.dataDir, project.id);
    sendJson(res, 201, projectJson(project));
  });

  router.get("/api/projects", (_req, res, ctx) => {
    const app = appOf(ctx);
    const includeArchived = ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    const list = app.queries.listProjects({ includeArchived }).map(projectJson);
    sendJson(res, 200, { projects: list });
  });

  router.get("/api/projects/:id", (_req, res, ctx) => {
    const app = appOf(ctx);
    const p = requireProject(app.queries, ctx.params.id!);
    sendJson(res, 200, projectJson(p));
  });

  router.patch("/api/projects/:id", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const body = await readJsonBody<Record<string, unknown>>(req);
    const patch: UpdateProjectInput = {};
    if (typeof body.name === "string") patch.name = body.name;
    if ("description" in body) {
      patch.description =
        body.description === null || body.description === undefined
          ? null
          : String(body.description);
    }
    if (body.task_source && typeof body.task_source === "object") {
      patch.taskSource = body.task_source as UpdateProjectInput["taskSource"];
    }
    if (body.taskSource && typeof body.taskSource === "object") {
      patch.taskSource = body.taskSource as UpdateProjectInput["taskSource"];
    }
    if ("default_model" in body) {
      patch.defaultModel =
        body.default_model === null || body.default_model === undefined
          ? null
          : String(body.default_model);
    }
    if ("default_provider" in body) {
      patch.defaultProvider =
        body.default_provider === null || body.default_provider === undefined
          ? null
          : String(body.default_provider);
    }
    if ("network_policy" in body && typeof body.network_policy === "string") {
      patch.networkPolicy = body.network_policy;
    }
    const updated = app.queries.updateProject(ctx.params.id!, patch);
    sendJson(res, 200, projectJson(updated));
  });

  router.delete("/api/projects/:id", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const archived = app.queries.archiveProject(ctx.params.id!);
    sendJson(res, 200, projectJson(archived));
  });

  // ---- eval store (canonical eval packages) ----

  router.get("/api/projects/:id/evals", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const includeArchived =
      ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    const categoryName = ctx.query.category_name;
    const list = app.queries
      .listTasks(projectId, { includeArchived })
      .filter((task) => !categoryName || task.categoryName === categoryName);
    sendJson(res, 200, {
      evals: list.map((task) =>
        taskJson(task, app.queries.listEvalQueuesUsingTask(projectId, task.id)
          .map((q) => ({ id: q.id, name: q.name }))),
      ),
    });
  });

  router.get("/api/projects/:id/eval-categories", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const counts = new Map<string, number>();
    for (const task of app.queries.listTasks(ctx.params.id!)) {
      if (!task.categoryName) continue;
      counts.set(task.categoryName, (counts.get(task.categoryName) ?? 0) + 1);
    }
    sendJson(res, 200, {
      categories: [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, evalCount]) => ({ name, eval_count: evalCount })),
    });
  });

  router.post("/api/projects/:id/evals", async (req, res, ctx) => {
    const app = appOf(ctx);
    const project = requireProject(app.queries, ctx.params.id!);
    const upload = await readJsonBody<EvalPackageUpload>(req, {
      limitBytes: 70 * 1024 * 1024,
    });
    try {
      const created = await createCanonicalEval(app, project, upload);
      sendJson(res, 201, taskJson(created));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/api/projects/:id/evals:import-archive", async (req, res, ctx) => {
    const app = appOf(ctx);
    const project = requireProject(app.queries, ctx.params.id!);
    const format = ctx.query.format as EvalArchiveFormat | undefined;
    if (!format || !["zip", "tar", "tar.gz"].includes(format)) {
      throw badRequest("format query parameter must be zip|tar|tar.gz");
    }
    const archive = await readBinaryBody(req, 64 * 1024 * 1024);
    const importId = randomUUID();
    const quarantineDir = join(app.dataDir, "projects", project.id, "eval-imports");
    const archivePath = join(quarantineDir, `${importId}.${format.replace(".", "-")}`);
    await mkdir(quarantineDir, { recursive: true });
    await writeFile(archivePath, archive);
    try {
      const decodedUpload = await decodeEvalArchiveFile(archivePath, format);
      const decoded = new Map<string, Buffer>();
      for (const [path, value] of Object.entries(decodedUpload.files)) {
        const encoded = typeof value === "string" ? { encoding: "utf8" as const, content: value } : value;
        decoded.set(path, Buffer.from(encoded.content, encoded.encoding === "base64" ? "base64" : "utf8"));
      }
      if (detectEvalLayout(decoded) === "suite") {
        const tasks = await createSuiteEvals(app, project, decoded);
        sendJson(res, 201, {
          count: tasks.length,
          tasks: tasks.map((t) => taskJson(t)),
        });
      } else {
        const created = await createSingleEvalFromFiles(app, project, decoded);
        sendJson(res, 201, taskJson(created));
      }
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    } finally {
      await rm(archivePath, { force: true });
    }
  });

  router.get("/api/projects/:id/evals/:evalId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const task = requireTask(app.queries, projectId, ctx.params.evalId!);
    sendJson(
      res,
      200,
      taskJson(task, app.queries.listEvalQueuesUsingTask(projectId, task.id)
        .map((q) => ({ id: q.id, name: q.name }))),
    );
  });

  router.patch("/api/projects/:id/evals/:evalId", (_req, _res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    requireTask(app.queries, ctx.params.id!, ctx.params.evalId!);
    throw conflict(
      "canonical eval packages are immutable; upload a complete new package version",
    );
  });

  router.delete("/api/projects/:id/evals/:evalId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const existing = requireTask(app.queries, projectId, ctx.params.evalId!);
    // Guard: refuse to archive an eval that a live queue still references. A
    // dangling queue item would otherwise fail at claim time ("references
    // unavailable eval") with no visibility here.
    const users = app.queries.listEvalQueuesUsingTask(projectId, existing.id);
    if (users.length > 0) {
      throw conflict(
        `eval ${existing.id} is referenced by queue(s): ${users.map((q) => q.name).join(", ")}`,
      );
    }
    sendJson(res, 200, taskJson(app.queries.archiveTask(existing.id)));
  });

  // ---- standalone eval-store namespace (lookup across projects) ----

  /** GET /api/evals — list evals across all projects (filterable). */
  router.get("/api/evals", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.query.project_id;
    const categoryName = ctx.query.category_name;
    const includeArchived =
      ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    const out: Record<string, unknown>[] = [];
    for (const project of app.queries.listProjects({ includeArchived })) {
      if (projectId && project.id !== projectId) continue;
      for (const task of app.queries.listTasks(project.id, { includeArchived })) {
        if (categoryName && task.categoryName !== categoryName) continue;
        out.push(taskJson(
          task,
          app.queries.listEvalQueuesUsingTask(project.id, task.id)
            .map((q) => ({ id: q.id, name: q.name })),
        ));
      }
    }
    sendJson(res, 200, { evals: out });
  });

  /** GET /api/evals/:evalId — one eval by global id (no project prefix). */
  router.get("/api/evals/:evalId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const task = app.queries.getTask(ctx.params.evalId!);
    if (!task) throw notFound("eval", ctx.params.evalId!);
    sendJson(
      res,
      200,
      taskJson(task, app.queries.listEvalQueuesUsingTask(task.projectId, task.id)
        .map((q) => ({ id: q.id, name: q.name }))),
    );
  });

  // ---- runs (read-only; execution is queue-scoped) ----

  router.get("/api/projects/:id/runs", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const list = app.queries.listRuns({ projectId: ctx.params.id! }).map(runJson);
    sendJson(res, 200, { runs: list });
  });

  // ---- run detail / events / diff / report ----

  router.get("/api/runs/:id", (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    assertResourceScope(req, app.queries, { runId: run.id });
    sendJson(res, 200, runJson(run));
  });

  router.get("/api/runs/:id/events", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    assertResourceScope(req, app.queries, { runId: run.id });
    // `since` is exclusive (last received seq). Default -1 so a first connect
    // with since=0 (common client convention for "from the start") still
    // includes seq 0 (run.start). readFromSeq yields seq > sinceSeq.
    // Mapping: omitted or "0" → -1 (full replay); "5" → 5 (resume after 5).
    let sinceSeq = -1;
    if (ctx.query.since !== undefined && ctx.query.since !== "") {
      const n = Number(ctx.query.since);
      if (Number.isFinite(n)) {
        // Treat since=0 as "from the beginning" (include seq 0).
        sinceSeq = n === 0 ? -1 : n;
      }
    }
    // Also accept Accept header preference.
    const accept = header(req, "accept") ?? "";
    const finalMode =
      ctx.query.stream === "ndjson"
        ? "ndjson"
        : accept.includes("ndjson")
          ? "ndjson"
          : "sse";
    await streamEvents(req, res, app, run, sinceSeq, finalMode);
  });

  router.get("/api/runs/:id/diff", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    assertResourceScope(req, app.queries, { runId: run.id });
    const path = resolveDiffPath(
      app.dataDir,
      run.projectId,
      run.id,
      run.diffPath,
    );
    if (!existsSync(path)) {
      throw notFound(`diff not available for run ${run.id}`);
    }
    const text = await readFile(path, "utf8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.end(text);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function apiTokenJson(t: {
  id: string;
  userId: string | null;
  projectId: string | null;
  tokenHash: string;
  label: string | null;
  readOnly: boolean;
  createdAt: string;
  revokedAt: string | null;
  token?: string;
}) {
  // NEVER include plaintext unless it was just minted (create response).
  const base = {
    id: t.id,
    user_id: t.userId,
    project_id: t.projectId,
    token_hash: t.tokenHash,
    label: t.label,
    read_only: t.readOnly,
    created_at: t.createdAt,
    revoked_at: t.revokedAt,
  };
  if (t.token !== undefined) {
    return { ...base, token: t.token };
  }
  return base;
}

/**
 * Token management routes. Always registered; when authEnabled the pre-dispatch
 * gate requires a valid (non-read-only for writes) Bearer. Bootstrap the first
 * token via `queries.createApiToken(...)` (seed) — there is no unauthenticated
 * mint path when auth is on.
 */
function registerTokenRoutes(router: Router): void {
  router.get("/api/tokens", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.query.project_id || ctx.query.projectId;
    const userId = ctx.query.user_id || ctx.query.userId;
    const list = app.queries.listApiTokens({
      ...(projectId ? { projectId } : {}),
      ...(userId ? { userId } : {}),
    });
    // Hashes only — never plaintext.
    sendJson(res, 200, { tokens: list.map((t) => apiTokenJson(t)) });
  });

  router.post("/api/tokens", async (req, res, ctx) => {
    const app = appOf(ctx);
    // Gate already rejects read-only tokens on POST when authEnabled.
    // When auth is off (local), anyone can mint (dev convenience).
    const auth = getRequestAuth(req);
    if (auth?.readOnly) {
      throw new HttpError(
        403,
        "Forbidden",
        "read-only token cannot perform write operations",
        { type: "https://agenteval.dev/errors/forbidden" },
      );
    }
    const body = await readJsonBody<{
      user_id?: string | null;
      userId?: string | null;
      project_id?: string | null;
      projectId?: string | null;
      label?: string | null;
      read_only?: boolean;
      readOnly?: boolean;
    }>(req);
    const created = app.queries.createApiToken({
      userId: body.user_id ?? body.userId ?? null,
      projectId: body.project_id ?? body.projectId ?? null,
      label: body.label ?? null,
      readOnly: body.read_only ?? body.readOnly ?? false,
    });
    // Plaintext returned ONCE.
    sendJson(res, 201, apiTokenJson(created));
  });

  router.delete("/api/tokens/:tokenHash", (req, res, ctx) => {
    const app = appOf(ctx);
    const auth = getRequestAuth(req);
    if (auth?.readOnly) {
      throw new HttpError(
        403,
        "Forbidden",
        "read-only token cannot perform write operations",
        { type: "https://agenteval.dev/errors/forbidden" },
      );
    }
    const tokenHash = ctx.params.tokenHash!;
    // Accept either the hash itself or (defensive) a mistaken plaintext —
    // if it looks like aev_*, hash it. Prefer hash-only clients.
    const hash =
      tokenHash.startsWith("aev_") && tokenHash.length > 10
        ? hashToken(tokenHash)
        : tokenHash;
    const existing = app.queries.getApiToken(hash);
    if (!existing) throw notFound(`token not found`);
    app.queries.revokeApiToken(hash);
    sendJson(res, 200, { revoked: true, token_hash: hash });
  });
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

/**
 * Bootstrap the REST API.
 *
 * ```ts
 * const api = createServer({ dataDir });
 * const port = await api.listen(0);
 * // ...
 * await api.close();
 * ```
 */
export function createServer(opts: CreateServerOptions): ApiServer {
  const open = opts.openDb ?? defaultOpenDb;
  const opened = opts.queries
    ? { queries: opts.queries, dataDir: opts.dataDir }
    : open(opts.dataDir);

  const liveQueueContainers = createLiveQueueContainersMap();
  const authEnabled = opts.authEnabled === true;

  // Build the production watcher seams: resolve SHA via the injected resolver or
  // GitHub client, detect an active generation, and launch a queue generation
  // pinned to an immutable commit override. When that generation closes, the
  // oldest pending watcher event for the queue is auto-launched next (FIFO),
  // continuing across generations with no intermediate commit dropped.
  const makeLauncher = (baseOpts?: StartQueueContainerOptions) => {
    return async (queueId: string, commit: string) => {
      const queue = opened.queries.getEvalQueue(queueId);
      if (!queue) return { launched: false as const };
      const project = opened.queries.getProject(queue.projectId);
      if (!project) return { launched: false as const };
      const startOpts: StartQueueContainerOptions = {
        ...(baseOpts ?? {}),
        agentCommitOverride: commit,
        onQueueDrained: async () => {
          // Generation closed: continue the FIFO with the oldest pending event
          // for this queue. If the launch fails, revert it to pending so it is
          // not dropped and can be retried on a later close.
          const next = opened.queries.nextPendingWatcherEvent(queueId);
          if (!next?.resolvedSha) return;
          opened.queries.markWatcherEventLaunching(next.id);
          const r = await makeLauncher(baseOpts)(queueId, next.resolvedSha).catch(async () => {
            opened.queries.markWatcherEventPending(next.id);
            return { launched: false as const };
          });
          if (r.launched && r.batchId) {
            opened.queries.markWatcherEventLaunched(next.id, r.batchId, next.resolvedSha!);
          } else {
            opened.queries.markWatcherEventPending(next.id);
          }
        },
      };
      const live = await startQueueContainer(
        app.dataDir,
        opened.queries,
        queueId,
        liveQueueContainers,
        startOpts,
      );
      return { launched: true as const, batchId: live.batchId };
    };
  };

  const watcherSeams: WatcherSeams =
    opts.watcherSeams ??
    {
      async resolveSha(repo, ref) {
        if (opts.refResolver) {
          const r = await opts.refResolver.resolveRef(repo, ref);
          return { sha: r.sha };
        }
        throw new Error("watcher SHA resolution not configured");
      },
      hasActiveGeneration(queueId: string) {
        return opened.queries.getActiveQueueContainer(queueId) != null;
      },
      launch: makeLauncher(opts.queueStartOpts
        ? { runtime: opts.queueStartOpts.runtime, timeoutMs: opts.queueStartOpts.timeoutMs }
        : undefined),
    };

  const app: AppCtx = {
    queries: opened.queries,
    dataDir: opts.dataDir,
    liveQueueContainers,
    idempotency: new IdempotencyStore(),
    authEnabled,
    watcherSeams,
    ...(opts.githubClient ? { githubClient: opts.githubClient } : {}),
  };
  if (opts.queueStartOpts) app.queueStartOpts = opts.queueStartOpts;

  const router = new Router();
  registerRoutes(router);
  // Watcher rules + webhook ingress (P8b) — modular mount.
  registerWatcherRoutes(router);
  registerAdapterRoutes(router);
  registerQueueRoutes(router);
  // Settings + password auth + project export (P9).
  registerSettingsRoutes(router);
  registerArchiveRoutes(router);
  registerSandboxRoutes(router);
  registerGitHubRoutes(router);

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const method = (req.method ?? "GET").toUpperCase();
        const url = req.url ?? "/";
        const qIdx = url.indexOf("?");
        const path = qIdx === -1 ? url : url.slice(0, qIdx);

        // Pre-dispatch auth gate. When authEnabled is false (default), this is a
        // no-op — existing unauthenticated tests + local API clients keep working.
        // When true, every /api/* route (except GET /api/health) requires a
        // valid Bearer token; read-only tokens cannot write; project-scoped
        // tokens must match the path project.
        const allowed = await gateRequest({
          authEnabled: app.authEnabled,
          queries: app.queries,
          req,
          res,
          method,
          path,
        });
        if (!allowed) return;

        await router.handle(req, res, app);
      } catch (err) {
        handleError(res, err);
      }
    })();
  });

  return {
    server,
    queries: app.queries,
    liveQueueContainers,
    app,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const addr = server.address();
          if (addr && typeof addr === "object") {
            resolve(addr.port);
          } else {
            reject(new Error("failed to bind server"));
          }
        });
      });
    },
    async close() {
      for (const live of [...liveQueueContainers.values()]) {
        await live.stop().catch(() => undefined);
      }
      liveQueueContainers.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Re-exports for consumers / tests.
export {
  createLiveQueueContainersMap,
  startQueueContainer,
} from "../runner/queue-worker.js";
export type {
  LiveQueueContainer,
  LiveQueueContainersMap,
  StartQueueContainerOptions,
} from "../runner/queue-worker.js";

/**
 * REST API server — project/task/run CRUD + run control + SSE events.
 *
 * Bootstraps a tiny zero-dep router with a shared AppCtx. Routes follow
 * plan/api.md (project-scoped). Auth is optional via CreateServerOptions.authEnabled
 * (default false for local-dev + existing tests; see src/api/auth.ts).
 *
 * Runs execute in real Podman containers through run-controller-bridge.ts.
 * The configurable concurrency cap controls how many run containers are live.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, watch as fsWatch } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDb as defaultOpenDb, resolveProjectDir, type OpenDbResult } from "../db/index.js";
import {
  judgementDir,
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
import { Router, readJsonBody, sendJson, type RequestContext } from "./router.js";
import {
  badRequest,
  conflict,
  handleError,
  HttpError,
  notFound,
} from "./errors.js";
import {
  abortRun,
  createLiveRunsMap,
  isTerminalStatus,
  pauseRun,
  resolveDiffPath,
  resolveEventsPath,
  resumeRun,
  runDirPath,
  setNetwork,
  startRun,
  type LiveRunsMap,
  type StartRunOptions,
} from "./run-controller-bridge.js";
import {
  registerJudgementRoutes,
  sanitizeFilenamePart,
  serveHtmlFile,
  type JudgeRunner,
} from "./judgements-routes.js";
import { registerFindingsRoutes } from "./findings-routes.js";
import { registerRegressionRoutes } from "./regression-routes.js";
import { registerWatcherRoutes } from "./watcher-routes.js";
import { registerQueueRoutes } from "./queue-routes.js";
import { registerAdapterRoutes } from "./adapter-routes.js";
import { registerWebhooksRoutes } from "./webhooks-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerRubricRoutes } from "./rubric-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerSandboxRoutes } from "./sandbox-routes.js";
import { registerReleaseRoutes } from "./release-routes.js";
import { registerCommitEvalRoutes } from "./commit-eval-routes.js";
import { registerGitHubRoutes } from "./github-routes.js";
import { registerImprovementRoutes } from "./improvement-routes.js";
import {
  createLiveQueueContainersMap,
  type LiveQueueContainersMap,
  type StartQueueContainerOptions,
} from "../runner/queue-worker.js";
import type { GitHubClient } from "./github.js";
import { handleRunFinalized, type AutoJudgeDeps } from "./auto-judge.js";
import { createBatchClaimStore } from "../judge/batch-completion.js";
import { judgeRun } from "../judge/worker.js";
import {
  OutboundWebhookDispatcher,
  RealDeliverySink,
  type DeliverySink,
} from "./webhooks/outbound.js";
import type { RefResolver } from "../watcher/engine.js";
import {
  gateRequest,
  getRequestAuth,
  hashToken,
} from "./auth.js";
import {
  IdempotencyStore,
  type IdempotencyEntry,
  withIdempotency,
} from "./middleware.js";

// ---------------------------------------------------------------------------
// App context
// ---------------------------------------------------------------------------

/** Stub RefResolver used when createServer is not given a real/fake resolver. */
function defaultRefResolver(): RefResolver {
  return {
    async resolveRef() {
      throw new Error("ref resolution not configured");
    },
  };
}

export interface AppCtx {
  queries: DbQueries;
  dataDir: string;
  liveRuns: LiveRunsMap;
  /** Queue-id keyed persistent queue containers. */
  liveQueueContainers: LiveQueueContainersMap;
  /** Queue worker options forwarded by the API lifecycle routes. */
  queueStartOpts?: StartQueueContainerOptions;
  /** Max concurrent live runs (P3 = 1). */
  concurrency: number;
  /**
   * In-memory Idempotency-Key → response body.
   * Backed by {@link IdempotencyStore} (LRU + TTL); Map-compatible surface.
   */
  idempotency: {
    has(key: string): boolean;
    get(key: string): IdempotencyEntry | undefined;
    set(key: string, value: IdempotencyEntry): unknown;
  };
  /** FIFO of run ids waiting for a slot (concurrency). */
  startQueue: string[];
  /** Currently starting/running count. */
  activeStarts: number;
  /** Extra startRun options forwarded from createServer. */
  startOpts?: Omit<StartRunOptions, "adapter">;
  /** Real PI SDK judge runner used by judgement APIs and auto-judge. */
  judgeRunner: JudgeRunner;
  /** Defaults for create-judgement when the request omits them. */
  defaultSystemPromptVersion?: string;
  defaultJudgeModel?: string;
  defaultJudgeProvider?: string;
  /**
   * When true, every /api/* route (except GET /api/health) requires a valid
   * Bearer token. Default false so local-dev + the existing unauthenticated
   * test suite keep working (loopback UI server-side fetch included).
   */
  authEnabled: boolean;
  /**
   * Resolve a git ref → sha (+ optional imageTag) for watcher manual fire /
   * webhook ingress. Tests inject a fake; production wires git ls-remote.
   * Defaults to a stub that throws "ref resolution not configured".
   */
  refResolver: RefResolver;
  /**
   * Enqueue a run into the concurrency-limited start pipeline.
   * Used by queue promote so created runs actually begin.
   */
  enqueueStart: (runId: string) => void | Promise<void>;
  /**
   * Outbound webhook dispatcher (P8c). Undefined when outbound webhooks are
   * explicitly disabled; otherwise a RealDeliverySink-backed dispatcher.
   * Emit sites no-op cleanly when this is undefined.
   */
  outboundWebhooks?: OutboundWebhookDispatcher;
  /**
   * Single-winner claims over batch ids, so N runs finishing concurrently
   * produce exactly one release rollup.
   */
  batchClaims: ReturnType<typeof createBatchClaimStore>;
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
  /** Concurrency cap for starting runs (default 1 for P3). */
  concurrency?: number;
  /** Extra startRun options (timeout, skipAgent, …). */
  startOpts?: Omit<StartRunOptions, "adapter">;
  /** Options for persistent queue-container execution. */
  queueStartOpts?: StartQueueContainerOptions;
  defaultSystemPromptVersion?: string;
  defaultJudgeModel?: string;
  defaultJudgeProvider?: string;
  /**
   * On startup, reconcile queued/running analyses orphaned by a prior process
   * (crash/deploy that killed an in-flight judge) by marking them failed.
   * Default true. Test harnesses that host a long-lived judge in-process and
   * restart the server mid-run may disable this to avoid clobbering it.
   */
  reconcileOrphans?: boolean;
  /**
   * Gate /api/* behind Bearer tokens. Default **false** (local-dev path):
   * existing tests that hit routes unauthenticated MUST keep working.
   * When true, require a valid non-revoked token except GET /api/health.
   * See src/api/auth.ts for the loopback/default-off contract.
   */
  authEnabled?: boolean;
  /**
   * Optional ref resolver for watcher routes. Tests inject a fake.
   * Defaults to a stub that throws "ref resolution not configured".
   */
  refResolver?: RefResolver;
  /**
   * Optional outbound webhook dispatcher (P8c). When omitted, createServer
   * builds a default RealDeliverySink-backed dispatcher. Tests pass a
   * dispatcher pointed at a real local HTTP server. Pass `null` to disable
   * outbound webhooks entirely (hooks no-op).
   */
  outboundDispatcher?: OutboundWebhookDispatcher | null;
  /**
   * Optional delivery sink used when building the default dispatcher.
   * Prefer `outboundDispatcher` for full control; this is a lighter seam.
   */
  outboundSink?: DeliverySink;
  /** Override default backoff (ms) for the built-in dispatcher. */
  outboundBackoffMs?: number[];
  /**
   * Read-only GitHub client. Inject a stubbed transport in tests so browsing
   * live repo state never depends on the network.
   */
  githubClient?: GitHubClient;
}

export interface ApiServer {
  server: Server;
  queries: DbQueries;
  liveRuns: LiveRunsMap;
  liveQueueContainers: LiveQueueContainersMap;
  app: AppCtx;
  /** Listen on an ephemeral port (or given port). Resolves with the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  /** Close the HTTP server and best-effort abort live runs. */
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
    default_judge_model: p.defaultJudgeModel,
    workspace_image: p.workspaceImage,
    check_runners: p.checkRunners,
    adapter_overrides: p.adapterOverrides,
    network_policy: p.networkPolicy,
    retention_runs: p.retentionRuns,
    artifact_retention: p.artifactRetention,
    sandbox: p.sandbox,
    archived: p.archived,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function taskJson(t: Task) {
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
    events_path: r.eventsPath,
    diff_path: r.diffPath,
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

function assertNotTerminal(run: Run): void {
  if (isTerminalStatus(run.status)) {
    throw conflict(`run ${run.id} is terminal (${run.status})`);
  }
}

// ---------------------------------------------------------------------------
// Sequential start queue (concurrency cap)
// ---------------------------------------------------------------------------

/** Build the real PI SDK runner used by the single-run judgement API. */
function createRealJudgeRunner(): JudgeRunner {
  return async (ctx) => {
    const run = ctx.queries.getRun(ctx.runId);
    if (!run) throw new Error(`run not found: ${ctx.runId}`);
    const task = ctx.queries.getTask(run.taskId);
    if (!task) throw new Error(`eval not found: ${run.taskId}`);
    const runDir = runDirPath(ctx.dataDir, ctx.projectId, ctx.runId);
    const hasSourceArtifacts =
      existsSync(join(runDir, "diff.patch")) ||
      existsSync(join(runDir, "outputs-manifest.json"));
    const result = await judgeRun({
      runDir,
      task: {
        prompt: task.prompt,
        rubric: ctx.body.rubric ?? task.rubric,
        agentCategory: task.agentCategory,
        ...(task.referenceSolution
          ? { referenceSolution: task.referenceSolution }
          : {}),
      },
      judgeModel: ctx.judgeModel,
      judgeProvider: ctx.judgeProvider,
      hasSourceArtifacts,
      ...(ctx.judgePrompt ? { judgePrompt: ctx.judgePrompt } : {}),
      judgementId: ctx.judgementId,
      projectId: ctx.projectId,
      dataDir: ctx.dataDir,
    });
    if (result.status !== "completed" || !result.verdict) {
      throw new Error(result.error ?? "PI judge did not produce a completed verdict");
    }
    ctx.queries.storeVerdict(ctx.judgementId, result.verdict);
  };
}

/** Collect the auto-judge coordinator's dependencies from the app context. */
function autoJudgeDeps(app: AppCtx): AutoJudgeDeps {
  return {
    queries: app.queries,
    dataDir: app.dataDir,
    claims: app.batchClaims,
    ...(app.judgeRunner ? { judgeRunner: app.judgeRunner } : {}),
    ...(app.defaultJudgeModel ? { defaultJudgeModel: app.defaultJudgeModel } : {}),
    ...(app.defaultJudgeProvider
      ? { defaultJudgeProvider: app.defaultJudgeProvider }
      : {}),
    ...(app.defaultSystemPromptVersion
      ? { defaultSystemPromptVersion: app.defaultSystemPromptVersion }
      : {}),
  };
}

async function enqueueStart(app: AppCtx, runId: string): Promise<void> {
  app.startQueue.push(runId);
  void drainStartQueue(app);
}

/**
 * Emit run.completed exactly once after a run reaches a terminal status.
 * No-ops when outbound webhooks are not configured.
 */
function emitRunCompleted(app: AppCtx, runId: string): void {
  if (!app.outboundWebhooks) return;
  const run = app.queries.getRun(runId);
  if (!run || !isTerminalStatus(run.status)) return;
  void app.outboundWebhooks.dispatchEvent({
    type: "run.completed",
    projectId: run.projectId,
    resourceId: runId,
    data: {
      status: run.status,
      endedAt: run.endedAt,
    },
    timestamp: run.endedAt ?? new Date().toISOString(),
  });
}

async function drainStartQueue(app: AppCtx): Promise<void> {
  while (app.activeStarts < app.concurrency && app.startQueue.length > 0) {
    const runId = app.startQueue.shift()!;
    // Skip if already live or terminal.
    const run = app.queries.getRun(runId);
    if (!run || isTerminalStatus(run.status) || app.liveRuns.has(runId)) {
      continue;
    }
    app.activeStarts += 1;
    try {
      const live = await startRun(app.dataDir, app.queries, runId, app.liveRuns, {
        ...(app.startOpts ?? {}),
        // Thread outbound dispatcher into the runner so run.completed fires
        // exactly once at terminal finalization (not on status polls).
        ...(app.outboundWebhooks
          ? { outboundWebhooks: app.outboundWebhooks }
          : {}),
        // Auto-judge each run, then roll up the release when its batch is done.
        onRunFinalized: (info) =>
          handleRunFinalized(autoJudgeDeps(app), info),
      });
      // When the run finishes, free a slot and drain more.
      void live.done.finally(() => {
        // Safety-net emit: if the runner path already emitted, the dispatcher
        // will fan-out again only if called — the runner is the primary site.
        // We do NOT re-emit here to keep exactly-once; the runner hook owns it.
        app.activeStarts = Math.max(0, app.activeStarts - 1);
        void drainStartQueue(app);
      });
    } catch (err) {
      app.activeStarts = Math.max(0, app.activeStarts - 1);
      try {
        app.queries.finalizeRun(runId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          controlState: "done",
        });
        // Terminal via start-failure path — emit once here (runner never started).
        emitRunCompleted(app, runId);
      } catch {
        // best-effort
      }
      void drainStartQueue(app);
    }
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
  const live = app.liveRuns.get(run.id);
  if (
    (fresh && isTerminalStatus(fresh.status) && !live) ||
    (live?.finished)
  ) {
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
      const lr = app.liveRuns.get(run.id);
      const terminal =
        (r && isTerminalStatus(r.status) && (!lr || lr.finished)) ||
        (lr?.finished ?? false);

      // Also stop when we see a run.end in the stream.
      // (lastSeq advanced above)

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

function registerRoutes(router: Router, startOpts: CreateServerOptions["startOpts"]): void {
  // Stash startOpts on a closure via app.startOpts (set at create time).
  void startOpts;

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
      artifact_retention?: string;
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
      artifactRetention: body.artifact_retention,
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
    if (
      "artifact_retention" in body &&
      typeof body.artifact_retention === "string"
    ) {
      patch.artifactRetention = body.artifact_retention;
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

  // ---- tasks ----

  router.get("/api/projects/:id/tasks", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const includeArchived =
      ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    const categoryName = ctx.query.category_name;
    const list = app.queries
      .listTasks(ctx.params.id!, { includeArchived })
      .filter((task) => !categoryName || task.categoryName === categoryName)
      .map(taskJson);
    sendJson(res, 200, { tasks: list });
  });

  router.post("/api/projects/:id/tasks", (_req, _res, _ctx) => {
    throw badRequest(
      "flat task creation is not supported; create a canonical eval package through POST /api/projects/:id/evals",
    );
  });

  router.get("/api/projects/:id/tasks/:taskId", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const task = requireTask(app.queries, ctx.params.id!, ctx.params.taskId!);
    sendJson(res, 200, taskJson(task));
  });

  router.patch("/api/projects/:id/tasks/:taskId", (_req, _res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    requireTask(app.queries, ctx.params.id!, ctx.params.taskId!);
    throw conflict(
      "canonical eval packages are immutable; upload a complete new package version instead of patching fields",
    );
  });

  router.delete("/api/projects/:id/tasks/:taskId", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    requireTask(app.queries, ctx.params.id!, ctx.params.taskId!);
    const archived = app.queries.archiveTask(ctx.params.taskId!);
    sendJson(res, 200, taskJson(archived));
  });

  // ---- eval definitions (preferred aliases for task CRUD) ----

  router.get("/api/projects/:id/evals", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const includeArchived =
      ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    sendJson(res, 200, {
      evals: app.queries
        .listTasks(ctx.params.id!, { includeArchived })
        .filter((task) => !ctx.query.category_name || task.categoryName === ctx.query.category_name)
        .map(taskJson),
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
          tasks: tasks.map(taskJson),
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
    requireProject(app.queries, ctx.params.id!);
    sendJson(
      res,
      200,
      taskJson(requireTask(app.queries, ctx.params.id!, ctx.params.evalId!)),
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
    requireProject(app.queries, ctx.params.id!);
    const existing = requireTask(app.queries, ctx.params.id!, ctx.params.evalId!);
    sendJson(res, 200, taskJson(app.queries.archiveTask(existing.id)));
  });

  router.post("/api/projects/:id/tasks/sync", (_req, _res, _ctx) => {
    throw badRequest("legacy task-source sync is disabled; import canonical eval packages instead");
  });

  router.post("/api/projects/:id/tasks:push", (_req, _res, _ctx) => {
    throw badRequest("flat HTTP-push tasks are disabled; import a canonical eval package instead");
  });

  // ---- runs (create under project) ----

  router.post(
    "/api/projects/:id/runs",
    withIdempotency(async (req, res, ctx) => {
      const app = appOf(ctx);
      const project = requireProject(app.queries, ctx.params.id!);

      const body = await readJsonBody<{
        taskId?: string;
        task_id?: string;
        taskTags?: string[];
        task_tags?: string[];
        agent?: string;
        agentId?: string;
        agent_id?: string;
        model?: string;
        provider?: string;
        repeats?: number;
        params?: Record<string, unknown>;
        adapterOverrides?: Record<string, unknown>;
        adapter_overrides?: Record<string, unknown>;
        autoJudge?: boolean;
        trigger?: string;
        trigger_ref?: string;
      }>(req);

    const taskId = body.taskId ?? body.task_id;
    const taskTags = body.taskTags ?? body.task_tags ?? [];
    let task: Task | null = null;

    if (taskId) {
      task = requireTask(app.queries, project.id, taskId);
    } else if (taskTags.length > 0) {
      const all = app.queries.listTasks(project.id);
      task =
        all.find(
          (t) => t.tags && taskTags.every((tag) => t.tags!.includes(tag)),
        ) ?? null;
      if (!task) throw notFound(`no task matching tags: ${taskTags.join(",")}`);
    } else {
      throw badRequest("taskId (or taskTags) is required");
    }

    const configuredAdapter = app.queries.listProjectAgentAdapters(project.id, {
      includeDisabled: true,
    })[0];
    const agentId = configuredAdapter?.agentId ?? project.defaultAgentId;
    const requestedAgent = body.agent ?? body.agentId ?? body.agent_id;
    if (requestedAgent && requestedAgent !== agentId) {
      throw badRequest("runs must use the project's configured agent");
    }
    const model = body.model ?? project.defaultModel;
    const provider = body.provider ?? project.defaultProvider;
    if (!agentId || !model || !provider) {
      throw badRequest("configure the project agent adapter, model, and provider first");
    }
    const repeats = Math.max(1, Math.min(100, Number(body.repeats ?? 1) || 1));

    // Per-run adapter overrides (image pin, env, tool allowlist). Previously
    // accepted and dropped; the image pin is recorded on the batch so every run
    // in it launches from the requested image.
    const runOverrides = body.adapterOverrides ?? body.adapter_overrides;
    const pinnedImage =
      runOverrides && typeof runOverrides.image === "string"
        ? runOverrides.image
        : runOverrides && typeof runOverrides.imageTag === "string"
          ? runOverrides.imageTag
          : undefined;

    const batch = app.queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId,
      model,
      provider,
      params: body.params ?? {},
      repeats,
      trigger: body.trigger,
      triggerRef: body.trigger_ref,
      ...(pinnedImage ? { agentImage: pinnedImage } : {}),
    });

    const runs: Run[] = [];
    for (let i = 0; i < repeats; i++) {
      const r = app.queries.createRun({
        batchId: batch.id,
        taskId: task.id,
        projectId: project.id,
        agentId,
        model,
        provider,
        repeatIndex: i,
        status: "queued",
        controlState: "running",
        startedAt: new Date().toISOString(),
        trigger: body.trigger,
        triggerRef: body.trigger_ref,
        ...(pinnedImage
          ? { agentImage: pinnedImage, agentImageSource: "run_override" }
          : {}),
        // Store the WHOLE override blob, not just the image: env (proxy /
        // gateway endpoints), params, and allowedTools are equally per-run.
        ...(runOverrides ? { adapterOverrides: runOverrides } : {}),
      });
      runs.push(r);
    }

    // Start the first run (concurrency 1 → sequential via queue).
    for (const r of runs) {
      void enqueueStart(app, r.id);
    }

    const bodyOut = {
      batch_id: batch.id,
      run_ids: runs.map((r) => r.id),
      runs: runs.map(runJson),
      status: "accepted",
    };
    const headers = {
      Location: `/api/runs/${runs[0]!.id}`,
    };

    // Idempotency capture is handled by the withIdempotency wrapper around this
    // handler (method+path scoped, TOCTOU-safe via store.reserve). The inline
    // per-key cache was removed: it keyed on the raw header alone (cross-route
    // collision risk) and used check-then-act (concurrent double-execute).
    sendJson(res, 202, bodyOut, headers);
    }),
  );

  router.get("/api/projects/:id/runs", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    const list = app.queries.listRuns({ projectId: ctx.params.id! }).map(runJson);
    sendJson(res, 200, { runs: list });
  });

  // ---- run detail / events / diff / report ----

  router.get("/api/runs/:id", (_req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    sendJson(res, 200, runJson(run));
  });

  router.get("/api/runs/:id/events", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
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

  router.get("/api/runs/:id/diff", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
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

  // GET /api/runs/:id/report — serve report.html from the latest completed judgement (P5b)
  router.get("/api/runs/:id/report", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    const list = app.queries.listJudgements({ runId: run.id });
    // Prefer status=completed with a verdictPath; newest first by endedAt||createdAt.
    const candidates = list.judgements
      .filter((j) => j.status === "completed" && j.verdictPath)
      .slice();
    candidates.sort((a, b) => {
      const ta = a.endedAt ?? a.createdAt ?? "";
      const tb = b.endedAt ?? b.createdAt ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return b.id.localeCompare(a.id);
    });
    const j = candidates[0];
    if (!j) {
      throw notFound(`report not available for run ${run.id}`);
    }
    const p = join(judgementDir(app.dataDir, j.projectId, j.id), "report.html");
    if (!existsSync(p)) {
      throw notFound(`report not available for run ${run.id}`);
    }
    const download =
      ctx.query.download === "1" || ctx.query.download === "true";
    await serveHtmlFile(res, p, {
      download,
      filename: `report-${sanitizeFilenamePart(run.id)}.html`,
    });
  });

  // ---- run control ----

  router.post("/api/runs/:id/pause", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    assertNotTerminal(run);
    const mode =
      (ctx.query.mode === "hard" ? "hard" : "soft") as "soft" | "hard";
    try {
      const updated = await pauseRun(run.id, mode, app.queries, app.liveRuns);
      sendJson(res, 200, runJson(updated));
    } catch (err) {
      mapControlError(err);
    }
  });

  router.post("/api/runs/:id/resume", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    assertNotTerminal(run);
    try {
      const updated = await resumeRun(run.id, app.queries, app.liveRuns);
      sendJson(res, 200, runJson(updated));
    } catch (err) {
      mapControlError(err);
    }
  });

  router.post("/api/runs/:id/abort", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    assertNotTerminal(run);
    try {
      const updated = await abortRun(
        run.id,
        app.queries,
        app.liveRuns,
        app.outboundWebhooks,
      );
      sendJson(res, 200, runJson(updated));
    } catch (err) {
      mapControlError(err);
    }
  });

  router.post("/api/runs/:id/control", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    const body = await readJsonBody<{
      action?: string;
      enabled?: boolean;
      mode?: string;
      value?: unknown;
    }>(req);

    const action = body.action;
    if (!action) throw badRequest("action is required");

    if (action === "network") {
      if (typeof body.enabled !== "boolean") {
        throw badRequest("enabled (boolean) is required for action=network");
      }
      // Network toggle is allowed even if terminal? Spec says live control —
      // only while live. But tests expect 200 after start. If not live yet,
      // create a stub or return 409.
      try {
        const result = setNetwork(run.id, body.enabled, app.liveRuns);
        sendJson(res, 200, result);
      } catch (err) {
        // If run is queued and not yet live, wait briefly for start.
        if (
          err &&
          typeof err === "object" &&
          (err as { code?: string }).code === "NOT_LIVE"
        ) {
          // Brief wait for the start queue.
          const ok = await waitForLive(app, run.id, 5_000);
          if (!ok) {
            throw conflict(`run ${run.id} is not live yet`);
          }
          const result = setNetwork(run.id, body.enabled, app.liveRuns);
          sendJson(res, 200, result);
          return;
        }
        mapControlError(err);
      }
      return;
    }

    assertNotTerminal(run);

    if (action === "pause") {
      const mode = body.mode === "hard" ? "hard" : "soft";
      const updated = await pauseRun(run.id, mode, app.queries, app.liveRuns);
      sendJson(res, 200, runJson(updated));
      return;
    }
    if (action === "resume") {
      const updated = await resumeRun(run.id, app.queries, app.liveRuns);
      sendJson(res, 200, runJson(updated));
      return;
    }
    if (action === "abort") {
      const updated = await abortRun(
        run.id,
        app.queries,
        app.liveRuns,
        app.outboundWebhooks,
      );
      sendJson(res, 200, runJson(updated));
      return;
    }

    throw badRequest(`unknown action: ${action}`);
  });
}

function mapControlError(err: unknown): never {
  if (err && typeof err === "object" && (err as { code?: string }).code === "TERMINAL") {
    throw conflict(err instanceof Error ? err.message : "run is terminal");
  }
  if (err instanceof HttpError) throw err;
  throw err;
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
 * token via `queries.createApiToken(...)` (CLI/seed) — there is no unauthenticated
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

async function waitForLive(
  app: AppCtx,
  runId: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (app.liveRuns.has(runId)) return true;
    const r = app.queries.getRun(runId);
    if (r && isTerminalStatus(r.status)) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return app.liveRuns.has(runId);
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

  const liveRuns = createLiveRunsMap();
  const liveQueueContainers = createLiveQueueContainersMap();
  const authEnabled = opts.authEnabled === true;

  // Reconcile analyses orphaned by a prior process (a crash, deploy, or OOM
  // that killed an in-flight judge mid-run). Any queued/running analysis left
  // over can no longer be completed — its worker is gone — so mark it failed
  // rather than leaving a permanent "running" zombie. This is the prod-grade
  // guard so a judge death never silently wedges a queue report forever.
  const orphanSweep = (): void => {
    for (const row of opened.queries.listOrphanedAnalyses()) {
      opened.queries.updateQueueAnalysis(row.id, {
        status: "failed",
        error: `judge worker interrupted before completion (reconciled at server startup); prior status: ${row.status}`,
      });
    }
  };
  if (opts.reconcileOrphans !== false) orphanSweep();

  // Outbound webhooks (P8c): default RealDeliverySink dispatcher unless
  // explicitly disabled (null) or a pre-built dispatcher is injected.
  let outboundWebhooks: OutboundWebhookDispatcher | undefined;
  if (opts.outboundDispatcher === null) {
    outboundWebhooks = undefined;
  } else if (opts.outboundDispatcher) {
    outboundWebhooks = opts.outboundDispatcher;
  } else {
    outboundWebhooks = new OutboundWebhookDispatcher({
      queries: opened.queries,
      sink: opts.outboundSink ?? new RealDeliverySink(),
      ...(opts.outboundBackoffMs ? { backoffMs: opts.outboundBackoffMs } : {}),
    });
  }

  const app: AppCtx = {
    queries: opened.queries,
    dataDir: opts.dataDir,
    liveRuns,
    liveQueueContainers,
    concurrency: opts.concurrency ?? 1,
    // LRU + TTL store; still Map-compatible for the inline run/judgement caches.
    idempotency: new IdempotencyStore(),
    startQueue: [],
    activeStarts: 0,
    authEnabled,
    refResolver: opts.refResolver ?? defaultRefResolver(),
    // Bound below after app is constructed so the closure sees the final object.
    enqueueStart: () => undefined,
    batchClaims: createBatchClaimStore(),
    judgeRunner: createRealJudgeRunner(),
    ...(opts.githubClient ? { githubClient: opts.githubClient } : {}),
  };
  // Wire the real start-pipeline seam (concurrency-limited).
  app.enqueueStart = (runId: string) => enqueueStart(app, runId);
  app.startOpts = opts.startOpts;
  if (opts.queueStartOpts) app.queueStartOpts = opts.queueStartOpts;
  if (outboundWebhooks) app.outboundWebhooks = outboundWebhooks;
  if (opts.defaultSystemPromptVersion) {
    app.defaultSystemPromptVersion = opts.defaultSystemPromptVersion;
  }
  if (opts.defaultJudgeModel) app.defaultJudgeModel = opts.defaultJudgeModel;
  if (opts.defaultJudgeProvider) {
    app.defaultJudgeProvider = opts.defaultJudgeProvider;
  }

  const router = new Router();
  registerRoutes(router, opts.startOpts);
  // Judgement routes (P4c) — modular mount so this file stays focused on runs.
  registerJudgementRoutes(router);
  // Findings / issues-log routes (P6b) — list + lifecycle detail + k/N.
  registerFindingsRoutes(router);
  // Regression views (P7b) — trend + two-run compare + release compare.
  registerRegressionRoutes(router);
  // Watcher rules + webhook ingress (P8b) — modular mount.
  registerWatcherRoutes(router);
  registerAdapterRoutes(router);
  registerQueueRoutes(router);
  // Outbound webhook subscriptions (P8c) — CRUD + deliveries + test fire.
  registerWebhooksRoutes(router);
  // Settings + password auth + project export (P9).
  registerSettingsRoutes(router);
  // Project-scoped reusable rubrics — CRUD.
  registerRubricRoutes(router);
  registerArtifactRoutes(router);
  registerSandboxRoutes(router);
  registerReleaseRoutes(router);
  registerCommitEvalRoutes(router);
  registerGitHubRoutes(router);
  registerImprovementRoutes(router);

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const method = (req.method ?? "GET").toUpperCase();
        const url = req.url ?? "/";
        const qIdx = url.indexOf("?");
        const path = qIdx === -1 ? url : url.slice(0, qIdx);

        // Pre-dispatch auth gate. When authEnabled is false (default), this is a
        // no-op — existing unauthenticated tests + local UI keep working.
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
    liveRuns,
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
      // Best-effort abort of live runs so tests don't hang.
      for (const [id, live] of [...liveRuns.entries()]) {
        try {
          if (!live.finished) {
            await live.controller.abort().catch(() => undefined);
            await live.handle.remove().catch(() => undefined);
          }
        } catch {
          // ignore
        }
        liveRuns.delete(id);
      }
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
  createLiveRunsMap,
  isTerminalStatus,
  startRun,
  pauseRun,
  resumeRun,
  abortRun,
  setNetwork,
};
export type { LiveRun, LiveRunsMap, StartRunOptions } from "./run-controller-bridge.js";
export {
  createLiveQueueContainersMap,
  startQueueContainer,
} from "../runner/queue-worker.js";
export type {
  LiveQueueContainer,
  LiveQueueContainersMap,
  StartQueueContainerOptions,
} from "../runner/queue-worker.js";
export {
  OutboundWebhookDispatcher,
  RealDeliverySink,
  signPayload,
  buildEventPayload,
  dispatch,
} from "./webhooks/outbound.js";
export type {
  DeliverySink,
  OutboundEvent,
  DispatchOpts,
} from "./webhooks/outbound.js";

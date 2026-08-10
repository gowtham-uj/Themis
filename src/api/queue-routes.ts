/** Persistent eval-queue, queue-container, introspection, and archive routes. */

import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CreateEvalQueueInput,
  CreateEvalQueueItemInput,
  DbQueries,
  EvalQueue,
  EvalQueueItem,
  Project,
  QueueAnalysis,
  UpdateEvalQueueInput,
  UpdateEvalQueueItemInput,
} from "../db/queries.js";
import { runQueueAnalysis } from "../judge/queue-worker.js";
import { verifyEvalArchive } from "../runner/eval-archive.js";
import { parsePorts } from "../runner/project-config.js";
import {
  startQueueContainer,
  type LiveQueueContainer,
  type LiveQueueContainersMap,
  type StartQueueContainerOptions,
} from "../runner/queue-worker.js";
import { getRequestAuth, isLoopbackAddress } from "./auth.js";
import { badRequest, conflict, HttpError, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;

export interface QueueAppCtx {
  queries: DbQueries;
  dataDir: string;
  liveQueueContainers: LiveQueueContainersMap;
  queueStartOpts?: StartQueueContainerOptions;
  authEnabled: boolean;
}

interface ExecBody {
  command?: string;
  cwd?: string;
  env?: Record<string, unknown>;
  timeout_ms?: number;
  timeoutMs?: number;
  max_output_bytes?: number;
  maxOutputBytes?: number;
}

function appOf(ctx: RequestContext): QueueAppCtx {
  return ctx.app as QueueAppCtx;
}

function requireProject(queries: DbQueries, id: string): Project {
  const project = queries.getProject(id);
  if (!project || project.archived) throw notFound(`project not found: ${id}`);
  return project;
}

function requireQueue(
  queries: DbQueries,
  projectId: string,
  queueId: string,
): EvalQueue {
  const queue = queries.getEvalQueue(queueId);
  if (!queue || queue.projectId !== projectId) {
    throw notFound(`eval queue not found: ${queueId}`);
  }
  return queue;
}

function requireQueueAnalysis(
  queries: DbQueries,
  queue: EvalQueue,
  analysisId: string,
): QueueAnalysis {
  const analysis = queries.getQueueAnalysis(analysisId);
  if (!analysis || analysis.queueId !== queue.id) {
    throw notFound(`queue analysis not found: ${analysisId}`);
  }
  return analysis;
}

function requireItem(
  queries: DbQueries,
  queue: EvalQueue,
  itemId: string,
): EvalQueueItem {
  const item = queries.getEvalQueueItem(itemId);
  if (!item || item.queueId !== queue.id || item.projectId !== queue.projectId) {
    throw notFound(`queue item not found: ${itemId}`);
  }
  return item;
}

function requireLiveQueue(
  app: QueueAppCtx,
  queue: EvalQueue,
): LiveQueueContainer {
  const live = app.liveQueueContainers.get(queue.id);
  if (!live || live.finished || !live.acceptingExec) {
    throw conflict(`queue ${queue.id} has no live container`);
  }
  return live;
}

function objectOrNull(value: unknown, name: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object or null`);
  }
  return value as Record<string, unknown>;
}

function positiveInt(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return value;
}

function assertBridgeAccess(
  req: IncomingMessage,
  app: QueueAppCtx,
  projectId: string,
): void {
  if (!app.authEnabled) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      throw new HttpError(
        403,
        "Forbidden",
        "container introspection requires loopback access or API authentication",
        { type: "https://agenteval.dev/errors/introspection-forbidden" },
      );
    }
    return;
  }
  const auth = getRequestAuth(req);
  if (auth?.projectId != null && auth.projectId !== projectId) {
    throw new HttpError(401, "Unauthorized", "token is not scoped to this project", {
      type: "https://agenteval.dev/errors/unauthorized",
    });
  }
}

function parseExecBody(body: ExecBody): {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
} {
  if (typeof body.command !== "string" || body.command.trim().length === 0) {
    throw badRequest("command is required");
  }
  if (Buffer.byteLength(body.command, "utf8") > MAX_COMMAND_BYTES) {
    throw badRequest(`command must be <= ${MAX_COMMAND_BYTES} bytes`);
  }
  if (body.command.includes("\0")) throw badRequest("command must not contain NUL");
  const cwd = body.cwd ?? "/workspace";
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.includes("\0")) {
    throw badRequest("cwd must be an absolute container path without NUL");
  }
  const env: Record<string, string> = {};
  if (body.env !== undefined) {
    if (!body.env || typeof body.env !== "object" || Array.isArray(body.env)) {
      throw badRequest("env must be an object of string values");
    }
    if (Object.keys(body.env).length > 128) {
      throw badRequest("env may contain at most 128 entries");
    }
    for (const [name, value] of Object.entries(body.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw badRequest(`invalid environment variable name: ${name}`);
      }
      if (typeof value !== "string" || value.includes("\0")) {
        throw badRequest(`env.${name} must be a string without NUL`);
      }
      env[name] = value;
    }
  }
  const timeoutMs = positiveInt(
    body.timeout_ms ?? body.timeoutMs,
    "timeout_ms",
    DEFAULT_TIMEOUT_MS,
  );
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw badRequest(`timeout_ms must be <= ${MAX_TIMEOUT_MS}`);
  }
  const maxOutputBytes = positiveInt(
    body.max_output_bytes ?? body.maxOutputBytes,
    "max_output_bytes",
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  if (maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw badRequest(`max_output_bytes must be <= ${MAX_OUTPUT_BYTES}`);
  }
  return { command: body.command, cwd, env, timeoutMs, maxOutputBytes };
}

function queueView(app: QueueAppCtx, queue: EvalQueue): Record<string, unknown> {
  const live = app.liveQueueContainers.get(queue.id);
  const container = app.queries.getActiveQueueContainer(queue.id);
  const runs = container
    ? app.queries.listRuns({ batchId: container.batchId })
    : [];
  return {
    queue,
    items: app.queries.listEvalQueueItems(queue.id, { includeDisabled: true }),
    container,
    current_run_id: live?.currentRunId ?? null,
    current_queue_item_id: live?.currentQueueItemId ?? null,
    runs,
    analyses: app.queries.listQueueAnalyses(queue.id),
  };
}

async function writeExecFrame(
  res: ServerResponse,
  channel: 1 | 2 | 3 | 4,
  payload: Buffer,
): Promise<void> {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(channel, 0);
  header.writeUInt32BE(payload.length, 1);
  if (!res.write(Buffer.concat([header, payload]))) await once(res, "drain");
}

/** Register persistent queue/container and immutable archive APIs. */
export function registerQueueRoutes(router: Router): void {
  router.post("/api/projects/:id/queues", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const project = requireProject(app.queries, projectId);
    const body = await readJsonBody<{
      name?: string;
      description?: string | null;
      agent_id?: string;
      agentId?: string;
      model?: string;
      provider?: string;
      adapter_overrides?: Record<string, unknown> | null;
      adapterOverrides?: Record<string, unknown> | null;
      sandbox?: Record<string, unknown> | null;
      network_policy?: string;
      networkPolicy?: string;
      ports?: unknown;
      judge_model?: string | null;
      judgeModel?: string | null;
      judge_provider?: string | null;
      judgeProvider?: string | null;
      auto_judge?: boolean;
      autoJudge?: boolean;
      shared_adapter_id?: string | null;
      sharedAdapterId?: string | null;
    }>(req);    if (typeof body.name !== "string" || !body.name.trim()) {
      throw badRequest("name is required");
    }
    const configuredAdapter = app.queries.listProjectAgentAdapters(projectId, {
      includeDisabled: true,
    })[0];
    const agentId = configuredAdapter?.agentId ?? project.defaultAgentId;
    const requestedAgentId = body.agent_id ?? body.agentId;
    if (requestedAgentId && requestedAgentId !== agentId) {
      throw badRequest("queues must use the project's configured agent");
    }
    const model = body.model ?? project.defaultModel;
    const provider = body.provider ?? project.defaultProvider;
    if (!agentId || !model || !provider) {
      throw badRequest("configure the project agent adapter, model, and provider first");
    }
    const input: CreateEvalQueueInput = {
      name: body.name.trim(),
      agentId,
      model,
      provider,
    };
    if (body.description !== undefined) input.description = body.description;
    const rawOverrides = body.adapter_overrides ?? body.adapterOverrides;
    if (rawOverrides !== undefined) {
      input.adapterOverrides = objectOrNull(rawOverrides, "adapter_overrides");
    }
    if (body.sandbox !== undefined) input.sandbox = objectOrNull(body.sandbox, "sandbox");
    const networkPolicy = body.network_policy ?? body.networkPolicy;
    if (networkPolicy !== undefined) input.networkPolicy = networkPolicy;
    if (body.ports !== undefined) input.ports = parsePorts(body.ports) ?? [];
    const judgeModel = body.judge_model ?? body.judgeModel;
    if (judgeModel !== undefined) input.judgeModel = judgeModel;
    const judgeProvider = body.judge_provider ?? body.judgeProvider;
    if (judgeProvider !== undefined) input.judgeProvider = judgeProvider;
    const autoJudge = body.auto_judge ?? body.autoJudge;
    if (autoJudge !== undefined) input.autoJudge = autoJudge;
    const sharedAdapterId = body.shared_adapter_id ?? body.sharedAdapterId;
    if (sharedAdapterId !== undefined) input.sharedAdapterId = sharedAdapterId ?? null;
    const queue = app.queries.createEvalQueue(projectId, input);    sendJson(res, 201, queueView(app, queue));
  });

  router.get("/api/projects/:id/queues", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    sendJson(res, 200, {
      queues: app.queries.listEvalQueues(projectId).map((queue) => queueView(app, queue)),
    });
  });

  router.get("/api/projects/:id/queues/:queueId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    sendJson(res, 200, queueView(app, queue));
  });

  router.patch("/api/projects/:id/queues/:queueId", async (req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    if (app.queries.getActiveQueueContainer(queue.id)) {
      throw conflict("stop the queue container before editing queue execution settings");
    }
    const body = await readJsonBody<Record<string, unknown>>(req);
    const patch: UpdateEvalQueueInput = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body.description === null || typeof body.description === "string") {
      patch.description = body.description as string | null;
    }
    if (body.agent_id !== undefined || body.agentId !== undefined) {
      throw badRequest("a queue cannot change the project's agent");
    }
    if (typeof body.model === "string") patch.model = body.model;
    if (typeof body.provider === "string") patch.provider = body.provider;
    if (body.adapter_overrides !== undefined || body.adapterOverrides !== undefined) {
      patch.adapterOverrides = objectOrNull(
        body.adapter_overrides ?? body.adapterOverrides,
        "adapter_overrides",
      );
    }
    if (body.sandbox !== undefined) patch.sandbox = objectOrNull(body.sandbox, "sandbox");
    const network = body.network_policy ?? body.networkPolicy;
    if (typeof network === "string") patch.networkPolicy = network;
    if (body.ports !== undefined) patch.ports = parsePorts(body.ports) ?? [];
    const judgeModel = body.judge_model ?? body.judgeModel;
    if (judgeModel === null || typeof judgeModel === "string") patch.judgeModel = judgeModel;
    const judgeProvider = body.judge_provider ?? body.judgeProvider;
    if (judgeProvider === null || typeof judgeProvider === "string") {
      patch.judgeProvider = judgeProvider;
    }
    const autoJudge = body.auto_judge ?? body.autoJudge;
    if (typeof autoJudge === "boolean") patch.autoJudge = autoJudge;
    patch.incrementRevision = true;
    const updated = app.queries.updateEvalQueue(queue.id, patch);
    sendJson(res, 200, queueView(app, updated));
  });

  router.delete("/api/projects/:id/queues/:queueId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    if (app.queries.getActiveQueueContainer(queue.id)) {
      throw conflict("stop the queue container before deleting the queue");
    }
    app.queries.deleteEvalQueue(queue.id);
    res.statusCode = 204;
    res.end();
  });

  router.post("/api/projects/:id/queues/:queueId/items", async (req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    if (app.queries.getActiveQueueContainer(queue.id)) {
      throw conflict("stop the queue container before changing queue items");
    }
    const body = await readJsonBody<{
      eval_id?: string;
      task_id?: string;
      taskId?: string;
      repeats?: number;
      enabled?: boolean;
      position?: number;
      before?: string;
      after?: string;
      overrides?: Record<string, unknown> | null;
    }>(req);
    const taskId = body.eval_id ?? body.task_id ?? body.taskId;
    if (!taskId) throw badRequest("eval_id is required");
    const task = app.queries.getTask(taskId);
    if (!task || task.projectId !== queue.projectId || task.archived) {
      throw badRequest(`eval is unavailable: ${taskId}`);
    }
    const input: CreateEvalQueueItemInput = { taskId };
    if (body.repeats !== undefined) input.repeats = positiveInt(body.repeats, "repeats");
    if (body.enabled !== undefined) input.enabled = body.enabled;
    if (typeof body.position === "number") input.position = body.position;
    else if (body.before) input.position = { before: body.before };
    else if (body.after) input.position = { after: body.after };
    if (body.overrides !== undefined) input.overrides = objectOrNull(body.overrides, "overrides");
    const item = app.queries.createEvalQueueItem(queue.id, input);
    sendJson(res, 201, { item });
  });

  router.get("/api/projects/:id/queues/:queueId/items", (_req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    sendJson(res, 200, {
      items: app.queries.listEvalQueueItems(queue.id, { includeDisabled: true }),
    });
  });

  router.patch(
    "/api/projects/:id/queues/:queueId/items/:itemId",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const item = requireItem(app.queries, queue, ctx.params.itemId!);
      if (app.queries.getActiveQueueContainer(queue.id)) {
        throw conflict("stop the queue container before changing queue items");
      }
      const body = await readJsonBody<Record<string, unknown>>(req);
      const patch: UpdateEvalQueueItemInput = {};
      if (typeof body.position === "number") patch.position = body.position;
      if (typeof body.before === "string") patch.before = body.before;
      if (typeof body.after === "string") patch.after = body.after;
      if (body.repeats !== undefined) patch.repeats = positiveInt(body.repeats, "repeats");
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (body.overrides !== undefined) {
        patch.overrides = objectOrNull(body.overrides, "overrides");
      }
      sendJson(res, 200, { item: app.queries.updateEvalQueueItem(item.id, patch) });
    },
  );

  router.delete(
    "/api/projects/:id/queues/:queueId/items/:itemId",
    (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const item = requireItem(app.queries, queue, ctx.params.itemId!);
      if (app.queries.getActiveQueueContainer(queue.id)) {
        throw conflict("stop the queue container before changing queue items");
      }
      app.queries.deleteEvalQueueItem(item.id);
      res.statusCode = 204;
      res.end();
    },
  );

  router.put("/api/projects/:id/queues/:queueId/container", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    try {
      const live = await startQueueContainer(
        app.dataDir,
        app.queries,
        queue.id,
        app.liveQueueContainers,
        app.queueStartOpts,
      );
      sendJson(res, 202, {
        queue_id: queue.id,
        batch_id: live.batchId,
        queue_container_id: live.queueContainerId,
        runtime_container_id: live.handle.id,
        image: live.handle.image,
        ports: live.handle.ports ?? [],
      });
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "ALREADY_ACTIVE") throw conflict(message);
      if (/no enabled evals|unavailable eval|multiple images|adapter .*not ready|configured agent/i.test(message)) {
        throw badRequest(message);
      }
      throw err;
    }
  });

  router.get("/api/projects/:id/queues/:queueId/container", (_req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    const container = app.queries.getActiveQueueContainer(queue.id);
    if (!container) throw conflict(`queue ${queue.id} has no live container`);
    sendJson(res, 200, queueView(app, queue));
  });

  router.patch(
    "/api/projects/:id/queues/:queueId/container",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const live = requireLiveQueue(app, queue);
      const body = await readJsonBody<{ action?: string }>(req);
      if (body.action === "pause") await live.pause();
      else if (body.action === "resume") await live.resume();
      else throw badRequest("action must be pause or resume");
      sendJson(res, 200, queueView(app, app.queries.getEvalQueue(queue.id)!));
    },
  );

  router.delete(
    "/api/projects/:id/queues/:queueId/container",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const live = requireLiveQueue(app, queue);
      await live.stop();
      res.statusCode = 204;
      res.end();
    },
  );

  router.post(
    "/api/projects/:id/queues/:queueId/container/exec",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      assertBridgeAccess(req, app, queue.projectId);
      const live = requireLiveQueue(app, queue);
      const input = parseExecBody(
        await readJsonBody<ExecBody>(req, { limitBytes: 256 * 1024 }),
      );
      let session;
      try {
        session = await live.startExec({
          argv: ["/bin/bash", "-lc", input.command],
          cwd: input.cwd,
          env: input.env,
          user: "root",
          timeoutMs: input.timeoutMs,
        });
      } catch (err) {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        if (code === "NOT_LIVE" || code === "NOT_RUNNING" || code === "PAUSED") {
          throw conflict(err instanceof Error ? err.message : "queue container is unavailable");
        }
        throw err;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/vnd.agenteval.exec-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("X-Agenteval-Exec-Framing", "channel-u8,length-u32be,payload");
      res.setHeader("X-Agenteval-Stdout-Channel", "1");
      res.setHeader("X-Agenteval-Stderr-Channel", "2");
      res.setHeader("X-Agenteval-Control-Channel", "3");
      res.setHeader("X-Agenteval-Error-Channel", "4");
      res.setHeader("X-Agenteval-Queue-Id", queue.id);
      res.setHeader("X-Agenteval-Container-Id", live.handle.id);
      res.flushHeaders();

      let disconnected = false;
      res.once("close", () => {
        if (res.writableEnded) return;
        disconnected = true;
        void session.stop().catch(() => undefined);
      });
      const pump = async (stream: AsyncIterable<Buffer>, channel: 1 | 2) => {
        for await (const chunk of stream) {
          if (disconnected) break;
          await writeExecFrame(res, channel, Buffer.from(chunk));
        }
      };
      try {
        const drains = Promise.all([
          pump(session.stdout(), 1),
          pump(session.stderr(), 2),
        ]);
        const result = await session.wait();
        await drains;
        if (!disconnected) {
          await writeExecFrame(
            res,
            3,
            Buffer.from(
              JSON.stringify({
                exit_code: result.exitCode,
                timed_out: result.timedOut,
                duration_ms: result.durationMs,
                user: "root",
                cwd: input.cwd,
                current_run_id: live.currentRunId,
              }),
              "utf8",
            ),
          );
          res.end();
        }
      } catch (err) {
        if (!disconnected) {
          await writeExecFrame(
            res,
            4,
            Buffer.from(err instanceof Error ? err.message : String(err), "utf8"),
          ).catch(() => undefined);
          res.end();
        }
      }
    },
  );

  router.get("/api/projects/:id/containers", (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    assertBridgeAccess(req, app, projectId);
    const containers = [...app.liveQueueContainers.values()]
      .filter((live) => live.projectId === projectId && !live.finished)
      .map((live) => ({
        queue_id: live.queueId,
        batch_id: live.batchId,
        queue_container_id: live.queueContainerId,
        runtime_container_id: live.handle.id,
        image: live.handle.image,
        ports: live.handle.ports ?? [],
        current_run_id: live.currentRunId,
        current_queue_item_id: live.currentQueueItemId,
        paused: live.paused,
        exec_path: `/api/projects/${projectId}/queues/${live.queueId}/container/exec`,
      }));
    sendJson(res, 200, { project_id: projectId, containers });
  });

  router.post(
    "/api/projects/:id/queues/:queueId/analyses",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const body = await readJsonBody<{
        batch_id?: string;
        batchId?: string;
        run_ids?: string[];
        runIds?: string[];
        all?: boolean;
        judge_model?: string;
        judgeModel?: string;
        judge_provider?: string;
        judgeProvider?: string;
        judge_prompt?: string | null;
        judgePrompt?: string | null;
        judge_params?: Record<string, unknown> | null;
        judgeParams?: Record<string, unknown> | null;
        parent_analysis_id?: string | null;
        parentAnalysisId?: string | null;
      }>(req);
      const batchId =
        body.batch_id ??
        body.batchId ??
        queue.activeBatchId ??
        app.queries.listQueueContainers(queue.id)[0]?.batchId;
      if (!batchId) throw badRequest("batch_id is required when the queue has no execution history");
      const runIds = body.run_ids ?? body.runIds;
      if (!body.all && (!runIds || runIds.length === 0)) {
        throw badRequest("set all:true or provide run_ids");
      }
      const judgeModel = body.judge_model ?? body.judgeModel ?? queue.judgeModel;
      const judgeProvider =
        body.judge_provider ?? body.judgeProvider ?? queue.judgeProvider ?? queue.provider;
      if (!judgeModel || !judgeProvider) {
        throw badRequest("judge_model and judge_provider are required");
      }
      const result = await runQueueAnalysis(app.dataDir, app.queries, {
        queueId: queue.id,
        batchId,
        ...(body.all ? {} : { runIds }),
        judgeModel,
        judgeProvider,
        judgePrompt: body.judge_prompt ?? body.judgePrompt ?? null,
        judgeParams: body.judge_params ?? body.judgeParams ?? null,
        parentAnalysisId:
          body.parent_analysis_id ?? body.parentAnalysisId ?? null,
      });
      sendJson(res, result.status === "completed" ? 201 : 502, result);
    },
  );

  router.get("/api/projects/:id/queues/:queueId/analyses", (_req, res, ctx) => {
    const app = appOf(ctx);
    const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
    sendJson(res, 200, { analyses: app.queries.listQueueAnalyses(queue.id) });
  });

  router.get(
    "/api/projects/:id/queues/:queueId/analyses/:analysisId",
    (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const analysis = requireQueueAnalysis(
        app.queries,
        queue,
        ctx.params.analysisId!,
      );
      sendJson(res, 200, { analysis });
    },
  );

  router.get(
    "/api/projects/:id/queues/:queueId/analyses/:analysisId/events",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const analysis = requireQueueAnalysis(
        app.queries,
        queue,
        ctx.params.analysisId!,
      );
      if (!analysis.eventsPath) throw conflict("queue analysis events are not ready");
      const events = await readFile(analysis.eventsPath).catch(() => null);
      if (events === null) throw notFound("queue analysis events file is missing");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(events);
    },
  );

  router.get(
    "/api/projects/:id/queues/:queueId/analyses/:analysisId/transcript",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const analysis = requireQueueAnalysis(
        app.queries,
        queue,
        ctx.params.analysisId!,
      );
      if (!analysis.rawResponsePath) {
        throw conflict("queue analysis PI transcript is not ready");
      }
      const transcript = await readFile(analysis.rawResponsePath).catch(() => null);
      if (transcript === null) throw notFound("queue analysis PI transcript is missing");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(transcript);
    },
  );

  router.get(
    "/api/projects/:id/queues/:queueId/analyses/:analysisId/verdict",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const analysis = requireQueueAnalysis(
        app.queries,
        queue,
        ctx.params.analysisId!,
      );
      if (!analysis.verdictPath) throw conflict("queue analysis verdict is not ready");
      const verdict = await readFile(analysis.verdictPath).catch(() => null);
      if (verdict === null) throw notFound("queue analysis verdict file is missing");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(verdict);
    },
  );

  router.get(
    "/api/projects/:id/queues/:queueId/analyses/:analysisId/report",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const analysis = requireQueueAnalysis(
        app.queries,
        queue,
        ctx.params.analysisId!,
      );
      if (!analysis.reportPath) throw conflict("queue analysis report is not ready");
      const html = await readFile(analysis.reportPath, "utf8").catch(() => null);
      if (html === null) throw notFound("queue analysis report file is missing");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(html);
    },
  );

  router.get("/api/evals/:runId/archive", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = app.queries.getRun(ctx.params.runId!);
    if (!run) throw notFound(`run not found: ${ctx.params.runId}`);
    if (app.authEnabled) {
      const auth = getRequestAuth(req);
      if (auth?.projectId != null && auth.projectId !== run.projectId) {
        throw new HttpError(401, "Unauthorized", "token is not scoped to this project", {
          type: "https://agenteval.dev/errors/unauthorized",
        });
      }
    }
    const archive = app.queries.getEvalArchive(run.id);
    if (!archive) throw notFound(`eval archive not found: ${run.id}`);
    const verification = await verifyEvalArchive(archive);
    sendJson(res, verification.ok ? 200 : 409, { archive, verification });
  });
}

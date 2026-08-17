/** Persistent eval-queue, queue-container, introspection, and archive routes. */

import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CreateEvalQueueInput,
  CreateEvalQueueItemInput,
  DbQueries,
  EvalQueue,
  EvalQueueItem,
  Project,
  ProjectAgentAdapter,
  UpdateEvalQueueInput,
  UpdateEvalQueueItemInput,
} from "../db/queries.js";
import { listAdapters } from "../adapters/index.js";
import { verifyEvalArchive } from "../runner/eval-archive.js";
import { parsePorts } from "../runner/project-config.js";
import {
  startQueueContainer,
  validateItemAgainstGenerationSignature,
  type GenerationContainerSignature,
  type LiveQueueContainer,
  type LiveQueueContainersMap,
  type StartQueueContainerOptions,
} from "../runner/queue-worker.js";
import {
  resolveAgentCommit,
  type AdapterBuildService,
  type ResolvedAgentCommit,
} from "../runner/adapter-build.js";
import { isTerminalStatus } from "../runner/status.js";
import { getRequestAuth, isLoopbackAddress } from "./auth.js";
import { badRequest, conflict, HttpError, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";
import { withBodyIdempotency } from "./middleware.js";

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

function requireSharedAdapter(queries: DbQueries, projectId: string, adapterId: string) {
  const adapter = queries.getProjectAgentAdapter(adapterId);
  if (!adapter || !adapter.shared || !adapter.enabled || adapter.projectId === projectId) {
    throw badRequest(`shared_adapter_id is unavailable: ${adapterId}`);
  }
  return adapter;
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

/** The build service used for commit resolution (queries + a dataDir for builds). */
function buildServiceFor(app: QueueAppCtx): AdapterBuildService {
  return { queries: app.queries, dataDir: app.dataDir };
}

/** The selected adapter (project-owned or shared) backing a queue's agent. */
function adapterForQueue(
  queries: DbQueries,
  queue: EvalQueue,
): ProjectAgentAdapter | null {
  if (queue.sharedAdapterId) {
    return queries.getProjectAgentAdapter(queue.sharedAdapterId);
  }
  return queries.getProjectAgentAdapterByAgentId(queue.projectId, queue.agentId);
}

/**
 * Resolve a queue's agent_commit / agent_ref into a stored full SHA.
 *
 * A full 40-char SHA is accepted verbatim (reproducible pin). Any ref is resolved
 * immediately to its exact commit via the adapter's source repo so the queue
 * stores only full shas. Returns null when the queue uses a built-in adapter
 * (may omit agent_commit) or when no commit/ref is given.
 */
async function resolveQueueCommit(
  app: QueueAppCtx,
  queue: EvalQueue,
  body: { agent_commit?: string | null; agentCommit?: string | null; agent_ref?: string | null; agentRef?: string | null },
): Promise<ResolvedAgentCommit | null> {
  const commit = body.agent_commit ?? body.agentCommit;
  const ref = body.agent_ref ?? body.agentRef;
  if (commit === undefined && ref === undefined) {
    // No commit requested: keep the existing queue pin (null allowed for built-ins).
    return queue.agentCommit ? { sha: queue.agentCommit, shortSha: queue.agentCommit.slice(0, 12), repo: "" } : null;
  }
  if (commit !== undefined && commit !== null && ref !== undefined && ref !== null) {
    throw badRequest("provide agent_commit or agent_ref, not both");
  }
  const adapter = adapterForQueue(app.queries, queue);
  if (!adapter || adapter.installType !== "source-build" || !adapter.sourceRepo) {
    throw badRequest(
      "agent_commit/agent_ref requires a source-built agent adapter with source_repo",
    );
  }
  if (ref !== undefined && ref !== null) {
    const resolved = await resolveAgentCommit(
      buildServiceFor(app),
      adapter.sourceRepo,
      String(ref),
    );
    if (!resolved) {
      throw badRequest("agent_ref could not be resolved to a commit; pass a full SHA or a resolvable ref");
    }
    return resolved;
  }
  if (commit !== undefined && commit !== null) {
    return resolveAgentCommit(buildServiceFor(app), adapter.sourceRepo, String(commit));
  }
  return null;
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

/** Strip host-internal storage paths from a queue container row for API clients. */
function publicContainer(
  container: import("../db/queries.js").QueueContainer | null,
): Record<string, unknown> | null {
  if (!container) return null;
  const { workspaceDir: _workspaceDir, ...rest } = container;
  void _workspaceDir;
  return { ...rest } as unknown as Record<string, unknown>;
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
    container: publicContainer(container),
    current_run_id: live?.currentRunId ?? null,
    current_queue_item_id: live?.currentQueueItemId ?? null,
    runs,
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
      shared_adapter_id?: string | null;
      sharedAdapterId?: string | null;
      builtin_adapter_id?: string | null;
      builtinAdapterId?: string | null;
      agent_commit?: string | null;
      agentCommit?: string | null;
      agent_ref?: string | null;
      agentRef?: string | null;
    }>(req);
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw badRequest("name is required");
    }
    const sharedAdapterId = body.shared_adapter_id ?? body.sharedAdapterId;
    const sharedAdapter = typeof sharedAdapterId === "string"
      ? requireSharedAdapter(app.queries, projectId, sharedAdapterId)
      : null;
    if (sharedAdapterId !== undefined && sharedAdapterId !== null && typeof sharedAdapterId !== "string") {
      throw badRequest("shared_adapter_id must be a string or null");
    }
    const configuredAdapter = app.queries.listProjectAgentAdapters(projectId, {
      includeDisabled: true,
    })[0];
    if (!sharedAdapter && configuredAdapter && !configuredAdapter.enabled) {
      throw badRequest("the project's configured adapter is disabled");
    }
    const builtinAdapterId = body.builtin_adapter_id ?? body.builtinAdapterId;
    if (builtinAdapterId !== undefined && builtinAdapterId !== null) {
      if (typeof builtinAdapterId !== "string") {
        throw badRequest("builtin_adapter_id must be a string or null");
      }
      if (!listAdapters().includes(builtinAdapterId)) {
        throw badRequest(`builtin_adapter_id must name a registered built-in adapter: ${listAdapters().join(", ")}`);
      }
      if (sharedAdapter || configuredAdapter) {
        throw badRequest("builtin_adapter_id cannot be combined with a project/shared adapter; choose one");
      }
    }
    const agentId =
      sharedAdapter?.agentId ??
      builtinAdapterId ??
      configuredAdapter?.agentId;
    const requestedAgentId = body.agent_id ?? body.agentId;
    if (requestedAgentId && requestedAgentId !== agentId) {
      throw badRequest(
        sharedAdapter
          ? "agent_id must match the explicitly selected shared adapter"
          : "queues must use the project's configured agent or explicitly select a builtin_adapter_id",
      );
    }
    // No silent fallback: a queue must resolve to an adapter explicitly.
    if (!agentId) {
      throw badRequest(
        "no agent adapter selected: create a project adapter, reference a shared adapter, or explicitly set builtin_adapter_id",
      );
    }
    const sharedAgent = sharedAdapter ? app.queries.getAgent(sharedAdapter.agentId) : null;
    const model =
      body.model ?? project.defaultModel ?? sharedAgent?.defaultModel ??
      (builtinAdapterId ? app.queries.getAgent(builtinAdapterId)?.defaultModel ?? undefined : undefined);
    const provider =
      body.provider ?? project.defaultProvider ?? sharedAgent?.defaultProvider ??
      (builtinAdapterId ? app.queries.getAgent(builtinAdapterId)?.defaultProvider ?? undefined : undefined);
    if (!model || !provider) {
      throw badRequest("configure the queue agent model and provider first");
    }
    const input: CreateEvalQueueInput = {
      name: body.name.trim(),
      agentId,
      model,
      provider,
      sharedAdapterId: sharedAdapter?.id ?? null,
      builtinAdapterId: builtinAdapterId ?? null,
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
    const queue = app.queries.createEvalQueue(projectId, input);
    // Pin the queue to an agent commit (resolved to a full SHA) if requested.
    // Done after create so the queue row exists to inspect its adapter.
    if (body.agent_commit !== undefined || body.agentCommit !== undefined ||
        body.agent_ref !== undefined || body.agentRef !== undefined) {
      if (input.builtinAdapterId) {
        throw badRequest("builtin_adapter_id queues cannot pin an agent_commit");
      }
      const resolved = await resolveQueueCommit(app, queue, body);
      if (resolved) {
        app.queries.updateEvalQueue(queue.id, { agentCommit: resolved.sha });
      } else if (body.agent_commit !== undefined && body.agent_commit !== null) {
        throw badRequest("agent_commit must resolve to a full SHA for a source-built adapter");
      }
    }
    sendJson(res, 201, queueView(app, app.queries.getEvalQueue(queue.id)!));
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
      throw badRequest("a queue cannot directly change agent_id; select shared_adapter_id instead");
    }
    if (body.shared_adapter_id !== undefined || body.sharedAdapterId !== undefined) {
      const requestedShared = body.shared_adapter_id ?? body.sharedAdapterId;
      if (requestedShared === null) {
        patch.sharedAdapterId = null;
        // Clearing shared must leave an explicit adapter: a project adapter or a builtin.
        if (body.builtin_adapter_id === undefined && body.builtinAdapterId === undefined) {
          const configured = app.queries.listProjectAgentAdapters(queue.projectId)[0];
          if (!configured) {
            throw badRequest("clearing shared_adapter_id requires an enabled project adapter or builtin_adapter_id");
          }
          if (!configured.enabled) throw badRequest("the project's configured adapter is disabled");
          patch.agentId = configured.agentId;
        }
      } else if (typeof requestedShared === "string") {
        const shared = requireSharedAdapter(app.queries, queue.projectId, requestedShared);
        patch.sharedAdapterId = shared.id;
        patch.agentId = shared.agentId;
        patch.builtinAdapterId = null;
      } else {
        throw badRequest("shared_adapter_id must be a string or null");
      }
    }
    if (body.builtin_adapter_id !== undefined || body.builtinAdapterId !== undefined) {
      const requestedBuiltin = body.builtin_adapter_id ?? body.builtinAdapterId;
      if (requestedBuiltin === null) {
        // Clearing builtin must leave an explicit adapter.
        if (body.shared_adapter_id === undefined && body.sharedAdapterId === undefined) {
          const configured = app.queries.listProjectAgentAdapters(queue.projectId)[0];
          if (!configured) {
            throw badRequest("clearing builtin_adapter_id requires an enabled project adapter or shared_adapter_id");
          }
          if (!configured.enabled) throw badRequest("the project's configured adapter is disabled");
          patch.agentId = configured.agentId;
          patch.builtinAdapterId = null;
        }
      } else if (typeof requestedBuiltin === "string") {
        if (!listAdapters().includes(requestedBuiltin)) {
          throw badRequest(`builtin_adapter_id must name a registered built-in: ${listAdapters().join(", ")}`);
        }
        patch.builtinAdapterId = requestedBuiltin;
        patch.agentId = requestedBuiltin;
        patch.sharedAdapterId = null;
      } else {
        throw badRequest("builtin_adapter_id must be a string or null");
      }
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
    if (body.agent_commit !== undefined || body.agentCommit !== undefined ||
        body.agent_ref !== undefined || body.agentRef !== undefined) {
      const base = app.queries.getEvalQueue(queue.id)!;
      const resolved = await resolveQueueCommit(app, base, body);
      if (resolved) patch.agentCommit = resolved.sha;
      else if ((body.agent_commit ?? body.agentCommit) != null) {
        throw badRequest("agent_commit must be a full SHA for a source-built adapter");
      }
    }
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
    // Mid-run additions are allowed but must be runnable in the active
    // generation's immutable container. Reject incompatible items with 409.
    const live = app.liveQueueContainers.get(queue.id);
    if (live && !live.finished) {
      const incompat = await validateItemAgainstGenerationSignature({
        queries: app.queries,
        queue,
        task,
        overrides: body.overrides !== undefined ? objectOrNull(body.overrides, "overrides") : null,
        signature: live.signature,
      });
      if (incompat) {
        throw conflict(`item cannot run in the active queue generation: ${incompat}`);
      }
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

  router.post(
    "/api/projects/:id/queues/:queueId/items:load-category",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
      const body = await readJsonBody<{
        category_name?: string;
        categoryName?: string;
        repeats?: number;
        enabled?: boolean;
      }>(req);
      const categoryName = body.category_name ?? body.categoryName;
      if (!categoryName?.trim()) throw badRequest("category_name is required");
      const repeats = body.repeats === undefined ? 1 : positiveInt(body.repeats, "repeats");
      const existingTaskIds = new Set(
        app.queries.listEvalQueueItems(queue.id, { includeDisabled: true }).map((item) => item.taskId),
      );
      const matches = app.queries.listTasks(queue.projectId)
        .filter((task) => task.categoryName === categoryName.trim());
      if (matches.length === 0) {
        throw badRequest(`no enabled evals found in category: ${categoryName.trim()}`);
      }
      const live = app.liveQueueContainers.get(queue.id);
      const signature = live && !live.finished ? live.signature : null;
      const added = [];
      const skipped: string[] = [];
      const incompatible: string[] = [];
      for (const task of matches) {
        if (existingTaskIds.has(task.id)) {
          skipped.push(task.id);
          continue;
        }
        if (signature) {
          const incompat = await validateItemAgainstGenerationSignature({
            queries: app.queries,
            queue,
            task,
            overrides: null,
            signature,
          });
          if (incompat) {
            incompatible.push(task.id);
            continue;
          }
        }
        added.push(app.queries.createEvalQueueItem(queue.id, {
          taskId: task.id,
          repeats,
          enabled: body.enabled ?? true,
        }));
      }
      sendJson(res, added.length > 0 ? 201 : 200, {
        category_name: categoryName.trim(),
        matched_eval_count: matches.length,
        added,
        skipped_eval_ids: skipped,
        incompatible_eval_ids: incompatible,
      });
    },
  );

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
      const body = await readJsonBody<Record<string, unknown>>(req);
      const patch: UpdateEvalQueueItemInput = {};
      if (typeof body.position === "number") patch.position = body.position;
      if (typeof body.before === "string") patch.before = body.before;
      if (typeof body.after === "string") patch.after = body.after;
      if (body.repeats !== undefined) {
        const requested = positiveInt(body.repeats, "repeats");
        // Repeat floor: cannot reduce repeats below the number of runs for this
        // item already claimed in the ACTIVE generation (their immutable run
        // snapshots can never change). The item's lifetime `claimedRepeats`
        // counter is cumulative across generations and is never reset, so it is
        // NOT the floor: it would falsely lock repeats at the historical total
        // after a generation closes and a fresh one starts with nothing claimed.
        const activeContainer = app.queries.getActiveQueueContainer(queue.id);
        let floor = 0;
        if (activeContainer) {
          floor = app.queries
            .listRuns({ batchId: activeContainer.batchId })
            .filter((r) => r.queueItemId === item.id).length;
        }
        if (requested < floor) {
          throw conflict(
            `cannot reduce repeats below ${floor} already claimed in the active generation`,
          );
        }
        patch.repeats = requested;
      }
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (body.overrides !== undefined) {
        const overrides = objectOrNull(body.overrides, "overrides");
        // Changing overrides can alter network/image/ports/limits that the live
        // generation container is pinned to. Validate against that immutable
        // signature when a generation is active so an incompatible item is never
        // claimed into (and re-validated against) a built container.
        const live = app.liveQueueContainers.get(queue.id);
        if (live && !live.finished) {
          const task = app.queries.getTask(item.taskId);
          if (!task) throw badRequest(`eval is unavailable: ${item.taskId}`);
          const incompat = await validateItemAgainstGenerationSignature({
            queries: app.queries,
            queue,
            task,
            overrides,
            signature: live.signature,
          });
          if (incompat) {
            throw conflict(`item cannot run in the active queue generation: ${incompat}`);
          }
        }
        patch.overrides = overrides;
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
      // DELETING a queue item while a generation is active is allowed and becomes
      // a soft delete: prevents future claims without breaking run provenance.
      app.queries.deleteEvalQueueItem(item.id);
      res.statusCode = 204;
      res.end();
    },
  );

  router.put(
    "/api/projects/:id/queues/:queueId/container",
    withBodyIdempotency(
      // Body digest defaults to empty-body hash (this endpoint sends no body);
      // a retry with the same key and the same empty body replays the 202.
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      async (_req, res, ctx) => {
        const app = appOf(ctx);
        const queue = requireQueue(app.queries, ctx.params.id!, ctx.params.queueId!);
        const startOpts = { ...app.queueStartOpts };
        try {
          const live = await startQueueContainer(
            app.dataDir,
            app.queries,
            queue.id,
            app.liveQueueContainers,
            startOpts,
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
          if (/no enabled evals|unavailable eval|multiple images|adapter .*not ready|configured agent|no agent_commit|reproducible commit/i.test(message)) {
            throw badRequest(message);
          }
          throw err;
        }
      },
    ),
  );

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
      else if (body.action === "abort") await live.abortCurrentRun();
      else throw badRequest("action must be pause, resume, or abort");
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

  router.get("/api/evals/:runId/metrics", (req, res, ctx) => {
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
    const metrics = app.queries.getEvalMetrics(run.id);
    if (!metrics) throw notFound(`eval metrics not found: ${run.id}`);
    sendJson(res, 200, {
      run_id: metrics.runId,
      project_id: metrics.projectId,
      schema_version: metrics.schemaVersion,
      execution: metrics.execution,
      outcome: metrics.outcome,
      created_at: metrics.createdAt,
      updated_at: metrics.updatedAt,
    });
  });

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
    // Strip absolute host manifest paths: internal storage locations are never
    // serialized to API clients (the central archive API strips storagePath too).
    const publicArchive = {
      runId: archive.runId,
      projectId: archive.projectId,
      queueId: archive.queueId,
      batchId: archive.batchId,
      manifestSha256: archive.manifestSha256,
      sizeBytes: archive.sizeBytes,
      sealedAt: archive.sealedAt,
    };
    sendJson(res, verification.ok ? 200 : 409, { archive: publicArchive, verification });
  });
}

/**
 * Eval-queue REST routes (P8b-routes).
 *
 * POST   /api/projects/:id/queue
 * GET    /api/projects/:id/queue
 * PATCH  /api/projects/:id/queue/:entryId
 * DELETE /api/projects/:id/queue/:entryId
 * POST   /api/projects/:id/queue/:entryId/promote
 * POST   /api/projects/:id/queue/drain
 *
 * Auth is a wrapping concern (p8b-auth); these handlers do not check tokens.
 * Spec: plan/api.md §Eval queue.
 */

import type {
  CreateQueueEntryInput,
  DbQueries,
  QueueEntry,
  QueueTargetKind,
  ReorderQueueEntryOpts,
} from "../db/queries.js";
import { badRequest, conflict, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal AppCtx surface for queue routes.
 * `enqueueStart` is the server start-pipeline seam: promote calls it for each
 * created run so work actually begins (does not reimplement startRun).
 */
export interface QueueAppCtx {
  queries: DbQueries;
  dataDir: string;
  /** Kick a run into the concurrency-limited start pipeline. */
  enqueueStart?: (runId: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appOf(ctx: RequestContext): QueueAppCtx {
  return ctx.app as QueueAppCtx;
}

function requireProject(queries: DbQueries, id: string) {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

/**
 * Load a queue entry for a project. 404 when missing or wrong project.
 */
function requireQueueEntry(
  queries: DbQueries,
  projectId: string,
  entryId: string,
): QueueEntry {
  const entry = queries.getQueueEntry(entryId);
  if (!entry || entry.projectId !== projectId) {
    throw notFound(`queue entry not found: ${entryId}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register eval-queue routes on an existing Router.
 * Called from createServer next to registerWatcherRoutes.
 */
export function registerQueueRoutes(router: Router): void {
  // POST /api/projects/:id/queue — add entry
  router.post("/api/projects/:id/queue", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const body = await readJsonBody<{
      ref?: string | null;
      triggerRef?: string | null;
      taskId?: string | null;
      taskTags?: string[];
      agent?: string;
      agentId?: string;
      model?: string | null;
      provider?: string | null;
      repeats?: number | null;
      params?: Record<string, unknown> | null;
      adapterOverrides?: Record<string, unknown> | null;
      autoJudge?: boolean | null;
      judgeModel?: string | null;
      priority?: number;
      after?: string;
      before?: string;
      position?: number;
      dedupKey?: string | null;
      source?: string | null;
    }>(req);

    const agentId = body.agentId ?? body.agent;
    if (!agentId || !String(agentId).trim()) {
      throw badRequest("agent (or agentId) is required");
    }

    const targetKind: QueueTargetKind = body.taskId ? "task" : "task_set";
    if (targetKind === "task" && !body.taskId) {
      throw badRequest("taskId is required when targeting a single task");
    }

    const input: CreateQueueEntryInput = {
      targetKind,
      agentId: String(agentId).trim(),
      triggerRef: body.triggerRef ?? body.ref ?? null,
      taskId: body.taskId ?? null,
      source: body.source ?? "api",
    };
    if (body.taskTags !== undefined) input.taskTags = body.taskTags;
    if (body.model !== undefined) input.model = body.model;
    if (body.provider !== undefined) input.provider = body.provider;
    if (body.repeats !== undefined) input.repeats = body.repeats;
    if (body.params !== undefined) input.params = body.params;
    if (body.adapterOverrides !== undefined) {
      input.adapterOverrides = body.adapterOverrides;
    }
    if (body.autoJudge !== undefined) input.autoJudge = body.autoJudge;
    if (body.judgeModel !== undefined) input.judgeModel = body.judgeModel;
    if (body.priority !== undefined) input.priority = body.priority;
    if (body.dedupKey !== undefined) input.dedupKey = body.dedupKey;

    // Position: absolute number, or relative after/before.
    if (typeof body.position === "number") {
      input.position = body.position;
    } else if (body.after) {
      input.position = { after: body.after };
    } else if (body.before) {
      input.position = { before: body.before };
    }

    const entry = app.queries.createQueueEntry(projectId, input);
    sendJson(res, 202, { entry, position: entry.position });
  });

  // GET /api/projects/:id/queue — list (ordered)
  router.get("/api/projects/:id/queue", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const status = ctx.query.status || undefined;
    const queue = app.queries.listQueueEntries(
      projectId,
      status ? { status } : {},
    );
    sendJson(res, 200, { queue });
  });

  // PATCH /api/projects/:id/queue/:entryId — reorder / priority
  // NOTE: register before /queue/drain would not collide (different paths).
  router.patch("/api/projects/:id/queue/:entryId", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const entryId = ctx.params.entryId!;
    requireProject(app.queries, projectId);
    requireQueueEntry(app.queries, projectId, entryId);

    const body = await readJsonBody<{
      position?: number;
      after?: string;
      before?: string;
      priority?: number;
    }>(req);

    const opts: ReorderQueueEntryOpts = {};
    if (typeof body.position === "number") opts.position = body.position;
    if (body.after !== undefined) opts.after = body.after;
    if (body.before !== undefined) opts.before = body.before;
    if (typeof body.priority === "number") opts.priority = body.priority;

    if (
      opts.position === undefined &&
      opts.after === undefined &&
      opts.before === undefined &&
      opts.priority === undefined
    ) {
      throw badRequest(
        "provide position, after, before, and/or priority to reorder",
      );
    }

    try {
      const entry = app.queries.reorderQueueEntry(entryId, opts);
      sendJson(res, 200, { entry });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) throw notFound(message);
      throw badRequest(message);
    }
  });

  // DELETE /api/projects/:id/queue/:entryId — soft-remove (idempotent for removed)
  router.delete("/api/projects/:id/queue/:entryId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const entryId = ctx.params.entryId!;
    requireProject(app.queries, projectId);
    // Idempotent soft-remove: missing → 404; already removed → still 204.
    const existing = app.queries.getQueueEntry(entryId);
    if (!existing || existing.projectId !== projectId) {
      throw notFound(`queue entry not found: ${entryId}`);
    }
    app.queries.removeQueueEntry(entryId);
    res.statusCode = 204;
    res.end();
  });

  // POST /api/projects/:id/queue/:entryId/promote — create batch+runs + start
  router.post(
    "/api/projects/:id/queue/:entryId/promote",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const entryId = ctx.params.entryId!;
      requireProject(app.queries, projectId);
      const entry = requireQueueEntry(app.queries, projectId, entryId);

      if (entry.status === "promoted" || entry.status === "running") {
        throw conflict(`queue entry already promoted: ${entryId}`);
      }
      if (entry.status === "removed") {
        throw conflict(`queue entry was removed: ${entryId}`);
      }
      if (entry.status !== "queued") {
        throw conflict(
          `cannot promote queue entry ${entryId}: status is ${entry.status}`,
        );
      }

      let promoted;
      try {
        promoted = app.queries.promoteQueueEntry(entryId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(message)) throw notFound(message);
        if (/cannot promote|no tasks|task not found/i.test(message)) {
          throw badRequest(message);
        }
        throw err;
      }

      // Wire each created run into the runner start pipeline.
      if (app.enqueueStart) {
        for (const runId of promoted.runIds) {
          void app.enqueueStart(runId);
        }
      }

      sendJson(res, 202, {
        batchId: promoted.batchId,
        batchIds: promoted.batchIds,
        runIds: promoted.runIds,
        entry: promoted.entry,
      });
    },
  );

  // POST /api/projects/:id/queue/drain — soft-remove all queued entries
  router.post("/api/projects/:id/queue/drain", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const result = app.queries.drainQueue(projectId);
    sendJson(res, 200, { removed: result.removed });
  });
}

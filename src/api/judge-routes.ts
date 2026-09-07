/**
 * WP-13 judge HTTP surfaces — real Phase-1 runner over sealed archives.
 */

import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryStore } from "../db/queries.js";

import { migrate as migrateThemis } from "../db/sqlite/migrate.js";
import { getResultVersion, listResultVersionsByRun } from "../db/sqlite/results.js";
import { loadGatewayConfig } from "../judge/gateway/config.js";
import { Phase1Service } from "../judge/phase1-service.js";
import { projectStoredModelConfig, viewModelConfig } from "../config/model-config.js";
import { archiveStoreDir, readArchiveStoreManifest } from "../runner/archive-store.js";
import {
  judgeQueueStatus,
  pauseJudgeQueue,
  resumeJudgeQueue,
} from "../judge/ingest/pause.js";
import {
  countPending,
  flushPending,
  getLinkedJudgeQueue,
  linkJudgeQueue,
  submitStandaloneArchives,
} from "../judge/ingest/store.js";
import { badRequest, notFound } from "./errors.js";
import { blockingReason, projectReadiness } from "./readiness.js";
import { readJsonBody, sendJson, type Router } from "./router.js";

type App = { dataDir: string; queries: QueryStore };

function openThemisDb(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, "themis.sqlite"));
  migrateThemis(db);
  return db;
}

function appOf(ctx: { app: unknown }): App {
  return ctx.app as App;
}

/** Register judge health + Phase-1 execution routes. */
export function registerJudgeRoutes(router: Router, phase1: Phase1Service): void {
  router.get("/api/judge/health", (_req, res) => {
    let configured = false;
    try {
      loadGatewayConfig();
      configured = true;
    } catch {
      configured = false;
    }
    sendJson(res, 200, {
      ok: true,
      gateway_configured: configured,
      model: viewModelConfig("phase1").model || null,
      reasoning_effort: viewModelConfig("phase1").reasoningEffort,
    });
  });

  // ---- Judge-queue ingestion (linked + standalone) -------------------------

  /** Create a judge queue linked to an eval queue (one per eval queue). */
  router.post("/api/judge/queues", async (req, res, ctx) => {
    const app = appOf(ctx);
    const body = (await readJsonBody<{
      name: string;
      project_id: string;
      linked_eval_queue_id?: string | null;
      auto_judge?: boolean;
    }>(req).catch(() => ({}))) as {
      name: string;
      project_id: string;
      linked_eval_queue_id?: string | null;
      auto_judge?: boolean;
    };
    if (!body.name || !body.project_id) {
      throw badRequest("name and project_id are required");
    }
    const db = openThemisDb(app.dataDir);
    try {
      const queue = linkJudgeQueue(db, {
        name: body.name,
        projectId: body.project_id,
        linkedEvalQueueId: body.linked_eval_queue_id ?? "",
        autoJudge: body.auto_judge ?? false,
      });
      sendJson(res, 200, { judge_queue: queue });
    } finally {
      db.close();
    }
  });

  /** Submit archive run ids onto a (standalone or linked) judge queue. */
  router.post("/api/judge/queues/:queueId/archives", async (req, res, ctx) => {
    const app = appOf(ctx);
    const body = (await readJsonBody<{ run_ids: string[] }>(req).catch(() => ({ run_ids: [] }))) as {
      run_ids: string[];
    };
    if (!Array.isArray(body.run_ids) || body.run_ids.length === 0) {
      throw badRequest("run_ids[] is required");
    }
    const db = openThemisDb(app.dataDir);
    try {
      // Resolve real archive identity (projectId + manifest sha) so the durable
      // job carries truthful provenance rather than empty placeholders.
      const { readFile } = await import("node:fs/promises");
      const { createHash } = await import("node:crypto");
      const archives = [];
      for (const runId of body.run_ids) {
        const row = app.queries.getEvalArchive(runId);
        const legacy = row ? null : await readArchiveStoreManifest(archiveStoreDir(app.dataDir, runId));
        const projectId = row?.projectId ?? String(
          (legacy?.project as Record<string, unknown> | undefined)?.id ?? "",
        );
        // New archives carry the canonical manifest hash in eval_archives.
        // Legacy rows fall back to the sealed manifest bytes.
        let baseManifestSha256 = row?.manifestSha256 ?? "";
        if (!baseManifestSha256) try {
          const sealed = await readFile(
            join(archiveStoreDir(app.dataDir, runId), "eval_lifecycle_logs", "archive.json"),
          );
          baseManifestSha256 = createHash("sha256").update(sealed).digest("hex");
        } catch {
          baseManifestSha256 = createHash("sha256")
            .update(JSON.stringify(legacy ?? {}))
            .digest("hex");
        }
        archives.push({
          runId,
          projectId,
          evalQueueId: null as string | null,
          baseManifestSha256,
        });
      }
      const results = submitStandaloneArchives(db, ctx.params.queueId!, archives);
      sendJson(res, 200, { submitted: results.length, results });
    } finally {
      db.close();
    }
  });

  /** Flush buffered archives for a linked queue (auto-judge off path). */
  router.post("/api/judge/queues/:queueId/flush", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const db = openThemisDb(app.dataDir);
    try {
      const results = flushPending(db, ctx.params.queueId!);
      sendJson(res, 200, { flushed: results.length, results });
    } finally {
      db.close();
    }
  });

  /**
   * Pause a judge queue (design §3). `kind` records WHY — provider_quota and
   * provider_rate_limit pause WITHOUT consuming a retry attempt, so resume
   * continues from the last committed checkpoint.
   */
  router.post("/api/judge/queues/:queueId/pause", async (req, res, ctx) => {
    const app = appOf(ctx);
    const body = (await readJsonBody<{ kind?: string; reason?: string }>(req).catch(
      () => ({}),
    )) as { kind?: string; reason?: string };
    const allowed = [
      "manual",
      "provider_quota",
      "provider_rate_limit",
      "budget",
      "operator_safety",
    ];
    if (body.kind && !allowed.includes(body.kind)) {
      throw badRequest(`kind must be one of: ${allowed.join(", ")}`);
    }
    const db = openThemisDb(app.dataDir);
    try {
      const out = pauseJudgeQueue(db, ctx.params.queueId!, {
        kind: (body.kind as never) ?? undefined,
        reason: body.reason ?? null,
      });
      sendJson(res, 200, out);
    } finally {
      db.close();
    }
  });

  /** Resume a paused judge queue; paused jobs requeue from their checkpoints. */
  router.post("/api/judge/queues/:queueId/resume", async (req, res, ctx) => {
    const app = appOf(ctx);
    const body = (await readJsonBody<{ only_kind?: string }>(req).catch(() => ({}))) as {
      only_kind?: string;
    };
    const db = openThemisDb(app.dataDir);
    try {
      const out = resumeJudgeQueue(db, ctx.params.queueId!, {
        onlyKind: (body.only_kind as never) ?? undefined,
      });
      sendJson(res, 200, out);
    } finally {
      db.close();
    }
  });

  /** Queue status: job counts by state and the pause kinds in effect. */
  router.get("/api/judge/queues/:queueId/status", (_req, res, ctx) => {
    const app = appOf(ctx);
    const db = openThemisDb(app.dataDir);
    try {
      sendJson(res, 200, judgeQueueStatus(db, ctx.params.queueId!));
    } finally {
      db.close();
    }
  });

  /**
   * The judge queue linked to this project's eval queue, plus job counts.
   * `queue` is null when the project has not linked one yet.
   */
  router.get("/api/projects/:id/judge-queue", (_req, res, ctx) => {
    const app = appOf(ctx);
    const project = app.queries.getProject(ctx.params.id!);
    if (!project) throw notFound(`project not found: ${ctx.params.id}`);
    const evalQueue = app.queries.listEvalQueues(project.id)[0];
    if (!evalQueue) {
      sendJson(res, 200, { queue: null, status: null, eval_queue_id: null });
      return;
    }
    const db = openThemisDb(app.dataDir);
    try {
      const queue = getLinkedJudgeQueue(db, evalQueue.id);
      sendJson(res, 200, {
        queue,
        eval_queue_id: evalQueue.id,
        status: queue ? judgeQueueStatus(db, queue.id) : null,
      });
    } finally {
      db.close();
    }
  });

  /** Inspect a linked queue's buffered archive count. */
  router.get("/api/judge/queues/:queueId/pending", (_req, res, ctx) => {
    const app = appOf(ctx);
    const db = openThemisDb(app.dataDir);
    try {
      sendJson(res, 200, { pending: countPending(db, ctx.params.queueId!) });
    } finally {
      db.close();
    }
  });

  router.post("/api/judge/runs/:runId/phase1", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const body = (await readJsonBody<{ work_dir?: string; track_id?: string }>(req).catch(
      () => ({}) as { work_dir?: string; track_id?: string },
    )) as { work_dir?: string; track_id?: string };
    const archiveRow = app.queries.getEvalArchive(runId);
    // Adapter setup and eval selection gate Phase 1 too. Checking here names
    // the skipped step instead of failing later inside a judge node.
    if (archiveRow) {
      const blocked = blockingReason(projectReadiness(app.queries, archiveRow.projectId), "phase1");
      if (blocked) throw badRequest(blocked);
    }
    const canonicalDir = archiveRow
      ? join(app.dataDir, "projects", archiveRow.projectId, "evals", runId)
      : null;
    const legacyDir = archiveStoreDir(app.dataDir, runId);
    const { access: canAccess } = await import("node:fs/promises");
    const archiveDir = canonicalDir && (await canAccess(canonicalDir).then(() => true).catch(() => false))
      ? canonicalDir
      : legacyDir;
    // The archive may appear in the catalog a moment before its directory is
    // fully materialized (seal renames the tree). Retry briefly rather than
    // 404-ing on a just-sealed run.
    const { access } = await import("node:fs/promises");
    let ready = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await access(archiveDir);
        ready = true;
        break;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!ready) throw notFound(`sealed archive not found for run ${runId}`);

    const projectModelConfig = archiveRow
      ? projectStoredModelConfig(app.queries.getProject(archiveRow.projectId)?.modelConfig)
      : null;
    const started = await phase1.start({
      runId,
      archiveDir,
      trackId: body.track_id,
      projectModelConfig,
    });
    sendJson(res, 202, { accepted: true, run_id: runId, operation_id: started.operationId });
  });

  /** Poll Phase-1 completion: 200 when a result exists, 202 while still running. */
  router.post("/api/judge/runs/:runId/phase1/pause", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    // Same reason as the project-scoped pause: an unknown run must be a 404, not a
    // 200 that reads like the judge was already stopped.
    if (!app.queries.getRun(runId)) throw notFound("run not found");
    const { pausePiWorkDir } = await import("../judge/pi/runtime.js");
    const primary = join(app.dataDir, "judge_work", `case_${runId}`, "node4");
    let out = await pausePiWorkDir(primary);
    if (!out.killed) out = await pausePiWorkDir(join(app.dataDir, "judge_work", runId));
    sendJson(res, 200, { paused: out.killed, pid: out.pid, run_id: runId, resumable: true });
  });

  /** Resume is POST /api/judge/runs/:runId/phase1 — it --continues the PI session. */

  router.get("/api/judge/runs/:runId/phase1", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    // Always answer immediately. Long-running work must never hold the socket.
    const st = await phase1.status(runId);
    if (st.state === "running") {
      sendJson(res, 202, { accepted: true, run_id: runId, status: "running" });
      return;
    }
    const db = openThemisDb(app.dataDir);
    try {
      const rows = listResultVersionsByRun(db, runId);
      if (rows.length > 0) {
        sendJson(res, 200, { result_version: rows[rows.length - 1] });
      } else {
        sendJson(res, 202, { accepted: false, run_id: runId, status: "not_started" });
      }
    } finally {
      db.close();
    }
  });

  router.get("/api/judge/results/:resultId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const db = openThemisDb(app.dataDir);
    try {
      const row = getResultVersion(db, ctx.params.resultId!);
      if (!row) throw notFound(`result version not found: ${ctx.params.resultId}`);
      sendJson(res, 200, { result: row });
    } finally {
      db.close();
    }
  });

  router.get("/api/judge/runs/:runId/results", (_req, res, ctx) => {
    const app = appOf(ctx);
    const db = openThemisDb(app.dataDir);
    try {
      sendJson(res, 200, {
        run_id: ctx.params.runId,
        results: listResultVersionsByRun(db, ctx.params.runId!),
      });
    } finally {
      db.close();
    }
  });
}

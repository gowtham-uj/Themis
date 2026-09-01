/**
 * WP-13 judge HTTP surfaces — real Phase-1 runner over sealed archives.
 */

import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryStore } from "../db/queries.js";

import { migrate as migrateThemis } from "../db/sqlite/migrate.js";
import { advanceCurrentPointer } from "../db/sqlite/pointers.js";
import { getResultVersion, listResultVersionsByRun, upsertResultVersion } from "../db/sqlite/results.js";
import { ModelGateway } from "../judge/gateway/client.js";
import { loadGatewayConfig } from "../judge/gateway/config.js";
import { runPhase1 } from "../judge/graph/graph.js";
import { publishJudgeArchiveView } from "../judge/results/publish-view.js";
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

/** In-flight phase1 runs keyed by runId: resolved with the result once done. */
const phase1InFlight = new Map<
  string,
  Promise<{ result_version?: unknown; current_pointer?: unknown; paused?: boolean; run_id?: string; reason?: string }>
>();

/** Register judge health + Phase-1 execution routes. */
export function registerJudgeRoutes(router: Router): void {
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
      model: process.env.AGENTEVAL_DEFAULT_MODEL || "deepseek-v4-flash",
      reasoning_effort: process.env.THEMIS_REASONING_EFFORT || "max",
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

    let gateway: ModelGateway;
    try {
      gateway = ModelGateway.fromEnv();
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }

    // Stable per-run work/session path. Re-posting after a quota/rate-limit
    // pause resumes the exact PI session via --continue; it never starts the
    // courtroom from scratch. Callers may still supply an explicit work_dir.
    const workDir =
      typeof body.work_dir === "string" && body.work_dir.length > 0
        ? body.work_dir
        : join(app.dataDir, "judge_work", runId);
    const viewDir = join(app.dataDir, "judge_views", runId);
    const { mkdir: ensureDir } = await import("node:fs/promises");
    await ensureDir(workDir, { recursive: true });
    await ensureDir(viewDir, { recursive: true });

    // Phase-1 is a minutes-long model pipeline. Return 202 immediately and run
    // in the background — holding an HTTP response open across model calls is
    // exactly the pattern the design forbids (and trips client header timeouts).
    let existing = phase1InFlight.get(runId);
    if (!existing) {
      const task = (async () => {
        let state;
        try {
          state = await runPhase1({
            caseId: `case_${runId}`,
            runId,
            archiveDir,
            workDir,
            gateway,
            attemptId: `att_${runId}_${Date.now()}`,
            // Real PI courtroom wired to the same saved connection object.
            pi: {
              baseUrl: process.env.OPENAI_BASE_URL ?? "",
              apiKey: process.env.OPENAI_API_KEY ?? "",
              model: process.env.AGENTEVAL_DEFAULT_MODEL || "deepseek-v4-flash",
              reasoningEffort: process.env.THEMIS_REASONING_EFFORT || "max",
            },
          });
        } catch (err) {
          // A provider throttle must NOT be surfaced as a crash: pause any
          // linked judge queue without consuming a retry, so a later resume
          // continues from the committed checkpoint.
          const { ProviderThrottledError } = await import("../judge/gateway/client.js");
          if (err instanceof ProviderThrottledError) {
            const { pauseJudgeQueue } = await import("../judge/ingest/pause.js");
            const { getLinkedJudgeQueue } = await import("../judge/ingest/store.js");
            const db = openThemisDb(app.dataDir);
            try {
              const q = getLinkedJudgeQueue(db, runId) ?? db
                .prepare(`SELECT id FROM judge_queues WHERE project_id = (SELECT project_id FROM judge_jobs WHERE run_id = ? LIMIT 1) LIMIT 1`)
                .get(runId) as { id: string } | undefined;
              if (q) {
                pauseJudgeQueue(db, q.id, {
                  kind: err.throttleKind === "quota" ? "provider_quota" : "provider_rate_limit",
                  reason: err.message,
                });
              }
            } finally {
              db.close();
            }
            return { paused: true, run_id: runId, reason: err.message };
          }
          throw err;
        }

        const published = await publishJudgeArchiveView({
          runId,
          trackId: body.track_id || "default",
          baseArchiveDir: archiveDir,
          // The mediated tools write under THEMIS_JUDGE_DIR = workDir/node4,
          // so the court records live at node4/judge.
          judgeDir: join(workDir, "node4", "judge"),
          viewDir,
          // PI orchestrator + subagent session logs -> judge_traces/
          traceDir: join(workDir, "node4"),
        });

        const db = openThemisDb(app.dataDir);
        try {
          const stored = upsertResultVersion(db, published.result);
          const pointer = advanceCurrentPointer(db, {
            runId,
            trackId: stored.trackId,
            resultVersionId: stored.id,
            archiveViewPath: stored.archiveViewPath ?? viewDir,
            baseManifestSha256: stored.reportSha256,
            expectedResultVersionId: null,
          });
          return { result_version: stored, current_pointer: pointer };
        } finally {
          db.close();
        }
      })().finally(() => {
        phase1InFlight.delete(runId);
      });
      existing = task;
      phase1InFlight.set(runId, existing);
    }
    sendJson(res, 202, { accepted: true, run_id: runId });
  });

  /** Poll Phase-1 completion: 200 when a result exists, 202 while still running. */
  router.post("/api/judge/runs/:runId/phase1/pause", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const { pausePiWorkDir } = await import("../judge/pi/runtime.js");
    const primary = join(app.dataDir, "judge_work", `case_${runId}`, "node4");
    let out = await pausePiWorkDir(primary);
    if (!out.killed) out = await pausePiWorkDir(join(app.dataDir, "judge_work", runId));
    sendJson(res, 200, { paused: out.killed, pid: out.pid, run_id: runId, resumable: true });
  });

  /** Resume is POST /api/judge/runs/:runId/phase1 — it --continues the PI session. */

  router.get("/api/judge/runs/:runId/phase1", (_req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    // Always answer immediately. Long-running work must never hold the socket.
    if (phase1InFlight.has(runId)) {
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

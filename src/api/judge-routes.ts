/**
 * WP-13 judge HTTP surfaces — real Phase-1 runner over sealed archives.
 */

import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate as migrateThemis } from "../db/sqlite/migrate.js";
import { advanceCurrentPointer } from "../db/sqlite/pointers.js";
import { getResultVersion, listResultVersionsByRun, upsertResultVersion } from "../db/sqlite/results.js";
import { ModelGateway } from "../judge/gateway/client.js";
import { loadGatewayConfig } from "../judge/gateway/config.js";
import { runPhase1 } from "../judge/graph/graph.js";
import { publishJudgeArchiveView } from "../judge/results/publish-view.js";
import { archiveStoreDir } from "../runner/archive-store.js";
import { badRequest, notFound } from "./errors.js";
import { readJsonBody, sendJson, type Router } from "./router.js";

type App = { dataDir: string };

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
  Promise<{ result_version: unknown; current_pointer: unknown }>
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

  router.post("/api/judge/runs/:runId/phase1", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const body = (await readJsonBody<{ work_dir?: string; track_id?: string }>(req).catch(
      () => ({}) as { work_dir?: string; track_id?: string },
    )) as { work_dir?: string; track_id?: string };
    const archiveDir = archiveStoreDir(app.dataDir, runId);
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

    const workDir =
      typeof body.work_dir === "string" && body.work_dir.length > 0
        ? body.work_dir
        : await mkdtemp(join(tmpdir(), "ae-judge-"));
    const viewDir = await mkdtemp(join(tmpdir(), "ae-judge-view-"));

    // Phase-1 is a minutes-long model pipeline. Return 202 immediately and run
    // in the background — holding an HTTP response open across model calls is
    // exactly the pattern the design forbids (and trips client header timeouts).
    let existing = phase1InFlight.get(runId);
    if (!existing) {
      const task = (async () => {
        const state = await runPhase1({
          caseId: `case_${runId}`,
          runId,
          archiveDir,
          workDir,
          gateway,
          attemptId: `att_${runId}_${Date.now()}`,
        });

        const published = await publishJudgeArchiveView({
          runId,
          trackId: body.track_id || "default",
          baseArchiveDir: archiveDir,
          judgeDir: join(workDir, "judge"),
          viewDir,
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

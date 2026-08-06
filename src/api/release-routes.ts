/**
 * Release routes — the batch-level (per-tagged-version) view.
 *
 * GET /api/projects/:id/releases                → list evaluated releases
 * GET /api/batches/:batchId/release             → the release verdict JSON
 * GET /api/batches/:batchId/release/report      → the release HTML report
 * POST /api/batches/:batchId/release            → (re)build the rollup now
 *
 * A release is a batch: one run per eval task, all triggered by the same tagged
 * commit. The rollup normally happens automatically when the last run finishes;
 * the POST exists for rebuilding after a re-judge, and for batches that
 * completed before rollups existed.
 *
 * Auth is a wrapping concern; these handlers do not check tokens.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbQueries } from "../db/queries.js";
import { batchProgress } from "../judge/batch-completion.js";
import { releaseDir, runReleaseRollup, type AutoJudgeDeps } from "./auto-judge.js";
import { badRequest, notFound } from "./errors.js";
import { sendJson, type RequestContext, type Router } from "./router.js";
import { serveHtmlFile } from "./judgements-routes.js";

/** Minimal AppCtx surface these routes need. */
export interface ReleaseAppCtx {
  queries: DbQueries;
  dataDir: string;
  judgeRunner?: unknown;
  batchClaims: { claim(id: string): boolean; release(id: string): void };
  defaultJudgeModel?: string;
  defaultJudgeProvider?: string;
  defaultSystemPromptVersion?: string;
}

function appOf(ctx: RequestContext): ReleaseAppCtx {
  return ctx.app as ReleaseAppCtx;
}

function depsOf(app: ReleaseAppCtx): AutoJudgeDeps {
  return {
    queries: app.queries,
    dataDir: app.dataDir,
    claims: app.batchClaims,
  };
}

/** Runs of a batch, or 404 when the batch has none (or does not exist). */
function requireBatchRuns(queries: DbQueries, batchId: string) {
  const runs = queries.listRuns({ batchId });
  if (runs.length === 0) throw notFound(`batch not found: ${batchId}`);
  return runs;
}

export function registerReleaseRoutes(router: Router): void {
  // Every batch in a project, newest first, with rollup availability.
  router.get("/api/projects/:id/releases", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const project = app.queries.getProject(projectId);
    if (!project) throw notFound(`project not found: ${projectId}`);

    const byBatch = new Map<string, ReturnType<DbQueries["listRuns"]>>();
    for (const run of app.queries.listRuns({ projectId })) {
      const list = byBatch.get(run.batchId);
      if (list) list.push(run);
      else byBatch.set(run.batchId, [run]);
    }

    const releases = [...byBatch.entries()]
      .map(([batchId, runs]) => {
        const p = batchProgress(runs, batchId);
        const first = runs[0]!;
        const startedAt = runs.reduce(
          (m, r) => (r.startedAt && r.startedAt > m ? r.startedAt : m),
          "",
        );
        return {
          batch_id: batchId,
          project_id: projectId,
          agent_id: first.agentId,
          model: first.model,
          provider: first.provider,
          release_ref: first.triggerRef ?? null,
          started_at: startedAt || null,
          runs_total: p.total,
          runs_terminal: p.terminal,
          runs_completed: p.completed,
          runs_failed: p.failed,
          done: p.done,
          // Whether a rollup has actually been produced for this batch.
          has_report: existsSync(
            join(releaseDir(app.dataDir, projectId, batchId), "release.json"),
          ),
        };
      })
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));

    sendJson(res, 200, { releases });
  });

  // The release verdict itself.
  router.get("/api/batches/:batchId/release", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const path = join(
      releaseDir(app.dataDir, runs[0]!.projectId, batchId),
      "release.json",
    );
    if (!existsSync(path)) {
      const p = batchProgress(runs, batchId);
      throw notFound(
        p.done
          ? `no release rollup for batch ${batchId} (POST to build it)`
          : `batch ${batchId} is still running (${p.terminal}/${p.total} runs finished)`,
      );
    }
    const text = await readFile(path, "utf8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.end(text);
  });

  // The rendered report.
  router.get("/api/batches/:batchId/release/report", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const path = join(
      releaseDir(app.dataDir, runs[0]!.projectId, batchId),
      "release.html",
    );
    if (!existsSync(path)) {
      throw notFound(`no release report for batch ${batchId}`);
    }
    const download =
      ctx.query.download === "1" || ctx.query.download === "true";
    await serveHtmlFile(res, path, {
      download,
      filename: `release-${batchId}.html`,
    });
  });

  // Build (or rebuild) the rollup on demand.
  router.post("/api/batches/:batchId/release", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const p = batchProgress(runs, batchId);
    const force = ctx.query.force === "1" || ctx.query.force === "true";
    if (!p.done && !force) {
      throw badRequest(
        `batch ${batchId} is still running (${p.terminal}/${p.total} runs finished); pass ?force=1 to build anyway`,
      );
    }
    const verdict = await runReleaseRollup(
      depsOf(app),
      runs[0]!.projectId,
      batchId,
    );
    sendJson(res, 200, {
      batch_id: batchId,
      report_url: `/api/batches/${encodeURIComponent(batchId)}/release/report`,
      overall: verdict.overall,
      recurring_defects: verdict.recurringDefects.length,
    });
  });
}

/**
 * Regression-views REST routes (P7b-api).
 *
 * GET /api/projects/:id/tasks/:taskId/trend     → score trend + finding deltas
 * GET /api/projects/:id/compare/runs?a=&b=      → two-run compare + provenance
 * GET /api/projects/:id/compare/releases?from=&to= → release compare + versions
 *
 * Joins QueryStore rows into pure compute inputs (src/regression) via
 * regression-join.ts. Spec: plan/api.md §Trends + comparison.
 */

import type {
  DbQueries,
  Project,
  Run,
  Task,
} from "../db/queries.js";
import {
  batchStats,
  compareTwoRuns,
  releaseCompare,
  scoreTrend,
  type FindingInstance,
  type RunCompare,
  type ReleaseCompare,
} from "../regression/index.js";
import { badRequest, notFound } from "./errors.js";
import {
  buildReleaseSide,
  buildRunCompareSide,
  buildTrendPoints,
  latestCompletedJudgement,
  runsForVersion,
} from "./regression-join.js";
import { sendJson, type RequestContext, type Router } from "./router.js";

// ---------------------------------------------------------------------------
// Wire types (API envelopes consumed by the UI client)
// ---------------------------------------------------------------------------

/** FindingInstance on the wire — plain JSON, refs already decoded. */
export interface FindingInstanceApi {
  fingerprint: string;
  category: string;
  kind: string;
  severity: string;
  claim: string;
  refs: object[];
  occurrenceStatus: "introduced" | "persisted" | "resolved" | string;
  runId: string;
  judgementId: string;
}

/** One annotated point on the per-task trend. */
export interface TrendPointApi {
  order: number;
  runId: string;
  judgementId: string;
  overallScore: number | null;
  verdict: "pass" | "fail" | "partial" | null;
  batchId: string;
  createdAt: string;
  findingDeltas: {
    introduced: FindingInstanceApi[];
    resolved: FindingInstanceApi[];
  };
  batchStats?: { mean: number; spread: number; n: number };
}

/** Provenance block for one side of a two-run compare. */
export interface RunCompareProvenance {
  runId: string;
  judgementId: string;
  agentCommit?: string;
  triggerRef?: string;
  overallScore: number | null;
  verdict: "pass" | "fail" | "partial" | null;
}

/** GET .../compare/runs envelope (compute result + provenance; findings on wire). */
export interface RunCompareApi {
  deltaOverall: number | null;
  perCriterion: RunCompare["perCriterion"];
  findingSetDiff: {
    introduced: FindingInstanceApi[];
    resolved: FindingInstanceApi[];
    persisted: FindingInstanceApi[];
  };
  diagnosticDeltas: RunCompare["diagnosticDeltas"];
  a: RunCompareProvenance;
  b: RunCompareProvenance;
}

/** GET .../compare/releases envelope. */
export type ReleaseCompareApi = ReleaseCompare & {
  fromVersion: string;
  toVersion: string;
  fromTasks: number;
  toTasks: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal AppCtx surface needed by regression routes. */
export interface RegressionAppCtx {
  queries: DbQueries;
  dataDir: string;
}

function appOf(ctx: RequestContext): RegressionAppCtx {
  return ctx.app as RegressionAppCtx;
}

function requireProject(queries: DbQueries, id: string): Project {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

function requireTask(
  queries: DbQueries,
  projectId: string,
  taskId: string,
): Task {
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

/** Serialize FindingInstance[] for JSON (refs are already plain objects). */
function findingApi(f: FindingInstance): FindingInstanceApi {
  return {
    fingerprint: f.fingerprint,
    category: f.category,
    kind: f.kind,
    severity: f.severity,
    claim: f.claim,
    refs: f.refs as object[],
    occurrenceStatus: f.occurrenceStatus,
    runId: f.runId,
    judgementId: f.judgementId,
  };
}

function provenance(
  run: Run,
  side: {
    judgement: {
      judgementId: string;
      overallScore: number | null;
      verdict: "pass" | "fail" | "partial" | null;
    };
  },
): RunCompareProvenance {
  const out: RunCompareProvenance = {
    runId: run.id,
    judgementId: side.judgement.judgementId,
    overallScore: side.judgement.overallScore,
    verdict: side.judgement.verdict,
  };
  if (run.agentCommit) out.agentCommit = run.agentCommit;
  if (run.triggerRef) out.triggerRef = run.triggerRef;
  return out;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register regression-view routes on an existing Router.
 * Called from createServer next to registerFindingsRoutes.
 */
export function registerRegressionRoutes(router: Router): void {
  // GET /api/projects/:id/tasks/:taskId/trend
  router.get(
    "/api/projects/:id/tasks/:taskId/trend",
    (_req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const taskId = ctx.params.taskId!;
      requireProject(app.queries, projectId);
      requireTask(app.queries, projectId, taskId);

      const runs = app.queries.listRuns({ projectId, taskId });
      const joinPoints = buildTrendPoints(runs, app.queries);
      const trend = scoreTrend(joinPoints);

      // Optional batchStats: mean/spread/n over scores sharing the same batchId.
      const scoresByBatch = new Map<string, number[]>();
      for (const jp of joinPoints) {
        if (jp.judgement.overallScore === null) continue;
        const arr = scoresByBatch.get(jp.batchId) ?? [];
        arr.push(jp.judgement.overallScore);
        scoresByBatch.set(jp.batchId, arr);
      }
      const joinByJudgement = new Map(
        joinPoints.map((jp) => [jp.judgement.judgementId, jp]),
      );

      const points: TrendPointApi[] = trend.map((p) => {
        const jp = joinByJudgement.get(p.judgementId);
        const batchId = jp?.batchId ?? "";
        const createdAt = jp?.createdAt ?? jp?.judgement.createdAt ?? "";
        const scores = scoresByBatch.get(batchId) ?? [];
        const stats = scores.length > 0 ? batchStats(scores) : null;
        const point: TrendPointApi = {
          order: p.order,
          runId: p.runId,
          judgementId: p.judgementId,
          overallScore: p.overallScore,
          verdict: p.verdict,
          batchId,
          createdAt,
          findingDeltas: {
            introduced: p.findingDeltas.introduced.map(findingApi),
            resolved: p.findingDeltas.resolved.map(findingApi),
          },
        };
        if (stats && stats.n > 0) {
          point.batchStats = {
            mean: stats.mean,
            spread: stats.spread,
            n: stats.n,
          };
        }
        return point;
      });

      // Defensive: oldest-first by createdAt (buildTrendPoints already ordered).
      points.sort((a, b) => {
        const c = a.createdAt.localeCompare(b.createdAt);
        if (c !== 0) return c;
        return a.order - b.order;
      });

      sendJson(res, 200, { points });
    },
  );

  // GET /api/projects/:id/compare/runs?a=&b=
  router.get("/api/projects/:id/compare/runs", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const aId = ctx.query.a?.trim() || "";
    const bId = ctx.query.b?.trim() || "";
    if (!aId || !bId) {
      throw badRequest("query params a and b (run ids) are required");
    }

    const runA = requireRun(app.queries, aId);
    const runB = requireRun(app.queries, bId);

    // Runs must belong to this project.
    if (runA.projectId !== projectId) {
      throw notFound(`run not found: ${aId}`);
    }
    if (runB.projectId !== projectId) {
      throw notFound(`run not found: ${bId}`);
    }

    const jA = latestCompletedJudgement(app.queries, runA.id);
    if (!jA) {
      throw notFound(`no completed judgement for run: ${aId}`);
    }
    const jB = latestCompletedJudgement(app.queries, runB.id);
    if (!jB) {
      throw notFound(`no completed judgement for run: ${bId}`);
    }

    const sideA = buildRunCompareSide(jA, runA, app.queries);
    const sideB = buildRunCompareSide(jB, runB, app.queries);
    const result = compareTwoRuns(sideA, sideB);

    // Serialize findings in set-diff for wire (refs as plain objects).
    const body = {
      deltaOverall: result.deltaOverall,
      perCriterion: result.perCriterion,
      findingSetDiff: {
        introduced: result.findingSetDiff.introduced.map(findingApi),
        resolved: result.findingSetDiff.resolved.map(findingApi),
        persisted: result.findingSetDiff.persisted.map(findingApi),
      },
      diagnosticDeltas: result.diagnosticDeltas,
      a: provenance(runA, sideA),
      b: provenance(runB, sideB),
    } satisfies RunCompareApi;
    sendJson(res, 200, body);
  });

  // GET /api/projects/:id/compare/releases?from=&to=
  router.get("/api/projects/:id/compare/releases", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const from = ctx.query.from?.trim() || "";
    const to = ctx.query.to?.trim() || "";
    if (!from || !to) {
      throw badRequest("query params from and to (agent versions) are required");
    }
    if (from === to) {
      throw badRequest("from and to must be different versions");
    }

    // Partition: a run belongs to a version if agentCommit OR triggerRef matches.
    // Runs matching neither are excluded from both releases.
    const allRuns = app.queries.listRuns({ projectId });
    const fromRuns = runsForVersion(allRuns, from);
    const toRuns = runsForVersion(allRuns, to);

    if (fromRuns.length === 0) {
      throw badRequest(`no runs for version ${from}`);
    }
    if (toRuns.length === 0) {
      throw badRequest(`no runs for version ${to}`);
    }

    const fromSide = buildReleaseSide(from, fromRuns, app.queries);
    const toSide = buildReleaseSide(to, toRuns, app.queries);
    const result = releaseCompare(fromSide, toSide);

    const body: ReleaseCompareApi = {
      ...result,
      fromVersion: from,
      toVersion: to,
      fromTasks: fromSide.taskResults.length,
      toTasks: toSide.taskResults.length,
    };
    sendJson(res, 200, body);
  });
}

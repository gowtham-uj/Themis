/**
 * Improvement API — the surface an EXTERNAL agent consumes.
 *
 * GET /api/evaluations/:batchId/improvements   the plan for one evaluation
 * GET /api/projects/:id/improvements           the current plan for a project
 * GET /api/projects/:id/chronic                defects that resist fixing
 * POST /api/evaluations/:batchId/verify        re-run a step's verification set
 *
 * The consuming agent runs elsewhere and only ever sees this API, so these
 * endpoints are shaped for a machine reader rather than a report viewer: no
 * HTML, no digging through a release verdict for the one array that matters,
 * and every step carries the exact call needed to prove its fix worked.
 *
 * Read-only except `verify`, which starts an evaluation of an existing commit
 * against a subset of evals — the same operation as /evaluate, aimed at the
 * tasks a plan step said to re-run.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DbQueries, Run } from "../db/queries.js";
import { batchProgress } from "../judge/batch-completion.js";
import type { ReleaseVerdict } from "../judge/release-verdict.js";
import { releaseDir } from "./auto-judge.js";
import { badRequest, notFound } from "./errors.js";
import { readJsonBody, sendJson, type RequestContext, type Router } from "./router.js";

/** Minimal AppCtx surface these routes need. */
export interface ImprovementAppCtx {
  queries: DbQueries;
  dataDir: string;
}

function appOf(ctx: RequestContext): ImprovementAppCtx {
  return ctx.app as ImprovementAppCtx;
}

function requireBatchRuns(queries: DbQueries, batchId: string): Run[] {
  const runs = queries.listRuns({ batchId });
  if (runs.length === 0) throw notFound(`evaluation not found: ${batchId}`);
  return runs;
}

/** Load a stored release verdict, or null when the rollup has not run. */
async function loadVerdict(
  dataDir: string,
  projectId: string,
  batchId: string,
): Promise<ReleaseVerdict | null> {
  const path = join(releaseDir(dataDir, projectId, batchId), "release.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as ReleaseVerdict;
  } catch {
    return null;
  }
}

/**
 * The plan, shaped for a machine.
 *
 * Each step is self-contained: what to change, where, why, and the literal
 * request that proves it worked. A consuming agent should never have to
 * assemble a follow-up call by hand — that is where "re-run the affected
 * tests" quietly becomes "re-run everything" or "re-run nothing".
 */
function planJson(
  v: ReleaseVerdict,
  batchId: string,
  projectId: string,
): Record<string, unknown> {
  return {
    evaluation_id: batchId,
    project_id: projectId,
    agent_id: v.agentId,
    commit: v.releaseRef,
    generated_at: v.generatedAt,
    overall: {
      score: v.overall.score,
      evals_passed: v.overall.tasksPassed,
      evals_judged: v.overall.tasksJudged,
      evals_total: v.overall.tasksTotal,
    },
    // Where the work is concentrated, so a consumer can decide what kind of
    // change it is even attempting before reading individual steps.
    subsystem_load: v.subsystemLoad.map((s) => ({
      subsystem: s.subsystem,
      defects: s.defectCount,
      evals_affected: s.evalsAffected,
      top_defect: s.topDefect,
    })),
    steps: v.improvementPlan.map((s) => ({
      rank: s.rank,
      subsystem: s.subsystem,
      change: s.change,
      rationale: s.rationale,
      evals_blocked: s.evalsBlocked,
      estimated_score_gain: s.estimatedScoreGain,
      // Previous fixes did not work — patching again is the wrong move.
      chronic: s.chronic,
      verification: {
        target_task_ids: s.verifyTaskIds,
        regression_task_ids: s.regressionTaskIds,
        // The exact call that proves this step worked.
        request: {
          method: "POST",
          path: `/api/projects/${projectId}/evaluate`,
          body: {
            commit: v.releaseRef,
            taskIds: [...s.verifyTaskIds, ...s.regressionTaskIds],
            agentId: v.agentId,
            label: `verify: ${s.change.slice(0, 60)}`,
          },
        },
      },
    })),
    // Reliability is separate from the plan because it changes WHAT KIND of
    // fix applies, not which defect to fix first.
    reliability: v.reliability
      .filter((r) => r.verdict === "flaky" || r.verdict === "reliable_fail")
      .map((r) => ({
        task_id: r.taskId,
        eval_name: r.evalName,
        kind: r.verdict,
        passes: r.passes,
        attempts: r.attempts,
        pass_rate: r.passRate,
        score_range: r.scoreRange,
      })),
    regressions_explained: v.explainedRegressions.map((r) => ({
      task_id: r.taskId,
      eval_name: r.evalName,
      before: r.baselineScore,
      after: r.candidateScore,
      diverged_at_seq: r.divergence.divergedAtCandidateSeq,
      common_prefix_steps: r.divergence.commonPrefixLength,
      summary: r.divergence.summary,
      tools_only_in_passing_run: r.divergence.toolsOnlyInBaseline,
    })),
  };
}

/** Newest evaluation of a project that has a rollup on disk. */
async function newestEvaluationWithPlan(
  app: ImprovementAppCtx,
  projectId: string,
): Promise<{ batchId: string; verdict: ReleaseVerdict } | null> {
  const byBatch = new Map<string, Run[]>();
  for (const run of app.queries.listRuns({ projectId })) {
    const list = byBatch.get(run.batchId);
    if (list) list.push(run);
    else byBatch.set(run.batchId, [run]);
  }
  const ordered = [...byBatch.entries()].sort((a, b) => {
    const ta = a[1].reduce((m, r) => (r.startedAt && r.startedAt > m ? r.startedAt : m), "");
    const tb = b[1].reduce((m, r) => (r.startedAt && r.startedAt > m ? r.startedAt : m), "");
    return tb.localeCompare(ta);
  });
  for (const [batchId] of ordered) {
    const verdict = await loadVerdict(app.dataDir, projectId, batchId);
    if (verdict) return { batchId, verdict };
  }
  return null;
}

export function registerImprovementRoutes(router: Router): void {
  // The plan for one evaluation.
  router.get("/api/evaluations/:batchId/improvements", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const projectId = runs[0]!.projectId;

    const verdict = await loadVerdict(app.dataDir, projectId, batchId);
    if (!verdict) {
      const p = batchProgress(runs, batchId);
      throw notFound(
        p.done
          ? `no improvement plan for evaluation ${batchId} (POST /api/batches/${batchId}/release to build it)`
          : `evaluation ${batchId} is still running (${p.terminal}/${p.total} evals finished)`,
      );
    }
    sendJson(res, 200, planJson(verdict, batchId, projectId));
  });

  // The current plan for a project — the newest evaluation that has one.
  router.get("/api/projects/:id/improvements", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    if (!app.queries.getProject(projectId)) {
      throw notFound(`project not found: ${projectId}`);
    }
    const found = await newestEvaluationWithPlan(app, projectId);
    if (!found) {
      throw notFound(`no evaluation with an improvement plan for ${projectId}`);
    }
    sendJson(res, 200, planJson(found.verdict, found.batchId, projectId));
  });

  /**
   * Defects that have resisted fixing across evaluations.
   *
   * Separate from the plan because it answers a different question: not "what
   * next" but "what have we been failing to fix" — the cue to change approach
   * rather than attempt another patch.
   */
  router.get("/api/projects/:id/chronic", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    if (!app.queries.getProject(projectId)) {
      throw notFound(`project not found: ${projectId}`);
    }
    const found = await newestEvaluationWithPlan(app, projectId);
    if (!found) {
      sendJson(res, 200, { project_id: projectId, chronic_defects: [] });
      return;
    }
    const chronic = found.verdict.rankedDefects.filter(
      (d) => d.persistence?.chronic === true,
    );
    sendJson(res, 200, {
      project_id: projectId,
      evaluation_id: found.batchId,
      chronic_defects: chronic.map((d) => ({
        fingerprint: d.fingerprint,
        category: d.category,
        claim: d.claim,
        severity: d.severity,
        subsystem: d.subsystem,
        evals_blocked: d.evalsBlocked,
        task_ids: d.taskIds,
        evaluations_survived: d.persistence?.evaluationCount ?? 0,
      })),
    });
  });

  /**
   * Re-run a plan step's verification set.
   *
   * Convenience over /evaluate: the consuming agent names the step it applied
   * and the commit it applied the fix to, and the platform works out which
   * evals prove it — rather than the agent reassembling that list and getting
   * it subtly wrong.
   */
  router.post("/api/evaluations/:batchId/verify", async (req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const projectId = runs[0]!.projectId;

    const verdict = await loadVerdict(app.dataDir, projectId, batchId);
    if (!verdict) throw notFound(`no improvement plan for evaluation ${batchId}`);

    const body = await readJsonBody<{
      step?: number;
      rank?: number;
      commit?: string;
      agentId?: string;
      agent_id?: string;
    }>(req);

    const rank = body.step ?? body.rank;
    if (typeof rank !== "number") {
      throw badRequest("step (the plan step's rank) is required");
    }
    const step = verdict.improvementPlan.find((s) => s.rank === rank);
    if (!step) {
      throw badRequest(
        `no step with rank ${rank} (plan has ${verdict.improvementPlan.length} step(s))`,
      );
    }

    // The commit carrying the fix — NOT the one that was evaluated. Verifying
    // against the original commit would re-measure the defect, not the fix.
    const commit = body.commit;
    if (!commit) {
      throw badRequest(
        "commit is required — the revision containing the fix, not the one this plan came from",
      );
    }

    sendJson(res, 200, {
      evaluation_id: batchId,
      project_id: projectId,
      step: rank,
      change: step.change,
      // Deliberately does NOT start the run itself: the consumer chose the
      // commit, and it should be the thing that triggers work against it.
      next: {
        method: "POST",
        path: `/api/projects/${projectId}/evaluate`,
        body: {
          commit,
          taskIds: [...step.verifyTaskIds, ...step.regressionTaskIds],
          agentId: body.agentId ?? body.agent_id ?? verdict.agentId,
          label: `verify step ${rank}: ${step.change.slice(0, 60)}`,
        },
      },
      success_criterion: {
        must_start_passing: step.verifyTaskIds,
        must_keep_passing: step.regressionTaskIds,
      },
    });
  });
}

/**
 * Commit evaluation — run a project's eval suite against a specific revision.
 *
 * POST /api/projects/:id/evaluate      → evaluate a commit/ref/PR head
 * GET  /api/projects/:id/evaluations   → past evaluations, newest first
 * GET  /api/evaluations/:batchId       → one evaluation's status + results
 * GET  /api/evaluations/:batchId/report → its HTML report
 *
 * This is the platform's primary entry point: "here is a commit, run the evals
 * against it." A tagged release is one caller of this, not the concept itself —
 * the same call works for a PR head, an arbitrary sha, or a branch tip you want
 * to measure before merging.
 *
 * One evaluation = one batch = one run per selected eval task, all pinned to the
 * same revision. Pinning at the RUN level (rather than editing task definitions)
 * is what lets the same suite be aimed at any revision without mutating it.
 *
 * Auth is a wrapping concern; these handlers do not check tokens.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DbQueries, Run, Task } from "../db/queries.js";
import { batchProgress } from "../judge/batch-completion.js";
import { collectBatchBundles, summarizeBundles } from "../judge/eval-bundle.js";
import { releaseDir } from "./auto-judge.js";
import { badRequest, notFound } from "./errors.js";
import { readJsonBody, sendJson, type RequestContext, type Router } from "./router.js";
import { serveHtmlFile } from "./judgements-routes.js";
import { GitHubClient, parseRepoRef } from "./github.js";

/** Minimal AppCtx surface these routes need. */
export interface CommitEvalAppCtx {
  queries: DbQueries;
  dataDir: string;
  enqueueStart: (runId: string) => void | Promise<void>;
  /** Injected in tests; production builds one from settings/env. */
  githubClient?: GitHubClient;
}

function appOf(ctx: RequestContext): CommitEvalAppCtx {
  return ctx.app as CommitEvalAppCtx;
}

/** Body of POST /evaluate. */
interface EvaluateBody {
  /** Commit sha, tag, or branch to evaluate. */
  commit?: string;
  ref?: string;
  sha?: string;
  /** Repo override; defaults to whatever each task already points at. */
  repo?: string;
  /** Which evals to run: explicit ids, tag filter, or all (default). */
  taskIds?: string[];
  task_ids?: string[];
  tags?: string[];
  /** Agent under test. */
  agentId?: string;
  agent_id?: string;
  agent?: string;
  model?: string;
  provider?: string;
  /** Repeats per eval (default 1) — for measuring run-to-run variance. */
  repeats?: number;
  /** Free-form label shown in the evaluations list (e.g. "PR #482"). */
  label?: string;
  adapterOverrides?: Record<string, unknown>;
  adapter_overrides?: Record<string, unknown>;
}

/** Pick the eval tasks this evaluation covers. */
function selectTasks(
  queries: DbQueries,
  projectId: string,
  body: EvaluateBody,
): Task[] {
  const all = queries.listTasks(projectId).filter((t) => !t.archived);
  const explicit = body.taskIds ?? body.task_ids;

  if (explicit && explicit.length > 0) {
    const byId = new Map(all.map((t) => [t.id, t]));
    const byExternal = new Map(
      all.filter((t) => t.externalId).map((t) => [t.externalId!, t]),
    );
    const picked: Task[] = [];
    const missing: string[] = [];
    for (const id of explicit) {
      const t = byId.get(id) ?? byExternal.get(id);
      if (t) picked.push(t);
      else missing.push(id);
    }
    // Silently skipping a requested eval would understate the suite — the
    // caller asked for coverage they did not get.
    if (missing.length > 0) {
      throw badRequest(`unknown task(s): ${missing.join(", ")}`);
    }
    return picked;
  }

  if (body.tags && body.tags.length > 0) {
    return all.filter((t) =>
      body.tags!.every((tag) => (t.tags ?? []).includes(tag)),
    );
  }
  return all;
}

/** Wire shape for one evaluation (a batch). */
function evaluationJson(
  dataDir: string,
  projectId: string,
  batchId: string,
  runs: readonly Run[],
): Record<string, unknown> {
  const p = batchProgress(runs, batchId);
  const first = runs[0];
  const startedAt = runs.reduce(
    (m, r) => (r.startedAt && r.startedAt > m ? r.startedAt : m),
    "",
  );
  return {
    evaluation_id: batchId,
    project_id: projectId,
    // What was actually evaluated — the whole point of this surface.
    commit: first?.workspaceCommit ?? null,
    requested_ref: first?.workspaceRef ?? null,
    repo: first?.workspaceRepo ?? null,
    label: first?.triggerRef ?? null,
    agent_id: first?.agentId ?? null,
    model: first?.model ?? null,
    provider: first?.provider ?? null,
    started_at: startedAt || null,
    evals_total: p.total,
    evals_finished: p.terminal,
    evals_completed: p.completed,
    evals_failed: p.failed,
    done: p.done,
    has_report: existsSync(
      join(releaseDir(dataDir, projectId, batchId), "release.html"),
    ),
    report_url: `/api/evaluations/${encodeURIComponent(batchId)}/report`,
  };
}

/** Group a project's runs into evaluations (batches). */
function evaluationsOf(
  queries: DbQueries,
  dataDir: string,
  projectId: string,
): Array<Record<string, unknown>> {
  const byBatch = new Map<string, Run[]>();
  for (const run of queries.listRuns({ projectId })) {
    const list = byBatch.get(run.batchId);
    if (list) list.push(run);
    else byBatch.set(run.batchId, [run]);
  }
  return [...byBatch.entries()]
    .map(([batchId, runs]) =>
      evaluationJson(dataDir, projectId, batchId, runs),
    )
    .sort((a, b) =>
      String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")),
    );
}

/** The repo this project's eval tasks target, if any. */
function repoOfTasks(queries: DbQueries, projectId: string): string | null {
  for (const t of queries.listTasks(projectId)) {
    if (!t.archived && t.workspace.source === "git" && t.workspace.repo) {
      return t.workspace.repo;
    }
  }
  return null;
}

/** GitHub client for ref resolution; tests inject one on the app context. */
function clientFor(app: CommitEvalAppCtx): GitHubClient {
  return app.githubClient ?? new GitHubClient();
}

function requireBatchRuns(queries: DbQueries, batchId: string): Run[] {
  const runs = queries.listRuns({ batchId });
  if (runs.length === 0) throw notFound(`evaluation not found: ${batchId}`);
  return runs;
}

export function registerCommitEvalRoutes(router: Router): void {
  // Evaluate a commit.
  router.post("/api/projects/:id/evaluate", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const project = app.queries.getProject(projectId);
    if (!project || project.archived) {
      throw notFound(`project not found: ${projectId}`);
    }

    const body = await readJsonBody<EvaluateBody>(req);
    const commit = (body.commit ?? body.ref ?? body.sha ?? "").trim();
    if (!commit) {
      throw badRequest("commit (or ref/sha) is required");
    }

    // Resolve to a concrete sha before running anything. A branch name means
    // something different next week, so an evaluation pinned to a ref would not
    // be reproducible — and "which commit was that?" is the first question
    // anyone asks about a result. Best-effort: a repo we cannot reach (private,
    // no token, offline) still evaluates, using the ref as given.
    let resolvedSha: string | null = null;
    let resolvedMessage: string | null = null;
    const repoForResolve = body.repo ?? repoOfTasks(app.queries, projectId);
    if (repoForResolve) {
      const parsed = parseRepoRef(repoForResolve);
      if (parsed) {
        try {
          const c = await clientFor(app).resolveCommit(parsed, commit);
          resolvedSha = c.sha;
          resolvedMessage = c.message;
        } catch {
          // Unreachable/private/offline — fall through with the raw ref.
        }
      }
    }
    const evaluatedRef = resolvedSha ?? commit;

    const tasks = selectTasks(app.queries, projectId, body);
    if (tasks.length === 0) {
      throw badRequest("no eval tasks matched — nothing to evaluate");
    }

    const agentId =
      body.agentId ?? body.agent_id ?? body.agent ?? project.defaultAgentId;
    if (!agentId) {
      throw badRequest(
        "agentId is required (or set the project's default agent)",
      );
    }
    const model = body.model ?? project.defaultModel ?? "claude-sonnet-4-20250514";
    const provider = body.provider ?? project.defaultProvider ?? "anthropic";
    const repeats = Math.max(1, Math.min(20, Number(body.repeats ?? 1) || 1));
    const overrides = body.adapterOverrides ?? body.adapter_overrides;
    const pinnedImage =
      overrides && typeof overrides.image === "string"
        ? overrides.image
        : undefined;

    try {
      app.queries.registerAgent({
        id: agentId,
        displayName: agentId,
        defaultModel: model,
        defaultProvider: provider,
      });
    } catch {
      // already registered
    }

    // ONE batch covering every selected eval — that is what makes this a single
    // evaluation of a commit, and what lets the rollup judge see the whole
    // suite together rather than one task at a time.
    const batch = app.queries.createBatch({
      projectId,
      taskId: tasks[0]!.id,
      agentId,
      model,
      provider,
      repeats: tasks.length * repeats,
      trigger: "commit",
      triggerRef: body.label ?? commit,
      ...(pinnedImage ? { agentImage: pinnedImage } : {}),
    });

    const runs: Run[] = [];
    for (const task of tasks) {
      for (let i = 0; i < repeats; i++) {
        runs.push(
          app.queries.createRun({
            batchId: batch.id,
            taskId: task.id,
            projectId,
            agentId,
            model,
            provider,
            repeatIndex: i,
            status: "queued",
            controlState: "running",
            startedAt: new Date().toISOString(),
            trigger: "commit",
            triggerRef: body.label ?? commit,
            // The pin: every run in this evaluation targets the same revision.
            workspaceRef: evaluatedRef,
            ...(body.repo ? { workspaceRepo: body.repo } : {}),
            ...(pinnedImage
              ? { agentImage: pinnedImage, agentImageSource: "run_override" }
              : {}),
            ...(overrides ? { adapterOverrides: overrides } : {}),
          }),
        );
      }
    }

    for (const r of runs) void app.enqueueStart(r.id);

    sendJson(res, 202, {
      evaluation_id: batch.id,
      project_id: projectId,
      // What was asked for, and what it actually resolved to.
      requested_ref: commit,
      commit: evaluatedRef,
      ...(resolvedMessage ? { commit_message: resolvedMessage } : {}),
      ...(body.repo ? { repo: body.repo } : {}),
      evals: tasks.map((t) => ({ task_id: t.id, name: t.name })),
      runs: runs.map((r) => ({ id: r.id, task_id: r.taskId })),
      status_url: `/api/evaluations/${encodeURIComponent(batch.id)}`,
      report_url: `/api/evaluations/${encodeURIComponent(batch.id)}/report`,
    });
  });

  // Past evaluations for a project.
  router.get("/api/projects/:id/evaluations", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    if (!app.queries.getProject(projectId)) {
      throw notFound(`project not found: ${projectId}`);
    }
    sendJson(res, 200, {
      evaluations: evaluationsOf(app.queries, app.dataDir, projectId),
    });
  });

  // One evaluation: progress plus per-eval results.
  router.get("/api/evaluations/:batchId", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const projectId = runs[0]!.projectId;

    const bundles = await collectBatchBundles(
      app.queries,
      app.dataDir,
      batchId,
    );

    sendJson(res, 200, {
      ...evaluationJson(app.dataDir, projectId, batchId, runs),
      summary: summarizeBundles(bundles),
      // Per-eval results, keyed by eval NAME rather than run id.
      evals: bundles.map((b) => ({
        name: b.evalName,
        task_id: b.taskId,
        run_id: b.runId,
        status: b.runStatus,
        env_kind: b.envKind,
        provision_error: b.provision?.error ?? null,
        events: b.events?.count ?? 0,
        diff_bytes: b.diff?.text.length ?? 0,
        artifacts: b.artifacts.length,
        judged: b.verdict !== null,
        report_url: b.judgementId
          ? `/api/judgements/${encodeURIComponent(b.judgementId)}/report`
          : null,
      })),
    });
  });

  // The evaluation's HTML report.
  router.get("/api/evaluations/:batchId/report", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const batchId = ctx.params.batchId!;
    const runs = requireBatchRuns(app.queries, batchId);
    const path = join(
      releaseDir(app.dataDir, runs[0]!.projectId, batchId),
      "release.html",
    );
    if (!existsSync(path)) {
      const p = batchProgress(runs, batchId);
      throw notFound(
        p.done
          ? `no report for evaluation ${batchId} yet`
          : `evaluation ${batchId} is still running (${p.terminal}/${p.total} evals finished)`,
      );
    }
    const download =
      ctx.query.download === "1" || ctx.query.download === "true";
    await serveHtmlFile(res, path, {
      download,
      filename: `evaluation-${batchId}.html`,
    });
  });
}

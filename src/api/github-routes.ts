/**
 * Project agent-repository browsing + commit resolution.
 *
 * Replaces the old generic global / project-workspace GitHub browsing. A queue is
 * pinned to a commit from its SELECTED adapter's source repo; these endpoints
 * browse / resolve that same repo so the picked commit is always reproducible:
 *
 *   GET /api/projects/:id/agent/commits?ref=…       → recent commits (branch/ref scoped)
 *   GET /api/projects/:id/agent/refs                 → branches + tags
 *   POST /api/projects/:id/agent/resolve  {ref}      → any ref → concrete commit
 *
 * Read-only. The GitHub token comes from server settings or the environment,
 * NEVER from the request — a caller must not be able to make the server use a
 * token it supplied.
 */

import type { DbQueries, ProjectAgentAdapter } from "../db/queries.js";
import {
  GitHubClient,
  GitHubError,
  parseRepoRef,
  type RepoRef,
} from "./github.js";
import { badRequest, HttpError, notFound } from "./errors.js";
import { readJsonBody, sendJson, type RequestContext, type Router } from "./router.js";

/** Minimal AppCtx surface these routes need. */
export interface GitHubAppCtx {
  queries: DbQueries;
  /** Injected in tests; production builds one from settings/env. */
  githubClient?: GitHubClient;
}

function appOf(ctx: RequestContext): GitHubAppCtx {
  return ctx.app as GitHubAppCtx;
}

/** Token from stored settings, falling back to the environment. */
function clientFor(app: GitHubAppCtx): GitHubClient {
  if (app.githubClient) return app.githubClient;
  let token: string | undefined;
  try {
    const settings = app.queries as unknown as {
      getSetting?: (key: string) => { value?: string } | null;
    };
    token = settings.getSetting?.("github_token")?.value;
  } catch {
    // settings unavailable — env only
  }
  return new GitHubClient({ token });
}

/** The project's selected enabled agent adapter, or its explicitly shared adapter. */
function selectedAdapterForQueue(
  queries: DbQueries,
  projectId: string,
  agentId: string,
): ProjectAgentAdapter | null {
  const queueAdapter = queries
    .listEvalQueues(projectId)
    .find((q) => q.agentId === agentId);
  if (queueAdapter?.sharedAdapterId) {
    const shared = queries.getProjectAgentAdapter(queueAdapter.sharedAdapterId);
    if (shared) return shared;
  }
  return queries.getProjectAgentAdapterByAgentId(projectId, agentId);
}

/**
 * The repo a project's queue agent is pinned to — its selected adapter's source
 * repo. That is the only repository a commit/branch/tag picker can meaningfully
 * offer, and it is exactly the repo the queue will build from.
 */
function repoForProjectAgent(
  queries: DbQueries,
  projectId: string,
  agentId: string,
): RepoRef {
  const project = queries.getProject(projectId);
  if (!project || project.archived) {
    throw notFound(`project not found: ${projectId}`);
  }
  const adapter = selectedAdapterForQueue(queries, projectId, agentId);
  const repoSource = adapter?.sourceRepo;
  if (!adapter || !repoSource || adapter.installType !== "source-build") {
    throw badRequest(
      `project ${projectId} has no source-built agent adapter; pin a commit from its source_repo (or pass ?repo=owner/name)`,
    );
  }
  const parsed = parseRepoRef(repoSource);
  if (!parsed) {
    throw badRequest(`adapter source_repo is not a valid repo reference: ${repoSource}`);
  }
  return parsed;
}

/** Repo from the query string, or 400. */
function repoFromQuery(ctx: RequestContext): RepoRef {
  const raw = ctx.query.repo ?? ctx.query.repository ?? "";
  const repo = parseRepoRef(raw);
  if (!repo) {
    throw badRequest("repo is required, as owner/name or a GitHub URL");
  }
  return repo;
}

/** Turn a GitHubError into the matching HTTP error. */
function rethrow(err: unknown): never {
  if (err instanceof GitHubError) {
    throw new HttpError(
      err.status === 404 ? 404 : err.status === 403 ? 403 : 502,
      err.status === 404 ? "Not Found" : "GitHub Error",
      err.message,
    );
  }
  throw err;
}

function intParam(ctx: RequestContext, key: string): number | undefined {
  const raw = ctx.query[key];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function registerGitHubRoutes(router: Router): void {
  // Project agent-repo commits — the adapter's own source repo, newest first.
  router.get("/api/projects/:id/agent/commits", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const agentId = ctx.query.agent_id ?? ctx.query.agentId;
    if (!agentId) throw badRequest("agent_id is required");
    const repo = ctx.query.repo
      ? repoFromQuery(ctx)
      : repoForProjectAgent(app.queries, projectId, agentId);
    try {
      const commits = await clientFor(app).listCommits(repo, {
        ...(ctx.query.ref ? { ref: ctx.query.ref } : {}),
        ...(intParam(ctx, "limit") !== undefined
          ? { limit: intParam(ctx, "limit")! }
          : {}),
      });
      sendJson(res, 200, {
        project_id: projectId,
        agent_id: agentId,
        repo: `${repo.owner}/${repo.name}`,
        commits: commits.map((c) => ({
          sha: c.sha,
          short_sha: c.shortSha,
          message: c.message,
          author: c.author,
          authored_at: c.authoredAt,
          url: c.url,
        })),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  // Project agent-repo refs — branches + tags of the adapter source repo.
  router.get("/api/projects/:id/agent/refs", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const agentId = ctx.query.agent_id ?? ctx.query.agentId;
    if (!agentId) throw badRequest("agent_id is required");
    const repo = ctx.query.repo
      ? repoFromQuery(ctx)
      : repoForProjectAgent(app.queries, projectId, agentId);
    try {
      const [branches, tags] = await Promise.all([
        clientFor(app).listBranches(repo),
        clientFor(app).listTags(repo),
      ]);
      sendJson(res, 200, {
        project_id: projectId,
        agent_id: agentId,
        repo: `${repo.owner}/${repo.name}`,
        branches: branches.map((b) => ({ name: b.name, sha: b.sha })),
        tags: tags.map((t) => ({ name: t.name, sha: t.sha })),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  // Project agent-repo commit resolution — any ref → concrete commit.
  router.post("/api/projects/:id/agent/resolve", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const body = await readJsonBody<{
      agent_id?: string;
      agentId?: string;
      ref?: string;
      commit?: string;
      sha?: string;
    }>(req);
    const agentId = body.agent_id ?? body.agentId;
    if (!agentId) throw badRequest("agent_id is required");
    const ref = body.ref ?? body.commit ?? body.sha;
    if (!ref || !String(ref).trim()) throw badRequest("ref is required");
    const repo = ctx.query.repo
      ? repoFromQuery(ctx)
      : repoForProjectAgent(app.queries, projectId, agentId);
    try {
      const c = await clientFor(app).resolveCommit(repo, String(ref).trim());
      sendJson(res, 200, {
        project_id: projectId,
        agent_id: agentId,
        repo: `${repo.owner}/${repo.name}`,
        requested_ref: ref,
        sha: c.sha,
        short_sha: c.shortSha,
        message: c.message,
        author: c.author,
        authored_at: c.authoredAt,
        url: c.url,
      });
    } catch (err) {
      rethrow(err);
    }
  });
}

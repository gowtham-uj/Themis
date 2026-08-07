/**
 * Live GitHub browsing — pick the commit to evaluate.
 *
 * GET /api/github/commits?repo=…&ref=…   → recent commits, newest first
 * GET /api/github/refs?repo=…            → branches + tags
 * GET /api/github/pulls?repo=…           → open PRs with head shas
 * GET /api/github/resolve?repo=…&ref=…   → any ref → concrete commit
 * GET /api/projects/:id/github/commits   → same, using the project's own repo
 *
 * These exist so a commit can be chosen from real repository state rather than
 * pasted as a sha. The payloads are shaped for a picker: subject line, author,
 * date, short sha.
 *
 * Read-only. The GitHub token comes from server settings or the environment,
 * never from the request — a caller must not be able to make the server use a
 * token it supplied.
 */

import type { DbQueries, Task } from "../db/queries.js";
import {
  GitHubClient,
  GitHubError,
  parseRepoRef,
  type RepoRef,
} from "./github.js";
import { badRequest, HttpError, notFound } from "./errors.js";
import { sendJson, type RequestContext, type Router } from "./router.js";

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
    // Settings are the operator-configured source; env is the deploy default.
    const settings = app.queries as unknown as {
      getSetting?: (key: string) => { value?: string } | null;
    };
    token = settings.getSetting?.("github_token")?.value;
  } catch {
    // settings unavailable — env only
  }
  return new GitHubClient({ token });
}

/** Repo from the query string, or 400. */
function repoFromQuery(ctx: RequestContext): RepoRef {
  const raw = ctx.query.repo ?? ctx.query.repository ?? "";
  const repo = parseRepoRef(raw);
  if (!repo) {
    throw badRequest(
      "repo is required, as owner/name or a GitHub URL",
    );
  }
  return repo;
}

/**
 * The repo a project's evals point at.
 *
 * Taken from the project's tasks rather than stored separately: the repo an
 * eval suite targets IS whatever its tasks target, and a second copy of that
 * fact would be one that could disagree.
 */
function repoForProject(queries: DbQueries, projectId: string): RepoRef {
  const project = queries.getProject(projectId);
  if (!project || project.archived) {
    throw notFound(`project not found: ${projectId}`);
  }
  const tasks: Task[] = queries.listTasks(projectId).filter((t) => !t.archived);
  for (const t of tasks) {
    if (t.workspace.source === "git" && t.workspace.repo) {
      const parsed = parseRepoRef(t.workspace.repo);
      if (parsed) return parsed;
    }
  }
  throw badRequest(
    `project ${projectId} has no git-backed eval tasks; pass ?repo=owner/name`,
  );
}

/** Turn a GitHubError into the matching HTTP error. */
function rethrow(err: unknown): never {
  if (err instanceof GitHubError) {
    // 404 and 403 mean the same thing to a caller as they do to GitHub.
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
  router.get("/api/github/commits", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const repo = repoFromQuery(ctx);
    try {
      const commits = await clientFor(app).listCommits(repo, {
        ...(ctx.query.ref ? { ref: ctx.query.ref } : {}),
        ...(ctx.query.path ? { path: ctx.query.path } : {}),
        ...(intParam(ctx, "limit") !== undefined
          ? { limit: intParam(ctx, "limit")! }
          : {}),
      });
      sendJson(res, 200, {
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

  router.get("/api/github/refs", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const repo = repoFromQuery(ctx);
    const client = clientFor(app);
    try {
      const [branches, tags] = await Promise.all([
        client.listBranches(repo),
        client.listTags(repo),
      ]);
      sendJson(res, 200, {
        repo: `${repo.owner}/${repo.name}`,
        branches: branches.map((b) => ({ name: b.name, sha: b.sha })),
        tags: tags.map((t) => ({ name: t.name, sha: t.sha })),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  router.get("/api/github/pulls", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const repo = repoFromQuery(ctx);
    try {
      const pulls = await clientFor(app).listPullRequests(repo, {
        ...(ctx.query.state === "closed" || ctx.query.state === "all"
          ? { state: ctx.query.state }
          : {}),
        ...(intParam(ctx, "limit") !== undefined
          ? { limit: intParam(ctx, "limit")! }
          : {}),
      });
      sendJson(res, 200, {
        repo: `${repo.owner}/${repo.name}`,
        pulls: pulls.map((p) => ({
          number: p.number,
          title: p.title,
          author: p.author,
          // The head sha is what an eval would actually run against.
          head_sha: p.headSha,
          head_ref: p.headRef,
          base_ref: p.baseRef,
          draft: p.draft,
          url: p.url,
        })),
      });
    } catch (err) {
      rethrow(err);
    }
  });

  router.get("/api/github/resolve", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const repo = repoFromQuery(ctx);
    const ref = ctx.query.ref ?? ctx.query.commit ?? ctx.query.sha ?? "";
    if (!ref) throw badRequest("ref is required");
    try {
      const c = await clientFor(app).resolveCommit(repo, ref);
      sendJson(res, 200, {
        repo: `${repo.owner}/${repo.name}`,
        requested_ref: ref,
        // The resolved sha is what an evaluation records: a branch name means
        // something different next week, so a result pinned to a ref is not
        // reproducible.
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

  // Project-scoped: browse the repo this project's evals already target.
  router.get("/api/projects/:id/github/commits", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const repo = ctx.query.repo
      ? repoFromQuery(ctx)
      : repoForProject(app.queries, ctx.params.id!);
    try {
      const commits = await clientFor(app).listCommits(repo, {
        ...(ctx.query.ref ? { ref: ctx.query.ref } : {}),
        ...(intParam(ctx, "limit") !== undefined
          ? { limit: intParam(ctx, "limit")! }
          : {}),
      });
      sendJson(res, 200, {
        project_id: ctx.params.id,
        repo: `${repo.owner}/${repo.name}`,
        commits: commits.map((c) => ({
          sha: c.sha,
          short_sha: c.shortSha,
          message: c.message,
          author: c.author,
          authored_at: c.authoredAt,
          url: c.url,
          // One click from "this commit" to "evaluate it".
          evaluate_url: `/api/projects/${encodeURIComponent(ctx.params.id!)}/evaluate`,
        })),
      });
    } catch (err) {
      rethrow(err);
    }
  });
}

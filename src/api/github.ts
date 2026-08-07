/**
 * Live GitHub repository state — branches, tags, commits, pull requests.
 *
 * Exists so a commit can be *picked* rather than typed. Choosing what to
 * evaluate from a list of real commits ("the PR head", "the tag before the
 * regression") is a different action from pasting a 40-character sha, and the
 * platform should support the first one.
 *
 * Read-only by construction: this module can list and resolve, never write. A
 * token is optional (public repos work without one) and comes from settings or
 * the environment, never from the request — a caller must not be able to make
 * the server use a token it supplied.
 */

/** A repo reference, normalized to `owner/name`. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** One commit as shown in a picker. */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authoredAt: string;
  url: string;
}

/** A branch or tag head. */
export interface RefSummary {
  name: string;
  sha: string;
  kind: "branch" | "tag";
}

/** An open pull request, with the head commit an eval would target. */
export interface PullRequestSummary {
  number: number;
  title: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  url: string;
}

/** Raised when GitHub cannot be reached or returns an error. */
export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/**
 * Parse the many ways a repo gets written into `owner/name`.
 *
 * Accepts `owner/name`, full https URLs, `git@` SSH remotes, and trailing
 * `.git` — because the same repo is spelled all of those ways across a task
 * definition, a watcher rule, and whatever someone pastes into a form.
 */
export function parseRepoRef(input: string): RepoRef | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  // git@github.com:owner/name.git
  const ssh = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };

  // https://github.com/owner/name(.git)(/anything)
  const url = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/.exec(raw);
  if (url) return { owner: url[1]!, name: url[2]! };

  // owner/name
  const plain = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(raw);
  if (plain) return { owner: plain[1]!, name: plain[2]! };

  return null;
}

/** Options for a GitHub client. */
export interface GitHubClientOptions {
  /** Personal access token; optional for public repos. */
  token?: string | undefined;
  /** API base, for GitHub Enterprise. */
  apiBase?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Minimal read-only GitHub client.
 *
 * Deliberately not a full SDK: four list operations and a ref resolve is the
 * entire surface the "pick a commit to evaluate" flow needs, and a narrow
 * surface is one that cannot accidentally mutate a repository.
 */
export class GitHubClient {
  private readonly token: string | undefined;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions = {}) {
    this.token =
      opts.token ??
      process.env.GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      undefined;
    this.apiBase = (opts.apiBase ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** True when a token is configured — public repos work without one. */
  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agenteval",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, { headers });
    } catch (err) {
      throw new GitHubError(
        `GitHub request failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Rate limiting is common enough to name explicitly — "403" alone sends
      // people looking for a permissions problem they do not have.
      const rateLimited =
        res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
      throw new GitHubError(
        rateLimited
          ? `GitHub rate limit exceeded${this.token ? "" : " (configure a token to raise it)"}`
          : `GitHub ${res.status}: ${body.slice(0, 200)}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /** Recent commits, newest first. Optionally on a branch and/or a path. */
  async listCommits(
    repo: RepoRef,
    opts: { ref?: string; path?: string; limit?: number } = {},
  ): Promise<CommitSummary[]> {
    const params = new URLSearchParams();
    params.set("per_page", String(Math.min(100, Math.max(1, opts.limit ?? 30))));
    if (opts.ref) params.set("sha", opts.ref);
    if (opts.path) params.set("path", opts.path);

    const raw = await this.get<
      Array<{
        sha: string;
        html_url: string;
        commit: {
          message: string;
          author: { name?: string; date?: string } | null;
        };
        author: { login?: string } | null;
      }>
    >(`/repos/${repo.owner}/${repo.name}/commits?${params.toString()}`);

    return raw.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      // Only the subject line: a picker shows one row per commit.
      message: (c.commit.message ?? "").split("\n")[0] ?? "",
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      authoredAt: c.commit.author?.date ?? "",
      url: c.html_url,
    }));
  }

  /** Branches, newest-activity order as GitHub returns them. */
  async listBranches(repo: RepoRef, limit = 100): Promise<RefSummary[]> {
    const raw = await this.get<
      Array<{ name: string; commit: { sha: string } }>
    >(`/repos/${repo.owner}/${repo.name}/branches?per_page=${Math.min(100, limit)}`);
    return raw.map((b) => ({
      name: b.name,
      sha: b.commit.sha,
      kind: "branch" as const,
    }));
  }

  /** Tags — the usual way a release is named. */
  async listTags(repo: RepoRef, limit = 100): Promise<RefSummary[]> {
    const raw = await this.get<
      Array<{ name: string; commit: { sha: string } }>
    >(`/repos/${repo.owner}/${repo.name}/tags?per_page=${Math.min(100, limit)}`);
    return raw.map((t) => ({
      name: t.name,
      sha: t.commit.sha,
      kind: "tag" as const,
    }));
  }

  /** Open pull requests, with the head sha an eval would target. */
  async listPullRequests(
    repo: RepoRef,
    opts: { state?: "open" | "closed" | "all"; limit?: number } = {},
  ): Promise<PullRequestSummary[]> {
    const params = new URLSearchParams({
      state: opts.state ?? "open",
      per_page: String(Math.min(100, Math.max(1, opts.limit ?? 30))),
      sort: "updated",
      direction: "desc",
    });
    const raw = await this.get<
      Array<{
        number: number;
        title: string;
        draft?: boolean;
        html_url: string;
        user: { login?: string } | null;
        head: { sha: string; ref: string };
        base: { ref: string };
      }>
    >(`/repos/${repo.owner}/${repo.name}/pulls?${params.toString()}`);

    return raw.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user?.login ?? "unknown",
      headSha: p.head.sha,
      headRef: p.head.ref,
      baseRef: p.base.ref,
      draft: p.draft === true,
      url: p.html_url,
    }));
  }

  /**
   * Resolve any ref (branch, tag, sha, `pull/N/head`) to a concrete commit.
   *
   * Evaluations record the resolved sha, not the ref they were asked for: a
   * branch name means something different next week, and a result that cannot
   * be traced to an exact revision is not reproducible.
   */
  async resolveCommit(repo: RepoRef, ref: string): Promise<CommitSummary> {
    const target = (ref ?? "").trim();
    if (!target) throw new GitHubError("ref is required", 400);

    const pr = /^(?:pull\/)?#?(\d+)$/.exec(target);
    const path = pr
      ? `/repos/${repo.owner}/${repo.name}/pulls/${pr[1]}`
      : `/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(target)}`;

    if (pr) {
      const p = await this.get<{
        head: { sha: string; ref: string };
        title: string;
        user: { login?: string } | null;
        updated_at: string;
        html_url: string;
      }>(path);
      return {
        sha: p.head.sha,
        shortSha: p.head.sha.slice(0, 7),
        message: p.title,
        author: p.user?.login ?? "unknown",
        authoredAt: p.updated_at,
        url: p.html_url,
      };
    }

    const c = await this.get<{
      sha: string;
      html_url: string;
      commit: { message: string; author: { name?: string; date?: string } | null };
      author: { login?: string } | null;
    }>(path);
    return {
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: (c.commit.message ?? "").split("\n")[0] ?? "",
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      authoredAt: c.commit.author?.date ?? "",
      url: c.html_url,
    };
  }
}

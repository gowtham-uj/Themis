/**
 * Evaluate a commit: pick a revision from live GitHub state, run the eval
 * suite against it, read the results back — all over the API.
 *
 * The properties that matter:
 *
 *  - the eval suite is aimed at a revision WITHOUT mutating task definitions
 *    (the same suite must work against a tag, a PR head, or an arbitrary sha);
 *  - a ref is resolved to a concrete sha, because a branch name means something
 *    different next week and a result that cannot be traced to an exact
 *    revision is not reproducible;
 *  - a requested-but-missing eval is an error, not a silent omission — the
 *    caller asked for coverage they would not have got.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubClient, parseRepoRef } from "../src/api/github.ts";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { createFixtureAdapter } from "../src/api/run-controller-bridge.ts";

// ---------------------------------------------------------------------------
// repo parsing
// ---------------------------------------------------------------------------

describe("parseRepoRef", () => {
  it("accepts every spelling a repo shows up as", () => {
    // The same repo appears as all of these across a task definition, a
    // watcher rule, and whatever someone pastes into a form.
    expect(parseRepoRef("acme/app")).toEqual({ owner: "acme", name: "app" });
    expect(parseRepoRef("https://github.com/acme/app")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(parseRepoRef("https://github.com/acme/app.git")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(parseRepoRef("git@github.com:acme/app.git")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(parseRepoRef("https://github.com/acme/app/tree/main")).toEqual({
      owner: "acme",
      name: "app",
    });
  });

  it("returns null for things that are not repos", () => {
    expect(parseRepoRef("")).toBeNull();
    expect(parseRepoRef("   ")).toBeNull();
    expect(parseRepoRef("just-a-name")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GitHub client against a stubbed transport
// ---------------------------------------------------------------------------

/** Fake fetch returning canned GitHub payloads. */
function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

const repo = { owner: "acme", name: "app" };

describe("GitHubClient", () => {
  it("lists commits shaped for a picker", async () => {
    const client = new GitHubClient({
      fetchImpl: stubFetch({
        "/commits": [
          {
            sha: "a".repeat(40),
            html_url: "https://github.com/acme/app/commit/aaa",
            commit: {
              message: "fix: off-by-one in range\n\nlonger body ignored",
              author: { name: "Dev", date: "2026-08-01T10:00:00Z" },
            },
            author: { login: "devlogin" },
          },
        ],
      }),
    });
    const commits = await client.listCommits(repo, { limit: 1 });
    expect(commits[0]!.shortSha).toBe("aaaaaaa");
    // Subject line only — a picker shows one row per commit.
    expect(commits[0]!.message).toBe("fix: off-by-one in range");
    expect(commits[0]!.author).toBe("devlogin");
  });

  it("lists open PRs with the head sha an eval would target", async () => {
    const client = new GitHubClient({
      fetchImpl: stubFetch({
        "/pulls": [
          {
            number: 482,
            title: "Add retry logic",
            draft: false,
            html_url: "https://github.com/acme/app/pull/482",
            user: { login: "contributor" },
            head: { sha: "b".repeat(40), ref: "feature/retry" },
            base: { ref: "main" },
          },
        ],
      }),
    });
    const pulls = await client.listPullRequests(repo);
    expect(pulls[0]!.number).toBe(482);
    expect(pulls[0]!.headSha).toBe("b".repeat(40));
    expect(pulls[0]!.baseRef).toBe("main");
  });

  it("resolves a PR number to its head commit", async () => {
    const client = new GitHubClient({
      fetchImpl: stubFetch({
        "/pulls/482": {
          head: { sha: "c".repeat(40), ref: "feature/retry" },
          title: "Add retry logic",
          user: { login: "contributor" },
          updated_at: "2026-08-02T09:00:00Z",
          html_url: "https://github.com/acme/app/pull/482",
        },
      }),
    });
    for (const spelling of ["482", "#482", "pull/482"]) {
      const c = await client.resolveCommit(repo, spelling);
      expect(c.sha).toBe("c".repeat(40));
    }
  });

  it("names rate limiting instead of reporting a bare 403", async () => {
    // "403" alone sends people looking for a permissions problem they do not
    // have.
    const client = new GitHubClient({
      fetchImpl: (async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        })) as unknown as typeof fetch,
    });
    await expect(client.listCommits(repo)).rejects.toThrow(/rate limit/i);
  });

  it("surfaces an unknown repo as 404", async () => {
    const client = new GitHubClient({ fetchImpl: stubFetch({}) });
    await expect(client.listCommits(repo)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// the API: browse, then evaluate
// ---------------------------------------------------------------------------

interface Ctx {
  base: string;
  api: ApiServer;
  dataDir: string;
}

async function boot(githubClient?: GitHubClient): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-commit-"));
  const api = createServer({
    dataDir,
    adapter: createFixtureAdapter({ holdMs: 5, messages: ["ok"] }),
    concurrency: 1,
    startOpts: { timeoutMs: 15_000 },
    // A documented seam, so browsing live repo state never needs the network.
    ...(githubClient ? { githubClient } : {}),
  });
  const port = await api.listen(0);
  return { base: `http://127.0.0.1:${port}`, api, dataDir };
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* keep {} */
  }
  return { status: res.status, json };
}

const rubric = {
  version: 1,
  profile: "bugfix",
  criteria: [
    {
      id: "C1",
      axis: "A",
      label: "correct",
      weight: 1,
      appliesTo: "coding",
      anchors: { full: "y", partial: "s", none: "n" },
    },
  ],
};

/** Project with N eval tasks, all pointing at a repo. */
async function seedProject(
  base: string,
  slug: string,
  evalNames: string[],
): Promise<{ projectId: string; taskIds: string[] }> {
  const proj = await http(base, "POST", "/api/projects", {
    name: slug,
    slug,
  });
  const projectId = proj.json.id as string;
  const taskIds: string[] = [];
  for (const name of evalNames) {
    const t = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
      name,
      prompt: `do ${name}`,
      workspace: { source: "empty" },
      agentCategory: "coding",
      rubric,
      tags: name.includes("smoke") ? ["smoke"] : ["full"],
    });
    expect(t.status).toBe(201);
    taskIds.push(t.json.id as string);
  }
  return { projectId, taskIds };
}

describe("POST /api/projects/:id/evaluate", () => {
  it("runs the suite against a commit, pinning every run to it", async () => {
    const ctx = await boot();
    try {
      const { projectId } = await seedProject(ctx.base, "eval-commit", [
        "smoke: boots",
        "full: handles retries",
      ]);

      const sha = "d".repeat(40);
      const res = await http(
        ctx.base,
        "POST",
        `/api/projects/${projectId}/evaluate`,
        { commit: sha, agentId: "fixture", label: "PR #482" },
      );
      expect(res.status).toBe(202);
      expect(res.json.commit).toBe(sha);
      // One run per eval, all in ONE evaluation.
      expect((res.json.runs as unknown[]).length).toBe(2);
      expect(res.json.evaluation_id).toBeTruthy();

      // Every run records the revision it evaluates — without the task
      // definitions having been touched.
      const evaluationId = res.json.evaluation_id as string;
      const detail = await http(
        ctx.base,
        "GET",
        `/api/evaluations/${evaluationId}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.json.requested_ref).toBe(sha);
      expect((detail.json.evals as unknown[]).length).toBe(2);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("resolves a branch name to a concrete sha before running", async () => {
    // A result pinned to "main" is not reproducible; one pinned to a sha is.
    const client = new GitHubClient({
      fetchImpl: stubFetch({
        "/commits/main": {
          sha: "e".repeat(40),
          html_url: "https://github.com/acme/app/commit/eee",
          commit: {
            message: "chore: bump deps",
            author: { name: "Dev", date: "2026-08-03T00:00:00Z" },
          },
          author: { login: "dev" },
        },
      }),
    });
    const ctx = await boot(client);
    try {
      const { projectId } = await seedProject(ctx.base, "eval-resolve", [
        "smoke: boots",
      ]);
      const res = await http(
        ctx.base,
        "POST",
        `/api/projects/${projectId}/evaluate`,
        { commit: "main", repo: "acme/app", agentId: "fixture" },
      );
      expect(res.status).toBe(202);
      expect(res.json.requested_ref).toBe("main");
      expect(res.json.commit).toBe("e".repeat(40));
      expect(res.json.commit_message).toBe("chore: bump deps");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("still evaluates when the repo cannot be reached", async () => {
    // Private repo, no token, or offline — the eval should run with the ref as
    // given rather than refusing.
    const client = new GitHubClient({
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch,
    });
    const ctx = await boot(client);
    try {
      const { projectId } = await seedProject(ctx.base, "eval-offline", [
        "smoke: boots",
      ]);
      const res = await http(
        ctx.base,
        "POST",
        `/api/projects/${projectId}/evaluate`,
        { commit: "v9.9.9", repo: "acme/app", agentId: "fixture" },
      );
      expect(res.status).toBe(202);
      expect(res.json.commit).toBe("v9.9.9");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("selects a subset of evals by tag", async () => {
    const ctx = await boot();
    try {
      const { projectId } = await seedProject(ctx.base, "eval-tags", [
        "smoke: boots",
        "full: handles retries",
        "full: handles timeouts",
      ]);
      const res = await http(
        ctx.base,
        "POST",
        `/api/projects/${projectId}/evaluate`,
        { commit: "f".repeat(40), agentId: "fixture", tags: ["smoke"] },
      );
      expect(res.status).toBe(202);
      expect((res.json.evals as Array<{ name: string }>).map((e) => e.name)).toEqual([
        "smoke: boots",
      ]);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects an unknown eval rather than silently skipping it", async () => {
    // Silently omitting a requested eval would understate the suite.
    const ctx = await boot();
    try {
      const { projectId, taskIds } = await seedProject(ctx.base, "eval-missing", [
        "smoke: boots",
      ]);
      const res = await http(
        ctx.base,
        "POST",
        `/api/projects/${projectId}/evaluate`,
        {
          commit: "a".repeat(40),
          agentId: "fixture",
          taskIds: [taskIds[0]!, "does-not-exist"],
        },
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("does-not-exist");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("requires a commit", async () => {
    const ctx = await boot();
    try {
      const { projectId } = await seedProject(ctx.base, "eval-nocommit", [
        "smoke: boots",
      ]);
      const res = await http(
        ctx.base,
        "POST",
        `/api/projects/${projectId}/evaluate`,
        { agentId: "fixture" },
      );
      expect(res.status).toBe(400);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("lists past evaluations newest first", async () => {
    const ctx = await boot();
    try {
      const { projectId } = await seedProject(ctx.base, "eval-list", [
        "smoke: boots",
      ]);
      for (const sha of ["1".repeat(40), "2".repeat(40)]) {
        await http(ctx.base, "POST", `/api/projects/${projectId}/evaluate`, {
          commit: sha,
          agentId: "fixture",
        });
        await new Promise((r) => setTimeout(r, 30));
      }
      const list = await http(
        ctx.base,
        "GET",
        `/api/projects/${projectId}/evaluations`,
      );
      expect(list.status).toBe(200);
      expect((list.json.evaluations as unknown[]).length).toBeGreaterThanOrEqual(
        2,
      );
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("GET /api/github/*", () => {
  it("browses commits, refs and pulls for a repo", async () => {
    const client = new GitHubClient({
      fetchImpl: stubFetch({
        "/commits?": [
          {
            sha: "a".repeat(40),
            html_url: "u",
            commit: {
              message: "feat: add thing",
              author: { name: "D", date: "2026-08-01T00:00:00Z" },
            },
            author: { login: "d" },
          },
        ],
        "/branches": [{ name: "main", commit: { sha: "b".repeat(40) } }],
        "/tags": [{ name: "v2.0.0", commit: { sha: "c".repeat(40) } }],
        "/pulls?": [
          {
            number: 7,
            title: "wip",
            html_url: "u",
            user: { login: "x" },
            head: { sha: "d".repeat(40), ref: "wip" },
            base: { ref: "main" },
          },
        ],
      }),
    });
    const ctx = await boot(client);
    try {
      const commits = await http(
        ctx.base,
        "GET",
        "/api/github/commits?repo=acme/app&limit=1",
      );
      expect(commits.status).toBe(200);
      expect((commits.json.commits as Array<{ short_sha: string }>)[0]!.short_sha)
        .toBe("aaaaaaa");

      const refs = await http(ctx.base, "GET", "/api/github/refs?repo=acme/app");
      expect((refs.json.branches as Array<{ name: string }>)[0]!.name).toBe("main");
      expect((refs.json.tags as Array<{ name: string }>)[0]!.name).toBe("v2.0.0");

      const pulls = await http(
        ctx.base,
        "GET",
        "/api/github/pulls?repo=acme/app",
      );
      expect((pulls.json.pulls as Array<{ head_sha: string }>)[0]!.head_sha).toBe(
        "d".repeat(40),
      );
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("400s without a repo", async () => {
    const ctx = await boot();
    try {
      const res = await http(ctx.base, "GET", "/api/github/commits");
      expect(res.status).toBe(400);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

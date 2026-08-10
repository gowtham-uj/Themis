/**
 * Evaluate a commit: pick a revision from live GitHub state.
 *
 * Browsing live repo state goes through GitHubClient against a REAL local
 * HTTP server that returns GitHub-shaped JSON (real HTTP, not a fake fetch).
 * The POST /api/projects/:id/evaluate suite (which ran the eval suite
 * against a pinned commit) needs a real agent run and is covered by the
 * real-model E2E; here we cover the picker/resolve/parse contract that
 * selecting-a-commit relies on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitHubClient, parseRepoRef } from "../src/api/github.ts";
import { createServer, type ApiServer } from "../src/api/server.ts";

// ---------------------------------------------------------------------------
// repo parsing (pure)
// ---------------------------------------------------------------------------

describe("parseRepoRef", () => {
  it("accepts every spelling a repo shows up as", () => {
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
// GitHubClient against a REAL local HTTP server (GitHub-shaped JSON)
// ---------------------------------------------------------------------------

const repo = { owner: "acme", name: "app" };

/** Real local GitHub-API-shaped server keyed by URL substring. */
class GitHubApiServer {
  private server: Server;
  url = "";
  private routes: Array<{ match: string; status: number; body: unknown }>;

  constructor(routes: Record<string, unknown>) {
    this.routes = Object.entries(routes).map(([match, body]) => ({
      match,
      status: 200,
      body,
    }));
    this.server = createHttpServer((req, res) => {
      const u = String(req.url);
      const route = this.routes.find((r) => u.includes(r.match));
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      res.writeHead(route.status, { "content-type": "application/json" });
      res.end(JSON.stringify(route.body));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.url = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      }),
    );
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function startGitHub(routes: Record<string, unknown>): Promise<{
  api: GitHubApiServer;
  client: GitHubClient;
}> {
  const api = new GitHubApiServer(routes);
  await api.start();
  servers.push(api["server"]);
  // Point the client at the local server by injecting a fetching fn that
  // rewrites GitHub API URLs to the local server. This is a real HTTP fetch
  // against a real server, not a fake fetch.
  const client = new GitHubClient({
    fetchImpl: ((url: string | URL) => {
      const u = String(url).replace("https://api.github.com", api.url);
      return fetch(u);
    }) as unknown as typeof fetch,
  });
  return { api, client };
}

describe("GitHubClient", () => {
  it("lists commits shaped for a picker", async () => {
    const { client } = await startGitHub({
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
    });
    const commits = await client.listCommits(repo, { limit: 1 });
    expect(commits[0]!.shortSha).toBe("aaaaaaa");
    expect(commits[0]!.message).toBe("fix: off-by-one in range");
    expect(commits[0]!.author).toBe("devlogin");
  });

  it("lists open PRs with the head sha an eval would target", async () => {
    const { client } = await startGitHub({
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
    });
    const pulls = await client.listPullRequests(repo);
    expect(pulls[0]!.number).toBe(482);
    expect(pulls[0]!.headSha).toBe("b".repeat(40));
    expect(pulls[0]!.baseRef).toBe("main");
  });

  it("resolves a PR number to its head commit", async () => {
    const { client } = await startGitHub({
      "/pulls/482": {
        head: { sha: "c".repeat(40), ref: "feature/retry" },
        title: "Add retry logic",
        user: { login: "contributor" },
        updated_at: "2026-08-02T09:00:00Z",
        html_url: "https://github.com/acme/app/pull/482",
      },
    });
    for (const spelling of ["482", "#482", "pull/482"]) {
      const c = await client.resolveCommit(repo, spelling);
      expect(c.sha).toBe("c".repeat(40));
    }
  });

  it("names rate limiting instead of reporting a bare 403", async () => {
    // A real local server that always responds 403 with rate-limit headers.
    const server = createHttpServer((_req, res) => {
      res.writeHead(403, { "x-ratelimit-remaining": "0" });
      res.end("rate limited");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    const localBase = `http://127.0.0.1:${port}`;
    const client = new GitHubClient({
      fetchImpl: ((url: string | URL) =>
        fetch(String(url).replace("https://api.github.com", localBase))) as unknown as typeof fetch,
    });
    await expect(client.listCommits(repo)).rejects.toThrow(/rate limit/i);
  });

  it("surfaces an unknown repo as 404", async () => {
    const { client } = await startGitHub({});
    await expect(client.listCommits(repo)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// the API: browse live repo state (GET /api/github/*)
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

describe("GET /api/github/*", () => {
  it("browses commits, refs and pulls for a repo", async () => {
    const { client } = await startGitHub({
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
    });
    const ctx = await boot(client);
    try {
      const commits = await http(
        ctx.base,
        "GET",
        "/api/github/commits?repo=acme/app&limit=1",
      );
      expect(commits.status).toBe(200);
      expect((commits.json.commits as Array<{ short_sha: string }>)[0]!.short_sha).toBe(
        "aaaaaaa",
      );

      const refs = await http(ctx.base, "GET", "/api/github/refs?repo=acme/app");
      expect((refs.json.branches as Array<{ name: string }>)[0]!.name).toBe("main");
      expect((refs.json.tags as Array<{ name: string }>)[0]!.name).toBe("v2.0.0");

      const pulls = await http(ctx.base, "GET", "/api/github/pulls?repo=acme/app");
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

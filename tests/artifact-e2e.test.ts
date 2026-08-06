/**
 * Artifacts end-to-end over real HTTP: a run produces a screenshot, the judge
 * cites it in a finding, the API serves it, and retention reclaims everything
 * the verdict did not cite — without breaking the cited link.
 *
 * This is the developer-facing contract for no-diff categories (browser, data,
 * research): the evidence a finding points at must be fetchable, and the disk
 * it does not point at must not accumulate forever.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { createFixtureAdapter } from "../src/api/run-controller-bridge.ts";
import type { JudgeRunContext } from "../src/api/judgements-routes.ts";
import type { DbQueries } from "../src/db/queries.ts";
import type { Verdict } from "../src/judge/verdict.ts";
import { artifactsDir } from "../src/runner/artifacts.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.close();
    } catch {
      /* best-effort */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
}

async function http(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep null */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** A 1x1 PNG — real bytes, so content-type handling is exercised honestly. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Judge that locates its finding on an artifact, the no-diff shape. */
function makeArtifactJudge(): (ctx: JudgeRunContext) => Promise<void> {
  return async (ctx: JudgeRunContext) => {
    const queries = ctx.queries as DbQueries;
    const verdict = {
      schemaVersion: 1,
      overall: { score: 0.5, verdict: "partial", summary: "page rendered" },
      criteria: [
        {
          criterion: "C1",
          weight: 1,
          feedback: "screenshot captured",
          score: 0.5,
          evidence: ["shot.png"],
          findingIds: ["f1"],
        },
      ],
      findings: [
        {
          id: "f1",
          category: "verification_skipped",
          severity: "major",
          confidence: 0.9,
          claim: "the captured page rendered unstyled",
          refs: [{ kind: "artifact", path: "shot.png" }],
        },
      ],
      positiveFindings: [],
      metaFindings: [],
      diagnostics: {},
      attribution: { agent_vs_environment: "agent" },
      observations: [],
      improvements: {
        summary: "ok",
        withoutSource: [
          {
            area: "verification",
            priority: "high",
            change: "wait for styles before capturing",
            why: "the screenshot is taken pre-hydration",
            refs: [{ kind: "artifact", path: "shot.png" }],
            linkedFindings: ["f1"],
          },
        ],
      },
    } as unknown as Verdict;
    queries.storeVerdict(ctx.judgementId, verdict);
  };
}

async function boot(): Promise<{ base: string; dataDir: string; api: ApiServer }> {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-art-e2e-"));
  dirs.push(dataDir);
  const api = createServer({
    dataDir,
    adapter: createFixtureAdapter({ holdMs: 20, messages: ["shot taken"] }),
    concurrency: 1,
    startOpts: { timeoutMs: 15_000 },
    judgeRunner: makeArtifactJudge(),
  });
  servers.push(api);
  const port = await api.listen(0);
  return { base: `http://127.0.0.1:${port}`, dataDir, api };
}

/** Poll a run until it reaches a terminal status. */
async function waitForRun(base: string, runId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const res = await http(base, "GET", `/api/runs/${runId}`);
    const status = (res.json as { status?: string })?.status ?? "";
    if (["completed", "failed", "aborted", "timeout"].includes(status)) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return "timeout-waiting";
}

/** Create a project + task + run and drive it to completion. */
async function runToCompletion(
  base: string,
  projectBody: Record<string, unknown>,
): Promise<{ projectId: string; runId: string }> {
  const proj = await http(base, "POST", "/api/projects", { body: projectBody });
  expect(proj.status).toBe(201);
  const projectId = (proj.json as { id: string }).id;

  const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
    body: {
      name: "Screenshot the landing page",
      prompt: "open the page and capture a screenshot",
      workspace: { source: "empty" },
      agentCategory: "browser",
      rubric: {
        version: 1,
        profile: "bugfix",
        criteria: [
          {
            id: "C1",
            axis: "A",
            label: "captured",
            weight: 1,
            appliesTo: "both",
            anchors: { full: "yes", partial: "some", none: "no" },
          },
        ],
      },
    },
  });
  expect(taskRes.status).toBe(201);
  const taskId = (taskRes.json as { id: string }).id;

  const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
    body: { taskId, repeats: 1 },
  });
  expect([200, 201, 202]).toContain(start.status);
  const runs = (start.json as { runs?: Array<{ id: string }> }).runs ?? [];
  const runId = runs[0]!.id;
  expect(await waitForRun(base, runId)).toBe("completed");
  return { projectId, runId };
}

/** Write artifacts into a completed run's outputs dir, as the sandbox would. */
async function seedArtifacts(
  dataDir: string,
  projectId: string,
  runId: string,
): Promise<void> {
  const root = artifactsDir(join(dataDir, "projects", projectId, "runs", runId));
  await mkdir(join(root, "scratch"), { recursive: true });
  await writeFile(join(root, "shot.png"), PNG_1X1);
  await writeFile(join(root, "scratch", "debug.log"), "noisy trace output\n");
  await writeFile(join(root, "dump.json"), '{"rows":1}');
}

describe("run artifacts end-to-end (serve + cite + retain)", () => {
  it("lists and serves artifacts, and a cited screenshot survives retention", async () => {
    const { base, dataDir } = await boot();
    const { projectId, runId } = await runToCompletion(base, {
      name: "Artifacts",
      slug: "artifacts-e2e",
      // Space-efficient: purge everything the verdict does not cite.
      artifact_retention: "referenced",
    });

    // The project setting round-trips over the API.
    const projGet = await http(base, "GET", `/api/projects/${projectId}`);
    expect((projGet.json as { artifact_retention?: string }).artifact_retention).toBe(
      "referenced",
    );

    await seedArtifacts(dataDir, projectId, runId);

    // ---- list ----
    const list = await http(base, "GET", `/api/runs/${runId}/artifacts`);
    expect(list.status).toBe(200);
    const artifacts = (
      list.json as {
        artifacts: Array<{
          path: string;
          is_image: boolean;
          content_type: string;
          url: string;
          sha256: string;
        }>;
      }
    ).artifacts;
    expect(artifacts.map((a) => a.path)).toEqual([
      "dump.json",
      "scratch/debug.log",
      "shot.png",
    ]);
    const shot = artifacts.find((a) => a.path === "shot.png")!;
    expect(shot.is_image).toBe(true);
    expect(shot.content_type).toBe("image/png");
    expect(shot.sha256).toMatch(/^[0-9a-f]{64}$/);

    // ---- serve: image inline, bytes intact ----
    const img = await fetch(`${base}${shot.url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1X1)).toBe(true);

    // ---- serve: nested path works; non-image downloads rather than renders ----
    const log = await fetch(
      `${base}/api/runs/${runId}/artifacts/scratch/debug.log`,
    );
    expect(log.status).toBe(200);
    expect(log.headers.get("content-disposition")).toContain("attachment");
    expect(log.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await log.text()).toBe("noisy trace output\n");

    // ---- judge: finding located on the artifact ----
    const jud = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: {},
    });
    expect(jud.status).toBe(202);
    const judgementId = (jud.json as { judgementId: string }).judgementId;

    // Wait for the judge (and the retention pass that follows it).
    let verdictBody: unknown = null;
    for (let i = 0; i < 200; i++) {
      const res = await http(base, "GET", `/api/judgements/${judgementId}`);
      const j = res.json as { status?: string; verdict_body?: unknown };
      if (j?.status === "completed") {
        verdictBody = j.verdict_body ?? null;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(verdictBody).not.toBeNull();

    // ---- retention: cited evidence kept, the rest reclaimed ----
    // Poll: the purge runs after the judgement is marked completed.
    let remaining: string[] = [];
    for (let i = 0; i < 100; i++) {
      const after = await http(base, "GET", `/api/runs/${runId}/artifacts`);
      remaining = (
        after.json as { artifacts: Array<{ path: string }> }
      ).artifacts.map((a) => a.path);
      if (remaining.length === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(remaining).toEqual(["shot.png"]);

    // The whole point: the finding's ref still resolves after the purge.
    const stillThere = await fetch(`${base}${shot.url}`);
    expect(stillThere.status).toBe(200);
    expect(Buffer.from(await stillThere.arrayBuffer()).equals(PNG_1X1)).toBe(true);
  }, 60_000);

  it("keeps every artifact when the project opts out of purging", async () => {
    const { base, dataDir } = await boot();
    const { projectId, runId } = await runToCompletion(base, {
      name: "Keep",
      slug: "artifacts-keep",
      artifact_retention: "keep",
    });
    await seedArtifacts(dataDir, projectId, runId);

    const jud = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: {},
    });
    expect(jud.status).toBe(202);
    const judgementId = (jud.json as { judgementId: string }).judgementId;
    for (let i = 0; i < 200; i++) {
      const res = await http(base, "GET", `/api/judgements/${judgementId}`);
      if ((res.json as { status?: string })?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Give any (incorrect) purge a chance to run before asserting nothing went.
    await new Promise((r) => setTimeout(r, 300));

    const after = await http(base, "GET", `/api/runs/${runId}/artifacts`);
    expect(
      (after.json as { artifacts: Array<{ path: string }> }).artifacts.map(
        (a) => a.path,
      ),
    ).toEqual(["dump.json", "scratch/debug.log", "shot.png"]);
  }, 60_000);

  it("refuses path traversal out of the outputs dir", async () => {
    const { base, dataDir } = await boot();
    const { projectId, runId } = await runToCompletion(base, {
      name: "Traversal",
      slug: "artifacts-traversal",
    });
    await seedArtifacts(dataDir, projectId, runId);

    // Encoded traversal — the router decodes params, so this reaches the
    // resolver as literal "..", which it must reject.
    const escaped = await fetch(
      `${base}/api/runs/${runId}/artifacts/%2e%2e/%2e%2e/run.json`,
    );
    expect(escaped.status).toBe(404);

    const missing = await fetch(`${base}/api/runs/${runId}/artifacts/nope.png`);
    expect(missing.status).toBe(404);
  }, 60_000);
});

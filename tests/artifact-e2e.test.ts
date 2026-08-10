/**
 * Run artifacts: list + serve + path-traversal refusal, over real HTTP.
 *
 * No agent or judge execution is involved. A completed run row is seeded via
 * queries and artifacts are written directly into the run's outputs dir (as
 * the sandbox would), then the artifact HTTP surface is exercised. The
 * retention-reclaims-uncited suite needs a real judge verdict's refs and is
 * covered by the real-model E2E.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
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

async function boot(): Promise<{ base: string; dataDir: string; api: ApiServer }> {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-art-e2e-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { base: `http://127.0.0.1:${port}`, dataDir, api };
}

/** Seed a project + agent + task + batch + completed run via queries. */
async function seedCompletedRun(
  api: ApiServer,
  projectBody: Record<string, unknown>,
): Promise<{ projectId: string; runId: string }> {
  const projectId = api.queries.createProject({
    name: projectBody.name as string,
    slug: projectBody.slug as string,
    ...(projectBody.artifact_retention
      ? { artifactRetention: projectBody.artifact_retention as string }
      : {}),
  }).id;
  const agent = api.queries.registerAgent({
    id: `art-agent-${Date.now()}`,
    displayName: "Art Agent",
  });
  const task = api.queries.createTask(projectId, {
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
  });
  const batch = api.queries.createBatch({
    taskId: task.id,
    projectId,
    agentId: agent.id,
    model: "stored-model",
    provider: "stored-provider",
    repeats: 1,
  });
  const run = api.queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId,
    agentId: agent.id,
    model: "stored-model",
    provider: "stored-provider",
    repeatIndex: 0,
    status: "completed",
  });
  return { projectId, runId: run.id };
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

describe("run artifacts (serve + list + traversal refusal)", () => {
  it("lists and serves artifacts with correct content-type/disposition + sha256", async () => {
    const { base, dataDir, api } = await boot();
    const { projectId, runId } = await seedCompletedRun(api, {
      name: "Artifacts",
      slug: "artifacts-e2e",
    });
    await seedArtifacts(dataDir, projectId, runId);

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

    const img = await fetch(`${base}${shot.url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1X1)).toBe(true);

    const log = await fetch(
      `${base}/api/runs/${runId}/artifacts/scratch/debug.log`,
    );
    expect(log.status).toBe(200);
    expect(log.headers.get("content-disposition")).toContain("attachment");
    expect(log.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await log.text()).toBe("noisy trace output\n");
  });

  it("refuses path traversal out of the outputs dir", async () => {
    const { base, dataDir, api } = await boot();
    const { projectId, runId } = await seedCompletedRun(api, {
      name: "Traversal",
      slug: "artifacts-traversal",
    });
    await seedArtifacts(dataDir, projectId, runId);

    const escaped = await fetch(
      `${base}/api/runs/${runId}/artifacts/%2e%2e/%2e%2e/run.json`,
    );
    expect(escaped.status).toBe(404);

    const missing = await fetch(`${base}/api/runs/${runId}/artifacts/nope.png`);
    expect(missing.status).toBe(404);
  });
});

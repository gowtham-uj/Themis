/**
 * Report HTTP routes (P5b-api).
 *
 * Boots the real ApiServer on a temp dataDir. Seeds a completed run + judgement
 * and writes report.html into the judgement dir. OFFLINE — no real LLM.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureAdapter,
  createServer,
  type ApiServer,
} from "../src/api/server.ts";
import { judgementDir } from "../src/db/queries.ts";
import {
  VERDICT_SCHEMA_VERSION,
  type Verdict,
} from "../src/judge/verdict.ts";
import type { Rubric } from "../src/domain.ts";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.close();
    } catch {
      // best-effort
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-report-routes-"));
  tempDirs.push(dir);
  return dir;
}

function sampleRubric(): Rubric {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      {
        id: "A1",
        axis: "A",
        label: "correctness",
        weight: 1,
        appliesTo: "coding",
        anchors: {
          full: "fully correct",
          partial: "partially correct",
          none: "incorrect",
        },
      },
    ],
  };
}

function sampleVerdict(): Verdict {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: {
      score: 0.8,
      verdict: "pass",
      summary: "fixture report verdict",
    },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "ok",
        score: 0.8,
        evidence: ["fixture"],
        findingIds: [],
      },
    ],
    findings: [],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: {
      looping: { value: false, note: "none" },
    },
    attribution: { agent_vs_environment: "agent" },
    observations: [],
    improvements: {
      summary: "n/a",
      withoutSource: [],
    },
  };
}

const SAMPLE_REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture report</title></head>
<body><h1>Fixture report</h1></body>
</html>
`;

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

async function http(
  base: string,
  method: string,
  path: string,
  opts: {
    body?: unknown;
    headers?: Record<string, string>;
    raw?: boolean;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  if (!opts.raw) {
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 25;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

async function boot(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const adapter = createFixtureAdapter({
    holdMs: 40,
    messages: ["fixture-hello"],
  });
  const api = createServer({
    dataDir,
    adapter,
    concurrency: 1,
    startOpts: { timeoutMs: 15_000 },
  });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

async function seedCompletedRun(
  base: string,
  api: ApiServer,
): Promise<{ projectId: string; taskId: string; runId: string }> {
  const proj = await http(base, "POST", "/api/projects", {
    body: { name: "ReportProj", slug: `report-${Date.now()}` },
  });
  expect(proj.status).toBe(201);
  const projectId = (proj.json as { id: string }).id;

  const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
    body: {
      name: "Report task",
      prompt: "Do the thing",
      workspace: { source: "empty" },
      rubric: sampleRubric(),
      profile: "bugfix",
    },
  });
  expect(taskRes.status).toBe(201);
  const taskId = (taskRes.json as { id: string }).id;

  const start = await http(base, "POST", `/api/projects/${projectId}/runs`, {
    body: {
      taskId,
      agent: "fixture",
      model: "fixture-model",
      provider: "fixture",
      repeats: 1,
    },
  });
  expect(start.status).toBe(202);
  const runId = (start.json as { run_ids: string[] }).run_ids[0]!;

  await waitFor(() => {
    const r = api.queries.getRun(runId);
    return r != null && (r.status === "completed" || r.status === "failed");
  });

  const run = api.queries.getRun(runId);
  expect(run?.status).toBe("completed");
  return { projectId, taskId, runId };
}

/**
 * Create a completed judgement with verdict.json + report.html on disk.
 */
async function seedCompletedJudgementWithReport(
  api: ApiServer,
  opts: { runId: string; projectId: string },
): Promise<{ judgementId: string; reportPath: string }> {
  const judgement = api.queries.createJudgement({
    runId: opts.runId,
    projectId: opts.projectId,
    judgeModel: "fixture-judge",
    judgeProvider: "fixture",
    systemPromptVersion: "v2-test",
    status: "running",
  });
  api.queries.storeVerdict(judgement.id, sampleVerdict());

  const dir = judgementDir(api.app.dataDir, opts.projectId, judgement.id);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.html");
  await writeFile(reportPath, SAMPLE_REPORT_HTML, "utf8");

  return { judgementId: judgement.id, reportPath };
}

describe("Report routes (P5b-api)", () => {
  it("GET /api/runs/:id/report → 200 text/html with nosniff when report exists", async () => {
    const { api, base } = await boot();
    const { projectId, runId } = await seedCompletedRun(base, api);
    await seedCompletedJudgementWithReport(api, { runId, projectId });

    const res = await http(base, "GET", `/api/runs/${runId}/report`, {
      raw: true,
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.text.trimStart().toLowerCase().startsWith("<!doctype html")).toBe(
      true,
    );
    expect(res.text).toContain("Fixture report");
  });

  it("GET /api/runs/:id/report?download=1 → Content-Disposition attachment", async () => {
    const { api, base } = await boot();
    const { projectId, runId } = await seedCompletedRun(base, api);
    await seedCompletedJudgementWithReport(api, { runId, projectId });

    const res = await http(
      base,
      "GET",
      `/api/runs/${runId}/report?download=1`,
      { raw: true },
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/attachment/i);
    expect(cd).toContain(`report-${runId}.html`);
  });

  it("GET /api/runs/:id/report → 404 when run has no judgement", async () => {
    const { api, base } = await boot();
    const { runId } = await seedCompletedRun(base, api);

    const res = await http(base, "GET", `/api/runs/${runId}/report`, {
      raw: true,
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/judgements/:id/report → 200 text/html; 404 if missing", async () => {
    const { api, base } = await boot();
    const { projectId, runId } = await seedCompletedRun(base, api);
    const { judgementId } = await seedCompletedJudgementWithReport(api, {
      runId,
      projectId,
    });

    const ok = await http(
      base,
      "GET",
      `/api/judgements/${judgementId}/report`,
      { raw: true, headers: { Accept: "text/html" } },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/html/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.text.trimStart().toLowerCase().startsWith("<!doctype html")).toBe(
      true,
    );

    const missingJ = await http(
      base,
      "GET",
      `/api/judgements/does-not-exist/report`,
      { raw: true },
    );
    expect(missingJ.status).toBe(404);

    // Judgement without report.html
    const bare = api.queries.createJudgement({
      runId,
      projectId,
      judgeModel: "fixture-judge",
      judgeProvider: "fixture",
      systemPromptVersion: "v2-test",
      status: "completed",
    });
    const noFile = await http(
      base,
      "GET",
      `/api/judgements/${bare.id}/report`,
      { raw: true },
    );
    expect(noFile.status).toBe(404);
  });

  it("GET /api/judgements/:id/report?download=1 sets judgement filename", async () => {
    const { api, base } = await boot();
    const { projectId, runId } = await seedCompletedRun(base, api);
    const { judgementId } = await seedCompletedJudgementWithReport(api, {
      runId,
      projectId,
    });

    const res = await http(
      base,
      "GET",
      `/api/judgements/${judgementId}/report?download=1`,
      { raw: true },
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/attachment/i);
    expect(cd).toContain(`report-judgement-${judgementId}.html`);
  });
});

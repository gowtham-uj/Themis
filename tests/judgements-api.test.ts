/**
 * Judgements persistence + API tests (P4c) — pure API/persistence surface.
 *
 * The real judgeRunner now drives a PI SDK judge agent against a configured
 * provider/model; that path is exercised by the real-model E2E, not offline.
 * Here we seed completed runs + verdicts directly through queries.storeVerdict
 * (the persistence step the real runner ends on) and assert the API surface:
 * GET judgement + verdict body + score mirror + events stream + list filters +
 * 404. The POST→202 + Idempotency-Key dedup is asserted against the route's
 * synchronous response; we then seed the verdict ourselves.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { judgementDir, judgeEventsPath } from "../src/db/queries.ts";
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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-judgements-"));
  tempDirs.push(dir);
  return dir;
}

function sampleRubric(version = 1): Rubric {
  return {
    version,
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

function sampleVerdict(score = 0.75): Verdict {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: {
      score,
      verdict: score >= 0.8 ? "pass" : score >= 0.4 ? "partial" : "fail",
      summary: `verdict score=${score}`,
    },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "looks mostly correct",
        score,
        evidence: ["evidence line"],
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
    observations: ["observation"],
    improvements: {
      summary: "keep going",
      withoutSource: [],
    },
  };
}

interface HttpResult {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
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
  return { status: res.status, headers: res.headers, json, text };
}

/** Collect SSE data frames until the connection ends (or timeout). */
async function collectSse(
  base: string,
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events: unknown[] = [];
    for (const block of text.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            // ignore non-json
          }
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

async function boot(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

/** Seed project + task + a completed run via queries (no agent run needed). */
async function seedCompletedRun(
  api: ApiServer,
): Promise<{ projectId: string; taskId: string; runId: string }> {
  const project = api.queries.createProject({
    name: "JudgeProj",
    slug: `judge-${Date.now()}`,
    defaultJudgeModel: "deepseek-v4-flash",
    defaultJudgeProvider: "nuralwatt",
  });
  const agent = api.queries.registerAgent({
    id: `judge-agent-${Date.now()}`,
    displayName: "Judge Agent",
  });
  const task = api.queries.createTask(project.id, {
    name: "Judge task",
    prompt: "Do the thing",
    workspace: { source: "empty" },
    rubric: sampleRubric(1),
    profile: "bugfix",
  });
  const batch = api.queries.createBatch({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "stored-model",
    provider: "stored-provider",
    repeats: 1,
  });
  const run = api.queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "stored-model",
    provider: "stored-provider",
    repeatIndex: 0,
    status: "completed",
  });
  return { projectId: project.id, taskId: task.id, runId: run.id };
}

/** Seed a completed judgement + judge.jsonl events directly (the runner's persistence step). */
async function seedCompletedJudgement(
  api: ApiServer,
  runId: string,
  projectId: string,
  verdict: Verdict,
  opts: { model?: string; provider?: string; version?: string } = {},
): Promise<string> {
  const judgement = api.queries.createJudgement({
    runId,
    projectId,
    judgeModel: opts.model ?? "deepseek-v4-flash",
    judgeProvider: opts.provider ?? "nuralwatt",
    systemPromptVersion: opts.version ?? "v2-test",
    status: "running",
  });
  const dir = judgementDir(api.app.dataDir, projectId, judgement.id);
  await mkdir(dir, { recursive: true });
  const eventsPath = judgeEventsPath(api.app.dataDir, projectId, judgement.id);
  const lines = [
    {
      seq: 0,
      type: "judge.start",
      ts: new Date().toISOString(),
      judgementId: judgement.id,
    },
    {
      seq: 1,
      type: "message",
      role: "assistant",
      text: "scoring…",
      ts: new Date().toISOString(),
    },
    {
      seq: 2,
      type: "judge.end",
      ts: new Date().toISOString(),
      overall: verdict.overall,
    },
  ];
  await writeFile(
    eventsPath,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
  api.queries.storeVerdict(judgement.id, verdict);
  return judgement.id;
}

describe("Judgements API (P4c)", () => {
  it("GET /api/judgements/:id returns the seeded completed verdict + score mirror", async () => {
    const { api, base } = await boot();
    const { runId, projectId } = await seedCompletedRun(api);
    const verdict = sampleVerdict(0.75);
    const jid = await seedCompletedJudgement(api, runId, projectId, verdict, {
      model: "deepseek-v4-flash",
      version: "v2-test",
    });

    const get = await http(base, "GET", `/api/judgements/${jid}`);
    expect(get.status).toBe(200);
    const body = get.json as {
      id: string;
      status: string;
      judge_model: string;
      system_prompt_version: string;
      overall_score: number;
      verdict: string;
      overall: { score: number; verdict: string; summary: string };
      criteria: Array<{ criterion: string; score: number }>;
      findings: unknown[];
      improvements: unknown;
      diagnostics: unknown;
    };
    expect(body.id).toBe(jid);
    expect(body.status).toBe("completed");
    expect(body.judge_model).toBe("deepseek-v4-flash");
    expect(body.system_prompt_version).toBe("v2-test");
    expect(body.overall_score).toBe(verdict.overall.score);
    expect(body.verdict).toBe(verdict.overall.verdict);
    expect(body.overall.score).toBe(verdict.overall.score);
    expect(body.overall.summary).toBe(verdict.overall.summary);
    expect(body.criteria[0]!.criterion).toBe("A1");
    expect(body.criteria[0]!.score).toBe(verdict.overall.score);
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.improvements).toBeTruthy();
    expect(body.diagnostics).toBeTruthy();
  });

  it("GET /judgements/:id/events?since=0 streams judge.jsonl events", async () => {
    const { api, base } = await boot();
    const { runId, projectId } = await seedCompletedRun(api);
    const verdict = sampleVerdict(0.62);
    const jid = await seedCompletedJudgement(api, runId, projectId, verdict);

    const events = await collectSse(
      base,
      `/api/judgements/${jid}/events?since=0`,
      { timeoutMs: 5_000 },
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    const types = events
      .map((e) =>
        e && typeof e === "object" && "type" in e
          ? (e as { type: string }).type
          : null,
      )
      .filter(Boolean);
    expect(types).toContain("judge.start");
    expect(types).toContain("judge.end");

    const end = events.find(
      (e) =>
        e &&
        typeof e === "object" &&
        (e as { type?: string }).type === "judge.end",
    ) as { overall?: { score: number } } | undefined;
    expect(end?.overall?.score).toBe(verdict.overall.score);
  });

  it("storeVerdict mirrors overall_score + per-criterion scores into SQLite", async () => {
    const { api, base } = await boot();
    void base;
    const { runId, projectId } = await seedCompletedRun(api);
    const jid = await seedCompletedJudgement(api, runId, projectId, sampleVerdict(0.62));

    const j = api.queries.getJudgement(jid);
    expect(j).toBeTruthy();
    expect(j!.overallScore).toBe(0.62);
    expect(j!.verdict).toBe("partial");
    expect(j!.status).toBe("completed");
    expect(j!.endedAt).toBeTruthy();
    expect(j!.verdictBody?.overall.score).toBe(0.62);

    const listed = api.queries.listJudgements({
      projectId,
      runId,
      status: "completed",
    });
    expect(listed.judgements.length).toBeGreaterThanOrEqual(1);
    const hit = listed.judgements.find((x) => x.id === jid);
    expect(hit?.overallScore).toBe(0.62);
    expect(hit?.verdict).toBe("partial");
  });

  it("listJudgements filters by run + status via GET /api/judgements", async () => {
    const { api, base } = await boot();
    const { runId, projectId } = await seedCompletedRun(api);
    const verdict = sampleVerdict(0.7);
    const idA = await seedCompletedJudgement(api, runId, projectId, verdict, {
      model: "m1",
    });
    const idB = await seedCompletedJudgement(api, runId, projectId, verdict, {
      model: "m2",
    });
    void idA;
    void idB;
    const queued = api.queries.createJudgement({
      runId,
      projectId,
      judgeModel: "queued-model",
      judgeProvider: "nuralwatt",
      systemPromptVersion: "v2-test",
      status: "queued",
    });

    const byRun = await http(
      base,
      "GET",
      `/api/judgements?runId=${encodeURIComponent(runId)}`,
    );
    expect(byRun.status).toBe(200);
    const runList = byRun.json as {
      judgements: Array<{ id: string; status: string; run_id: string }>;
    };
    expect(runList.judgements.length).toBeGreaterThanOrEqual(3);
    expect(runList.judgements.every((j) => j.run_id === runId)).toBe(true);

    const completed = await http(
      base,
      "GET",
      `/api/judgements?runId=${encodeURIComponent(runId)}&status=completed`,
    );
    expect(completed.status).toBe(200);
    const completedList = completed.json as {
      judgements: Array<{ id: string; status: string }>;
    };
    expect(
      completedList.judgements.every((j) => j.status === "completed"),
    ).toBe(true);
    expect(completedList.judgements.some((j) => j.id === queued.id)).toBe(false);

    const queuedOnly = await http(
      base,
      "GET",
      `/api/judgements?status=queued&projectId=${encodeURIComponent(projectId)}`,
    );
    expect(queuedOnly.status).toBe(200);
    const qList = queuedOnly.json as {
      judgements: Array<{ id: string; status: string }>;
    };
    expect(qList.judgements.some((j) => j.id === queued.id)).toBe(true);
    expect(qList.judgements.every((j) => j.status === "queued")).toBe(true);
  });

  it("Idempotency-Key on POST /judgements does not double-create", async () => {
    const { api, base } = await boot();
    const { runId } = await seedCompletedRun(api);

    const headers = { "Idempotency-Key": "judge-idem-1" };
    const first = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: { model: "idem-judge" },
      headers,
    });
    expect(first.status).toBe(202);
    const firstId = (first.json as { judgementId: string }).judgementId;

    const second = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: { model: "idem-judge" },
      headers,
    });
    expect(second.status).toBe(202);
    const secondId = (second.json as { judgementId: string }).judgementId;
    expect(secondId).toBe(firstId);

    const listed = api.queries.listJudgements({ runId });
    const matching = listed.judgements.filter((j) => j.id === firstId);
    expect(matching.length).toBe(1);
  });

  it("GET /api/judgements/:id returns 404 for missing id", async () => {
    const { base } = await boot();
    const res = await http(base, "GET", "/api/judgements/does-not-exist");
    expect(res.status).toBe(404);
    const problem = res.json as {
      status: number;
      title: string;
      detail: string;
    };
    expect(problem.status).toBe(404);
    expect(problem.title).toBe("Not Found");
    expect(problem.detail).toMatch(/judgement/i);
  });
});

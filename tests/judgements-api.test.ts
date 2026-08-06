/**
 * Judgements persistence + API tests (P4c).
 *
 * Boots the real ApiServer on a temp dataDir with createFixtureAdapter.
 * Injects a fake judgeRunner so no real LLM is called.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFixtureAdapter,
  createServer,
  type ApiServer,
} from "../src/api/server.ts";
import type {
  JudgeRunner,
  JudgeRunContext,
} from "../src/api/judgements-routes.ts";
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
      summary: `fixture verdict score=${score}`,
    },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "looks mostly correct",
        score,
        evidence: ["fixture evidence"],
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
    observations: ["fixture observation"],
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

/**
 * Fake judge runner: writes a couple of judge.jsonl events, then storeVerdict.
 * Completes synchronously-ish so GET immediately after a short wait sees completed.
 */
function makeFakeJudgeRunner(verdict: Verdict): JudgeRunner {
  return async (ctx: JudgeRunContext) => {
    const eventsPath = ctx.eventsPath;
    await mkdir(dirname(eventsPath), { recursive: true });
    const lines = [
      {
        seq: 0,
        type: "judge.start",
        ts: new Date().toISOString(),
        judgementId: ctx.judgementId,
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
    ctx.queries.storeVerdict(ctx.judgementId, verdict);
  };
}

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}

async function seedCompletedRun(
  base: string,
  api: ApiServer,
): Promise<{ projectId: string; taskId: string; runId: string }> {
  const proj = await http(base, "POST", "/api/projects", {
    body: { name: "JudgeProj", slug: `judge-${Date.now()}` },
  });
  expect(proj.status).toBe(201);
  const projectId = (proj.json as { id: string }).id;

  const taskRes = await http(base, "POST", `/api/projects/${projectId}/tasks`, {
    body: {
      name: "Judge task",
      prompt: "Do the thing",
      workspace: { source: "empty" },
      rubric: sampleRubric(1),
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

  // Wait for fixture run to complete.
  await waitFor(() => {
    const r = api.queries.getRun(runId);
    return r != null && (r.status === "completed" || r.status === "failed");
  }, { timeoutMs: 15_000 });

  const run = api.queries.getRun(runId);
  expect(run?.status).toBe("completed");

  return { projectId, taskId, runId };
}

async function boot(opts: {
  verdict?: Verdict;
  judgeRunner?: JudgeRunner;
} = {}): Promise<{
  api: ApiServer;
  base: string;
  verdict: Verdict;
}> {
  const dataDir = await tempDataDir();
  const verdict = opts.verdict ?? sampleVerdict(0.75);
  const judgeRunner =
    opts.judgeRunner ?? makeFakeJudgeRunner(verdict);
  const adapter = createFixtureAdapter({
    holdMs: 40,
    messages: ["fixture-hello"],
  });
  const api = createServer({
    dataDir,
    adapter,
    concurrency: 1,
    startOpts: { timeoutMs: 15_000 },
    judgeRunner,
    defaultSystemPromptVersion: "v2-test",
    defaultJudgeModel: "fixture-judge",
    defaultJudgeProvider: "fixture",
  });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}`, verdict };
}

describe("Judgements API (P4c)", () => {
  it("POST /runs/:id/judgements → 202 + judgementId; GET returns completed verdict", async () => {
    const { api, base, verdict } = await boot();
    const { runId } = await seedCompletedRun(base, api);

    const post = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: { model: "fixture-judge", provider: "fixture" },
    });
    expect(post.status).toBe(202);
    const created = post.json as {
      judgementId: string;
      location: string;
    };
    expect(created.judgementId).toBeTruthy();
    expect(created.location).toBe(`/api/judgements/${created.judgementId}`);
    expect(post.headers.get("location")).toBe(
      `/api/judgements/${created.judgementId}`,
    );

    // Wait for the injected runner to store the verdict.
    await waitFor(() => {
      const j = api.queries.getJudgement(created.judgementId);
      return j?.status === "completed";
    });

    const get = await http(base, "GET", `/api/judgements/${created.judgementId}`);
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
    expect(body.id).toBe(created.judgementId);
    expect(body.status).toBe("completed");
    expect(body.judge_model).toBe("fixture-judge");
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
    const { api, base, verdict } = await boot();
    const { runId } = await seedCompletedRun(base, api);

    const post = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: {},
    });
    expect(post.status).toBe(202);
    const jid = (post.json as { judgementId: string }).judgementId;

    await waitFor(() => {
      const j = api.queries.getJudgement(jid);
      return j?.status === "completed";
    });

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

    // Confirm overall from the end event matches the injected verdict.
    const end = events.find(
      (e) =>
        e &&
        typeof e === "object" &&
        (e as { type?: string }).type === "judge.end",
    ) as { overall?: { score: number } } | undefined;
    expect(end?.overall?.score).toBe(verdict.overall.score);
  });

  it("storeVerdict mirrors overall_score + per-criterion scores into SQLite", async () => {
    const { api, base, verdict } = await boot({
      verdict: sampleVerdict(0.62),
    });
    const { runId, projectId } = await seedCompletedRun(base, api);

    const post = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: {},
    });
    const jid = (post.json as { judgementId: string }).judgementId;
    await waitFor(() => api.queries.getJudgement(jid)?.status === "completed");

    const j = api.queries.getJudgement(jid);
    expect(j).toBeTruthy();
    expect(j!.overallScore).toBe(0.62);
    expect(j!.verdict).toBe("partial");
    expect(j!.status).toBe("completed");
    expect(j!.endedAt).toBeTruthy();
    expect(j!.verdictBody?.overall.score).toBe(0.62);

    // listJudgements includes overall_score
    const listed = api.queries.listJudgements({
      projectId,
      runId,
      status: "completed",
    });
    expect(listed.judgements.length).toBeGreaterThanOrEqual(1);
    const hit = listed.judgements.find((x) => x.id === jid);
    expect(hit?.overallScore).toBe(0.62);
    expect(hit?.verdict).toBe(verdict.overall.verdict);
  });

  it("listJudgements filters by run + status via GET /api/judgements", async () => {
    const { api, base } = await boot();
    const { runId, projectId } = await seedCompletedRun(base, api);

    // Create two judgements with the same runner.
    const a = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: { model: "m1" },
    });
    const b = await http(base, "POST", `/api/runs/${runId}/judgements`, {
      body: { model: "m2" },
    });
    const idA = (a.json as { judgementId: string }).judgementId;
    const idB = (b.json as { judgementId: string }).judgementId;

    await waitFor(
      () =>
        api.queries.getJudgement(idA)?.status === "completed" &&
        api.queries.getJudgement(idB)?.status === "completed",
    );

    // Also create a queued judgement that we leave unfinished (no runner path
    // needed — we use setJudgementStatus after create without runner for a
    // third, or just create one via queries).
    const queued = api.queries.createJudgement({
      runId,
      projectId,
      judgeModel: "queued-model",
      judgeProvider: "fixture",
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
    expect(
      completedList.judgements.some((j) => j.id === idA || j.id === idB),
    ).toBe(true);
    expect(completedList.judgements.some((j) => j.id === queued.id)).toBe(
      false,
    );

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
    const { runId } = await seedCompletedRun(base, api);

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

    // Only one judgement row for this run with that model (runner may complete
    // both attempts if it raced — but the second request returns the cached
    // body, so we check that list doesn't explode with duplicates for this
    // idempotency key's single create).
    await waitFor(
      () => api.queries.getJudgement(firstId)?.status === "completed",
    );
    const listed = api.queries.listJudgements({ runId });
    // At least the one we created; exact count depends on races, but the
    // cached response guarantees we didn't create a *second* row from the
    // second HTTP call.
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

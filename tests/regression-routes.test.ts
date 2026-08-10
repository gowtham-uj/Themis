/**
 * Regression-views HTTP routes (P7b-api).
 *
 * Boots the real ApiServer on a temp dataDir. Seeds a project + 2-criteria
 * rubric task + two batches (agentCommit v1/v2) with storeVerdict directly.
 * Seeds already-validated historical verdict rows directly; no agent or judge execution is involved.
 *
 * Asserts: trend finding deltas, two-run set-diff, release suite compare,
 * listRuns taskId filter (additive).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { fingerprintOf } from "../src/db/findings.ts";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import {
  VERDICT_SCHEMA_VERSION,
  type Finding,
  type Verdict,
} from "../src/judge/verdict.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-regression-routes-"));
  tempDirs.push(dir);
  return dir;
}

function twoAxisRubric(): Rubric {
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
      {
        id: "D1",
        axis: "D",
        label: "verification",
        weight: 1,
        appliesTo: "coding",
        anchors: {
          full: "fully verified",
          partial: "partially verified",
          none: "not verified",
        },
      },
    ],
  };
}

function sampleTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "ext-task-1",
    name: "Fix the bug",
    prompt: "Please fix the off-by-one error",
    workspace: { source: "empty" },
    rubric: twoAxisRubric(),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
  };
}

function finding(
  id: string,
  category: string,
  claim: string,
  file: string,
  hunk: number,
): Finding {
  return {
    id,
    category,
    severity: "major",
    confidence: 0.9,
    claim,
    refs: [{ kind: "diff", file, hunk }],
  };
}

function baseVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: { score: 0.5, verdict: "partial", summary: "partial" },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "ok",
        score: 0.5,
        evidence: ["e"],
        findingIds: [],
      },
      {
        criterion: "D1",
        weight: 1,
        feedback: "ok",
        score: 0.5,
        evidence: ["e"],
        findingIds: [],
      },
    ],
    findings: [],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: { looping: { value: false, note: "none" } },
    attribution: { agent_vs_environment: "agent" },
    observations: [],
    improvements: { summary: "ok", withoutSource: [] },
    ...overrides,
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

interface SeededWorld {
  api: ApiServer;
  base: string;
  projectId: string;
  taskId: string;
  otherTaskId: string;
  agentId: string;
  batchV1Id: string;
  batchV2Id: string;
  runV1Id: string;
  runV2Id: string;
  sharedFp: string;
  v1OnlyFp: string;
  v2OnlyFp: string;
  scoreV1: number;
  scoreV2: number;
}

/**
 * Seed:
 *  - project + agent + two tasks (shared task for both versions; other task for listRuns filter)
 *  - batch v1 (agentCommit "v1") with run + verdict score 0.4
 *      findings: shared + v1-only
 *  - batch v2 (agentCommit "v2") with run + verdict score 0.7
 *      findings: shared + v2-only
 * Fingerprints: same category/file/hunk → same fp (task-scoped).
 */
async function seedWorld(): Promise<SeededWorld> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { queries } = api;

  const project = queries.createProject({
    name: "Regression Routes",
    slug: `regression-routes-${Date.now()}`,
  });
  const agent = queries.registerAgent({
    id: `agent-${Date.now()}`,
    displayName: "Test Agent",
  });
  const task = queries.createTask(project.id, sampleTask());
  const otherTask = queries.createTask(
    project.id,
    sampleTask({ id: "ext-task-2", name: "Other task" }),
  );

  const sharedFinding = finding(
    "f-shared",
    "test_gaming",
    "agent deleted the failing test",
    "src/auth.ts",
    2,
  );
  const v1OnlyFinding = finding(
    "f-v1",
    "verification_skipped",
    "agent never ran the tests",
    "src/auth.ts",
    3,
  );
  const v2OnlyFinding = finding(
    "f-v2",
    "hallucinated_api",
    "agent invented a nonexistent helper",
    "src/util.ts",
    1,
  );

  const scoreV1 = 0.4;
  const scoreV2 = 0.7;

  // --- v1 batch + run ---
  const batchV1 = queries.createBatch({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeats: 1,
    agentCommit: "v1",
    triggerRef: "v1",
  });
  const runV1 = queries.createRun({
    id: `run-v1-${Date.now()}`,
    batchId: batchV1.id,
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeatIndex: 0,
    status: "completed",
    agentCommit: "v1",
    triggerRef: "v1",
  });
  const jV1 = queries.createJudgement({
    id: `j-v1-${Date.now()}`,
    runId: runV1.id,
    projectId: project.id,
    judgeModel: "judge-model",
    judgeProvider: "test",
    systemPromptVersion: "v1",
    status: "running",
  });
  queries.storeVerdict(
    jV1.id,
    baseVerdict({
      overall: {
        score: scoreV1,
        verdict: "fail",
        summary: "v1 worse",
      },
      criteria: [
        {
          criterion: "A1",
          weight: 1,
          feedback: "weak",
          score: 0.4,
          evidence: [],
          findingIds: ["f-shared", "f-v1"],
        },
        {
          criterion: "D1",
          weight: 1,
          feedback: "weak",
          score: 0.3,
          evidence: [],
          findingIds: [],
        },
      ],
      findings: [sharedFinding, v1OnlyFinding],
      diagnostics: {
        looping: { value: true, note: "v1 looped" },
        verification_performed: { value: false },
      },
    }),
  );

  // Tiny delay so createdAt ordering is strictly increasing when ISO timestamps collide.
  await new Promise((r) => setTimeout(r, 5));

  // --- v2 batch + run ---
  const batchV2 = queries.createBatch({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeats: 1,
    agentCommit: "v2",
    triggerRef: "v2",
  });
  const runV2 = queries.createRun({
    id: `run-v2-${Date.now()}`,
    batchId: batchV2.id,
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeatIndex: 0,
    status: "completed",
    agentCommit: "v2",
    triggerRef: "v2",
  });
  const jV2 = queries.createJudgement({
    id: `j-v2-${Date.now()}`,
    runId: runV2.id,
    projectId: project.id,
    judgeModel: "judge-model",
    judgeProvider: "test",
    systemPromptVersion: "v1",
    status: "running",
  });
  queries.storeVerdict(
    jV2.id,
    baseVerdict({
      overall: {
        score: scoreV2,
        verdict: "partial",
        summary: "v2 better",
      },
      criteria: [
        {
          criterion: "A1",
          weight: 1,
          feedback: "better",
          score: 0.7,
          evidence: [],
          findingIds: ["f-shared", "f-v2"],
        },
        {
          criterion: "D1",
          weight: 1,
          feedback: "better",
          score: 0.6,
          evidence: [],
          findingIds: [],
        },
      ],
      findings: [sharedFinding, v2OnlyFinding],
      diagnostics: {
        looping: { value: false },
        verification_performed: { value: true, note: "ran tests" },
      },
    }),
  );

  // Other-task run (v1) — for listRuns taskId filter isolation.
  const batchOther = queries.createBatch({
    taskId: otherTask.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeats: 1,
    agentCommit: "v1",
  });
  queries.createRun({
    id: `run-other-${Date.now()}`,
    batchId: batchOther.id,
    taskId: otherTask.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeatIndex: 0,
    status: "completed",
    agentCommit: "v1",
  });

  const sharedFp = fingerprintOf(sharedFinding, task.id).fingerprint;
  const v1OnlyFp = fingerprintOf(v1OnlyFinding, task.id).fingerprint;
  const v2OnlyFp = fingerprintOf(v2OnlyFinding, task.id).fingerprint;

  return {
    api,
    base,
    projectId: project.id,
    taskId: task.id,
    otherTaskId: otherTask.id,
    agentId: agent.id,
    batchV1Id: batchV1.id,
    batchV2Id: batchV2.id,
    runV1Id: runV1.id,
    runV2Id: runV2.id,
    sharedFp,
    v1OnlyFp,
    v2OnlyFp,
    scoreV1,
    scoreV2,
  };
}

describe("regression routes (P7b-api)", () => {
  it("GET trend returns ordered points with finding deltas", async () => {
    const w = await seedWorld();
    const res = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/tasks/${w.taskId}/trend`,
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      points: Array<{
        order: number;
        runId: string;
        judgementId: string;
        overallScore: number | null;
        verdict: string | null;
        batchId: string;
        createdAt: string;
        findingDeltas: {
          introduced: Array<{ fingerprint: string }>;
          resolved: Array<{ fingerprint: string }>;
        };
      }>;
    };
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points.length).toBeGreaterThanOrEqual(2);

    // Oldest-first.
    for (let i = 1; i < body.points.length; i += 1) {
      expect(
        body.points[i]!.createdAt >= body.points[i - 1]!.createdAt,
      ).toBe(true);
    }

    const p0 = body.points[0]!;
    const p1 = body.points[1]!;
    expect(p0.overallScore).toBe(w.scoreV1);
    expect(p1.overallScore).toBe(w.scoreV2);
    expect(p0.runId).toBe(w.runV1Id);
    expect(p1.runId).toBe(w.runV2Id);

    // First point: all findings introduced, none resolved.
    const intro0 = p0.findingDeltas.introduced.map((f) => f.fingerprint);
    expect(intro0).toContain(w.sharedFp);
    expect(intro0).toContain(w.v1OnlyFp);
    expect(p0.findingDeltas.resolved).toHaveLength(0);

    // Second point (v1→v2): v2-new introduced; v1-only resolved; shared not either.
    const intro1 = p1.findingDeltas.introduced.map((f) => f.fingerprint);
    const resolved1 = p1.findingDeltas.resolved.map((f) => f.fingerprint);
    expect(intro1).toContain(w.v2OnlyFp);
    expect(intro1).not.toContain(w.sharedFp);
    expect(resolved1).toContain(w.v1OnlyFp);
    expect(resolved1).not.toContain(w.sharedFp);
  });

  it("GET trend 404 for missing task", async () => {
    const w = await seedWorld();
    const res = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/tasks/does-not-exist/trend`,
    );
    expect(res.status).toBe(404);
  });

  it("GET trend empty points (200) when no judged runs", async () => {
    const w = await seedWorld();
    // otherTask has a run but no judgement.
    const res = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/tasks/${w.otherTaskId}/trend`,
    );
    expect(res.status).toBe(200);
    const body = res.json as { points: unknown[] };
    expect(body.points).toEqual([]);
  });

  it("GET run-compare returns deltaOverall, axes, finding set-diff", async () => {
    const w = await seedWorld();
    const res = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/runs?a=${encodeURIComponent(w.runV1Id)}&b=${encodeURIComponent(w.runV2Id)}`,
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      deltaOverall: number | null;
      perCriterion: Array<{
        criterion: string;
        axis: string;
        delta: number;
        aScore: number;
        bScore: number;
      }>;
      findingSetDiff: {
        introduced: Array<{ fingerprint: string }>;
        resolved: Array<{ fingerprint: string }>;
        persisted: Array<{ fingerprint: string }>;
      };
      a: { runId: string; judgementId: string; overallScore: number | null };
      b: { runId: string; judgementId: string; overallScore: number | null };
    };

    // B − A = 0.7 − 0.4 = +0.3
    expect(body.deltaOverall).toBeCloseTo(w.scoreV2 - w.scoreV1, 6);
    expect(body.a.runId).toBe(w.runV1Id);
    expect(body.b.runId).toBe(w.runV2Id);
    expect(body.a.overallScore).toBe(w.scoreV1);
    expect(body.b.overallScore).toBe(w.scoreV2);

    const axes = new Map(body.perCriterion.map((c) => [c.criterion, c.axis]));
    expect(axes.get("A1")).toBe("A");
    expect(axes.get("D1")).toBe("D");
    expect(body.perCriterion).toHaveLength(2);

    const intro = body.findingSetDiff.introduced.map((f) => f.fingerprint);
    const resolved = body.findingSetDiff.resolved.map((f) => f.fingerprint);
    const persisted = body.findingSetDiff.persisted.map((f) => f.fingerprint);
    expect(intro).toEqual([w.v2OnlyFp]);
    expect(resolved).toEqual([w.v1OnlyFp]);
    expect(persisted).toEqual([w.sharedFp]);
  });

  it("GET run-compare 400 if a/b missing; 404 if run missing", async () => {
    const w = await seedWorld();
    const missing = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/runs`,
    );
    expect(missing.status).toBe(400);

    const onlyA = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/runs?a=${encodeURIComponent(w.runV1Id)}`,
    );
    expect(onlyA.status).toBe(400);

    const badRun = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/runs?a=${encodeURIComponent(w.runV1Id)}&b=no-such-run`,
    );
    expect(badRun.status).toBe(404);
  });

  it("GET release-compare returns suite deltas + per-task breakdown", async () => {
    const w = await seedWorld();
    const res = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/releases?from=v1&to=v2`,
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      from: string;
      to: string;
      fromVersion: string;
      toVersion: string;
      fromTasks: number;
      toTasks: number;
      suiteDelta: {
        deltaOverall: number;
        nImproved: number;
        nRegressed: number;
        nFlat: number;
        nNewTasks: number;
        nRemovedTasks: number;
      };
      findingCategoryDeltas: Array<{
        category: string;
        introduced: number;
        resolved: number;
        persisted: number;
        deltaNet: number;
      }>;
      perTaskBreakdown: Array<{
        taskId: string;
        presentInBoth: boolean;
        deltaOverall: number;
      }>;
    };

    expect(body.fromVersion).toBe("v1");
    expect(body.toVersion).toBe("v2");
    expect(body.from).toBe("v1");
    expect(body.to).toBe("v2");
    // Shared task only in both (other task is v1-only → nRemovedTasks).
    expect(body.suiteDelta.nImproved).toBe(1);
    expect(body.suiteDelta.nRegressed).toBe(0);
    expect(body.suiteDelta.deltaOverall).toBeCloseTo(w.scoreV2 - w.scoreV1, 6);

    // Finding category set-diff over tasks present in both.
    const byCat = new Map(
      body.findingCategoryDeltas.map((c) => [c.category, c]),
    );
    expect(byCat.get("hallucinated_api")?.introduced).toBe(1);
    expect(byCat.get("verification_skipped")?.resolved).toBe(1);
    expect(byCat.get("test_gaming")?.persisted).toBe(1);

    const shared = body.perTaskBreakdown.find((t) => t.taskId === w.taskId);
    expect(shared).toBeDefined();
    expect(shared!.presentInBoth).toBe(true);
    expect(shared!.deltaOverall).toBeCloseTo(w.scoreV2 - w.scoreV1, 6);
  });

  it("GET release-compare 400 if from===to or no runs for a version", async () => {
    const w = await seedWorld();
    const same = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/releases?from=v1&to=v1`,
    );
    expect(same.status).toBe(400);

    const missing = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/compare/releases?from=v1&to=v9-nope`,
    );
    expect(missing.status).toBe(400);
    const body = missing.json as { detail?: string };
    expect(String(body.detail ?? missing.text)).toMatch(/no runs for version/i);
  });

  it("listRuns({projectId, taskId}) returns only that task's runs", async () => {
    const w = await seedWorld();
    const { queries } = w.api;

    const all = queries.listRuns({ projectId: w.projectId });
    expect(all.length).toBeGreaterThanOrEqual(3); // v1 + v2 + other

    const forTask = queries.listRuns({
      projectId: w.projectId,
      taskId: w.taskId,
    });
    expect(forTask.length).toBe(2);
    expect(forTask.every((r) => r.taskId === w.taskId)).toBe(true);
    expect(forTask.map((r) => r.id).sort()).toEqual(
      [w.runV1Id, w.runV2Id].sort(),
    );

    const forOther = queries.listRuns({
      projectId: w.projectId,
      taskId: w.otherTaskId,
    });
    expect(forOther.length).toBe(1);
    expect(forOther[0]!.taskId).toBe(w.otherTaskId);

    // Existing filters still work (projectId alone; batchId alone).
    const byBatch = queries.listRuns({ batchId: w.batchV1Id });
    expect(byBatch.length).toBe(1);
    expect(byBatch[0]!.id).toBe(w.runV1Id);

    const byProject = queries.listRuns({ projectId: w.projectId });
    expect(byProject.length).toBe(all.length);
  });
});

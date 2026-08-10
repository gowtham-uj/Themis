/**
 * Findings / issues-log HTTP routes (P6b-api).
 *
 * Boots the real ApiServer on a temp dataDir. Seeds a project + task + a batch
 * of N=2 runs, then storeVerdicts the SAME finding on both so occurrenceCount=2.
 * Seeds already-validated verdict rows directly; no agent or judge execution is involved.
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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-findings-routes-"));
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

function sampleTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "ext-task-1",
    name: "Fix the bug",
    prompt: "Please fix the off-by-one error",
    workspace: { source: "empty" },
    rubric: sampleRubric(),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
  };
}

function defectFinding(
  id: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id,
    category: "test_gaming",
    severity: "major",
    confidence: 0.9,
    claim: "agent deleted the failing test",
    refs: [{ kind: "diff", file: "src/auth.ts", hunk: 2 }],
    fix: {
      direction: "restore the deleted assertion",
      repro: { command: "npm test", expected: "pass" },
    },
    ...overrides,
  };
}

function baseVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: { score: 0.4, verdict: "partial", summary: "partial" },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "reason",
        score: 0.4,
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
  agentId: string;
  batchId: string;
  runIds: [string, string];
  judgementIds: [string, string];
  fingerprint: string;
  finding: Finding;
}

/**
 * Seed a project + task + batch of 2 runs, storeVerdict the same finding on both.
 * Returns ids + fingerprint for assertions.
 */
async function seedRecurringFinding(): Promise<SeededWorld> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { queries } = api;

  const project = queries.createProject({
    name: "Findings Routes",
    slug: `findings-routes-${Date.now()}`,
  });
  const agent = queries.registerAgent({
    id: `agent-${Date.now()}`,
    displayName: "Test Agent",
  });
  const task = queries.createTask(project.id, sampleTask());

  const batch = queries.createBatch({
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeats: 2,
  });

  const run1 = queries.createRun({
    id: `run-1-${Date.now()}`,
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeatIndex: 0,
    status: "completed",
  });
  const run2 = queries.createRun({
    id: `run-2-${Date.now()}`,
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    agentId: agent.id,
    model: "test-model",
    provider: "test",
    repeatIndex: 1,
    status: "completed",
  });

  const finding = defectFinding("f1");
  const v1 = baseVerdict({
    findings: [finding],
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "r",
        score: 0.4,
        evidence: [],
        findingIds: ["f1"],
      },
    ],
  });
  const v2 = baseVerdict({
    findings: [{ ...finding, id: "f1b", confidence: 0.95 }],
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "r",
        score: 0.4,
        evidence: [],
        findingIds: ["f1b"],
      },
    ],
  });

  const j1 = queries.createJudgement({
    id: `j-1-${Date.now()}`,
    runId: run1.id,
    projectId: project.id,
    judgeModel: "judge-model",
    judgeProvider: "test",
    systemPromptVersion: "v1",
    status: "running",
  });
  queries.storeVerdict(j1.id, v1);

  // Ensure lastSeenAt ordering is deterministic if needed: tiny sleep is overkill;
  // second storeVerdict will get a later ISO timestamp naturally.
  const j2 = queries.createJudgement({
    id: `j-2-${Date.now()}`,
    runId: run2.id,
    projectId: project.id,
    judgeModel: "judge-model",
    judgeProvider: "test",
    systemPromptVersion: "v1",
    status: "running",
  });
  queries.storeVerdict(j2.id, v2);

  const { fingerprint } = fingerprintOf(finding, task.id);

  return {
    api,
    base,
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    batchId: batch.id,
    runIds: [run1.id, run2.id],
    judgementIds: [j1.id, j2.id],
    fingerprint,
    finding,
  };
}

describe("findings routes (P6b-api)", () => {
  it("GET /api/projects/:id/findings returns the recurring finding with count=2", async () => {
    const w = await seedRecurringFinding();
    const res = await http(w.base, "GET", `/api/projects/${w.projectId}/findings`);
    expect(res.status).toBe(200);
    const body = res.json as {
      findings: Array<{
        fingerprint: string;
        occurrenceCount: number;
        status: string;
        recurrence: { count: number; firstSeenRunId?: string; lastSeenRunId?: string };
      }>;
      nextCursor: string | null;
    };
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.findings).toHaveLength(1);
    const item = body.findings[0]!;
    expect(item.fingerprint).toBe(w.fingerprint);
    expect(item.occurrenceCount).toBe(2);
    expect(item.recurrence.count).toBe(2);
    expect(item.recurrence.firstSeenRunId).toBe(w.runIds[0]);
    expect(item.recurrence.lastSeenRunId).toBe(w.runIds[1]);
    expect(item.status).toBe("open");
    expect(body.nextCursor).toBeNull();
  });

  it("GET /api/projects/:id/findings?status=open filters", async () => {
    const w = await seedRecurringFinding();
    const open = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/findings?status=open`,
    );
    expect(open.status).toBe(200);
    const openBody = open.json as { findings: unknown[] };
    expect(openBody.findings).toHaveLength(1);

    const resolved = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/findings?status=resolved`,
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = resolved.json as { findings: unknown[] };
    expect(resolvedBody.findings).toHaveLength(0);
  });

  it("GET /api/projects/:id/findings/:fingerprint returns detail with decoded refs + kByBatch", async () => {
    const w = await seedRecurringFinding();
    const res = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/findings/${w.fingerprint}`,
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      finding: {
        fingerprint: string;
        occurrenceCount: number;
        occurrences: Array<{
          refs: unknown;
          fix: unknown;
          refsJson: string;
          status: string;
          runId: string;
        }>;
      };
      recurrence: { count: number; firstSeenRunId?: string; lastSeenRunId?: string };
      kByBatch: Array<{ batchId: string; k: number; n: number }>;
    };

    expect(body.finding.fingerprint).toBe(w.fingerprint);
    expect(body.finding.occurrenceCount).toBe(2);
    expect(body.finding.occurrences).toHaveLength(2);
    expect(body.recurrence.count).toBe(2);
    expect(body.recurrence.firstSeenRunId).toBe(w.runIds[0]);
    expect(body.recurrence.lastSeenRunId).toBe(w.runIds[1]);

    // refs decoded as objects, not JSON strings.
    for (const occ of body.finding.occurrences) {
      expect(Array.isArray(occ.refs)).toBe(true);
      expect(typeof occ.refs[0]).toBe("object");
      expect(occ.refs[0]).toMatchObject({
        kind: "diff",
        file: "src/auth.ts",
        hunk: 2,
      });
      expect(typeof occ.fix).toBe("object");
      expect(occ.fix).toMatchObject({
        direction: "restore the deleted assertion",
      });
      // Raw string still present.
      expect(typeof occ.refsJson).toBe("string");
    }

    // k/N: both runs in one batch → k=2, n=2.
    expect(body.kByBatch).toHaveLength(1);
    expect(body.kByBatch[0]).toEqual({
      batchId: w.batchId,
      k: 2,
      n: 2,
    });
  });

  it("GET nonexistent fingerprint / project → 404", async () => {
    const w = await seedRecurringFinding();

    const missingFp = await http(
      w.base,
      "GET",
      `/api/projects/${w.projectId}/findings/nonexistent-fp`,
    );
    expect(missingFp.status).toBe(404);

    const missingProject = await http(
      w.base,
      "GET",
      `/api/projects/does-not-exist/findings`,
    );
    expect(missingProject.status).toBe(404);

    const missingProjectDetail = await http(
      w.base,
      "GET",
      `/api/projects/does-not-exist/findings/${w.fingerprint}`,
    );
    expect(missingProjectDetail.status).toBe(404);
  });

  it("pagination: limit=1 returns nextCursor; next page returns the rest", async () => {
    // Seed two DISTINCT findings so we have 2 list items.
    const dataDir = await tempDataDir();
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const { queries } = api;

    const project = queries.createProject({
      name: "Paginate",
      slug: `paginate-${Date.now()}`,
    });
    const agent = queries.registerAgent({
      id: `agent-p-${Date.now()}`,
      displayName: "Test Agent",
    });
    const task = queries.createTask(project.id, sampleTask());
    const batch = queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: "m",
      provider: "p",
      repeats: 2,
    });

    const f1 = defectFinding("f1");
    const f2 = defectFinding("f2", {
      category: "verification_skipped",
      claim: "suite never ran",
      refs: [{ kind: "diff", file: "src/main.ts", hunk: 1 }],
    });

    // Two runs, each with a different finding so we get 2 rows in the log.
    const runA = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: "m",
      provider: "p",
      repeatIndex: 0,
      status: "completed",
    });
    const jA = queries.createJudgement({
      runId: runA.id,
      projectId: project.id,
      judgeModel: "j",
      judgeProvider: "t",
      systemPromptVersion: "v1",
      status: "running",
    });
    queries.storeVerdict(
      jA.id,
      baseVerdict({
        findings: [f1],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["f1"],
          },
        ],
      }),
    );

    const runB = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: "m",
      provider: "p",
      repeatIndex: 1,
      status: "completed",
    });
    const jB = queries.createJudgement({
      runId: runB.id,
      projectId: project.id,
      judgeModel: "j",
      judgeProvider: "t",
      systemPromptVersion: "v1",
      status: "running",
    });
    queries.storeVerdict(
      jB.id,
      baseVerdict({
        findings: [f2],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.3,
            evidence: [],
            findingIds: ["f2"],
          },
        ],
      }),
    );

    const page1 = await http(
      base,
      "GET",
      `/api/projects/${project.id}/findings?limit=1`,
    );
    expect(page1.status).toBe(200);
    const p1 = page1.json as {
      findings: Array<{ fingerprint: string }>;
      nextCursor: string | null;
    };
    expect(p1.findings).toHaveLength(1);
    expect(p1.nextCursor).toBeTruthy();

    const page2 = await http(
      base,
      "GET",
      `/api/projects/${project.id}/findings?limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`,
    );
    expect(page2.status).toBe(200);
    const p2 = page2.json as {
      findings: Array<{ fingerprint: string }>;
      nextCursor: string | null;
    };
    expect(p2.findings).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    // Distinct fingerprints across pages.
    expect(p1.findings[0]!.fingerprint).not.toBe(p2.findings[0]!.fingerprint);
  });

  it("GET list is sorted newest-lastSeenAt-first", async () => {
    const dataDir = await tempDataDir();
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const { queries } = api;

    const project = queries.createProject({
      name: "Sort",
      slug: `sort-${Date.now()}`,
    });
    const agent = queries.registerAgent({
      id: `agent-s-${Date.now()}`,
      displayName: "A",
    });
    const task = queries.createTask(project.id, sampleTask());
    const batch = queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: "m",
      provider: "p",
      repeats: 2,
    });

    const older = defectFinding("old", {
      category: "test_gaming",
      claim: "old finding",
      refs: [{ kind: "diff", file: "a.ts", hunk: 1 }],
    });
    const newer = defectFinding("new", {
      category: "verification_skipped",
      claim: "new finding",
      refs: [{ kind: "diff", file: "b.ts", hunk: 1 }],
    });

    const run1 = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: "m",
      provider: "p",
      repeatIndex: 0,
      status: "completed",
    });
    const j1 = queries.createJudgement({
      runId: run1.id,
      projectId: project.id,
      judgeModel: "j",
      judgeProvider: "t",
      systemPromptVersion: "v1",
      status: "running",
    });
    queries.storeVerdict(
      j1.id,
      baseVerdict({
        findings: [older],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["old"],
          },
        ],
      }),
    );

    // Force a later lastSeenAt for the second finding.
    await new Promise((r) => setTimeout(r, 5));

    const run2 = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: agent.id,
      model: "m",
      provider: "p",
      repeatIndex: 1,
      status: "completed",
    });
    const j2 = queries.createJudgement({
      runId: run2.id,
      projectId: project.id,
      judgeModel: "j",
      judgeProvider: "t",
      systemPromptVersion: "v1",
      status: "running",
    });
    queries.storeVerdict(
      j2.id,
      baseVerdict({
        findings: [newer],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.3,
            evidence: [],
            findingIds: ["new"],
          },
        ],
      }),
    );

    const res = await http(base, "GET", `/api/projects/${project.id}/findings`);
    expect(res.status).toBe(200);
    const body = res.json as {
      findings: Array<{ fingerprint: string; lastSeenAt: string; claim: string }>;
    };
    expect(body.findings).toHaveLength(2);
    // Newest first.
    expect(
      body.findings[0]!.lastSeenAt >= body.findings[1]!.lastSeenAt,
    ).toBe(true);
    expect(body.findings[0]!.claim).toBe("new finding");
  });
});

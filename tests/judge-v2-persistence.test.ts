import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { MemoryQueries, type QueryStore } from "../src/db/queries.ts";
import type { EvalJudgementNarrative, QueueImprovementStep } from "../src/judge/queue-schema.ts";
import type { Verdict } from "../src/judge/verdict.ts";

const dirs: string[] = [];
const handles: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function exercise(queries: QueryStore) {
  queries.registerAgent({ id: "agent", displayName: "Agent" });
  const project = queries.createProject({ name: "P", slug: `p-${Math.random()}` });
  const task = queries.createTask(project.id, {
    id: "eval",
    name: "Eval",
    prompt: "Do it",
    workspace: { source: "empty" },
    rubric: { version: 1, profile: "bugfix", criteria: [] },
    categoryName: "coding",
  }, {
    packagePath: "/tmp/package",
    packageDigest: "a".repeat(64),
    packageManifest: { files: [] },
    packageValidation: { valid: true },
  });
  expect(task.categoryName).toBe("coding");
  expect(task.packageDigest).toBe("a".repeat(64));

  const queue = queries.createEvalQueue(project.id, {
    name: "Q",
    agentId: "agent",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
  });
  const batch = queries.createBatch({
    taskId: task.id,
    projectId: project.id,
    agentId: "agent",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    params: {},
    repeats: 1,
    queueId: queue.id,
  });
  const run = queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    queueId: queue.id,
    agentId: "agent",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    repeatIndex: 0,
  });
  const analysis = queries.createQueueAnalysis({
    queueId: queue.id,
    projectId: project.id,
    batchId: batch.id,
    selectedRunIds: [run.id],
    evidenceHashes: { [run.id]: "hash" },
    judgeModel: "deepseek-v4-flash",
    judgeProvider: "nuralwatt",
    systemPromptVersion: "v2",
  });
  const verdict = JSON.parse(
    await readFile(join(import.meta.dirname, "fixtures/verdict-sample.json"), "utf8"),
  ) as Verdict;
  verdict.findings.forEach((finding) => {
    finding.refs = finding.refs.map((ref) => ref.kind === "trace" ? { ...ref, runId: run.id } : ref);
  });
  const narrative: EvalJudgementNarrative = {
    schemaVersion: 1,
    headline: "Outcome",
    judgement: "Evidence-linked judgement.",
    executionAnalysis: [{ stage: "work", judgement: "Agent worked.", refs: [{ kind: "trace", runId: run.id, seqs: [0, 1] }] }],
    strengths: [{ text: "Read before edit.", refs: [{ kind: "trace", runId: run.id, seqs: [0, 0] }] }],
    concerns: [],
    evidenceBoundaries: [{ status: "observed", text: "Trace was available.", refs: [{ kind: "trace", runId: run.id, seqs: [0, 1] }] }],
    handoff: { preserve: [], change: [], investigate: [] },
  };
  const judgement = queries.createJudgement({
    runId: run.id,
    projectId: project.id,
    queueAnalysisId: analysis.id,
    judgeModel: "deepseek-v4-flash",
    judgeProvider: "nuralwatt",
    systemPromptVersion: "v2",
    status: "running",
  });
  const stored = queries.storeVerdict(judgement.id, verdict, narrative);
  expect(stored.narrative).toEqual(narrative);
  expect(stored.narrativeSchemaVersion).toBe(1);
  expect(queries.getJudgement(judgement.id)?.narrative).toEqual(narrative);

  let rolledBackJudgementId = "";
  expect(() => queries.transaction(() => {
    const rolledBack = queries.createJudgement({
      runId: run.id,
      projectId: project.id,
      queueAnalysisId: analysis.id,
      judgeModel: "deepseek-v4-flash",
      judgeProvider: "nuralwatt",
      systemPromptVersion: "v2",
      status: "running",
    });
    rolledBackJudgementId = rolledBack.id;
    throw new Error("rollback probe");
  })).toThrow(/rollback probe/);
  expect(queries.getJudgement(rolledBackJudgementId)).toBeNull();

  const step: QueueImprovementStep = {
    id: "verify-step",
    rank: 1,
    class: "agent",
    priority: 0,
    confidence: 0.9,
    defectIds: ["d1"],
    subsystem: "verification",
    problem: "No final verification.",
    evidence: [{ kind: "trace", runId: run.id, seqs: [0, 1] }],
    target: { kind: "prompt", paths: ["completion policy"] },
    change: "Require final verification.",
    acceptanceCriteria: ["Final verification passes."],
    tests: [{ name: "verify", kind: "e2e", expected: "pass" }],
    verifyTaskIds: [task.id],
    regressionTaskIds: [task.id],
    dependencies: [],
    nonGoals: [],
    preventive: false,
    status: "ready",
  };
  expect(queries.storeImprovementSteps(analysis.id, project.id, queue.id, [step]))
    .toEqual([expect.objectContaining({ id: "verify-step", status: "ready" })]);
  expect(queries.updateImprovementStepLifecycle(analysis.id, step.id, { status: "in_progress" }).status)
    .toBe("in_progress");
  expect(() => queries.updateImprovementStepLifecycle(analysis.id, step.id, { status: "proposed" }))
    .toThrow(/invalid.*transition/i);

  const metrics = queries.upsertEvalMetrics({
    runId: run.id,
    projectId: project.id,
    schemaVersion: 1,
    execution: { measurements: { tool_calls: { value: 3 } } },
  });
  expect(metrics.outcome).toBeNull();
  queries.upsertEvalMetrics({
    runId: run.id,
    projectId: project.id,
    schemaVersion: 1,
    execution: metrics.execution,
    outcome: { officialReward: 1 },
  });
  expect(queries.getEvalMetrics(run.id)?.outcome).toEqual({ officialReward: 1 });
}

describe("judge v2 persistence", () => {
  it("persists through MemoryQueries", async () => {
    await exercise(new MemoryQueries(await dataDir("judge-v2-memory-")));
  });

  it("persists through schema v6 SQLite", async () => {
    const opened = openDb(await dataDir("judge-v2-sqlite-"));
    if (opened.raw) handles.push(opened.raw);
    expect(opened.backend).toBe("sqlite");
    await exercise(opened.queries);
  });
});

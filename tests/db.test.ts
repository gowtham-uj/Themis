/**
 * Persistence layer tests (P3a).
 * Uses a temp dataDir; exercises project/task/agent/batch/run CRUD via openDb.
 * Works with either the better-sqlite3 path or the in-memory fallback.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import {
  openDb,
  resolveProjectDir,
  type OpenDbResult,
} from "../src/db/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-db-"));
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

function sampleTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "ext-task-1",
    name: "Fix the bug",
    prompt: "Please fix the off-by-one error",
    workspace: { source: "empty" },
    rubric: sampleRubric(1),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
  };
}

function open(dataDir: string): OpenDbResult {
  return openDb(dataDir);
}

describe("openDb + backend", () => {
  it("opens a store and reports a backend", async () => {
    const dataDir = await tempDataDir();
    const result = open(dataDir);
    expect(result.dataDir).toBe(dataDir);
    expect(["sqlite", "memory"]).toContain(result.backend);
    expect(result.queries).toBeDefined();
    // Document which path is live for this environment.
    // eslint-disable-next-line no-console
    console.log(`[db.test] live persistence backend: ${result.backend}`);
    if (result.backend === "sqlite") {
      expect(result.raw).not.toBeNull();
      expect(result.db).not.toBeNull();
    } else {
      expect(result.raw).toBeNull();
      expect(result.db).toBeNull();
    }
  });

  it("migrate is idempotent (safe to open twice)", async () => {
    const dataDir = await tempDataDir();
    const a = open(dataDir);
    const project = a.queries.createProject({
      name: "P",
      slug: "p",
    });
    // Re-open same dir (sqlite) or fresh memory — for sqlite, data persists.
    const b = open(dataDir);
    if (a.backend === "sqlite" && b.backend === "sqlite") {
      const again = b.queries.getProject(project.id);
      expect(again?.name).toBe("P");
    } else {
      // memory backend is process-local; just ensure second open works
      expect(b.queries).toBeDefined();
    }
  });
});

describe("projects", () => {
  it("create / get / list / update / archive", async () => {
    const { queries } = open(await tempDataDir());
    const p = queries.createProject({
      name: "Eval Suite",
      slug: "eval-suite",
      description: "main",
      taskSource: { kind: "ui-builder" },
      networkPolicy: "offline",
    });
    expect(p.id).toBeTruthy();
    expect(p.slug).toBe("eval-suite");
    expect(p.networkPolicy).toBe("offline");
    expect(p.archived).toBe(false);

    expect(queries.getProject(p.id)?.name).toBe("Eval Suite");
    expect(queries.listProjects().map((x) => x.id)).toContain(p.id);

    const updated = queries.updateProject(p.id, { name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(updated.updatedAt >= p.updatedAt).toBe(true);

    const archived = queries.archiveProject(p.id);
    expect(archived.archived).toBe(true);
    expect(queries.listProjects().map((x) => x.id)).not.toContain(p.id);
    expect(
      queries.listProjects({ includeArchived: true }).map((x) => x.id),
    ).toContain(p.id);
  });

  it("resolveProjectDir creates on-disk layout", async () => {
    const dataDir = await tempDataDir();
    const dir = resolveProjectDir(dataDir, "proj-abc");
    expect(dir).toBe(join(dataDir, "projects", "proj-abc"));
    // second call is safe
    expect(resolveProjectDir(dataDir, "proj-abc")).toBe(dir);
  });
});

describe("tasks", () => {
  it("CRUD, rubric_version bumps only on rubric edit, project scoping", async () => {
    const dataDir = await tempDataDir();
    const { queries } = open(dataDir);

    const projectA = queries.createProject({ name: "A", slug: "a" });
    const projectB = queries.createProject({ name: "B", slug: "b" });

    const task = queries.createTask(projectA.id, sampleTask(), {
      sourceKind: "ui-builder",
    });
    expect(task.projectId).toBe(projectA.id);
    expect(task.externalId).toBe("ext-task-1");
    expect(task.rubricVersion).toBe(1);
    expect(task.agentCategory).toBe("coding");
    expect(task.workspace).toEqual({ source: "empty" });
    expect(task.sourceKind).toBe("ui-builder");

    // Snapshot on disk (best-effort; always written by our impl).
    const snapPath = join(
      dataDir,
      "projects",
      projectA.id,
      "tasks",
      task.id,
      "task.json",
    );
    const snap = JSON.parse(await readFile(snapPath, "utf8")) as {
      name: string;
    };
    expect(snap.name).toBe("Fix the bug");

    // Name edit does NOT bump rubric_version.
    const renamed = queries.updateTask(task.id, { name: "Fix the off-by-one" });
    expect(renamed.name).toBe("Fix the off-by-one");
    expect(renamed.rubricVersion).toBe(1);

    // Rubric edit DOES bump rubric_version.
    const newRubric = sampleRubric(1);
    newRubric.criteria[0]!.label = "correctness-v2";
    const rubriked = queries.updateTask(task.id, { rubric: newRubric });
    expect(rubriked.rubricVersion).toBe(2);
    expect(rubriked.rubric.criteria[0]!.label).toBe("correctness-v2");

    // Identical rubric re-write does not bump again.
    const same = queries.updateTask(task.id, { rubric: newRubric });
    expect(same.rubricVersion).toBe(2);

    // Project scoping: B cannot see A's tasks.
    const taskB = queries.createTask(
      projectB.id,
      sampleTask({ id: "ext-b", name: "B task" }),
    );
    const listA = queries.listTasks(projectA.id);
    const listB = queries.listTasks(projectB.id);
    expect(listA.map((t) => t.id)).toEqual([task.id]);
    expect(listB.map((t) => t.id)).toEqual([taskB.id]);
    expect(listA.find((t) => t.id === taskB.id)).toBeUndefined();

    const archived = queries.archiveTask(task.id);
    expect(archived.archived).toBe(true);
    expect(queries.listTasks(projectA.id)).toHaveLength(0);
    expect(
      queries.listTasks(projectA.id, { includeArchived: true }),
    ).toHaveLength(1);
  });
});

describe("agents + batches + runs", () => {
  it("register agent, create batch+run, list by project, control + finalize", async () => {
    const dataDir = await tempDataDir();
    const { queries } = open(dataDir);

    const project = queries.createProject({ name: "Runs", slug: "runs" });
    const task = queries.createTask(project.id, sampleTask());

    const agent = queries.registerAgent({
      id: "pi",
      displayName: "Pi",
      defaultModel: "claude-opus-4",
      defaultProvider: "anthropic",
    });
    expect(agent.id).toBe("pi");
    expect(queries.getAgent("pi")?.displayName).toBe("Pi");
    expect(queries.listAgents().map((a) => a.id)).toContain("pi");

    // register is upsert
    const again = queries.registerAgent({
      id: "pi",
      displayName: "Pi Coding Agent",
    });
    expect(again.displayName).toBe("Pi Coding Agent");
    expect(again.defaultModel).toBe("claude-opus-4");

    const batch = queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId: "pi",
      model: "claude-opus-4",
      provider: "anthropic",
      repeats: 2,
      params: { temperature: 0 },
      trigger: "manual",
      agentImage: "agenteval/pi:latest",
      agentCommit: "abc123",
    });
    expect(batch.repeats).toBe(2);
    expect(batch.projectId).toBe(project.id);

    const run = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: "pi",
      model: "claude-opus-4",
      provider: "anthropic",
      repeatIndex: 0,
      status: "running",
      controlState: "running",
      startedAt: "2026-08-06T12:00:00.000Z",
      agentImage: batch.agentImage ?? undefined,
      agentCommit: batch.agentCommit ?? undefined,
    });
    expect(run.status).toBe("running");
    expect(run.pauseCount).toBe(0);

    // listRuns by project
    const byProject = queries.listRuns({ projectId: project.id });
    expect(byProject.map((r) => r.id)).toEqual([run.id]);

    // listRuns by batch
    const byBatch = queries.listRuns({ batchId: batch.id });
    expect(byBatch).toHaveLength(1);

    // Project scoping for runs
    const other = queries.createProject({ name: "Other", slug: "other" });
    expect(queries.listRuns({ projectId: other.id })).toHaveLength(0);

    // updateRunControlState increments pause_count
    const paused = queries.updateRunControlState(run.id, {
      controlState: "paused-soft",
      pausedAt: "2026-08-06T12:01:00.000Z",
      incrementPauseCount: true,
      status: "paused",
    });
    expect(paused.controlState).toBe("paused-soft");
    expect(paused.pauseCount).toBe(1);
    expect(paused.status).toBe("paused");
    expect(paused.pausedAt).toBe("2026-08-06T12:01:00.000Z");

    const resumed = queries.updateRunControlState(run.id, {
      controlState: "running",
      resumedAt: "2026-08-06T12:02:00.000Z",
      status: "running",
    });
    expect(resumed.pauseCount).toBe(1); // not incremented again
    expect(resumed.controlState).toBe("running");

    // finalizeRun
    const final = queries.finalizeRun(run.id, {
      status: "completed",
      endedAt: "2026-08-06T12:05:00.000Z",
      durationMs: 240_000,
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      totalCost: 0.42,
      eventsPath: `projects/${project.id}/runs/${run.id}/events.jsonl`,
      diffPath: `projects/${project.id}/runs/${run.id}/diff.patch`,
    });
    expect(final.status).toBe("completed");
    expect(final.endedAt).toBe("2026-08-06T12:05:00.000Z");
    expect(final.durationMs).toBe(240_000);
    expect(final.inputTokens).toBe(1000);
    expect(final.outputTokens).toBe(200);
    expect(final.totalCost).toBe(0.42);
    expect(final.controlState).toBe("done");
    expect(final.eventsPath).toContain("events.jsonl");

    // Snapshot on disk
    const runSnap = JSON.parse(
      await readFile(
        join(dataDir, "projects", project.id, "runs", run.id, "run.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(runSnap.status).toBe("completed");

    // updateRunStatus
    const failed = queries.updateRunStatus(run.id, "failed");
    expect(failed.status).toBe("failed");
  });
});

describe("stubs (P6)", () => {
  it("finding methods throw until later phases", async () => {
    const { queries } = open(await tempDataDir());
    expect(() => queries.createFinding()).toThrow(/not implemented/);
  });
});

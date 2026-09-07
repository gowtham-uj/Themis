/**
 * Runs orphaned by a stopped API process must reach a terminal status.
 *
 * `api.close()` stops the container and marks its row terminal, but the queue
 * worker still has to seal the aborted run. When the process exits inside that
 * window nothing is left to finish the run, so it stayed `running` forever: the
 * pipeline never advanced and the console showed a run that could not complete.
 *
 * Recovery used to skip any container that was already terminal, which is
 * exactly the shape a clean shutdown leaves behind. Regression for that gap.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { MemoryQueries, type QueryStore, type TaskSpec } from "../src/db/queries.ts";

const dirs: string[] = [];
const sqliteHandles: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const h of sqliteHandles.splice(0)) h.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function dataDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function evalSpec(id: string): TaskSpec {
  return {
    id,
    name: id,
    prompt: `run ${id}`,
    workspace: { source: "empty" },
    rubric: {
      version: 1,
      profile: "bugfix",
      criteria: [
        {
          id: "A1",
          axis: "A",
          label: "outcome",
          weight: 1,
          appliesTo: "coding",
          anchors: { full: "done", partial: "partial", none: "missing" },
        },
      ],
    },
    agentCategory: "coding",
  } as TaskSpec;
}

/** Build a queue generation holding one run that is still `running`. */
function seedOrphan(q: QueryStore): { runId: string; containerId: string; queueId: string } {
  q.registerAgent({ id: "reapercode", displayName: "ReaperCode" });
  const project = q.createProject({ name: "P", slug: `p-${Math.random()}` });
  q.createProjectAgentAdapter(project.id, {
    agentId: "reapercode",
    name: "ReaperCode",
    image: "registry.example/reapercode@sha256:abc",
    command: { argv: ["reaper"] },
    connectionCheck: { argv: ["reaper", "check"], timeoutMs: 60_000 },
    evidence: { paths: [] },
    parserKind: "reapercode-jsonl",
    providerConfig: { credentialEnv: {} },
  });
  const queue = q.createEvalQueue(project.id, {
    name: "Q",
    agentId: "reapercode",
    model: "glm-5.3-flash",
    provider: "openai",
  });
  const batch = q.createBatch({
    taskId: null,
    projectId: project.id,
    agentId: "reapercode",
    model: "glm-5.3-flash",
    provider: "openai",
    repeats: 1,
    trigger: "eval-queue",
    triggerRef: queue.id,
    queueId: queue.id,
    queueRevision: queue.revision,
  });
  const task = q.createTask(project.id, evalSpec("orphan-eval"));
  const container = q.createQueueContainer({
    queueId: queue.id,
    projectId: project.id,
    batchId: batch.id,
    image: "registry.example/reapercode:1",
    state: "running",
    workspaceDir: "/tmp/ws",
  });
  const run = q.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    queueId: queue.id,
    queueContainerId: container.id,
    agentId: "reapercode",
    model: "glm-5.3-flash",
    provider: "openai",
    repeatIndex: 0,
    status: "running",
  });
  return { runId: run.id, containerId: container.id, queueId: queue.id };
}

function exerciseOrphanRecovery(q: QueryStore): void {
  const { runId, containerId } = seedOrphan(q);

  // A clean shutdown: the container is stopped and terminal, but the worker
  // never got to seal the run it had claimed.
  q.updateQueueContainer(containerId, {
    state: "stopped",
    stoppedAt: new Date().toISOString(),
  });
  expect(q.getRun(runId)?.status).toBe("running");

  q.recoverStaleQueueContainers({ olderThanMs: 0 });

  const recovered = q.getRun(runId)!;
  expect(recovered.status).toBe("failed");
  expect(recovered.controlState).toBe("done");
  expect(recovered.error).toMatch(/API process stopped/i);
}

/** A completed run must never be rewritten by the recovery sweep. */
function exerciseTerminalRunUntouched(q: QueryStore): void {
  const { runId, containerId } = seedOrphan(q);
  q.finalizeRun(runId, { status: "completed", controlState: "done" });
  q.updateQueueContainer(containerId, {
    state: "stopped",
    stoppedAt: new Date().toISOString(),
  });

  q.recoverStaleQueueContainers({ olderThanMs: 0 });

  const after = q.getRun(runId)!;
  expect(after.status).toBe("completed");
  expect(after.error).toBeFalsy();
}

describe("orphaned run recovery (Memory)", () => {
  it("fails a run left running under a terminal container", async () => {
    exerciseOrphanRecovery(new MemoryQueries(await dataDir("agenteval-orphan-mem-")));
  });
  it("leaves an already-completed run alone", async () => {
    exerciseTerminalRunUntouched(new MemoryQueries(await dataDir("agenteval-orphan-mem2-")));
  });
});

describe("orphaned run recovery (SQLite)", () => {
  it("fails a run left running under a terminal container", async () => {
    const opened = openDb(await dataDir("agenteval-orphan-sqlite-"));
    if (opened.raw) sqliteHandles.push(opened.raw);
    exerciseOrphanRecovery(opened.queries);
  });
  it("leaves an already-completed run alone", async () => {
    const opened = openDb(await dataDir("agenteval-orphan-sqlite2-"));
    if (opened.raw) sqliteHandles.push(opened.raw);
    exerciseTerminalRunUntouched(opened.queries);
  });
});

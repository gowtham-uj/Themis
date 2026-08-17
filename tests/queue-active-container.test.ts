/**
 * Queue one-active-generation enforcement across the container start window.
 *
 * A queue generation container row is created in `starting` state before the
 * runtime handle exists (and before the queue worker's claim loop runs). The
 * one-active-generation lock — `getActiveQueueContainer` — must hold across that
 * whole window, otherwise a second `startQueueContainer` / watcher launch can
 * pass the ALREADY_ACTIVE guard and spawn duplicate generations for one queue.
 *
 * Regression for the runtimeContainerId keyed guard that ignored `starting`
 * containers (a multi-minute image-build/start race window).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { MemoryQueries, type QueryStore } from "../src/db/queries.ts";

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

function makeQueue(
  q: QueryStore,
): { projectId: string; queueId: string; batchId: string } {
  q.registerAgent({ id: "pi", displayName: "Pi" });
  const project = q.createProject({ name: "P", slug: `p-${Math.random()}` });
  q.createProjectAgentAdapter(project.id, {
    agentId: "pi",
    name: "Pi",
    image: "registry.example/pi@sha256:abc",
    command: { argv: ["pi"] },
    connectionCheck: { argv: ["pi", "c"], timeoutMs: 60_000 },
    evidence: { paths: [] },
    parserKind: "pi-jsonl",
    providerConfig: { credentialEnv: {} },
  });
  const queue = q.createEvalQueue(project.id, {
    name: "Q",
    agentId: "pi",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
  });
  const batch = q.createBatch({
    taskId: null,
    projectId: project.id,
    agentId: "pi",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    repeats: 0,
    trigger: "eval-queue",
    triggerRef: queue.id,
    queueId: queue.id,
    queueRevision: queue.revision,
  });
  return { projectId: project.id, queueId: queue.id, batchId: batch.id };
}

function exerciseActiveContainer(q: QueryStore): void {
  const { projectId, queueId, batchId } = makeQueue(q);

  // A freshly created `starting` container (no runtimeContainerId yet) must be
  // considered ACTIVE so the one-active-generation guard holds across the start
  // window, before the runtime handle returns.
  const first = q.createQueueContainer({
    queueId,
    projectId,
    batchId,
    image: "registry.example/pi:1",
    state: "starting",
    workspaceDir: "/tmp/ws",
  });
  expect(q.getActiveQueueContainer(queueId)?.id).toBe(first.id);

  // A second concurrent start in the same window must be rejected.
  expect(() =>
    q.createQueueContainer({
      queueId,
      projectId,
      batchId,
      image: "registry.example/pi:1",
      state: "starting",
      workspaceDir: "/tmp/ws2",
    }),
  ).toThrow(/already has active container/i);

  // Once the runtime handle registers, the container stays the active one.
  q.updateQueueContainer(first.id, {
    runtimeContainerId: "podman-1",
    state: "running",
  });
  expect(q.getActiveQueueContainer(queueId)?.id).toBe(first.id);

  // A paused container is still active (generation not terminal).
  q.updateQueueContainer(first.id, { state: "paused" });
  expect(q.getActiveQueueContainer(queueId)?.id).toBe(first.id);

  // A tainted/completed generation is terminal only after stoppedAt is set.
  q.updateQueueContainer(first.id, {
    state: "tainted",
    stoppedAt: new Date().toISOString(),
  });
  expect(q.getActiveQueueContainer(queueId)).toBeNull();

  // A failed container is not active and frees the slot for a new start.
  q.updateQueueContainer(first.id, { state: "failed", stoppedAt: null });
  expect(q.getActiveQueueContainer(queueId)).toBeNull();
  const retry = q.createQueueContainer({
    queueId,
    projectId,
    batchId,
    image: "registry.example/pi:1",
    state: "starting",
    workspaceDir: "/tmp/ws3",
  });
  expect(retry.state).toBe("starting");
}

describe("one-active-generation enforcement (Memory)", () => {
  it("holds across the starting window (no runtimeContainerId yet)", async () => {
    exerciseActiveContainer(new MemoryQueries(await dataDir("agenteval-active-mem-")));
  });
});

describe("one-active-generation enforcement (SQLite)", () => {
  it("holds across the starting window (no runtimeContainerId yet)", async () => {
    const opened = openDb(await dataDir("agenteval-active-sqlite-"));
    if (opened.raw) sqliteHandles.push(opened.raw);
    exerciseActiveContainer(opened.queries);
  });
});

/** Persistent eval-store queues, container generations, archives, and analyses. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryQueries, type QueryStore } from "../src/db/queries.ts";
import { openDb } from "../src/db/index.ts";
import type { TaskSpec } from "../src/domain.ts";

const dirs: string[] = [];
const sqliteHandles: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const handle of sqliteHandles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dataDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function evalSpec(id: string, name: string): TaskSpec {
  return {
    id,
    name,
    prompt: `run ${name}`,
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
    env: {
      kind: "greenfield",
      setupScript: "printf setup > marker",
      cleanupScript: "rm -f marker",
    },
  };
}

async function exerciseStore(q: QueryStore): Promise<void> {
  q.registerAgent({ id: "reapercode", displayName: "ReaperCode" });
  const project = q.createProject({ name: "P", slug: `p-${Math.random()}` });
  const adapter = q.createProjectAgentAdapter(project.id, {
    agentId: "reapercode",
    name: "ReaperCode CLI",
    image: "registry.example/reapercode@sha256:abc",
    command: {
      argv: ["reaper", "run", "--prompt", "{{prompt}}"],
      env: { ANTHROPIC_AUTH_TOKEN: "{{credential:ANTHROPIC_AUTH_TOKEN}}" },
    },
    connectionCheck: {
      argv: ["reaper", "run", "--prompt", "connection"],
      timeoutMs: 60_000,
    },
    evidence: { paths: [".reaper"], requiredPaths: [".reaper/runs"] },
    parserKind: "reapercode-jsonl",
    providerConfig: {
      credentialEnv: {
        anthropic: { ANTHROPIC_AUTH_TOKEN: "ANTHROPIC_AUTH_TOKEN" },
      },
    },
  });
  expect(q.getProjectAgentAdapterByAgentId(project.id, "reapercode")).toEqual(adapter);
  expect(() =>
    q.createProjectAgentAdapter(project.id, {
      agentId: "pi",
      name: "Pi",
      image: "pi:latest",
      command: { argv: ["pi"] },
      connectionCheck: { argv: ["pi", "check"] },
      evidence: { paths: [] },
      parserKind: "pi-jsonl",
    }),
  ).toThrow(/already has an agent adapter/);
  expect(q.updateProjectAgentAdapter(adapter.id, { enabled: false }).enabled).toBe(false);
  expect(q.updateProjectAgentAdapter(adapter.id, { enabled: true }).enabled).toBe(true);

  const first = q.createTask(project.id, evalSpec("eval-a", "A"));
  const second = q.createTask(project.id, evalSpec("eval-b", "B"));
  expect(first.version).toBe(1);
  const edited = q.updateTask(first.id, { prompt: "updated prompt" });
  expect(edited.version).toBe(2);

  const queue = q.createEvalQueue(project.id, {
    name: "regression",
    agentId: "reapercode",
    model: "claude-opus-4-6",
    provider: "anthropic",
    ports: [{ containerPort: 8000, name: "web" }],
  });
  const a = q.createEvalQueueItem(queue.id, { taskId: first.id, repeats: 2 });
  const b = q.createEvalQueueItem(queue.id, {
    taskId: second.id,
    position: { before: a.id },
  });
  expect(q.listEvalQueueItems(queue.id).map((i) => i.id)).toEqual([b.id, a.id]);
  expect(q.getEvalQueue(queue.id)!.revision).toBe(3);

  const batch = q.createBatch({
    taskId: second.id,
    projectId: project.id,
    agentId: queue.agentId,
    model: queue.model,
    provider: queue.provider,
    repeats: 3,
    queueId: queue.id,
    queueRevision: q.getEvalQueue(queue.id)!.revision,
  });
  const container = q.createQueueContainer({
    queueId: queue.id,
    projectId: project.id,
    batchId: batch.id,
    runtimeContainerId: "podman-1",
    image: "localhost/reaper:latest",
    state: "running",
    workspaceDir: "/tmp/queue-workspace",
  });
  expect(() =>
    q.createQueueContainer({
      queueId: queue.id,
      projectId: project.id,
      batchId: batch.id,
      image: "x",
      state: "starting",
      workspaceDir: "/tmp/other",
    }),
  ).toThrow(/already has active container/);

  const snapshot = {
    id: edited.id,
    version: edited.version,
    prompt: edited.prompt,
    rubric: edited.rubric,
    env: edited.env,
  };
  const run = q.createRun({
    batchId: batch.id,
    taskId: edited.id,
    projectId: project.id,
    queueId: queue.id,
    queueItemId: a.id,
    queueContainerId: container.id,
    agentId: queue.agentId,
    model: queue.model,
    provider: queue.provider,
    repeatIndex: 0,
    evalVersion: edited.version,
    evalSnapshot: snapshot,
  });
  expect(q.getRun(run.id)).toMatchObject({
    queueId: queue.id,
    queueItemId: a.id,
    queueContainerId: container.id,
    evalVersion: 2,
    evalSnapshot: snapshot,
  });

  q.storeEvalArchive({
    runId: run.id,
    projectId: project.id,
    queueId: queue.id,
    batchId: batch.id,
    manifestPath: `/archives/${run.id}/archive.json`,
    manifestSha256: "a".repeat(64),
    sizeBytes: 1234,
  });
  expect(q.listEvalArchives({ queueId: queue.id })).toHaveLength(1);

  q.updateQueueContainer(container.id, {
    state: "stopped",
    stoppedAt: new Date().toISOString(),
  });
  expect(q.getActiveQueueContainer(queue.id)).toBeNull();
}

describe("persistent eval queue store", () => {
  it("maintains the queue model in memory", async () => {
    await exerciseStore(new MemoryQueries(await dataDir("agenteval-queue-memory-")));
  });

  it("maintains the queue model in SQLite", async () => {
    const opened = openDb(await dataDir("agenteval-queue-sqlite-"));
    expect(opened.backend).toBe("sqlite");
    if (opened.raw) sqliteHandles.push(opened.raw);
    await exerciseStore(opened.queries);
  });

  it("migrates an unstarted legacy queue entry into a persistent queue", async () => {
    const dir = await dataDir("agenteval-queue-migrate-");
    const first = openDb(dir);
    expect(first.raw).not.toBeNull();
    // Build a realistic v8 store: project/task/agent rows plus a legacy
    // queue_entries table with one still-queued entry written via raw SQL
    // (the legacy public API was removed in v9).
    first.queries.registerAgent({ id: "pi", displayName: "Pi" });
    const project = first.queries.createProject({ name: "M", slug: "migrate" });
    const task = first.queries.createTask(project.id, evalSpec("legacy-eval", "Legacy"));
    const raw = first.raw!;
    raw.exec(`CREATE TABLE queue_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      trigger_ref TEXT,
      target_kind TEXT NOT NULL,
      task_id TEXT,
      task_tags_json TEXT,
      agent_id TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      repeats INTEGER,
      params_json TEXT,
      adapter_overrides_json TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      dedup_key TEXT,
      source TEXT,
      created_at TEXT NOT NULL,
      promoted_at TEXT,
      promoted_batch_id TEXT,
      removed_at TEXT
    )`);
    const entryId = "legacy-entry-1";
    raw.prepare(
      `INSERT INTO queue_entries (
        id, project_id, target_kind, task_id, agent_id, model, provider,
        repeats, position, status, source, created_at
      ) VALUES (?, ?, 'task', ?, 'pi', 'claude-opus-4-6', 'anthropic', 2, 1, 'queued', 'api', ?)`,
    ).run(entryId, project.id, task.id, new Date().toISOString());
    // Force a re-migration from an earlier version.
    raw.pragma("user_version = 8");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
    raw.close();

    const reopened = openDb(dir);
    if (reopened.raw) sqliteHandles.push(reopened.raw);
    const migrated = reopened.queries.getEvalQueue(`legacy-${entryId}`);
    expect(migrated).toMatchObject({ projectId: project.id, agentId: "pi" });
    expect(reopened.queries.listEvalQueueItems(migrated!.id)).toEqual([
      expect.objectContaining({ taskId: task.id, repeats: 2 }),
    ]);
    // Legacy queue_entries table is dropped after migration.
    expect(
      reopened.raw!.prepare("SELECT count(*) c FROM sqlite_master WHERE name='queue_entries'").get().c,
    ).toBe(0);
  });
});

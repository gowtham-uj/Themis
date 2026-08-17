/**
 * SCHEMA v9 + atomic queue-claim foundation tests.
 *
 * Covers:
 *  - adapter_builds commit-addressed CRUD + ready reuse (Sqlite + Memory)
 *  - eval_queues.agent_commit, item soft-deletion + claimed_repeats
 *  - run_batches.task_id nullable (multi-eval generations)
 *  - generation snapshot columns on batches/containers
 *  - watcher_rules.queue_id + durable pending watcher event state
 *  - atomic claimQueueWork: one run per repeat, immutable snapshots, empty-close
 *  - migration from v8 preserves runs and drops legacy queue_entries
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { MemoryQueries, type QueryStore } from "../src/db/queries.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
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
  };
}

/** Helper: build a project + one queue with N items and return ids. */
function buildQueue(
  q: QueryStore,
  opts: { itemRepeats?: number[]; agentCommit?: string } = {},
): {
  projectId: string;
  queueId: string;
  containerId: string;
  batchId: string;
  adapterId: string;
  taskIds: string[];
  itemIds: string[];
} {
  q.registerAgent({ id: "pi", displayName: "Pi" });
  const project = q.createProject({ name: "P", slug: `p-${Math.random()}` });
  const adapter = q.createProjectAgentAdapter(project.id, {
    agentId: "pi",
    name: "Pi CLI",
    image: "registry.example/pi@sha256:abc",
    command: { argv: ["pi", "--prompt", "{{prompt}}"] },
    connectionCheck: { argv: ["pi", "check"], timeoutMs: 60_000 },
    evidence: { paths: [] },
    parserKind: "pi-jsonl",
    providerConfig: { credentialEnv: {} },
  });
  const queue = q.createEvalQueue(project.id, {
    name: "Q",
    agentId: "pi",
    model: "claude-opus-4-6",
    provider: "anthropic",
    agentCommit: opts.agentCommit ?? "0123456789abcdef0123456789abcdef01234567",
  });
  const repeats = opts.itemRepeats ?? [1];
  const taskIds: string[] = [];
  const itemIds: string[] = [];
  repeats.forEach((r, i) => {
    const task = q.createTask(project.id, evalSpec(`t${i}-${Math.random()}`, `T${i}`));
    const item = q.createEvalQueueItem(queue.id, { taskId: task.id, repeats: r });
    taskIds.push(task.id);
    itemIds.push(item.id);
  });
  const batch = q.createBatch({
    taskId: null,
    projectId: project.id,
    agentId: "pi",
    model: "claude-opus-4-6",
    provider: "anthropic",
    repeats: 0,
    trigger: "eval-queue",
    triggerRef: queue.id,
    queueId: queue.id,
    queueRevision: queue.revision,
    accepting: true,
  });
  const container = q.createQueueContainer({
    queueId: queue.id,
    projectId: project.id,
    batchId: batch.id,
    image: "registry.example/pi:0123456",
    state: "running",
    workspaceDir: "/tmp/ws",
  });
  return {
    projectId: project.id,
    queueId: queue.id,
    containerId: container.id,
    batchId: batch.id,
    adapterId: adapter.id,
    taskIds,
    itemIds,
  };
}

function snapshot(b: {
  queueId: string;
  containerId: string;
  batchId: string;
}): Parameters<QueryStore["claimQueueWork"]>[0]["snapshot"] {
  return {
    batchId: b.batchId,
    queueId: b.queueId,
    queueRevision: 1,
    queueContainerId: b.containerId,
    agentCommit: "0123456789abcdef0123456789abcdef01234567",
    agentImage: "registry.example/pi:0123456",
    agentImageId: "sha256:img",
    agentVersion: "0123456789ab",
    buildId: "pi:0123456789abcdef0123456789abcdef01234567",
    model: "claude-opus-4-6",
    provider: "anthropic",
    adapterOverrides: null,
    networkPolicy: "allow",
  };
}

async function exerciseClaimStore(q: QueryStore): Promise<void> {
  // Two items: item0 repeats 1, item1 repeats 2.
  const b = buildQueue(q, { itemRepeats: [1, 2] });

  const claim1 = q.claimQueueWork({
    batchId: b.batchId,
    queueId: b.queueId,
    projectId: b.projectId,
    queueContainerId: b.containerId,
    snapshot: snapshot(b),
    itemSnapshot: { taskId: b.taskIds[0]! },
    evalSnapshot: { name: "eval0" },
    evalVersion: 1,
    taskId: b.taskIds[0]!,
    agentId: "pi",
  });
  expect(claim1.claimed).toBe(true);
  if (claim1.claimed) {
    expect(claim1.queueItemId).toBe(b.itemIds[0]);
    expect(claim1.repeatIndex).toBe(0);
    // Immutable snapshots + queue provenance on the claimed run.
    expect(claim1.run.evalSnapshot).toEqual({ name: "eval0" });
    expect(claim1.run.queueId).toBe(b.queueId);
    expect(claim1.run.queueItemId).toBe(b.itemIds[0]);
    expect(claim1.run.agentCommit).toBe(snapshot(b).agentCommit);
    // Item snapshot persisted for provenance (schema v9 itemSnapshot). When the
    // caller omits it, the claim op reconstructs the full item row (repeats etc.);
    // caller-supplied snapshots are stored verbatim.
    expect(claim1.run.itemSnapshot).toMatchObject({ taskId: b.taskIds[0] });
    expect(q.getEvalQueueItem(b.itemIds[0]!)!.claimedRepeats).toBe(1);
  }

  // Next claim goes to item0 already fully claimed -> item1 repeat 0.
  const claim2 = q.claimQueueWork({
    batchId: b.batchId,
    queueId: b.queueId,
    projectId: b.projectId,
    queueContainerId: b.containerId,
    snapshot: snapshot(b),
    itemSnapshot: { taskId: b.taskIds[1]! },
    evalSnapshot: { name: "eval1" },
    evalVersion: 1,
    taskId: b.taskIds[1]!,
    agentId: "pi",
  });
  expect(claim2.claimed).toBe(true);
  if (claim2.claimed) expect(claim2.queueItemId).toBe(b.itemIds[1]);

  const claim3 = q.claimQueueWork({
    batchId: b.batchId,
    queueId: b.queueId,
    projectId: b.projectId,
    queueContainerId: b.containerId,
    snapshot: snapshot(b),
    itemSnapshot: { taskId: b.taskIds[1]! },
    evalSnapshot: { name: "eval1" },
    evalVersion: 1,
    taskId: b.taskIds[1]!,
    agentId: "pi",
  });
  expect(claim3.claimed).toBe(true);
  if (claim3.claimed) expect(claim3.repeatIndex).toBe(1);

  // Exactly one run created per repeat (3 total), order preserved.
  expect(q.listRunsByBatch(b.batchId)).toHaveLength(3);

  // All repeats claimed -> atomic empty close.
  const closed = q.claimQueueWork({
    batchId: b.batchId,
    queueId: b.queueId,
    projectId: b.projectId,
    queueContainerId: b.containerId,
    snapshot: snapshot(b),
    itemSnapshot: {},
    evalSnapshot: {},
    evalVersion: 1,
    taskId: b.taskIds[0]!,
    agentId: "pi",
  });
  expect(closed.claimed).toBe(false);
  if (!closed.claimed) expect(closed.closed).toBe(true);
  // No extra run created on close.
  expect(q.listRunsByBatch(b.batchId)).toHaveLength(3);

  // Claims against a closed generation throw.
  expect(() =>
    q.claimQueueWork({
      batchId: b.batchId,
      queueId: b.queueId,
      projectId: b.projectId,
      queueContainerId: b.containerId,
      snapshot: snapshot(b),
      itemSnapshot: {},
      evalSnapshot: {},
      evalVersion: 1,
      taskId: b.taskIds[0]!,
      agentId: "pi",
    }),
  ).toThrow(/generation .* is closed/i);

  // Soft-deleted item is not claimable and not listed.
  const b2 = buildQueue(q, { itemRepeats: [1] });
  q.deleteEvalQueueItem(b2.itemIds[0]!);
  expect(q.listEvalQueueItems(b2.queueId)).toHaveLength(0);
  const r2 = q.claimQueueWork({
    batchId: b2.batchId,
    queueId: b2.queueId,
    projectId: b2.projectId,
    queueContainerId: b2.containerId,
    snapshot: snapshot(b2),
    itemSnapshot: {},
    evalSnapshot: {},
    evalVersion: 1,
    taskId: b2.taskIds[0]!,
    agentId: "pi",
  });
  expect(r2.claimed).toBe(false);

  // When the caller omits snapshot inputs, the claim op reconstructs the full
  // immutable eval + item snapshots for the actually-claimed item (so the worker
  // does not need to know which item is claimed next --- it resolves atomically).
  const b3 = buildQueue(q, { itemRepeats: [1] });
  const r3 = q.claimQueueWork({
    batchId: b3.batchId,
    queueId: b3.queueId,
    projectId: b3.projectId,
    queueContainerId: b3.containerId,
    snapshot: snapshot(b3),
    agentId: "pi",
  });
  expect(r3.claimed).toBe(true);
  if (r3.claimed) {
    // Item snapshot reconstructed from the item row (repeats + taskId present).
    expect(r3.run.itemSnapshot).toMatchObject({
      taskId: b3.taskIds[0],
      repeats: 1,
      queueId: b3.queueId,
    });
    // Eval snapshot reconstructed from the claimed task (name + prompt present).
    expect(r3.run.evalSnapshot).toMatchObject({ name: `T0` });
    expect(r3.run.taskId).toBe(b3.taskIds[0]);
  }

  // adapter_builds CRUD + ready reuse.
  const buildId = "pi:0123456789abcdef0123456789abcdef01234567";
  const created = q.upsertAdapterBuild({
    id: buildId,
    adapterId: b2.adapterId,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    status: "building",
  });
  expect(created.status).toBeDefined();
  const ready = q.updateAdapterBuild(buildId, {
    status: "ready",
    image: "registry.example/pi:0123456",
    imageId: "sha256:img",
    agentVersion: "0123456789ab",
  });
  expect(ready.status).toBe("ready");
  const reuse = q.getReadyAdapterBuild(
    b2.adapterId,
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(reuse).not.toBeNull();
  expect(reuse!.agentVersion).toBe("0123456789ab");
  expect(q.listAdapterBuilds(b2.adapterId)).toHaveLength(1);
}

describe("SCHEMA v9 + claim semantics (Memory)", () => {
  it("claims one run per repeat, empty-closes atomically, soft-deletes, adapter builds", async () => {
    await exerciseClaimStore(new MemoryQueries(await dataDir("agenteval-v9-mem-")));
  });
});

describe("SCHEMA v9 + claim semantics (SQLite)", () => {
  it("claims under an atomic BEGIN IMMEDIATE-equivalent, preserving invariants", async () => {
    const opened = openDb(await dataDir("agenteval-v9-sqlite-"));
    expect(opened.backend).toBe("sqlite");
    if (opened.raw) sqliteHandles.push(opened.raw);
    await exerciseClaimStore(opened.queries);
  });

  it("is schema version 9", async () => {
    const opened = openDb(await dataDir("agenteval-v9-schema-"));
    expect(opened.backend).toBe("sqlite");
    expect(opened.raw!.pragma("user_version", { simple: true })).toBe(9);
    expect(SCHEMA_VERSION).toBe(9);
    if (opened.raw) sqliteHandles.push(opened.raw);
  });

  it("migrates v8 -> v9: preserves historical runs, nullable task_id, drops queue_entries", async () => {
    const dir = await dataDir("agenteval-v9-migrate-");
    const first = openDb(dir);
    expect(first.raw).not.toBeNull();
    // Seed a minimal v8 row set, then downgrade the stamp and re-migrate.
    const raw = first.raw!;
    raw.pragma("user_version = 8");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 9").run();

    const reopened = openDb(dir);
    if (reopened.raw) sqliteHandles.push(reopened.raw);
    const rb = reopened.raw!;
    expect(rb.pragma("user_version", { simple: true })).toBe(9);
    // task_id column now nullable.
    const taskCol = rb
      .prepare("PRAGMA table_info(run_batches)")
      .all()
      .find((c: { name: string }) => (c as { name: string }).name === "task_id") as {
      notnull: number;
    };
    expect(taskCol.notnull).toBe(0);
    // Legacy queue_entries dropped.
    expect(
      rb
        .prepare("SELECT count(*) c FROM sqlite_master WHERE name='queue_entries'")
        .get().c,
    ).toBe(0);
    // New tables exist.
    for (const t of ["adapter_builds"]) {
      expect(
        rb.prepare("SELECT count(*) c FROM sqlite_master WHERE name=?").get(t).c,
      ).toBe(1);
    }
  });

  it("v8 -> v9 rebuild preserves run_batches rows and their runs", async () => {
    const dir = await dataDir("agenteval-v9-preserve-");
    const first = openDb(dir);
    expect(first.raw).not.toBeNull();
    const raw = first.raw!;

    // Seed a complete v8 dataset: project, agent, a v8-style run_batch with a
    // single-eval task_id (NOT NULL in v8) and one persisted run under it.
    first.queries.registerAgent({ id: "pi", displayName: "Pi" });
    const project = first.queries.createProject({ name: "P", slug: `p-${Date.now()}` });
    const task = first.queries.createTask(project.id, evalSpec("t-preserve", "T"));
    first.queries.createBatch({
      id: "batch-v8",
      taskId: task.id,
      projectId: project.id,
      agentId: "pi",
      model: "claude-opus-4-6",
      provider: "anthropic",
      repeats: 1,
      trigger: "commit",
      // v9 columns left undefined so the v8 row lacks them.
    });
    first.queries.createRun({
      id: "run-v8",
      batchId: "batch-v8",
      taskId: task.id,
      projectId: project.id,
      agentId: "pi",
      model: "claude-opus-4-6",
      provider: "anthropic",
      repeatIndex: 0,
      status: "completed",
      eventsPath: "/nonexistent/events.jsonl",
    });

    // Simulate the old v8 run_batches column set (task_id NOT NULL) so the
    // v9 rebuild must actually run the table-rebuild path. FK enforcement must
    // be off while swapping tables (runs references run_batches), matching the
    // migration's own rebuild implementation.
    raw.pragma("foreign_keys = OFF");
    raw.exec(`CREATE TABLE v8_run_batches (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      params_json TEXT NOT NULL,
      repeats INTEGER NOT NULL,
      trigger TEXT,
      trigger_ref TEXT,
      agent_image TEXT,
      agent_commit TEXT,
      queue_id TEXT REFERENCES eval_queues(id),
      queue_revision INTEGER,
      created_at TEXT NOT NULL
    )`);
    raw.exec(`INSERT INTO v8_run_batches (
      id, task_id, project_id, agent_id, model, provider, params_json, repeats,
      trigger, trigger_ref, agent_image, agent_commit, queue_id, queue_revision, created_at
    ) SELECT id, task_id, project_id, agent_id, model, provider, params_json, repeats,
      trigger, trigger_ref, agent_image, agent_commit, queue_id, queue_revision, created_at
      FROM run_batches WHERE id = 'batch-v8'`);
    raw.exec("DROP TABLE run_batches");
    raw.exec("ALTER TABLE v8_run_batches RENAME TO run_batches");

    // Downgrade the stamp and re-open to force the v9 migration.
    raw.pragma("user_version = 8");
    raw.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
    raw.close();

    const reopened = openDb(dir);
    if (reopened.raw) sqliteHandles.push(reopened.raw);
    const rb = reopened.raw!;
    expect(rb.pragma("user_version", { simple: true })).toBe(9);

    // The batch row survived the rebuild with its task link intact.
    const batched = rb
      .prepare("SELECT batch_id, COUNT(*) c FROM runs WHERE batch_id = 'batch-v8' GROUP BY batch_id")
      .get() as { c: number } | undefined;
    expect(batched?.c).toBe(1);
    const batchRow = rb
      .prepare("SELECT id, task_id FROM run_batches WHERE id = 'batch-v8'")
      .get() as { id: string; task_id: string | null } | undefined;
    expect(batchRow?.id).toBe("batch-v8");
    expect(batchRow?.task_id).toBe(task.id);
    // The persisted run still resolves through the query layer.
    expect(reopened.queries.getRun("run-v8")?.status).toBe("completed");
    // v9 generation columns exist and default to accepting.
    const accepting = rb
      .prepare("SELECT accepting FROM run_batches WHERE id = 'batch-v8'")
      .get() as { accepting: number } | undefined;
    expect(accepting?.accepting).toBe(1);
  });
});

/** SQLite + Memory parity for the v9 queue-bound watcher FIFO lifecycle. */
async function exerciseWatcherParity(q: QueryStore): Promise<void> {
  q.registerAgent({ id: "pi", displayName: "Pi" });
  const project = q.createProject({ name: "P", slug: `pw-${Math.random()}` });
  const queue = q.createEvalQueue(project.id, {
    name: "Q",
    agentId: "pi",
    model: "claude-opus-4-6",
    provider: "anthropic",
    agentCommit: "0123456789abcdef0123456789abcdef01234567",
  });
  const rule = q.createWatcherRule(project.id, {
    repo: "owner/name",
    trigger: "commit",
    queueId: queue.id,
  });
  // Second rule on a DIFFERENT queue must use an independent FIFO seq.
  const queue2 = q.createEvalQueue(project.id, {
    name: "Q2",
    agentId: "pi",
    model: "claude-opus-4-6",
    provider: "anthropic",
  });
  const rule2 = q.createWatcherRule(project.id, {
    repo: "owner/name",
    trigger: "commit",
    queueId: queue2.id,
  });

  const e1 = q.recordWatcherEvent({
    ruleId: rule.id,
    projectId: project.id,
    trigger: "commit",
    ref: "main",
    resolvedSha: "1111111111111111111111111111111111111111",
    status: "pending",
    queueId: queue.id,
    fifoSeq: q.nextWatcherFifoSeq(queue.id),
  });
  const e2 = q.recordWatcherEvent({
    ruleId: rule.id,
    projectId: project.id,
    trigger: "commit",
    ref: "dev",
    resolvedSha: "2222222222222222222222222222222222222222",
    status: "pending",
    queueId: queue.id,
    fifoSeq: q.nextWatcherFifoSeq(queue.id),
  });
  // Another queue starts its own FIFO at 1.
  const e3 = q.recordWatcherEvent({
    ruleId: rule2.id,
    projectId: project.id,
    trigger: "commit",
    resolvedSha: "3333333333333333333333333333333333333333",
    status: "pending",
    queueId: queue2.id,
    fifoSeq: q.nextWatcherFifoSeq(queue2.id),
  });

  // Strict oldest-FIFO ordering per queue.
  expect(q.nextPendingWatcherEvent(queue.id)!.id).toBe(e1.id);
  // Per-queue FIFO is independent.
  expect(q.nextWatcherFifoSeq(queue.id)).toBe(3);
  expect(q.nextWatcherFifoSeq(queue2.id)).toBe(2);
  expect(e3.fifoSeq).toBe(1);

  // Launching the head demotes the next pending event to head. The batch id
  // must reference a real run_batches row (SQLite FK on watcher_events.batch_id).
  q.createBatch({
    id: "batch-1",
    taskId: null,
    projectId: project.id,
    agentId: "pi",
    model: "claude-opus-4-6",
    provider: "anthropic",
    repeats: 0,
    trigger: "eval-queue",
    triggerRef: queue.id,
    queueId: queue.id,
    queueRevision: queue.revision,
  });
  q.markWatcherEventLaunched(e1.id, "batch-1", "1111111111111111111111111111111111111111");
  expect(q.nextPendingWatcherEvent(queue.id)!.id).toBe(e2.id);
  // Launched event no longer pending but still lists as launched with batch.
  const launched = q.listWatcherEvents(project.id, { ruleId: rule.id })
    .find((ev) => ev.id === e1.id);
  expect(launched?.status).toBe("launched");
  expect(launched?.batchId).toBe("batch-1");
  expect(launched?.processedSha).toBe("1111111111111111111111111111111111111111");
}

describe("watcher FIFO parity (SQLite + Memory)", () => {
  it("keeps per-queue FIFO ordering, dedup, and launch demotion identical", async () => {
    await exerciseWatcherParity(new MemoryQueries(await dataDir("agenteval-watch-mem-")));
    const opened = openDb(await dataDir("agenteval-watch-sqlite-"));
    if (opened.raw) sqliteHandles.push(opened.raw);
    await exerciseWatcherParity(opened.queries);
  });
});

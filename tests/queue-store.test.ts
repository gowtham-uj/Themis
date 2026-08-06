/**
 * Eval queue + watcher rule store tests (P8a).
 * Uses MemoryQueries (offline, no native sqlite required).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import { MemoryQueries } from "../src/db/queries.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-queue-"));
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
    id: "ext-1",
    name: "Task",
    prompt: "do it",
    workspace: { source: "empty" },
    rubric: sampleRubric(),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
  };
}

async function setup() {
  const dataDir = await tempDataDir();
  const q = new MemoryQueries(dataDir);
  const project = q.createProject({
    name: "Q",
    slug: "q",
    defaultAgentId: "pi",
    defaultModel: "claude",
    defaultProvider: "anthropic",
  });
  q.registerAgent({
    id: "pi",
    displayName: "Pi",
    defaultModel: "claude",
    defaultProvider: "anthropic",
  });
  const t1 = q.createTask(
    project.id,
    sampleTask({ id: "t1", tags: ["smoke", "fast"] }),
  );
  const t2 = q.createTask(
    project.id,
    sampleTask({ id: "t2", name: "T2", tags: ["regression"] }),
  );
  return { q, project, t1, t2 };
}

describe("createQueueEntry fractional positions", () => {
  it("orders head/tail/between by priority DESC then position ASC", async () => {
    const { q, project } = await setup();
    const a = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "x",
      agentId: "pi",
      source: "api",
      triggerRef: "v1",
    });
    // Default empty queue → 1000
    expect(a.position).toBe(1000);

    const b = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "y",
      agentId: "pi",
      source: "api",
      triggerRef: "v1",
    });
    // Tail append → 2000
    expect(b.position).toBe(2000);

    const mid = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "z",
      agentId: "pi",
      source: "api",
      triggerRef: "v1",
      position: { after: a.id },
    });
    expect(mid.position).toBe((a.position + b.position) / 2);

    const head = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "h",
      agentId: "pi",
      source: "api",
      triggerRef: "v1",
      position: { before: a.id },
    });
    expect(head.position).toBeLessThan(a.position);

    // Higher priority first
    const hi = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "hi",
      agentId: "pi",
      source: "api",
      priority: 10,
      triggerRef: "v1",
    });

    const list = q.listQueueEntries(project.id, { status: "queued" });
    expect(list[0]!.id).toBe(hi.id);
    // Within priority 0: head, a, mid, b
    const pri0 = list.filter((e) => e.priority === 0);
    expect(pri0.map((e) => e.id)).toEqual([head.id, a.id, mid.id, b.id]);
  });
});

describe("reorderQueueEntry", () => {
  it("supports after/before midpoints and priority change", async () => {
    const { q, project } = await setup();
    const a = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "a",
      agentId: "pi",
      source: "api",
    });
    const b = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "b",
      agentId: "pi",
      source: "api",
    });
    const c = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: "c",
      agentId: "pi",
      source: "api",
    });
    // Move c before a
    const moved = q.reorderQueueEntry(c.id, { before: a.id });
    expect(moved.position).toBeLessThan(a.position);

    // Move a after b
    const movedA = q.reorderQueueEntry(a.id, { after: b.id });
    expect(movedA.position).toBeGreaterThan(b.position);

    const prio = q.reorderQueueEntry(b.id, { priority: 5 });
    expect(prio.priority).toBe(5);

    const list = q.listQueueEntries(project.id);
    expect(list[0]!.id).toBe(b.id); // priority 5 first
  });
});

describe("promoteQueueEntry", () => {
  it("task → 1 batch + repeats runs; entry promoted", async () => {
    const { q, project, t1 } = await setup();
    const entry = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      repeats: 3,
      source: "api",
      triggerRef: "v2.3.0",
      model: "claude",
      provider: "anthropic",
    });
    const result = q.promoteQueueEntry(entry.id);
    expect(result.batchId).toBeTruthy();
    expect(result.batchIds).toHaveLength(1);
    expect(result.runIds).toHaveLength(3);
    expect(result.entry.status).toBe("promoted");
    expect(result.entry.promotedBatchId).toBe(result.batchId);
    expect(result.entry.promotedAt).toBeTruthy();

    const runs = q.listRuns({ batchId: result.batchId });
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === "queued")).toBe(true);
    expect(runs.every((r) => r.triggerRef === "v2.3.0")).toBe(true);
    expect(runs.every((r) => r.triggerRuleId === null)).toBe(true);
  });

  it("task_set matching 2 tags → 2 batches; no-match throws", async () => {
    const { q, project } = await setup();
    // tags: smoke matches t1, regression matches t2
    const entry = q.createQueueEntry(project.id, {
      targetKind: "task_set",
      taskTags: ["smoke", "regression"],
      agentId: "pi",
      repeats: 1,
      source: "watcher",
      triggerRef: "v1",
    });
    const result = q.promoteQueueEntry(entry.id);
    expect(result.batchIds).toHaveLength(2);
    expect(result.runIds).toHaveLength(2);

    const bad = q.createQueueEntry(project.id, {
      targetKind: "task_set",
      taskTags: ["nope"],
      agentId: "pi",
      source: "api",
    });
    expect(() => q.promoteQueueEntry(bad.id)).toThrow(/no tasks match/i);
  });
});

describe("removeQueueEntry + drainQueue", () => {
  it("soft-removes and is idempotent; drain only queued", async () => {
    const { q, project, t1 } = await setup();
    const a = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "api",
    });
    const b = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "api",
      triggerRef: "other",
    });
    q.promoteQueueEntry(a.id);
    // mark one as running-ish by promoting only a; b stays queued
    // Create a third that we soft-remove first
    const c = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "manual",
      triggerRef: "manual-1",
    });
    const removed = q.removeQueueEntry(c.id);
    expect(removed.status).toBe("removed");
    expect(removed.removedAt).toBeTruthy();
    const again = q.removeQueueEntry(c.id);
    expect(again.status).toBe("removed");

    // Manually set a "running" status entry via reorder path — promote leaves
    // a as promoted. Create another and leave queued.
    const d = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "api",
      triggerRef: "d",
    });
    // Simulate running by promote-like status mutation via second promote no —
    // drain only touches queued. b and d are queued; a promoted; c removed.
    const drain = q.drainQueue(project.id);
    expect(drain.removed).toBe(2); // b + d
    expect(q.getQueueEntry(a.id)!.status).toBe("promoted");
    expect(q.getQueueEntry(c.id)!.status).toBe("removed");
    expect(q.getQueueEntry(b.id)!.status).toBe("removed");
    expect(q.getQueueEntry(d.id)!.status).toBe("removed");
  });
});

describe("SECRET HYGIENE", () => {
  it("create returns secret once; get/list/update never leak it", async () => {
    const { q, project } = await setup();
    const created = q.createWatcherRule(project.id, {
      role: "agent",
      repo: "owner/name",
      trigger: "webhook",
      action: { enqueue: "all" },
    });
    expect(created.webhookSecret).toBeTruthy();
    expect(typeof created.webhookSecret).toBe("string");
    expect(created.webhookSecret!.length).toBeGreaterThan(8);

    const got = q.getWatcherRule(created.id);
    expect(got).not.toBeNull();
    expect(got!.webhookSecret).toBeNull();

    const listed = q.listWatcherRules(project.id, { includeDisabled: true });
    expect(listed.length).toBeGreaterThan(0);
    for (const r of listed) {
      expect(r.webhookSecret).toBeNull();
    }

    const updated = q.updateWatcherRule(created.id, { enabled: false });
    expect(updated.webhookSecret).toBeNull();
  });
});

describe("dedupKey auto-compute", () => {
  it("defaults for non-manual; manual never dedups", async () => {
    const { q, project, t1 } = await setup();
    const a = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "api",
      triggerRef: "v1",
    });
    expect(a.dedupKey).toBe(`v1:task:${t1.id}`);

    const set = q.createQueueEntry(project.id, {
      targetKind: "task_set",
      taskTags: ["smoke", "fast"],
      agentId: "pi",
      source: "watcher",
      triggerRef: "v2",
    });
    expect(set.dedupKey).toBe("v2:tags:smoke,fast");

    const m1 = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "manual",
      triggerRef: "v1",
    });
    const m2 = q.createQueueEntry(project.id, {
      targetKind: "task",
      taskId: t1.id,
      agentId: "pi",
      source: "manual",
      triggerRef: "v1",
    });
    expect(m1.dedupKey).toBeNull();
    expect(m2.dedupKey).toBeNull();
    // Same task can be queued twice manually
    expect(m1.id).not.toBe(m2.id);
  });
});

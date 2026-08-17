/**
 * Per-project agent-commit queue watcher engine tests.
 * Offline: OfflineRefResolver + MemoryQueries — no real git network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import { MemoryQueries } from "../src/db/queries.ts";
import type { WatcherRule } from "../src/db/queries.ts";
import {
  applySemverFilter,
  computeDedupKey,
  handleWatcherCommit,
  matchRules,
  repoMatches,
  shouldEnqueue,
  type RefResolver,
  type WatcherSeams,
} from "../src/watcher/engine.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "agenteval-watcher-"));
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
        anchors: { full: "fully correct", partial: "partial", none: "incorrect" },
      },
    ],
  };
}

function sampleTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "ext-1",
    name: "Fix bug",
    prompt: "fix it",
    workspace: { source: "empty" },
    rubric: sampleRubric(),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
  };
}

function rule(partial: Partial<WatcherRule> & Pick<WatcherRule, "id">): WatcherRule {
  return {
    projectId: "p1",
    role: "agent",
    repo: "owner/name",
    trigger: "tag",
    ref: null,
    semverFilter: null,
    webhookSecret: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

class OfflineRefResolver implements RefResolver {
  constructor(
    private readonly map: Record<string, { sha: string; imageTag?: string }> = {},
    private readonly throwOn?: string,
  ) {}

  async resolveRef(
    repo: string,
    ref: string,
  ): Promise<{ sha: string; imageTag?: string }> {
    if (this.throwOn && (ref === this.throwOn || repo === this.throwOn)) {
      throw new Error(`resolve failed for ${ref}`);
    }
    const key = `${repo}|${ref}`;
    const hit = this.map[key] ?? this.map[ref];
    if (hit) return hit;
    return { sha: `sha-of-${ref}`, imageTag: ref };
  }
}

/** Recording seam double: resolve + a controllable active-generation + launcher. */
interface LaunchRecorder {
  launches: Array<{ queueId: string; commit: string }>;
}
function makeSeams(
  resolver: RefResolver,
  opts: { activeQueueIds?: Set<string> } = {},
): { seams: WatcherSeams; recorder: LaunchRecorder } {
  const recorder: LaunchRecorder = { launches: [] };
  return {
    recorder,
    seams: {
      async resolveSha(repo, ref) {
        const r = await resolver.resolveRef(repo, ref);
        return { sha: r.sha };
      },
      hasActiveGeneration(queueId) {
        return opts.activeQueueIds?.has(queueId) ?? false;
      },
      async launch(_queueId, commit) {
        recorder.launches.push({ queueId: _queueId, commit });
        return { launched: true, batchId: `batch-${commit.slice(0, 8)}` };
      },
    },
  };
}

describe("matchRules", () => {
  it("matches role + repo + trigger + ref glob", () => {
    const rules = [
      rule({ id: "r1", ref: "v*", createdAt: "2026-01-02T00:00:00.000Z" }),
      rule({
        id: "r2",
        ref: "main",
        trigger: "commit",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      rule({
        id: "r3",
        ref: null,
        trigger: "tag",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ];
    const m = matchRules(rules, {
      trigger: "tag",
      ref: "v2.3.0",
      repo: "owner/name",
    });
    expect(m.map((r) => (r as WatcherRule).id)).toEqual(["r1", "r3"]);
  });

  it("repoMatches owner/name vs full github url", () => {
    expect(
      repoMatches("owner/name", "https://github.com/owner/name.git"),
    ).toBe(true);
    expect(repoMatches("owner/name", "https://github.com/other/name.git")).toBe(
      false,
    );
  });

  it("excludes disabled rules", () => {
    const rules = [
      rule({ id: "on", enabled: true }),
      rule({ id: "off", enabled: false }),
    ];
    const m = matchRules(rules, { trigger: "tag", ref: "v1", repo: "owner/name" });
    expect(m.map((r) => (r as WatcherRule).id)).toEqual(["on"]);
  });
});

describe("applySemverFilter", () => {
  it("range >=2.0.0 <3.0.0", () => {
    const f = ">=2.0.0 <3.0.0";
    expect(applySemverFilter("v2.3.0", f)).toBe(true);
    expect(applySemverFilter("v3.0.0", f)).toBe(false);
    expect(applySemverFilter("v1.5.0", f)).toBe(false);
  });

  it("strips leading v; no filter → true; non-semver + filter → false", () => {
    expect(applySemverFilter("v2.0.0", ">=2.0.0")).toBe(true);
    expect(applySemverFilter("anything", null)).toBe(true);
    expect(applySemverFilter("anything", undefined)).toBe(true);
    expect(applySemverFilter("not-a-version", ">=1.0.0")).toBe(false);
  });

  it("exact = and ~2.1 (~> 2.1.x)", () => {
    expect(applySemverFilter("2.3.0", "=2.3.0")).toBe(true);
    expect(applySemverFilter("2.3.1", "=2.3.0")).toBe(false);
    expect(applySemverFilter("2.1.0", "~2.1")).toBe(true);
    expect(applySemverFilter("2.2.0", "~2.1")).toBe(false);
  });
});

describe("computeDedupKey", () => {
  it("stable and collides only on same rule+ref+sha", () => {
    const a = computeDedupKey("r1", "v2", "abc");
    const b = computeDedupKey("r1", "v2", "abc");
    const c = computeDedupKey("r1", "v2", "def");
    const d = computeDedupKey("r2", "v2", "abc");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toBe("r1:v2:abc");
  });
});

describe("shouldEnqueue", () => {
  it("marks matched vs ignored(semver) per rule", () => {
    const rules = [
      rule({ id: "ok", semverFilter: ">=2.0.0 <3.0.0" }),
      rule({ id: "no", semverFilter: ">=3.0.0" }),
      rule({ id: "any", semverFilter: null }),
    ];
    const out = shouldEnqueue(rules as never, { ref: "v2.3.0" });
    expect(out.map((x) => [x.rule.id, x.status])).toEqual([
      ["ok", "matched"],
      ["no", "ignored"],
      ["any", "matched"],
    ]);
  });
});

describe("handleWatcherCommit", () => {
  async function setup() {
    const dataDir = await tempDataDir();
    const q = new MemoryQueries(dataDir);
    const project = q.createProject({ name: "P", slug: "p" });
    q.registerAgent({
      id: "pi",
      displayName: "Pi",
      defaultModel: "m",
      defaultProvider: "p",
    });
    q.createTask(project.id, sampleTask({ id: "t1", tags: ["smoke"] }));
    const adapter = q.createProjectAgentAdapter(project.id, {
      agentId: "pi",
      name: "My CLI",
      image: "localhost/agent:latest",
      sourceRepo: "owner/name",
      sourceRef: "main",
      installType: "source-build",
      containerfile: "FROM node:22-bookworm\n",
      command: { argv: ["pi", "run"] },
      connectionCheck: { argv: ["pi", "check"] },
      evidence: { paths: [] },
      parserKind: "canonical-jsonl",
    });
    const queue = q.createEvalQueue(project.id, {
      name: "Q",
      agentId: adapter.agentId,
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      agentCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const ruleRow = q.createWatcherRule(project.id, {
      queueId: queue.id,
      repo: "owner/name",
      trigger: "tag",
      ref: "v*",
    });
    expect(ruleRow.webhookSecret).toBeTruthy();
    return { q, project, queue, ruleRow };
  }

  it("no active generation → resolves SHA, records pending, launches immediately with commit override", async () => {
    const { q, project, queue, ruleRow } = await setup();
    const resolver = new OfflineRefResolver({
      "v2.3.0": { sha: "ffffffffffffffffffffffffffffffffffffffff" },
    });
    const { seams, recorder } = makeSeams(resolver);

    const out = await handleWatcherCommit({
      queries: q,
      seams,
      rule: ruleRow,
      queueId: queue.id,
      ref: "v2.3.0",
      eventRepo: "owner/name",
    });

    expect(out.status).toBe("launched");
    expect(out.event.status).toBe("launched");
    expect(out.event.resolvedSha).toBe("ffffffffffffffffffffffffffffffffffffffff");
    expect(out.event.fifoSeq).toBe(1);
    expect(recorder.launches).toEqual([
      { queueId: queue.id, commit: "ffffffffffffffffffffffffffffffffffffffff" },
    ]);
    // The queue default agent_commit is NOT mutated by the override launch.
    expect(q.getEvalQueue(queue.id)!.agentCommit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    void project;
  });

  it("same watcher+SHA twice → second is DEDUPED (no new event, no second launch)", async () => {
    const { q, queue, ruleRow } = await setup();
    const resolver = new OfflineRefResolver({
      "v1.0.0": { sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    const { seams, recorder } = makeSeams(resolver);

    const first = await handleWatcherCommit({
      queries: q, seams, rule: ruleRow, queueId: queue.id, ref: "v1.0.0", eventRepo: "owner/name",
    });
    expect(first.status).toBe("launched");

    const second = await handleWatcherCommit({
      queries: q, seams, rule: ruleRow, queueId: queue.id, ref: "v1.0.0", eventRepo: "owner/name",
    });
    expect(second.status).toBe("deduped");
    expect(q.listWatcherEvents(ruleRow.projectId).filter((e) => e.status === "deduped")).toHaveLength(1);
    expect(recorder.launches).toHaveLength(1);
  });

  it("active generation → commit stays PENDING with FIFO seq (not launched), no drop", async () => {
    const { q, queue, ruleRow } = await setup();
    const { seams, recorder } = makeSeams(new OfflineRefResolver(), {
      activeQueueIds: new Set([queue.id]),
    });

    const c1 = await handleWatcherCommit({
      queries: q, seams, rule: ruleRow, queueId: queue.id, ref: "v1.0.0",
      eventRepo: "owner/name",
    });
    const c2 = await handleWatcherCommit({
      queries: q, seams, rule: ruleRow, queueId: queue.id, ref: "v2.0.0",
      eventRepo: "owner/name",
    });

    expect(c1.status).toBe("pending");
    expect(c2.status).toBe("pending");
    expect(c1.event.fifoSeq).toBe(1);
    expect(c2.event.fifoSeq).toBe(2);
    // No launch while a generation is active.
    expect(recorder.launches).toHaveLength(0);
    // Oldest-pending returns the first (FIFO).
    expect(q.nextPendingWatcherEvent(queue.id)!.id).toBe(c1.event.id);
  });

  it("mismatched repo is rejected (repo identity)", async () => {
    const { q, queue, ruleRow } = await setup();
    const { seams } = makeSeams(new OfflineRefResolver());
    await expect(
      handleWatcherCommit({
        queries: q, seams, rule: ruleRow, queueId: queue.id, ref: "v1.0.0",
        eventRepo: "other/repo",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("launch failure leaves the event PENDING (not dropped) for a later FIFO retry", async () => {
    const { q, queue, ruleRow } = await setup();
    const resolver = new OfflineRefResolver({
      "v1.0.0": { sha: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" },
    });
    const recorder: LaunchRecorder = { launches: [] };
    const seams: WatcherSeams = {
      async resolveSha(repo, ref) {
        const r = await resolver.resolveRef(repo, ref);
        return { sha: r.sha };
      },
      hasActiveGeneration() {
        return false;
      },
      async launch(_queueId, commit) {
        recorder.launches.push({ queueId: _queueId, commit });
        return { launched: false };
      },
    };
    const out = await handleWatcherCommit({
      queries: q, seams, rule: ruleRow, queueId: queue.id, ref: "v1.0.0",
      eventRepo: "owner/name",
    });
    expect(out.status).toBe("pending");
    // It is still queued for a future generation close.
    expect(q.nextPendingWatcherEvent(queue.id)!.id).toBe(out.event.id);
    expect(out.event.resolvedSha).toBe("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
  });
});

describe("durable FIFO across generation close (auto next launch)", () => {
  it("oldest pending event launches first; the next-oldest becomes the new head", async () => {
    const dataDir = await tempDataDir();
    const q = new MemoryQueries(dataDir);
    const project = q.createProject({ name: "P", slug: "pff" });
    q.registerAgent({ id: "pi", displayName: "Pi" });
    q.createTask(project.id, sampleTask({ id: "t1", tags: ["smoke"] }));
    const adapter = q.createProjectAgentAdapter(project.id, {
      agentId: "pi", name: "C", image: "localhost/c", sourceRepo: "owner/name",
      sourceRef: "main", installType: "source-build", containerfile: "FROM node\n",
      command: { argv: ["c"] }, connectionCheck: { argv: ["c"] },
      evidence: { paths: [] }, parserKind: "canonical-jsonl",
    });
    const queue = q.createEvalQueue(project.id, {
      name: "Q", agentId: adapter.agentId, model: "m", provider: "p",
    });
    const ruleRow = q.createWatcherRule(project.id, { queueId: queue.id, repo: "owner/name", trigger: "commit" });

    // While the queue is active, enqueue two distinct commits FIFO.
    const resolver = new OfflineRefResolver({
      "main": { sha: "1111111111111111111111111111111111111111" },
      "dev": { sha: "2222222222222222222222222222222222222222" },
    });
    const s1: WatcherSeams = {
      async resolveSha(r, ref) { const o = await resolver.resolveRef(r, ref); return { sha: o.sha }; },
      hasActiveGeneration: () => true,
      async launch() { return { launched: false }; },
    };
    const e1 = await handleWatcherCommit({ queries: q, seams: s1, rule: ruleRow, queueId: queue.id, ref: "main", eventRepo: "owner/name" });
    const e2 = await handleWatcherCommit({ queries: q, seams: s1, rule: ruleRow, queueId: queue.id, ref: "dev", eventRepo: "owner/name" });
    expect(e1.status).toBe("pending");
    expect(e2.status).toBe("pending");
    expect(e1.event.fifoSeq).toBe(1);
    expect(e2.event.fifoSeq).toBe(2);

    // The generation closes → the queue frees. The oldest pending (fifo 1) is the
    // next to auto-launch; transitioning it to launching/launched leaves fifo 2 as
    // the new head, so no intermediate commit is dropped.
    const oldest = q.nextPendingWatcherEvent(queue.id)!;
    expect(oldest.id).toBe(e1.event.id);
    q.markWatcherEventLaunching(oldest.id);
    q.markWatcherEventLaunched(oldest.id, "b-1", oldest.resolvedSha!);
    const head = q.nextPendingWatcherEvent(queue.id)!;
    expect(head.id).toBe(e2.event.id);
    expect(head.fifoSeq).toBe(2);
  });
});

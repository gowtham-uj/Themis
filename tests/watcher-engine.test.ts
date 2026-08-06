/**
 * Pure watcher engine tests (P8a).
 * Offline: FakeRefResolver + MemoryQueries — no real git network.
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
  handleWatcherEvent,
  matchRules,
  repoMatches,
  shouldEnqueue,
  type RefResolver,
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
    action: { enqueue: "all" },
    webhookSecret: null,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

class FakeRefResolver implements RefResolver {
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
      role: "agent",
      repo: "owner/name",
    });
    expect(m.map((r) => r.id)).toEqual(["r1", "r3"]); // stable by createdAt
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
    const m = matchRules(rules, {
      trigger: "tag",
      ref: "v1",
      role: "agent",
      repo: "owner/name",
    });
    expect(m.map((r) => r.id)).toEqual(["on"]);
  });

  it("main matches main; null ref matches any", () => {
    const rules = [
      rule({ id: "main", trigger: "commit", ref: "main" }),
      rule({ id: "any", trigger: "commit", ref: null }),
    ];
    expect(
      matchRules(rules, {
        trigger: "commit",
        ref: "main",
        role: "agent",
        repo: "owner/name",
      }).map((r) => r.id),
    ).toEqual(["main", "any"]);
    expect(
      matchRules(rules, {
        trigger: "commit",
        ref: "develop",
        role: "agent",
        repo: "owner/name",
      }).map((r) => r.id),
    ).toEqual(["any"]);
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
    expect(applySemverFilter("2.1.9", "~2.1")).toBe(true);
    expect(applySemverFilter("2.2.0", "~2.1")).toBe(false);
    expect(applySemverFilter("v2.1.3", "~2.1.0")).toBe(true);
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
    const out = shouldEnqueue(rules, { ref: "v2.3.0" });
    expect(out.map((x) => [x.rule.id, x.status])).toEqual([
      ["ok", "matched"],
      ["no", "ignored"],
      ["any", "matched"],
    ]);
  });
});

describe("handleWatcherEvent", () => {
  async function setup() {
    const dataDir = await tempDataDir();
    const q = new MemoryQueries(dataDir);
    const project = q.createProject({
      name: "P",
      slug: "p",
      defaultAgentId: "pi",
      defaultModel: "m",
      defaultProvider: "p",
    });
    q.registerAgent({
      id: "pi",
      displayName: "Pi",
      defaultModel: "m",
      defaultProvider: "p",
    });
    q.createTask(project.id, sampleTask({ id: "t1", tags: ["smoke"] }));
    q.createTask(
      project.id,
      sampleTask({ id: "t2", name: "Other", tags: ["regression"] }),
    );
    return { q, project };
  }

  it("matching rule enqueues a batch; second same rule+ref+sha is DEDUPED", async () => {
    const { q, project } = await setup();
    const created = q.createWatcherRule(project.id, {
      role: "agent",
      repo: "owner/name",
      trigger: "tag",
      ref: "v*",
      action: { enqueue: "all", repeats: 2 },
    });
    expect(created.webhookSecret).toBeTruthy();

    const resolver = new FakeRefResolver({
      "v2.3.0": { sha: "deadbeef", imageTag: "v2.3.0" },
    });

    const first = await handleWatcherEvent(q, resolver, {
      projectId: project.id,
      trigger: "tag",
      ref: "v2.3.0",
      role: "agent",
      repo: "https://github.com/owner/name.git",
    });
    expect(first.results).toHaveLength(1);
    expect(first.results[0]!.status).toBe("enqueued");
    expect(first.results[0]!.batchIds?.length).toBeGreaterThan(0);

    const events1 = q.listWatcherEvents(project.id);
    expect(events1.some((e) => e.status === "enqueued" && e.batchId)).toBe(
      true,
    );
    const runs = q.listRuns({ projectId: project.id });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.status === "queued")).toBe(true);
    expect(runs.every((r) => r.triggerRuleId === created.id)).toBe(true);
    expect(runs.every((r) => r.agentCommit === "deadbeef")).toBe(true);

    const second = await handleWatcherEvent(q, resolver, {
      projectId: project.id,
      trigger: "tag",
      ref: "v2.3.0",
      role: "agent",
      repo: "owner/name",
    });
    expect(second.results[0]!.status).toBe("deduped");
    const events2 = q.listWatcherEvents(project.id);
    expect(events2.filter((e) => e.status === "deduped")).toHaveLength(1);
    // No new runs
    expect(q.listRuns({ projectId: project.id })).toHaveLength(runs.length);
  });

  it("non-matching repo produces no results", async () => {
    const { q, project } = await setup();
    q.createWatcherRule(project.id, {
      role: "agent",
      repo: "owner/name",
      trigger: "tag",
      action: { enqueue: "all" },
    });
    const out = await handleWatcherEvent(q, new FakeRefResolver(), {
      projectId: project.id,
      trigger: "tag",
      ref: "v1.0.0",
      role: "agent",
      repo: "other/repo",
    });
    expect(out.results).toEqual([]);
  });

  it("semver-ignored rule records ignored", async () => {
    const { q, project } = await setup();
    q.createWatcherRule(project.id, {
      role: "agent",
      repo: "owner/name",
      trigger: "tag",
      semverFilter: ">=3.0.0",
      action: { enqueue: "all" },
    });
    const out = await handleWatcherEvent(q, new FakeRefResolver(), {
      projectId: project.id,
      trigger: "tag",
      ref: "v2.0.0",
      role: "agent",
      repo: "owner/name",
    });
    expect(out.results[0]!.status).toBe("ignored");
    expect(
      q.listWatcherEvents(project.id).some((e) => e.status === "ignored"),
    ).toBe(true);
    expect(q.listRuns({ projectId: project.id })).toHaveLength(0);
  });

  it("resolveRef throw records failed without aborting other rules", async () => {
    const { q, project } = await setup();
    // Two rules; first throws on resolve, second succeeds.
    const rFail = q.createWatcherRule(project.id, {
      role: "agent",
      repo: "owner/name",
      trigger: "tag",
      ref: "v*",
      action: { enqueue: "subset", taskTags: ["smoke"], repeats: 1 },
    });
    // Nudge createdAt ordering via second rule after first.
    const rOk = q.createWatcherRule(project.id, {
      role: "agent",
      repo: "owner/name",
      trigger: "tag",
      ref: "v*",
      action: { enqueue: "subset", taskTags: ["regression"], repeats: 1 },
    });
    void rFail;
    void rOk;

    const resolver: RefResolver = {
      async resolveRef(_repo, ref) {
        // Fail first call only by using a counter
        // Simpler: fail when taskTags smoke — but resolver doesn't know rule.
        // Use throwOn for first resolve via mutable flag.
        if ((resolver as { n?: number }).n) {
          return { sha: "oksha", imageTag: ref };
        }
        (resolver as { n?: number }).n = 1;
        throw new Error("network down");
      },
    };

    const out = await handleWatcherEvent(q, resolver, {
      projectId: project.id,
      trigger: "tag",
      ref: "v2.0.0",
      role: "agent",
      repo: "owner/name",
    });
    expect(out.results).toHaveLength(2);
    const statuses = out.results.map((r) => r.status).sort();
    expect(statuses).toEqual(["enqueued", "failed"]);
    expect(out.results.some((r) => r.error?.includes("network down"))).toBe(
      true,
    );
  });
});

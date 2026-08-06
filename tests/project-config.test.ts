/**
 * Per-project execution config (plan/projects.md §82): a project refines the
 * global adapter for its codebase — image pin, project env, tool allowlist,
 * network policy — without forking the adapter.
 *
 * Two layers are covered:
 *  1. the pure resolver (precedence + malformed-input tolerance), and
 *  2. the end-to-end wire through startRun → RunContext.overrides →
 *     adapter.image()/command(), and → the container's network mode.
 *
 * (2) is what makes this more than a unit test: before this, projects stored
 * adapterOverrides/workspaceImage/networkPolicy and the API returned them, but
 * nothing consumed them at run start.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAdapterOverrides,
  resolveNetworkMode,
  resolveRunNetwork,
} from "../src/runner/project-config.ts";
import type { Adapter, RunContext } from "../src/adapters/types.ts";
import type { CanonicalEvent } from "../src/schema/events.ts";
import { openDb } from "../src/db/index.ts";
import { startRun, createLiveRunsMap } from "../src/api/run-controller-bridge.ts";
import { FakeContainerRuntime } from "../src/runner/fake-runtime.ts";

// ---------------------------------------------------------------------------
// 1. pure resolver
// ---------------------------------------------------------------------------

describe("resolveNetworkMode", () => {
  it("passes through the three valid modes, case/space tolerant", () => {
    expect(resolveNetworkMode("allow")).toBe("allow");
    expect(resolveNetworkMode("offline")).toBe("offline");
    expect(resolveNetworkMode("allowlist")).toBe("allowlist");
    expect(resolveNetworkMode("  OFFLINE ")).toBe("offline");
  });

  it("falls back to allow for unknown/absent values (never throws)", () => {
    expect(resolveNetworkMode(null)).toBe("allow");
    expect(resolveNetworkMode(undefined)).toBe("allow");
    expect(resolveNetworkMode("")).toBe("allow");
    expect(resolveNetworkMode("bogus")).toBe("allow");
    expect(resolveNetworkMode(42 as unknown as string)).toBe("allow");
  });
});

describe("resolveAdapterOverrides", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveAdapterOverrides(null)).toBeUndefined();
    expect(resolveAdapterOverrides({})).toBeUndefined();
    expect(
      resolveAdapterOverrides({ adapterOverrides: {}, workspaceImage: null }),
    ).toBeUndefined();
  });

  it("lifts workspaceImage into the adapter-facing image field", () => {
    expect(resolveAdapterOverrides({ workspaceImage: "acme/base:1" })).toEqual({
      image: "acme/base:1",
    });
  });

  it("prefers an explicit adapterOverrides.image over workspaceImage", () => {
    const out = resolveAdapterOverrides({
      workspaceImage: "acme/base:1",
      adapterOverrides: { image: "acme/pinned:2" },
    });
    expect(out?.image).toBe("acme/pinned:2");
  });

  it("accepts imageTag (the queue/watcher spelling of an image pin)", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: { imageTag: "acme/from-watcher:3" },
    });
    expect(out?.image).toBe("acme/from-watcher:3");
  });

  it("lets per-run overrides win over project config", () => {
    const out = resolveAdapterOverrides(
      { adapterOverrides: { model: "project-model", image: "project-img" } },
      { model: "run-model" },
    );
    expect(out?.model).toBe("run-model");
    // untouched keys still come from the project
    expect(out?.image).toBe("project-img");
  });

  it("carries env, params, allowedTools, provider and network", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: {
        env: { REGISTRY: "ghcr.io/acme" },
        params: { temperature: 0 },
        allowedTools: ["read", "write"],
        provider: "anthropic",
        network: "offline",
      },
    });
    expect(out).toEqual({
      env: { REGISTRY: "ghcr.io/acme" },
      params: { temperature: 0 },
      allowedTools: ["read", "write"],
      provider: "anthropic",
      network: "offline",
    });
  });

  it("drops malformed entries rather than passing them to the adapter", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: {
        model: 7, // wrong type → dropped
        env: { GOOD: "yes", BAD: 3 }, // non-string value dropped
        allowedTools: ["read", 9], // non-string dropped
        params: "not-an-object", // dropped
      },
    });
    expect(out?.model).toBeUndefined();
    expect(out?.env).toEqual({ GOOD: "yes" });
    expect(out?.allowedTools).toEqual(["read"]);
    expect(out?.params).toBeUndefined();
  });

  it("normalizes an invalid network override to allow", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: { network: "wide-open" },
    });
    expect(out?.network).toBe("allow");
  });
});

describe("resolveRunNetwork", () => {
  it("uses the project network policy by default", () => {
    expect(resolveRunNetwork({ networkPolicy: "offline" })).toBe("offline");
  });

  it("lets an explicit override win over the project policy", () => {
    expect(
      resolveRunNetwork({ networkPolicy: "offline" }, { network: "allow" }),
    ).toBe("allow");
  });

  it("defaults to allow with no config at all", () => {
    expect(resolveRunNetwork(null)).toBe("allow");
    expect(resolveRunNetwork(undefined, {})).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 2. end-to-end wire: project row → RunContext → container spec
// ---------------------------------------------------------------------------

/** Adapter that records the ctx it was handed, so we can assert the wire. */
function makeSpyAdapter(): Adapter & { seen: RunContext[] } {
  const seen: RunContext[] = [];
  return {
    id: "spy",
    seen,
    image(ctx: RunContext): string {
      seen.push(ctx);
      return ctx.overrides?.image ?? "default/image:0";
    },
    command(ctx: RunContext) {
      seen.push(ctx);
      return {
        argv: ["node", "-e", "process.exit(0)"],
        env: { ...(ctx.overrides?.env ?? {}) },
      };
    },
    // eslint-disable-next-line require-yield
    async *parse(): AsyncIterable<CanonicalEvent> {
      // no events — the run finalizes on process exit
    },
  };
}

interface Fixture {
  dataDir: string;
  cleanup: () => void;
  queries: ReturnType<typeof openDb>["queries"];
}

function openFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-projcfg-"));
  const { queries } = openDb(dataDir);
  return { dataDir, queries, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

/** Create project+task+batch+run and start it, returning the live run + adapter. */
async function runWithProject(
  fx: Fixture,
  projectPatch: {
    workspaceImage?: string;
    adapterOverrides?: Record<string, unknown>;
    networkPolicy?: string;
  },
) {
  const { queries, dataDir } = fx;
  const project = queries.createProject({
    name: "cfg",
    slug: "cfg",
    taskSource: { kind: "ui-builder" },
    ...projectPatch,
  });
  const task = queries.createTask(project.id, {
    id: "ext-cfg-1",
    name: "t",
    prompt: "do the thing",
    workspace: { source: "empty" },
    agentCategory: "coding",
    rubric: {
      version: 1,
      profile: "bugfix",
      criteria: [
        {
          id: "A1",
          axis: "A",
          label: "correctness",
          weight: 1,
          appliesTo: "coding",
          anchors: { full: "yes", partial: "some", none: "no" },
        },
      ],
    },
  });
  queries.registerAgent({ id: "spy", displayName: "spy" });
  const batch = queries.createBatch({
    projectId: project.id,
    taskId: task.id,
    agentId: "spy",
    model: "m",
    provider: "p",
    repeats: 1,
  });
  const run = queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    agentId: "spy",
    model: "m",
    provider: "p",
    repeatIndex: 0,
  });

  const adapter = makeSpyAdapter();
  const runtime = new FakeContainerRuntime();
  const live = await startRun(dataDir, queries, run.id, createLiveRunsMap(), {
    adapter,
    runtime,
    timeoutMs: 10_000,
  });
  await live.done;
  return { live, adapter, project, run };
}

describe("project config reaches the run (startRun wire)", () => {
  it("passes project adapterOverrides through to the adapter as ctx.overrides", async () => {
    const fx = openFixture();
    try {
      const { adapter } = await runWithProject(fx, {
        adapterOverrides: {
          env: { REGISTRY: "ghcr.io/acme" },
          allowedTools: ["read"],
        },
      });
      expect(adapter.seen.length).toBeGreaterThan(0);
      const ctx = adapter.seen[0]!;
      expect(ctx.overrides?.env).toEqual({ REGISTRY: "ghcr.io/acme" });
      expect(ctx.overrides?.allowedTools).toEqual(["read"]);
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  it("pins the container image from the project's workspaceImage", async () => {
    const fx = openFixture();
    try {
      const { live } = await runWithProject(fx, {
        workspaceImage: "acme/rust-toolchain:1",
      });
      expect(live.handle.image).toBe("acme/rust-toolchain:1");
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  it("applies the project's network policy to the container spec", async () => {
    const fx = openFixture();
    try {
      const { live } = await runWithProject(fx, { networkPolicy: "offline" });
      const record = (live.handle as unknown as { record: { network: string } })
        .record;
      expect(record.network).toBe("offline");
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  it("defaults to network=allow and the adapter's own image with no project config", async () => {
    const fx = openFixture();
    try {
      const { live, adapter } = await runWithProject(fx, {});
      const record = (live.handle as unknown as { record: { network: string } })
        .record;
      expect(record.network).toBe("allow");
      expect(live.handle.image).toBe("default/image:0");
      expect(adapter.seen[0]!.overrides).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  it("records the resolved image/network/overrides in exec.json provenance", async () => {
    const fx = openFixture();
    try {
      const { project, run } = await runWithProject(fx, {
        workspaceImage: "acme/base:9",
        networkPolicy: "offline",
      });
      const execJson = JSON.parse(
        readFileSync(
          join(fx.dataDir, "projects", project.id, "runs", run.id, "exec.json"),
          "utf8",
        ),
      ) as { image: string; network: string; adapterOverrides?: unknown };
      expect(execJson.image).toBe("acme/base:9");
      expect(execJson.network).toBe("offline");
      expect(execJson.adapterOverrides).toEqual({ image: "acme/base:9" });
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});

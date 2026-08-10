/** Sandbox port parsing and real Podman publication/provenance. */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePorts, resolveAdapterOverrides } from "../src/runner/project-config.ts";
import { PodmanRuntime } from "../src/runner/podman-runtime.ts";
import type { Adapter } from "../src/adapters/types.ts";
import type { CanonicalEvent } from "../src/schema/events.ts";
import { openDb } from "../src/db/index.ts";
import { startRun, createLiveRunsMap } from "../src/api/run-controller-bridge.ts";

function runtime(): PodmanRuntime {
  return new PodmanRuntime({
    prefix: process.env.AGENTEVAL_PODMAN_SUDO === "0" ? [] : ["sudo", "-n"],
  });
}

describe("parsePorts", () => {
  it("accepts bare ports and camel/snake-case objects", () => {
    expect(parsePorts([3000])).toEqual([{ containerPort: 3000 }]);
    expect(
      parsePorts([
        { containerPort: 3000, hostPort: 13000, name: "web" },
        { container_port: 9222, host_port: 19222, protocol: "tcp", name: "cdp" },
      ]),
    ).toEqual([
      { containerPort: 3000, hostPort: 13000, name: "web" },
      { containerPort: 9222, hostPort: 19222, protocol: "tcp", name: "cdp" },
    ]);
  });

  it("drops malformed entries and invalid protocols", () => {
    expect(
      parsePorts([
        { containerPort: 0 },
        { containerPort: 70000 },
        { containerPort: "web" },
        { containerPort: 5173 },
        { containerPort: 3000, protocol: "sctp" },
      ]),
    ).toEqual([{ containerPort: 5173 }, { containerPort: 3000 }]);
  });

  it("reaches adapter overrides", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: { ports: [{ containerPort: 9222, name: "cdp" }] },
    });
    expect(out?.ports).toEqual([{ containerPort: 9222, name: "cdp" }]);
  });
});

function makeAdapter(): Adapter {
  return {
    id: "portspy",
    image: () => "docker.io/library/alpine:3.19",
    command: () => ({ argv: ["sh", "-c", "sleep 2"], env: {} }),
    // eslint-disable-next-line require-yield
    async *parse(): AsyncIterable<CanonicalEvent> {},
  };
}

async function runWithPorts(ports?: Array<{ containerPort: number; name?: string }>) {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-portwire-"));
  const { queries } = openDb(dataDir);
  const project = queries.createProject({
    name: "ports",
    slug: `ports-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    taskSource: { kind: "ui-builder" },
    ...(ports ? { adapterOverrides: { ports } } : {}),
  });
  const task = queries.createTask(project.id, {
    id: `ext-${Date.now()}`,
    name: "t",
    prompt: "serve",
    workspace: { source: "empty" },
    agentCategory: "browser",
    rubric: {
      version: 1,
      profile: "browser",
      criteria: [
        {
          id: "A1",
          axis: "A",
          label: "correctness",
          weight: 1,
          appliesTo: "general",
          anchors: { full: "yes", partial: "some", none: "no" },
        },
      ],
    },
  });
  queries.registerAgent({ id: "portspy", displayName: "portspy" });
  const batch = queries.createBatch({
    projectId: project.id,
    taskId: task.id,
    agentId: "portspy",
    model: "m",
    provider: "p",
    repeats: 1,
  });
  const run = queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId: project.id,
    agentId: "portspy",
    model: "m",
    provider: "p",
    repeatIndex: 0,
  });
  const live = await startRun(dataDir, queries, run.id, createLiveRunsMap(), {
    adapter: makeAdapter(),
    runtime: runtime(),
    timeoutMs: 30_000,
  });
  await live.done;
  return { dataDir, project, run, live };
}

describe("project ports reach the real Podman sandbox", () => {
  it("publishes an ephemeral port and records it in exec.json", async () => {
    const fx = await runWithPorts([{ containerPort: 9222, name: "cdp" }]);
    try {
      expect(fx.live.handle.ports).toHaveLength(1);
      expect(fx.live.handle.ports![0]!.hostPort).toBeGreaterThan(0);
      const execJson = JSON.parse(
        readFileSync(
          join(fx.dataDir, "projects", fx.project.id, "runs", fx.run.id, "exec.json"),
          "utf8",
        ),
      ) as { ports: Array<{ containerPort: number; hostPort: number }> };
      expect(execJson.ports).toEqual(fx.live.handle.ports);
    } finally {
      rmSync(fx.dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("records an empty port list when none are requested", async () => {
    const fx = await runWithPorts();
    try {
      const execJson = JSON.parse(
        readFileSync(
          join(fx.dataDir, "projects", fx.project.id, "runs", fx.run.id, "exec.json"),
          "utf8",
        ),
      ) as { ports: unknown[] };
      expect(execJson.ports).toEqual([]);
    } finally {
      rmSync(fx.dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});

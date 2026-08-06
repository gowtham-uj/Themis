/**
 * Sandbox published ports (plan/projects.md §82, sandbox control).
 *
 * A run that drives a browser or serves a dev server needs an addressable host
 * port: the agent starts something on a container port, and the harness must
 * tell it which host port that became. Three layers are covered:
 *
 *  1. parsePorts — the loose project-config blob → typed mappings,
 *  2. resolvePorts / FakeContainerRuntime — ephemeral (hostPort 0/absent)
 *     requests resolved to concrete ports, injected as AGENTEVAL_PORT_<NAME>,
 *  3. the wire — project adapterOverrides.ports reaching the container spec and
 *     landing in exec.json so the resolved port is discoverable after the fact.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePorts, resolveAdapterOverrides } from "../src/runner/project-config.ts";
import { FakeContainerRuntime, resolvePorts } from "../src/runner/fake-runtime.ts";
import type { Adapter, RunContext } from "../src/adapters/types.ts";
import type { CanonicalEvent } from "../src/schema/events.ts";
import { openDb } from "../src/db/index.ts";
import { startRun, createLiveRunsMap } from "../src/api/run-controller-bridge.ts";

// ---------------------------------------------------------------------------
// 1. parsePorts
// ---------------------------------------------------------------------------

describe("parsePorts", () => {
  it("accepts a bare port number as a container port", () => {
    expect(parsePorts([3000])).toEqual([{ containerPort: 3000 }]);
  });

  it("accepts objects in camelCase and snake_case, plus protocol and name", () => {
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

  it("treats { port } as the container port", () => {
    expect(parsePorts([{ port: 8080 }])).toEqual([{ containerPort: 8080 }]);
  });

  it("drops malformed entries rather than passing them to the runtime", () => {
    const out = parsePorts([
      { containerPort: 0 }, // out of range
      { containerPort: 70000 }, // out of range
      { containerPort: "web" }, // wrong type
      "3000", // not a mapping
      null,
      { containerPort: 5173 }, // the one good entry
    ]);
    expect(out).toEqual([{ containerPort: 5173 }]);
  });

  it("returns undefined for non-arrays and for arrays with nothing usable", () => {
    expect(parsePorts(undefined)).toBeUndefined();
    expect(parsePorts("3000")).toBeUndefined();
    expect(parsePorts([])).toBeUndefined();
    expect(parsePorts([{ nope: 1 }])).toBeUndefined();
  });

  it("ignores an invalid protocol rather than forwarding it", () => {
    const out = parsePorts([{ containerPort: 3000, protocol: "sctp" }]);
    expect(out).toEqual([{ containerPort: 3000 }]);
  });

  it("reaches the adapter through project adapterOverrides", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: { ports: [{ containerPort: 9222, name: "cdp" }] },
    });
    expect(out?.ports).toEqual([{ containerPort: 9222, name: "cdp" }]);
  });
});

// ---------------------------------------------------------------------------
// 2. resolvePorts + the fake runtime
// ---------------------------------------------------------------------------

describe("resolvePorts", () => {
  it("assigns a concrete host port when none was requested", async () => {
    const [resolved] = await resolvePorts([{ containerPort: 3000 }]);
    expect(resolved!.containerPort).toBe(3000);
    expect(resolved!.hostPort).toBeGreaterThan(0);
    expect(resolved!.protocol).toBe("tcp");
  });

  it("honors an explicitly requested host port", async () => {
    const [resolved] = await resolvePorts([
      { containerPort: 3000, hostPort: 13579 },
    ]);
    expect(resolved!.hostPort).toBe(13579);
  });

  it("treats hostPort 0 as 'give me an ephemeral one'", async () => {
    const [resolved] = await resolvePorts([
      { containerPort: 3000, hostPort: 0 },
    ]);
    expect(resolved!.hostPort).toBeGreaterThan(0);
  });

  it("returns an empty list for no ports (the common coding-run case)", async () => {
    expect(await resolvePorts(undefined)).toEqual([]);
    expect(await resolvePorts([])).toEqual([]);
  });
});

describe("FakeContainerRuntime port publishing", () => {
  it("exposes resolved ports on the handle and records them", async () => {
    const runtime = new FakeContainerRuntime();
    const dir = mkdtempSync(join(tmpdir(), "agenteval-ports-"));
    try {
      const handle = await runtime.run({
        image: "test:1",
        workspaceDir: dir,
        argv: ["node", "-e", "process.exit(0)"],
        env: {},
        limits: { cpus: 1, memoryMiB: 128, pids: 32 },
        timeoutMs: 10_000,
        network: "allow",
        nonRoot: true,
        ports: [{ containerPort: 9222, name: "cdp" }],
      });
      expect(handle.ports).toHaveLength(1);
      expect(handle.ports![0]!.containerPort).toBe(9222);
      expect(handle.ports![0]!.hostPort).toBeGreaterThan(0);
      await handle.wait();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("tells the agent process its host ports via AGENTEVAL_PORT_<NAME>", async () => {
    const runtime = new FakeContainerRuntime();
    const dir = mkdtempSync(join(tmpdir(), "agenteval-portenv-"));
    try {
      const handle = await runtime.run({
        image: "test:1",
        workspaceDir: dir,
        // Echo the injected env so we can assert the child actually saw it.
        argv: [
          "node",
          "-e",
          "process.stdout.write(JSON.stringify({cdp:process.env.AGENTEVAL_PORT_CDP,web:process.env.AGENTEVAL_PORT_WEB_UI,bare:process.env.AGENTEVAL_PORT_5173}))",
        ],
        env: {},
        limits: { cpus: 1, memoryMiB: 128, pids: 32 },
        timeoutMs: 10_000,
        network: "allow",
        nonRoot: true,
        ports: [
          { containerPort: 9222, name: "cdp" },
          { containerPort: 3000, name: "web-ui" },
          { containerPort: 5173 }, // unnamed → keyed by container port
        ],
      });
      let out = "";
      const collect = (async () => {
        for await (const chunk of handle.stdout()) out += chunk.toString("utf8");
      })();
      await handle.wait();
      await collect;

      const seen = JSON.parse(out) as Record<string, string | undefined>;
      const byContainerPort = new Map(
        handle.ports!.map((p) => [p.containerPort, p.hostPort]),
      );
      expect(seen.cdp).toBe(String(byContainerPort.get(9222)));
      // Non-alphanumerics in the name become underscores.
      expect(seen.web).toBe(String(byContainerPort.get(3000)));
      expect(seen.bare).toBe(String(byContainerPort.get(5173)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 3. the wire: project config → container spec → exec.json
// ---------------------------------------------------------------------------

function makeAdapter(): Adapter {
  return {
    id: "portspy",
    image: () => "default/image:0",
    command: () => ({
      argv: ["node", "-e", "process.exit(0)"],
      env: {},
    }),
    // eslint-disable-next-line require-yield
    async *parse(): AsyncIterable<CanonicalEvent> {},
  };
}

describe("project ports reach the sandbox (startRun wire)", () => {
  it("publishes the project's ports and records them in exec.json", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agenteval-portwire-"));
    try {
      const { queries } = openDb(dataDir);
      const project = queries.createProject({
        name: "ports",
        slug: "ports",
        taskSource: { kind: "ui-builder" },
        adapterOverrides: {
          ports: [{ containerPort: 9222, name: "cdp" }],
        },
      });
      const task = queries.createTask(project.id, {
        id: "ext-ports-1",
        name: "t",
        prompt: "screenshot the page",
        workspace: { source: "empty" },
        agentCategory: "browser",
        rubric: {
          version: 1,
          profile: "bugfix",
          criteria: [
            {
              id: "A1",
              axis: "A",
              label: "correctness",
              weight: 1,
              appliesTo: "browser",
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

      const live = await startRun(
        dataDir,
        queries,
        run.id,
        createLiveRunsMap(),
        {
          adapter: makeAdapter(),
          runtime: new FakeContainerRuntime(),
          timeoutMs: 10_000,
        },
      );
      await live.done;

      const published = (
        live.handle as unknown as {
          ports?: Array<{ containerPort: number; hostPort: number }>;
        }
      ).ports;
      expect(published).toHaveLength(1);
      expect(published![0]!.containerPort).toBe(9222);

      const execJson = JSON.parse(
        readFileSync(
          join(dataDir, "projects", project.id, "runs", run.id, "exec.json"),
          "utf8",
        ),
      ) as { ports: Array<{ containerPort: number; hostPort: number }> };
      expect(execJson.ports).toHaveLength(1);
      expect(execJson.ports[0]!.containerPort).toBe(9222);
      // The resolved host port is the point — it is what an operator connects to.
      expect(execJson.ports[0]!.hostPort).toBe(published![0]!.hostPort);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("records an empty ports list when the project asks for none", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agenteval-noports-"));
    try {
      const { queries } = openDb(dataDir);
      const project = queries.createProject({
        name: "noports",
        slug: "noports",
        taskSource: { kind: "ui-builder" },
      });
      const task = queries.createTask(project.id, {
        id: "ext-noports-1",
        name: "t",
        prompt: "fix the bug",
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
      const live = await startRun(
        dataDir,
        queries,
        run.id,
        createLiveRunsMap(),
        {
          adapter: makeAdapter(),
          runtime: new FakeContainerRuntime(),
          timeoutMs: 10_000,
        },
      );
      await live.done;
      const execJson = JSON.parse(
        readFileSync(
          join(dataDir, "projects", project.id, "runs", run.id, "exec.json"),
          "utf8",
        ),
      ) as { ports: unknown[] };
      expect(execJson.ports).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

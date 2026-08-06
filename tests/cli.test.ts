import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter, AgentStreams, RunContext } from "../src/adapters/types.ts";
import { parseArgs, usage } from "../src/cli/index.ts";
import { runAgent } from "../src/runner/run.ts";
import { readJsonl } from "../src/schema/jsonl.ts";
import type { CanonicalEvent } from "../src/schema/events.ts";

function fixtureAdapter(lines: unknown[]): Adapter {
  return {
    id: "pi",
    image: () => "test",
    command: () => ({ argv: ["true"], env: {} }),
    async *parse(_streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent> {
      // Emit a minimal trajectory as if the agent ran.
      yield {
        v: 1,
        runId: ctx.runId,
        seq: 1,
        ts: new Date().toISOString(),
        type: "turn.start",
        turn: 0,
      };
      yield {
        v: 1,
        runId: ctx.runId,
        seq: 2,
        ts: new Date().toISOString(),
        type: "message",
        turn: 0,
        mode: "full",
        text: "done",
      };
      yield {
        v: 1,
        runId: ctx.runId,
        seq: 3,
        ts: new Date().toISOString(),
        type: "turn.end",
        turn: 0,
        stopReason: "stop",
      };
      // Extra fixture payload for visibility.
      for (const line of lines) {
        void line;
      }
    },
  };
}

describe("parseArgs", () => {
  it("parses run command with required flags", () => {
    const p = parseArgs([
      "node",
      "agenteval",
      "run",
      "pi",
      "--task",
      "hello",
      "--workspace",
      "./ws",
      "--provider",
      "anthropic",
      "--model",
      "m1",
    ]);
    expect(p.command).toBe("run");
    expect(p.agent).toBe("pi");
    expect(p.task).toBe("hello");
    expect(p.workspace).toBe("./ws");
    expect(p.provider).toBe("anthropic");
    expect(p.model).toBe("m1");
  });

  it("usage mentions run and agents", () => {
    const u = usage();
    expect(u).toContain("agenteval run");
    expect(u).toContain("pi");
    expect(u).toContain("reapercode");
  });
});

describe("runAgent (local orchestration)", () => {
  it("writes events.jsonl + hunk-numbered diff under data/runs/<id>", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-cli-"));
    const ws = join(root, "ws");
    const dataDir = join(root, "data");
    await mkdir(ws, { recursive: true });

    const result = await runAgent({
      agent: "pi",
      task: "create hello.txt",
      workspace: ws,
      dataDir,
      runId: "test-run-1",
      adapter: fixtureAdapter([]),
      spawnAgent: async () => {
        // Simulate the agent writing a file into the workspace.
        await writeFile(join(ws, "hello.txt"), "hi\n", "utf8");
        async function* empty(): AsyncIterable<Buffer> {
          // no stdout — adapter.parse uses our fixture yields
        }
        return {
          stdout: empty(),
          stderr: empty(),
          exitCode: 0,
          durationMs: 5,
        };
      },
    });

    expect(result.runId).toBe("test-run-1");
    expect(result.status).toBe("completed");
    expect(result.eventsPath).toBe(join(dataDir, "runs", "test-run-1", "events.jsonl"));
    expect(result.diffPath).toBe(join(dataDir, "runs", "test-run-1", "diff.patch"));

    const events: CanonicalEvent[] = [];
    for await (const obj of readJsonl(result.eventsPath)) {
      events.push(obj as CanonicalEvent);
    }
    expect(events[0]?.type).toBe("run.start");
    expect(events.some((e) => e.type === "message")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("run.end");
    const end = events[events.length - 1];
    if (end?.type === "run.end") {
      expect(end.status).toBe("completed");
      expect(end.diffPath).toBeTruthy();
    }

    const patch = await readFile(result.diffPath!, "utf8");
    expect(patch).toContain("hello.txt");
    expect(patch).toContain("# agenteval-hunk:");

    const runJson = JSON.parse(
      await readFile(join(result.runDir, "run.json"), "utf8"),
    ) as { runId: string; agent: string };
    expect(runJson.runId).toBe("test-run-1");
    expect(runJson.agent).toBe("pi");
  });

  it("errors clearly when reapercode is chosen without the required changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-cli-reaper-"));
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });

    await expect(
      runAgent({
        agent: "reapercode",
        task: "x",
        workspace: ws,
        dataDir: join(root, "data"),
      }),
    ).rejects.toThrow(/not liveable|reapercode-changes|stream-events|thinking/i);
  });

  it("skipAgent still prepares workspace and captures empty/agent-less diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-cli-skip-"));
    const ws = join(root, "ws");
    const dataDir = join(root, "data");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "pre.txt"), "pre\n", "utf8");

    const result = await runAgent({
      agent: "pi",
      task: "noop",
      workspace: ws,
      dataDir,
      skipAgent: true,
      runId: "skip-1",
      adapter: fixtureAdapter([]),
    });

    expect(result.status).toBe("completed");
    const events: CanonicalEvent[] = [];
    for await (const obj of readJsonl(result.eventsPath)) {
      events.push(obj as CanonicalEvent);
    }
    expect(events.some((e) => e.type === "run.start")).toBe(true);
    expect(events.some((e) => e.type === "run.end")).toBe(true);
  });

  // Regression (plan/adapters.md "Never trust clean exit alone"): a crash
  // mid-stream that emits a fatal error event but still exits 0 must read
  // status:"failed", not "completed".
  it("marks a fatal-error-but-exit-0 run as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-cli-fatal-"));
    const ws = join(root, "ws");
    const dataDir = join(root, "data");
    await mkdir(ws, { recursive: true });

    const crashingAdapter: Adapter = {
      id: "pi",
      image: () => "test",
      command: () => ({ argv: ["true"], env: {} }),
      async *parse(_streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent> {
        yield {
          v: 1, runId: ctx.runId, seq: 1, ts: new Date().toISOString(),
          type: "error", message: "agent crashed mid-stream", phase: "agent", fatal: true,
        };
      },
    };

    const result = await runAgent({
      agent: "pi",
      task: "x",
      workspace: ws,
      dataDir,
      runId: "fatal-1",
      adapter: crashingAdapter,
      spawnAgent: async () => {
        async function* empty(): AsyncIterable<Buffer> {}
        return { stdout: empty(), stderr: empty(), exitCode: 0, durationMs: 1 };
      },
    });

    expect(result.status).toBe("failed");
    const events: CanonicalEvent[] = [];
    for await (const obj of readJsonl(result.eventsPath)) {
      events.push(obj as CanonicalEvent);
    }
    const end = events[events.length - 1];
    expect(end?.type).toBe("run.end");
    if (end?.type === "run.end") expect(end.status).toBe("failed");
    expect(events.some((e) => e.type === "error" && e.fatal)).toBe(true);
  });

  it("marks a non-zero exit code run as failed even without a fatal event", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-cli-exit-"));
    const ws = join(root, "ws");
    const dataDir = join(root, "data");
    await mkdir(ws, { recursive: true });

    const result = await runAgent({
      agent: "pi",
      task: "x",
      workspace: ws,
      dataDir,
      runId: "exit-1",
      adapter: fixtureAdapter([]),
      spawnAgent: async () => {
        async function* empty(): AsyncIterable<Buffer> {}
        return { stdout: empty(), stderr: empty(), exitCode: 137, durationMs: 1 };
      },
    });

    expect(result.status).toBe("failed");
  });
});

describe("live pi smoke (guarded)", () => {
  const live = process.env.AGENTEVAL_LIVE === "1";

  it.skipIf(!live)(
    "spawns pi end-to-end when AGENTEVAL_LIVE=1",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenteval-live-"));
      const ws = join(root, "ws");
      await mkdir(ws, { recursive: true });
      const result = await runAgent({
        agent: "pi",
        task: "Create a file named hello.txt containing exactly: hi",
        workspace: ws,
        dataDir: join(root, "data"),
        provider: process.env.AGENTEVAL_PROVIDER ?? "anthropic",
        model: process.env.AGENTEVAL_MODEL ?? "claude-sonnet-4-20250514",
      });
      expect(result.eventsPath).toBeTruthy();
      const events: CanonicalEvent[] = [];
      for await (const obj of readJsonl(result.eventsPath)) {
        events.push(obj as CanonicalEvent);
      }
      expect(events.some((e) => e.type === "run.start")).toBe(true);
      expect(events.some((e) => e.type === "run.end")).toBe(true);
    },
    120_000,
  );
});

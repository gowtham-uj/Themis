/**
 * Contract tests for the pi adapter.
 *
 * Fixture: tests/fixtures/pi-session.jsonl — canned pi --mode json stdout
 * (SessionHeader + AgentSessionEvent stream) covering the full mapping table
 * in plan/event-schema.md § "Mapping: pi → canonical".
 *
 * Live smoke: guarded by AGENTEVAL_LIVE=1; spawns real pi via runPi.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPiCommand,
  createPiParseState,
  derivePiStatus,
  ensurePiAgentDir,
  mapPiEvent,
  parsePiStream,
  piAdapter,
  resolvePiBin,
  runPi,
} from "../src/adapters/pi.ts";
import type { AgentStreams, RunContext } from "../src/adapters/types.ts";
import {
  isCanonicalEvent,
  type CanonicalEvent,
  type MessageEvent,
  type RunEndEvent,
  type RunStartEvent,
  type ThinkingEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnEndEvent,
  type UsageEvent,
  validateCanonicalEvent,
} from "../src/schema/events.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "pi-session.jsonl");

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "pi-eval-1",
    project: { id: "proj-1", name: "demo" },
    task: {
      prompt: "create hello.txt with 'hi'",
      workspace: { source: "empty" },
    },
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    params: { thinking: "low", tools: "write" },
    workspaceDir: "/tmp/ws-pi",
    apiKeys: {
      ANTHROPIC_API_KEY: "sk-test-not-real",
      ANTHROPIC_BASE_URL: "https://proxy.example.test",
    },
    ...overrides,
  };
}

async function loadFixtureText(): Promise<string> {
  return readFile(FIXTURE_PATH, "utf8");
}

async function* stringAsStream(text: string): AsyncIterable<string> {
  // Awkward chunks exercise linesFromStream buffering.
  const chunkSize = 41;
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}

async function collectFromFixture(
  opts: { exitCode?: number; deferRunEnd?: boolean } = {},
): Promise<CanonicalEvent[]> {
  const text = await loadFixtureText();
  const ctx = makeCtx();
  const streams: AgentStreams = {
    stdout: stringAsStream(text),
    stderr: (async function* () {})(),
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : { exitCode: 0 }),
    durationMs: 42,
  };
  const events: CanonicalEvent[] = [];
  for await (const ev of parsePiStream(streams, ctx, {
    deferRunEnd: opts.deferRunEnd ?? false,
  })) {
    events.push(ev);
  }
  return events;
}

describe("piAdapter surface", () => {
  const ctx = makeCtx();

  it("exposes id pi", () => {
    expect(piAdapter.id).toBe("pi");
  });

  it("image is overridable", () => {
    expect(piAdapter.image(ctx)).toBe("agenteval/pi:latest");
    expect(
      piAdapter.image(makeCtx({ overrides: { image: "custom/pi:dev" } })),
    ).toBe("custom/pi:dev");
  });

  it("command launches pi --mode json with provider/model/prompt", () => {
    const { argv, env } = buildPiCommand(ctx);
    // Prefer node + package cli.js over bare PATH `pi`.
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toMatch(/cli\.js$/);
    expect(argv).toContain("--mode");
    expect(argv).toContain("json");
    expect(argv).toContain("-p");
    expect(argv).toContain(ctx.task.prompt);
    expect(argv).toContain("--provider");
    expect(argv).toContain("anthropic");
    expect(argv).toContain("--model");
    expect(argv).toContain(ctx.model);
    expect(argv).toContain("--thinking");
    expect(argv).toContain("low");
    expect(argv).toContain("--tools");
    expect(argv).toContain("write");
    expect(argv).toContain("--offline");
    expect(argv).toContain("--system-prompt");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-not-real");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example.test");
    expect(env.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(env.PI_OFFLINE).toBe("1");
  });

  it("resolvePiBin finds package cli.js or falls back to pi", () => {
    const bin = resolvePiBin();
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
  });

  it("ensurePiAgentDir writes models.json with anthropic baseUrl", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-dir-"));
    const dir = ensurePiAgentDir(join(root, "agent"), {
      anthropicBaseUrl: "https://proxy.example.test",
    });
    const models = JSON.parse(
      await readFile(join(dir, "models.json"), "utf8"),
    ) as { providers: { anthropic: { baseUrl: string } } };
    expect(models.providers.anthropic.baseUrl).toBe(
      "https://proxy.example.test",
    );
  });
});

describe("derivePiStatus", () => {
  it("failed on non-zero exit", () => {
    expect(derivePiStatus(1, true)).toBe("failed");
  });
  it("failed on fatal even with exit 0", () => {
    expect(derivePiStatus(0, true, true)).toBe("failed");
  });
  it("completed on exit 0 + agent_end", () => {
    expect(derivePiStatus(0, true, false)).toBe("completed");
  });
  it("failed when exit 0 but no terminal agent_end", () => {
    expect(derivePiStatus(0, false, false)).toBe("failed");
  });
});

describe("mapPiEvent contract (fixture line-by-line)", () => {
  it("maps the full canned session faithfully", async () => {
    const text = await loadFixtureText();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const ctx = makeCtx();
    const state = createPiParseState();
    const events: CanonicalEvent[] = [];
    for (const line of lines) {
      const raw = JSON.parse(line) as unknown;
      events.push(...mapPiEvent(raw, ctx, state));
    }

    for (const ev of events) {
      expect(isCanonicalEvent(ev)).toBe(true);
      expect(() => validateCanonicalEvent(ev)).not.toThrow();
    }

    // run.start from agent_start
    const start = events.find((e) => e.type === "run.start") as
      | RunStartEvent
      | undefined;
    expect(start).toBeDefined();
    expect(start!.agent).toBe("pi");
    expect(start!.model).toBe(ctx.model);
    expect(start!.provider).toBe("anthropic");
    expect(start!.workspace.source).toBe("empty");

    // turns
    const turnStarts = events.filter((e) => e.type === "turn.start");
    const turnEnds = events.filter((e) => e.type === "turn.end") as TurnEndEvent[];
    expect(turnStarts.length).toBe(2);
    expect(turnEnds.length).toBe(2);
    expect(turnEnds[0]!.stopReason).toBe("toolUse");
    expect(turnEnds[1]!.stopReason).toBe("stop");

    // thinking delta + full with signature
    const thinkingDeltas = events.filter(
      (e): e is ThinkingEvent => e.type === "thinking" && e.mode === "delta",
    );
    const thinkingFull = events.filter(
      (e): e is ThinkingEvent => e.type === "thinking" && e.mode === "full",
    );
    expect(thinkingDeltas.some((e) => e.text.includes("write the file"))).toBe(
      true,
    );
    expect(thinkingFull.length).toBeGreaterThanOrEqual(1);
    expect(thinkingFull[0]!.signature).toBe("sig-abc");
    expect(thinkingFull[0]!.text).toContain("write the file");

    // message delta + full
    const msgDeltas = events.filter(
      (e): e is MessageEvent => e.type === "message" && e.mode === "delta",
    );
    const msgFull = events.filter(
      (e): e is MessageEvent => e.type === "message" && e.mode === "full",
    );
    expect(msgDeltas.some((e) => e.text.includes("Creating hello.txt"))).toBe(
      true,
    );
    expect(msgFull.some((e) => e.text === "Creating hello.txt")).toBe(true);
    expect(msgFull.some((e) => e.text === "Done.")).toBe(true);

    // tool correlation by id
    const calls = events.filter(
      (e): e is ToolCallEvent => e.type === "tool.call",
    );
    const results = events.filter(
      (e): e is ToolResultEvent => e.type === "tool.result",
    );
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(calls[0]!.id).toBe("toolu_fixture_1");
    expect(calls[0]!.name).toBe("write");
    expect(calls[0]!.args).toEqual({ path: "hello.txt", content: "hi" });
    expect(results[0]!.id).toBe(calls[0]!.id);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.name).toBe("write");

    // usage fields (input/output/cache/reasoning/total + cost)
    const usages = events.filter((e): e is UsageEvent => e.type === "usage");
    expect(usages.length).toBeGreaterThanOrEqual(2);
    const firstUsage = usages.find((u) => u.inputTokens === 100);
    expect(firstUsage).toBeDefined();
    expect(firstUsage!.outputTokens).toBe(50);
    expect(firstUsage!.cacheReadTokens).toBe(10);
    expect(firstUsage!.cacheWriteTokens).toBe(5);
    expect(firstUsage!.reasoningTokens).toBe(12);
    expect(firstUsage!.totalTokens).toBe(165);
    expect(firstUsage!.cost?.total).toBeCloseTo(0.0033);

    // auto_retry / compaction → log
    const logs = events.filter((e) => e.type === "log");
    expect(logs.some((e) => e.type === "log" && e.message.includes("auto_retry_start"))).toBe(
      true,
    );
    expect(logs.some((e) => e.type === "log" && e.message.includes("compaction_start"))).toBe(
      true,
    );

    // agent_end → run.end
    const end = events.find((e) => e.type === "run.end") as
      | RunEndEvent
      | undefined;
    expect(end).toBeDefined();
    expect(end!.status).toBe("completed");
    expect(end!.durationMs).toBeGreaterThanOrEqual(0);
    expect(end!.usageTotal).toBeDefined();
    expect(end!.usageTotal!.inputTokens).toBe(100 + 120);
    expect(end!.usageTotal!.outputTokens).toBe(50 + 5);

    // seq monotonic non-negative
    let prev = -1;
    for (const ev of events) {
      expect(ev.seq).toBeGreaterThan(prev);
      expect(ev.runId).toBe(ctx.runId);
      prev = ev.seq;
    }
  });
});

describe("parsePiStream (fixture stream)", () => {
  it("yields a complete canonical stream including run.start/run.end", async () => {
    const events = await collectFromFixture({ exitCode: 0, deferRunEnd: false });
    expect(events[0]?.type).toBe("run.start");
    expect(events[events.length - 1]?.type).toBe("run.end");
    const end = events[events.length - 1] as RunEndEvent;
    expect(end.status).toBe("completed");
    for (const ev of events) {
      expect(() => validateCanonicalEvent(ev)).not.toThrow();
    }
  });

  it("with deferRunEnd uses exit code for final status", async () => {
    const events = await collectFromFixture({ exitCode: 1, deferRunEnd: true });
    const end = events[events.length - 1] as RunEndEvent;
    expect(end.type).toBe("run.end");
    expect(end.status).toBe("failed");
  });

  it("adapter.parse defers run.end and marks failed without terminal event", async () => {
    const ctx = makeCtx();
    const streams: AgentStreams = {
      stdout: stringAsStream(
        `${JSON.stringify({ type: "session", id: "s1", version: 3 })}\n${JSON.stringify({ type: "agent_start" })}\n`,
      ),
      stderr: (async function* () {})(),
      exitCode: 0,
      durationMs: 10,
    };
    const events: CanonicalEvent[] = [];
    for await (const ev of piAdapter.parse(streams, ctx)) {
      events.push(ev);
    }
    const end = events[events.length - 1] as RunEndEvent;
    expect(end.type).toBe("run.end");
    // exit 0 but no agent_end → failed (never trust clean exit alone)
    expect(end.status).toBe("failed");
  });
});

describe("live pi smoke (guarded)", () => {
  const live = process.env.AGENTEVAL_LIVE === "1";

  it.skipIf(!live)(
    "runPi creates hello.txt with hi and emits canonical stream",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenteval-pi-live-"));
      const ws = root;
      // Ensure empty writable workspace.
      await writeFile(join(ws, ".keep"), "", "utf8");

      const ctx = makeCtx({
        runId: `live-${Date.now()}`,
        workspaceDir: ws,
        model:
          process.env.AGENTEVAL_MODEL ?? "claude-haiku-4-5-20251001",
        provider: process.env.AGENTEVAL_PROVIDER ?? "anthropic",
        params: {
          thinking: "off",
          tools: "write",
          noSession: true,
          systemPrompt:
            "You are a helpful coding agent. Use tools to complete the task. Be concise.",
        },
        apiKeys: {
          ...(process.env.ANTHROPIC_API_KEY
            ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
            : {}),
          ...(process.env.ANTHROPIC_AUTH_TOKEN
            ? { ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN }
            : {}),
          ...(process.env.ANTHROPIC_BASE_URL
            ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }
            : {}),
        },
        task: {
          prompt:
            "Create a file named hello.txt containing exactly the two characters hi. Use the write tool.",
          workspace: { source: "empty" },
        },
      });

      const events: CanonicalEvent[] = [];
      for await (const ev of runPi(ctx, { noSession: true })) {
        events.push(ev);
      }

      expect(events.some((e) => e.type === "run.start")).toBe(true);
      expect(events.some((e) => e.type === "run.end")).toBe(true);
      const end = events.filter((e) => e.type === "run.end").at(-1) as RunEndEvent;
      // Surface agent error text on failure for debugging live flakes.
      if (end.status !== "completed") {
        const errs = events
          .filter((e) => e.type === "error" || e.type === "log")
          .map((e) =>
            e.type === "error" || e.type === "log" ? e.message.slice(0, 200) : "",
          );
        expect.soft(errs, "run failed; events above").toEqual([]);
      }
      expect(end.status).toBe("completed");

      const content = await readFile(join(ws, "hello.txt"), "utf8");
      expect(content.trim()).toBe("hi");

      const calls = events.filter((e) => e.type === "tool.call");
      expect(calls.some((e) => e.type === "tool.call" && e.name === "write")).toBe(
        true,
      );

      for (const ev of events) {
        expect(() => validateCanonicalEvent(ev)).not.toThrow();
      }
    },
    180_000,
  );
});

/**
 * Contract tests for the ReaperCode adapter.
 *
 * Fixture is a canned *post-change* trajectory (thinking + run_end + provider/model
 * on session_start) as specified by plan/reapercode-changes.md. Live ReaperCode
 * does not yet emit these kinds — ADAPTER_STATUS = 'spec-ahead-of-reaper'.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_STATUS,
  buildReaperCommand,
  isReaperTrajectoryEntry,
  parseReaperStream,
  parseReaperTrajectory,
  reaperCodeAdapter,
  reaperImage,
} from "../src/adapters/reapercode.ts";
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
const FIXTURE_PATH = join(__dirname, "fixtures", "reapercode-trajectory.jsonl");

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "eval-run-1",
    project: { id: "proj-1", name: "demo" },
    task: {
      prompt: "create hello.txt with 'hi'",
      workspace: { source: "empty" },
    },
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    params: { reasoningEffort: "medium" },
    workspaceDir: "/tmp/ws",
    apiKeys: { ANTHROPIC_API_KEY: "sk-test-not-real" },
    ...overrides,
  };
}

async function loadFixtureText(): Promise<string> {
  return readFile(FIXTURE_PATH, "utf8");
}

async function* stringAsStream(text: string): AsyncIterable<string> {
  // Yield in awkward chunks to exercise linesFromStream buffering.
  const chunkSize = 37;
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}

describe("ADAPTER_STATUS", () => {
  it("marks the adapter as ahead of live ReaperCode", () => {
    expect(ADAPTER_STATUS).toBe("spec-ahead-of-reaper");
  });
});

describe("reaperCodeAdapter surface", () => {
  const ctx = makeCtx();

  it("exposes id reapercode", () => {
    expect(reaperCodeAdapter.id).toBe("reapercode");
  });

  it("builds an image name (overridable)", () => {
    expect(reaperImage(ctx)).toBe("agenteval/reapercode:latest");
    expect(
      reaperImage(makeCtx({ overrides: { image: "custom/reaper:dev" } })),
    ).toBe("custom/reaper:dev");
    expect(reaperCodeAdapter.image(ctx)).toBe("agenteval/reapercode:latest");
  });

  it("command includes --stream-events and launch knobs", () => {
    const { argv, env } = buildReaperCommand(ctx);
    expect(argv).toContain("--stream-events");
    expect(argv).toContain("--prompt");
    expect(argv).toContain(ctx.task.prompt);
    expect(argv).toContain("--provider");
    expect(argv).toContain("anthropic");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-sonnet-4-6");
    expect(argv).toContain("--reasoning-effort");
    expect(argv).toContain("medium");
    expect(env.REAPER_STREAM_EVENTS).toBe("1");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-not-real");

    const viaAdapter = reaperCodeAdapter.command(ctx);
    expect(viaAdapter.argv).toEqual(argv);
  });
});

describe("full mapping: post-change trajectory fixture", () => {
  it("maps every expected kind to the canonical table", async () => {
    const text = await loadFixtureText();
    const ctx = makeCtx();
    const events = parseReaperTrajectory(text, ctx);

    // Every emitted event must validate against the schema.
    for (const ev of events) {
      expect(() => validateCanonicalEvent(ev)).not.toThrow();
      expect(isCanonicalEvent(ev)).toBe(true);
      expect(ev.runId).toBe(ctx.runId);
      expect(ev.v).toBe(1);
    }

    // seq is monotonic starting at 1
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.seq).toBe(i + 1);
    }

    const byType = (t: CanonicalEvent["type"]) => events.filter((e) => e.type === t);

    // session_start → run.start with provider/model from payload
    const starts = byType("run.start") as RunStartEvent[];
    expect(starts).toHaveLength(1);
    expect(starts[0]!.agent).toBe("reapercode");
    expect(starts[0]!.provider).toBe("anthropic");
    expect(starts[0]!.model).toBe("claude-sonnet-4-6");
    expect(starts[0]!.workspace).toEqual({ source: "empty" });
    expect(starts[0]!.params.userIntentSummary).toBe("create hello.txt with 'hi'");
    expect(starts[0]!.params.reasoningEffort).toBe("medium");
    expect(starts[0]!.params.maxTokens).toBe(8192);

    // thinking (new) → thinking{mode:full}
    const thinking = byType("thinking") as ThinkingEvent[];
    expect(thinking.length).toBeGreaterThanOrEqual(2);
    expect(thinking[0]!.mode).toBe("full");
    expect(thinking[0]!.turn).toBe(1);
    expect(thinking[0]!.text).toMatch(/hello\.txt/);
    expect(thinking[1]!.turn).toBe(2);

    // model_response / assistant_message → message{mode:full}
    const messages = byType("message") as MessageEvent[];
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.every((m) => m.mode === "full")).toBe(true);
    expect(messages.some((m) => m.text.includes("create hello.txt") || m.text.includes("Created hello.txt"))).toBe(
      true,
    );

    // tool_call started → tool.call
    const toolCalls = byType("tool.call") as ToolCallEvent[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.id).toBe("dec-write-1");
    expect(toolCalls[0]!.name).toBe("write_file");
    expect(toolCalls[0]!.args).toEqual({ path: "hello.txt", content: "hi" });
    expect(toolCalls[0]!.turn).toBe(1);

    // tool_call completed → tool.result. NOTE: live ReaperCode `tool_call`
    // (.strict() schema) has no duration_ms, so we do not assert one here.
    const toolResults = byType("tool.result") as ToolResultEvent[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.id).toBe("dec-write-1");
    expect(toolResults[0]!.name).toBe("write_file");
    expect(toolResults[0]!.isError).toBe(false);
    expect(toolResults[0]!.output).toEqual({ ok: true, bytes_written: 2 });

    // engine_turn_complete → turn.end
    const turnEnds = byType("turn.end") as TurnEndEvent[];
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]!.turn).toBe(1);
    expect(turnEnds[0]!.stopReason).toBe("toolUse");
    expect(turnEnds[1]!.turn).toBe(2);
    expect(turnEnds[1]!.stopReason).toBe("stop");

    // token_budget → usage
    const usages = byType("usage") as UsageEvent[];
    expect(usages).toHaveLength(2);
    expect(usages[0]!.inputTokens).toBe(1200);
    expect(usages[0]!.outputTokens).toBe(80);
    expect(usages[0]!.cacheReadTokens).toBe(100);
    expect(usages[0]!.cacheWriteTokens).toBe(50);
    expect(usages[1]!.inputTokens).toBe(1300);
    expect(usages[1]!.outputTokens).toBe(40);

    // verification_summary → log
    const logs = byType("log");
    expect(logs.some((l) => l.type === "log" && l.message.includes("verification_summary"))).toBe(
      true,
    );
    const verLog = logs.find(
      (l) => l.type === "log" && l.message.includes("verification_summary"),
    );
    expect(verLog && verLog.type === "log" && verLog.level).toBe("info");
    expect(verLog && verLog.type === "log" && verLog.message).toMatch(/pass_fail=pass/);

    // run_end (new) → run.end{status}
    const ends = byType("run.end") as RunEndEvent[];
    expect(ends).toHaveLength(1);
    expect(ends[0]!.status).toBe("completed");
    expect(ends[0]!.durationMs).toBe(6000);
    expect(ends[0]!.usageTotal).toEqual({
      inputTokens: 2500,
      outputTokens: 120,
      cacheReadTokens: 300,
      cacheWriteTokens: 70,
      totalTokens: 2990,
    });

    // Order: run.start first, run.end last
    expect(events[0]!.type).toBe("run.start");
    expect(events[events.length - 1]!.type).toBe("run.end");
  });

  it("parse() over a chunked stdout stream matches the offline parser", async () => {
    const text = await loadFixtureText();
    const ctx = makeCtx();
    const offline = parseReaperTrajectory(text, ctx);

    const streams: AgentStreams = {
      stdout: stringAsStream(text),
      stderr: (async function* () {})(),
      exitCode: 0,
      durationMs: 6000,
    };
    const live: CanonicalEvent[] = [];
    for await (const ev of parseReaperStream(streams, ctx)) {
      live.push(ev);
    }

    expect(live.map((e) => e.type)).toEqual(offline.map((e) => e.type));
    expect(live).toHaveLength(offline.length);
    // Adapter.parse delegates to parseReaperStream
    const viaAdapter: CanonicalEvent[] = [];
    for await (const ev of reaperCodeAdapter.parse(
      {
        stdout: stringAsStream(text),
        stderr: (async function* () {})(),
      },
      ctx,
    )) {
      viaAdapter.push(ev);
    }
    expect(viaAdapter.map((e) => e.type)).toEqual(offline.map((e) => e.type));
  });
});

describe("edge mappings", () => {
  it("tool_call failed → tool.result{isError:true}", () => {
    const ctx = makeCtx();
    // Use a minimal state via parseReaperTrajectory
    const events = parseReaperTrajectory(
      [
        {
          event_id: "e1",
          run_id: "r",
          session_id: "s",
          trace_id: "t",
          timestamp: "2026-08-06T10:00:00.000Z",
          log_schema_version: 1,
          kind: "tool_call",
          level: "info",
          tool_name: "bash",
          decision_id: "dec-bash-1",
          status: "failed",
          args: { command: "false" },
          error: { code: "tool_error", message: "exit 1" },
        },
      ],
      ctx,
    );
    expect(events).toHaveLength(1);
    const r = events[0]!;
    expect(r.type).toBe("tool.result");
    if (r.type === "tool.result") {
      expect(r.isError).toBe(true);
      expect(r.id).toBe("dec-bash-1");
      expect(r.name).toBe("bash");
      expect(r.output).toEqual({ code: "tool_error", message: "exit 1" });
    }
  });

  it("synthesizes run.end when stream ends without run_end", async () => {
    const ctx = makeCtx();
    const partial =
      JSON.stringify({
        event_id: "e1",
        run_id: "r",
        session_id: "s",
        trace_id: "t",
        timestamp: "2026-08-06T10:00:00.000Z",
        log_schema_version: 1,
        kind: "session_start",
        level: "info",
        user_intent_summary: "x",
        provider: "anthropic",
        model: "m",
      }) + "\n";

    const streams: AgentStreams = {
      stdout: stringAsStream(partial),
      stderr: (async function* () {})(),
      exitCode: 1,
      durationMs: 42,
    };
    const events: CanonicalEvent[] = [];
    for await (const ev of parseReaperStream(streams, ctx)) {
      events.push(ev);
    }
    expect(events[0]!.type).toBe("run.start");
    const end = events[events.length - 1]!;
    expect(end.type).toBe("run.end");
    if (end.type === "run.end") {
      expect(end.status).toBe("failed");
      expect(end.durationMs).toBe(42);
    }
  });

  it("falls back to ctx provider/model when session_start lacks them (pre-change shape)", () => {
    const ctx = makeCtx({ provider: "minimax", model: "mimo-v2" });
    const events = parseReaperTrajectory(
      [
        {
          event_id: "e1",
          run_id: "r",
          session_id: "s",
          trace_id: "t",
          timestamp: "2026-08-06T10:00:00.000Z",
          log_schema_version: 1,
          kind: "session_start",
          level: "info",
          user_intent_summary: "legacy start without provider/model",
        },
      ],
      ctx,
    );
    const start = events[0] as RunStartEvent;
    expect(start.type).toBe("run.start");
    expect(start.provider).toBe("minimax");
    expect(start.model).toBe("mimo-v2");
  });

  it("thinking streaming:true maps to mode delta", () => {
    const ctx = makeCtx();
    const events = parseReaperTrajectory(
      [
        {
          event_id: "e1",
          run_id: "r",
          session_id: "s",
          trace_id: "t",
          timestamp: "2026-08-06T10:00:00.000Z",
          log_schema_version: 1,
          kind: "thinking",
          level: "info",
          content: "partial...",
          turn_index: 1,
          streaming: true,
        },
      ],
      ctx,
    );
    expect(events[0]!.type).toBe("thinking");
    if (events[0]!.type === "thinking") {
      expect(events[0]!.mode).toBe("delta");
      expect(events[0]!.text).toBe("partial...");
    }
  });

  // Regression: live `engine_turn_complete` carries NO turn_index (schema.ts),
  // and `thinking`'s is optional. Turn attribution must work via open/close
  // pairing alone: turn 1 events → turn 1 turn.end, turn 2 events → turn 2.
  // Previously advanceTurn() bumped 2→3 on the 2nd turn.end.
  it("attribs multi-turn correctly with NO turn_index anywhere (open/close pairing)", () => {
    const ctx = makeCtx();
    const events = parseReaperTrajectory(
      [
        {
          event_id: "s0", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:00.000Z", log_schema_version: 1,
          kind: "session_start", level: "info", user_intent_summary: "two turns",
          provider: "anthropic", model: "m",
        },
        { event_id: "t1", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:01.000Z", log_schema_version: 1,
          kind: "thinking", level: "info", content: "turn1 thinking" },
        { event_id: "m1", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:02.000Z", log_schema_version: 1,
          kind: "assistant_message", level: "info", content: "turn1 msg" },
        { event_id: "e1", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:03.000Z", log_schema_version: 1,
          kind: "engine_turn_complete", level: "info", source: "main_agent",
          assistant_message: "turn1 msg", implicit: false,
          tool_result_count: 0, tool_results: [] },
        { event_id: "t2", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:04.000Z", log_schema_version: 1,
          kind: "thinking", level: "info", content: "turn2 thinking" },
        { event_id: "m2", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:05.000Z", log_schema_version: 1,
          kind: "assistant_message", level: "info", content: "turn2 msg" },
        { event_id: "e2", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:06.000Z", log_schema_version: 1,
          kind: "engine_turn_complete", level: "info", source: "main_agent",
          assistant_message: "turn2 msg", implicit: false,
          tool_result_count: 0, tool_results: [] },
        { event_id: "re", run_id: "r", session_id: "s", trace_id: "t",
          timestamp: "2026-08-06T10:00:07.000Z", log_schema_version: 1,
          kind: "run_end", level: "info", status: "completed", duration_ms: 7000,
          assistant_message: "turn2 msg" },
      ],
      ctx,
    );
    const turns = events.filter((e) => e.type === "turn.end") as TurnEndEvent[];
    const thinkings = events.filter((e) => e.type === "thinking") as ThinkingEvent[];
    const msgs = events.filter((e) => e.type === "message") as MessageEvent[];

    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(thinkings.map((t) => t.turn)).toEqual([1, 2]);
    // 3 messages: m1(turn1) + m2(turn2) + run_end final assistant_message(turn2,
    // reused — must NOT advance to a spurious turn 3).
    expect(msgs.map((m) => m.turn)).toEqual([1, 2, 2]);
    expect(msgs[2]!.text).toBe("turn2 msg"); // run_end final message
  });

  it("isReaperTrajectoryEntry rejects non-envelopes", () => {
    expect(isReaperTrajectoryEntry(null)).toBe(false);
    expect(isReaperTrajectoryEntry({})).toBe(false);
    expect(
      isReaperTrajectoryEntry({
        kind: "session_start",
        timestamp: "2026-08-06T10:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("mapReaperEntry is pure and returns arrays", () => {
    // Smoke: exercise mapReaperEntry directly with a ParseState via trajectory helper.
    const ctx = makeCtx();
    const out = parseReaperTrajectory([], ctx);
    expect(out).toEqual([]);
    // Unknown kind → log
    const unknown = parseReaperTrajectory(
      [
        {
          event_id: "e",
          run_id: "r",
          session_id: "s",
          trace_id: "t",
          timestamp: "2026-08-06T10:00:00.000Z",
          log_schema_version: 1,
          kind: "not_a_real_kind",
          level: "info",
        },
      ],
      ctx,
    );
    expect(unknown[0]!.type).toBe("log");
  });

  it("correlates tool call/result by decision_id", () => {
    const ctx = makeCtx();
    const events = parseReaperTrajectory(
      [
        {
          event_id: "a",
          run_id: "r",
          session_id: "s",
          trace_id: "t",
          timestamp: "2026-08-06T10:00:00.000Z",
          log_schema_version: 1,
          kind: "tool_call",
          tool_name: "bash",
          decision_id: "same-id",
          status: "started",
          args: { command: "echo hi" },
        },
        {
          event_id: "b",
          run_id: "r",
          session_id: "s",
          trace_id: "t",
          timestamp: "2026-08-06T10:00:01.000Z",
          log_schema_version: 1,
          kind: "tool_call",
          tool_name: "bash",
          decision_id: "same-id",
          status: "completed",
          output: "hi\n",
        },
      ],
      ctx,
    );
    expect(events[0]!.type).toBe("tool.call");
    expect(events[1]!.type).toBe("tool.result");
    if (events[0]!.type === "tool.call" && events[1]!.type === "tool.result") {
      expect(events[0]!.id).toBe(events[1]!.id);
    }
  });
});

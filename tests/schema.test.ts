import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNever,
  EVENT_TYPES,
  type CanonicalEvent,
  type EventType,
  EventValidationError,
  isCanonicalEvent,
  SCHEMA_VERSION,
  validateCanonicalEvent,
} from "../src/schema/events.ts";
import { appendJsonl, readFromSeq, readJsonl } from "../src/schema/jsonl.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort cleanup; tests don't depend on it.
  tempDirs.length = 0;
});

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-schema-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function base(seq: number, extras: Partial<CanonicalEvent> = {}): {
  v: typeof SCHEMA_VERSION;
  runId: string;
  seq: number;
  ts: string;
} {
  return {
    v: SCHEMA_VERSION,
    runId: "run-1",
    seq,
    ts: "2026-08-06T12:00:00.000Z",
    ...extras,
  };
}

/** One well-formed event per EventType — keeps exhaustiveness honest. */
function sampleEvents(): CanonicalEvent[] {
  return [
    {
      ...base(0),
      type: "run.start",
      agent: "pi",
      model: "claude-opus-4",
      provider: "anthropic",
      workspace: { source: "git", repo: "owner/repo", commit: "abc" },
      params: { temperature: 0.2 },
    },
    { ...base(1), type: "turn.start", turn: 0 },
    {
      ...base(2),
      type: "thinking",
      turn: 0,
      mode: "delta",
      text: "hmm",
      signature: "sig",
    },
    {
      ...base(3),
      type: "message",
      turn: 0,
      mode: "full",
      text: "hello",
    },
    {
      ...base(4),
      type: "tool.call",
      turn: 0,
      id: "tc-1",
      name: "bash",
      args: { command: "ls" },
    },
    {
      ...base(5),
      type: "tool.result",
      id: "tc-1",
      name: "bash",
      isError: false,
      output: "a.txt",
      durationMs: 12,
      truncated: false,
    },
    {
      ...base(6),
      type: "usage",
      turn: 0,
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      totalTokens: 38,
      cost: { input: 0.01, output: 0.02, total: 0.03 },
    },
    {
      ...base(7),
      type: "turn.end",
      turn: 0,
      stopReason: "toolUse",
    },
    {
      ...base(8),
      type: "exec",
      turn: 0,
      argv: ["npm", "test"],
      cwd: "/workspace",
      user: "agent",
      exitCode: 0,
      durationMs: 320,
      blocked: false,
    },
    {
      ...base(9),
      type: "net",
      turn: 0,
      host: "registry.npmjs.org",
      port: 443,
      proto: "http",
      direction: "outbound",
      method: "GET",
      url: "https://registry.npmjs.org/lodash",
      bytesSent: 120,
      bytesRecv: 4096,
      status: 200,
      durationMs: 90,
    },
    {
      ...base(10),
      type: "error",
      message: "boom",
      phase: "agent",
      fatal: false,
    },
    {
      ...base(11),
      type: "log",
      level: "info",
      message: "note",
    },
    {
      ...base(12),
      type: "run.end",
      status: "completed",
      durationMs: 1500,
      diffPath: "runs/run-1/diff.patch",
      usageTotal: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cost: { total: 0.03 },
      },
    },
  ];
}

describe("CanonicalEvent types + validation", () => {
  it("accepts every EventType sample (round-trip through validate)", () => {
    const events = sampleEvents();
    const seen = new Set<EventType>();
    for (const ev of events) {
      const validated = validateCanonicalEvent(ev);
      expect(validated).toEqual(ev);
      expect(isCanonicalEvent(ev)).toBe(true);
      seen.add(ev.type);
    }
    // Discriminated-union exhaustiveness: every declared EventType has a sample, AND the declared
    // set matches the plan's protocol (plan/event-schema.md defines 13 types). Asserting against a
    // hard-coded plan list — not against EVENT_TYPES itself — so a missing type can't hide.
    expect([...seen].sort()).toEqual([...EVENT_TYPES].sort());
    expect(EVENT_TYPES).toHaveLength(13);
    const PLAN_EVENT_TYPES = [
      "run.start", "run.end", "turn.start", "turn.end", "thinking", "message",
      "tool.call", "tool.result", "usage", "exec", "net", "error", "log",
    ];
    expect([...EVENT_TYPES].sort()).toEqual([...PLAN_EVENT_TYPES].sort());
  });

  it("accepts project-defined adapter ids on run.start", () => {
    const event = validateCanonicalEvent({
      ...base(0),
      type: "run.start",
      agent: "codex-project-adapter",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      workspace: { source: "empty" },
      params: {},
    });
    expect(event.type).toBe("run.start");
    if (event.type === "run.start") expect(event.agent).toBe("codex-project-adapter");
  });

  it("rejects missing envelope fields", () => {
    expect(isCanonicalEvent({ type: "log", level: "info", message: "x" })).toBe(
      false,
    );
    expect(() =>
      validateCanonicalEvent({ type: "log", level: "info", message: "x" }),
    ).toThrow(EventValidationError);
  });

  it("rejects wrong schema version and unknown type", () => {
    expect(() =>
      validateCanonicalEvent({
        ...base(0),
        v: 99,
        type: "log",
        level: "info",
        message: "x",
      }),
    ).toThrow(/v=1/);
    expect(() =>
      validateCanonicalEvent({
        ...base(0),
        type: "not.a.type",
      }),
    ).toThrow(/invalid `type`/);
  });

  it("rejects invalid enum values on type-specific fields", () => {
    expect(() =>
      validateCanonicalEvent({
        ...base(0),
        type: "run.end",
        status: "success",
        durationMs: 1,
      }),
    ).toThrow(/status/);
    expect(() =>
      validateCanonicalEvent({
        ...base(0),
        type: "thinking",
        turn: 0,
        mode: "partial",
        text: "x",
      }),
    ).toThrow(/mode/);
    expect(() =>
      validateCanonicalEvent({
        ...base(0),
        type: "log",
        level: "trace",
        message: "x",
      }),
    ).toThrow(/level/);
  });

  it("switch exhaustiveness helper covers all EventTypes", () => {
    function label(type: EventType): string {
      switch (type) {
        case "run.start":
          return "start";
        case "run.end":
          return "end";
        case "turn.start":
          return "t0";
        case "turn.end":
          return "t1";
        case "thinking":
          return "think";
        case "message":
          return "msg";
        case "tool.call":
          return "call";
        case "tool.result":
          return "result";
        case "usage":
          return "usage";
        case "exec":
          return "exec";
        case "net":
          return "net";
        case "error":
          return "err";
        case "log":
          return "log";
        default:
          return assertNever(type);
      }
    }
    for (const t of EVENT_TYPES) {
      expect(label(t).length).toBeGreaterThan(0);
    }
  });
});

describe("JSONL writer / reader", () => {
  it("round-trips objects writer→reader with equality", async () => {
    const path = await tempPath("events.jsonl");
    const events = sampleEvents();
    for (const ev of events) {
      await appendJsonl(path, ev);
    }

    const raw = await readFile(path, "utf8");
    // One JSON object per line, each line terminated with \n (incl. last).
    const lines = raw.split("\n");
    expect(lines[lines.length - 1]).toBe("");
    expect(lines.slice(0, -1)).toHaveLength(events.length);

    const read: unknown[] = [];
    for await (const obj of readJsonl(path)) {
      read.push(obj);
    }
    expect(read).toEqual(events);

    // Validated form stays equal too.
    expect(read.map((o) => validateCanonicalEvent(o))).toEqual(events);
  });

  it("ignores a truncated trailing line", async () => {
    const path = await tempPath("truncated.jsonl");
    const good1 = { ...base(0), type: "log", level: "info", message: "a" };
    const good2 = { ...base(1), type: "log", level: "info", message: "b" };
    await appendJsonl(path, good1);
    await appendJsonl(path, good2);

    // Simulate crash mid-write: incomplete JSON without trailing newline.
    const handle = await writeFile(
      path,
      `${await readFile(path, "utf8")}{"v":1,"runId":"run-1","seq":2,"ts":"2026-08-06T12:00:00.000Z","type":"log","level":"inf`,
    );
    void handle;

    const read: unknown[] = [];
    for await (const obj of readJsonl(path)) {
      read.push(obj);
    }
    expect(read).toEqual([good1, good2]);
  });

  it("ignores a complete-but-corrupt trailing JSON line", async () => {
    const path = await tempPath("corrupt.jsonl");
    const good = { ...base(0), type: "log", level: "info", message: "ok" };
    await appendJsonl(path, good);
    await writeFile(
      path,
      `${await readFile(path, "utf8")}{not-json\n`,
      "utf8",
    );

    const read: unknown[] = [];
    for await (const obj of readJsonl(path)) {
      read.push(obj);
    }
    expect(read).toEqual([good]);
  });

  it("readFromSeq yields only events with seq > sinceSeq", async () => {
    const path = await tempPath("tail.jsonl");
    const events = sampleEvents();
    for (const ev of events) {
      await appendJsonl(path, ev);
    }

    const since = 5;
    const tail: CanonicalEvent[] = [];
    for await (const obj of readFromSeq(path, since)) {
      tail.push(validateCanonicalEvent(obj));
    }
    expect(tail.map((e) => e.seq)).toEqual(
      events.filter((e) => e.seq > since).map((e) => e.seq),
    );
    expect(tail[0]?.type).toBe("usage");
  });

  it("readJsonl yields nothing for a missing file", async () => {
    const path = await tempPath("does-not-exist.jsonl");
    const read: unknown[] = [];
    for await (const obj of readJsonl(path)) {
      read.push(obj);
    }
    expect(read).toEqual([]);
  });

  it("appendJsonl is durable (file contains the line after await)", async () => {
    const path = await tempPath("durable.jsonl");
    const ev = {
      ...base(0),
      type: "log" as const,
      level: "debug" as const,
      message: "synced",
    };
    await appendJsonl(path, ev);
    const disk = await readFile(path, "utf8");
    expect(JSON.parse(disk.trim())).toEqual(ev);
  });
});

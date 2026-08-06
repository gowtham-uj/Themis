import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CrashReaper,
  createCrashReaper,
  DEFAULT_HEARTBEAT_WINDOW_MS,
  type InFlightRun,
} from "../src/runner/reaper.ts";
import { appendEvent } from "../src/schema/append.ts";
import {
  SCHEMA_VERSION,
  validateCanonicalEvent,
  type CanonicalEvent,
} from "../src/schema/events.ts";
import { parseJsonl } from "../src/schema/jsonl.ts";

const WINDOW = DEFAULT_HEARTBEAT_WINDOW_MS; // 5 min

async function makeRunDir(
  runId: string,
  seedEvents: CanonicalEvent[] = [],
): Promise<{ runDir: string; eventsPath: string }> {
  const runDir = await mkdtemp(join(tmpdir(), `agenteval-reaper-${runId}-`));
  const eventsPath = join(runDir, "events.jsonl");
  for (const ev of seedEvents) {
    await appendEvent(eventsPath, ev);
  }
  // Ensure file exists even with zero seed events.
  if (seedEvents.length === 0) {
    await writeFile(eventsPath, "", "utf8");
  }
  return { runDir, eventsPath };
}

function startEvent(runId: string, seq = 0): CanonicalEvent {
  return {
    v: SCHEMA_VERSION,
    runId,
    seq,
    ts: "2026-01-01T00:00:00.000Z",
    type: "run.start",
    agent: "pi",
    model: "test-model",
    provider: "test",
    workspace: { source: "empty" },
    params: {},
  };
}

describe("CrashReaper", () => {
  it("reaps an in-flight run past the heartbeat window", async () => {
    const runId = "stale-run-1";
    const { eventsPath } = await makeRunDir(runId, [startEvent(runId)]);

    const registry = new Map<string, InFlightRun>();
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const lastHeartbeatAt = startedAt + 10_000; // 10s into the run
    registry.set(runId, {
      runId,
      eventsPath,
      lastHeartbeatAt,
      startedAt,
      status: "running",
    });

    const reaper = new CrashReaper({
      listInFlight: () => [...registry.values()],
    });

    // now is lastHeartbeat + window + 1ms → stale
    const now = lastHeartbeatAt + WINDOW + 1;
    const reaped = await reaper.reap(now);

    expect(reaped).toEqual([runId]);

    const text = await readFile(eventsPath, "utf8");
    const events = parseJsonl(text) as CanonicalEvent[];
    // seed run.start + error + run.end
    expect(events.length).toBe(3);

    const errorEv = events.find((e) => e.type === "error");
    const endEv = events.find((e) => e.type === "run.end");
    expect(errorEv).toBeDefined();
    expect(endEv).toBeDefined();

    if (errorEv?.type === "error") {
      expect(errorEv.fatal).toBe(true);
      expect(errorEv.message.toLowerCase()).toMatch(/stale run reaped/);
      expect(errorEv.seq).toBe(1);
      expect(validateCanonicalEvent(errorEv).type).toBe("error");
    }
    if (endEv?.type === "run.end") {
      expect(endEv.status).toBe("failed");
      expect(endEv.seq).toBe(2);
      expect(endEv.durationMs).toBeGreaterThan(0);
      expect(validateCanonicalEvent(endEv).type).toBe("run.end");
    }
  });

  it("leaves a run with a fresh heartbeat untouched", async () => {
    const runId = "fresh-run-1";
    const { eventsPath } = await makeRunDir(runId, [startEvent(runId)]);
    const seedText = await readFile(eventsPath, "utf8");

    const now = Date.parse("2026-01-01T00:05:00.000Z");
    const registry: InFlightRun[] = [
      {
        runId,
        eventsPath,
        lastHeartbeatAt: now - 1_000, // 1s ago — well within 5min
        startedAt: now - 60_000,
        status: "running",
      },
    ];

    const reaper = createCrashReaper(() => registry);
    const reaped = await reaper.reap(now);

    expect(reaped).toEqual([]);
    const after = await readFile(eventsPath, "utf8");
    expect(after).toBe(seedText);
  });

  it("reaps only the stale runs when mixed with fresh ones", async () => {
    const staleId = "stale-2";
    const freshId = "fresh-2";
    const stale = await makeRunDir(staleId, [startEvent(staleId)]);
    const fresh = await makeRunDir(freshId, [startEvent(freshId)]);

    const now = 1_700_000_000_000;
    const runs: InFlightRun[] = [
      {
        runId: staleId,
        eventsPath: stale.eventsPath,
        lastHeartbeatAt: now - WINDOW - 5_000,
        startedAt: now - WINDOW - 60_000,
      },
      {
        runId: freshId,
        eventsPath: fresh.eventsPath,
        lastHeartbeatAt: now - 30_000,
        startedAt: now - 60_000,
      },
    ];

    const reapedIds: string[] = [];
    const reaper = new CrashReaper({
      listInFlight: () => runs,
    });
    const reaped = await reaper.reap(now, {
      onReaped: (r) => {
        reapedIds.push(r.runId);
      },
    });

    expect(reaped).toEqual([staleId]);
    expect(reapedIds).toEqual([staleId]);

    const staleEvents = parseJsonl(
      await readFile(stale.eventsPath, "utf8"),
    ) as CanonicalEvent[];
    expect(staleEvents.some((e) => e.type === "run.end")).toBe(true);

    const freshEvents = parseJsonl(
      await readFile(fresh.eventsPath, "utf8"),
    ) as CanonicalEvent[];
    expect(freshEvents).toHaveLength(1);
    expect(freshEvents[0]?.type).toBe("run.start");
  });

  it("continues seq from existing events", async () => {
    const runId = "seq-run";
    const seed: CanonicalEvent[] = [
      startEvent(runId, 0),
      {
        v: SCHEMA_VERSION,
        runId,
        seq: 5,
        ts: "2026-01-01T00:00:01.000Z",
        type: "log",
        level: "info",
        message: "heartbeat",
      },
    ];
    const { eventsPath } = await makeRunDir(runId, seed);
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    const reaper = createCrashReaper(() => [
      {
        runId,
        eventsPath,
        lastHeartbeatAt: now - WINDOW - 1,
        startedAt: now - WINDOW - 10_000,
      },
    ]);
    await reaper.reap(now);

    const events = parseJsonl(
      await readFile(eventsPath, "utf8"),
    ) as CanonicalEvent[];
    const errorEv = events.find((e) => e.type === "error");
    const endEv = events.find((e) => e.type === "run.end");
    expect(errorEv?.seq).toBe(6);
    expect(endEv?.seq).toBe(7);
  });

  it("respects a custom windowMs", async () => {
    const runId = "custom-window";
    const { eventsPath } = await makeRunDir(runId, [startEvent(runId)]);
    const now = 1_000_000;
    const reaper = createCrashReaper(
      () => [
        {
          runId,
          eventsPath,
          lastHeartbeatAt: now - 2_000, // 2s old
          startedAt: now - 5_000,
        },
      ],
      WINDOW,
    );

    // Default window (5min) → not stale
    expect(await reaper.reap(now)).toEqual([]);
    // Custom 1s window → stale
    expect(await reaper.reap(now, { windowMs: 1_000 })).toEqual([runId]);
  });

  // Idempotency: a stale-registry run that ALREADY finalized (its JSONL has a
  // terminal run.end) must not get a second terminal event. The reaper still
  // reports the runId (so onReaped can clean the stale registry) but writes
  // nothing — two run.ends would conflict on status history.
  it("does not append a second terminal event when one already exists", async () => {
    const runId = "already-terminal";
    const seed: CanonicalEvent[] = [
      startEvent(runId, 0),
      {
        v: SCHEMA_VERSION,
        runId,
        seq: 9,
        ts: "2026-01-01T00:00:30.000Z",
        type: "run.end",
        status: "completed",
        durationMs: 30_000,
      },
    ];
    const { eventsPath } = await makeRunDir(runId, seed);
    const beforeReap = await readFile(eventsPath, "utf8");

    const now = 1_000_000;
    let onReapedCalled = false;
    const reaper = new CrashReaper({
      listInFlight: () => [
        {
          runId,
          eventsPath,
          lastHeartbeatAt: now - WINDOW - 1, // stale
          startedAt: now - WINDOW - 60_000,
          status: "running", // registry still says running (stale)
        },
      ],
      defaultWindowMs: WINDOW,
    });

    const reaped = await reaper.reap(now, {
      onReaped: () => {
        onReapedCalled = true;
      },
    });

    // Still reported as reaped so the registry entry gets cleaned...
    expect(reaped).toEqual([runId]);
    expect(onReapedCalled).toBe(true);
    // ...but the JSONL is byte-for-byte unchanged — no duplicate run.end.
    const afterReap = await readFile(eventsPath, "utf8");
    expect(afterReap).toBe(beforeReap);

    const events = parseJsonl(afterReap) as CanonicalEvent[];
    const ends = events.filter((e) => e.type === "run.end");
    expect(ends).toHaveLength(1);
  });
});

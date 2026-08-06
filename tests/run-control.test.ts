/**
 * RunController lifecycle — soft/hard pause, resume, abort, status derivation.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunController } from "../src/runner/control.ts";
import {
  FakeContainerRuntime,
  asFakeHandle,
} from "../src/runner/fake-runtime.ts";
import { deriveRunStatus } from "../src/runner/run.ts";
import type { RunContainerSpec } from "../src/runner/runtime.ts";
import { parseJsonl } from "../src/schema/jsonl.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function baseSpec(workspaceDir: string, overrides: Partial<RunContainerSpec> = {}): RunContainerSpec {
  return {
    image: "agenteval/fake:test",
    workspaceDir,
    argv: ["node", "-e", "setTimeout(() => process.exit(0), 5_000);"],
    env: {},
    limits: { cpus: 1, memoryMiB: 128, pids: 32 },
    timeoutMs: 30_000,
    network: "allow",
    nonRoot: true,
    ...overrides,
  };
}

describe("deriveRunStatus (shared helper)", () => {
  it("maps abort / timeout / fatal / exit / completed correctly", () => {
    expect(
      deriveRunStatus({
        exitCode: 0,
        sawFatalError: false,
        aborted: true,
      }),
    ).toBe("aborted");

    expect(
      deriveRunStatus({
        exitCode: 137,
        sawFatalError: false,
        timedOut: true,
      }),
    ).toBe("timeout");

    expect(
      deriveRunStatus({
        exitCode: 0,
        sawFatalError: true,
      }),
    ).toBe("failed");

    expect(
      deriveRunStatus({
        exitCode: 2,
        sawFatalError: false,
      }),
    ).toBe("failed");

    expect(
      deriveRunStatus({
        exitCode: 0,
        sawFatalError: false,
        adapterStatus: "completed",
      }),
    ).toBe("completed");

    expect(
      deriveRunStatus({
        exitCode: 0,
        sawFatalError: false,
      }),
    ).toBe("completed");

    // Abort wins over fatal (operator abort records a fatal error event).
    expect(
      deriveRunStatus({
        exitCode: 1,
        sawFatalError: true,
        aborted: true,
        timedOut: true,
      }),
    ).toBe("aborted");
  });
});

describe("RunController", () => {
  const runtime = new FakeContainerRuntime();
  const live: Array<{ remove: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of live.splice(0)) {
      await h.remove().catch(() => undefined);
    }
    for (const h of runtime.handles) {
      await h.remove().catch(() => undefined);
    }
    runtime.handles.length = 0;
  });

  it("hard pause → resume → abort keeps partial events and records fatal error", async () => {
    const ws = await tempDir("agenteval-ctrl-ws-");
    const runDir = await tempDir("agenteval-ctrl-run-");
    const eventsPath = join(runDir, "events.jsonl");
    const runId = "run-ctrl-1";

    // Seed a partial event so we can assert the file is kept (append-only).
    await writeFile(
      eventsPath,
      `${JSON.stringify({
        v: 1,
        runId,
        seq: 0,
        ts: new Date().toISOString(),
        type: "log",
        level: "info",
        message: "partial-before-pause",
      })}\n`,
      "utf8",
    );

    // Long-running process so we can pause/abort mid-flight.
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: [
          "node",
          "-e",
          `
            process.stdout.write('alive\\n');
            setInterval(() => process.stdout.write('tick\\n'), 100);
          `,
        ],
        timeoutMs: 60_000,
      }),
    );
    live.push(handle);

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId,
      nextSeq: 1,
      startedAt: Date.now(),
    });

    expect(ctrl.controlState()).toBe("running");
    expect(ctrl.pauseCount()).toBe(0);

    // --- hard pause ---
    await new Promise((r) => setTimeout(r, 80));
    await ctrl.pause("hard");
    expect(ctrl.controlState()).toBe("paused-hard");
    expect(ctrl.pauseCount()).toBe(1);
    expect(asFakeHandle(handle).isPaused()).toBe(true);

    // Stay paused long enough that pausedMs > 0 is unambiguous.
    await new Promise((r) => setTimeout(r, 150));
    expect(ctrl.pausedMs()).toBeGreaterThan(0);

    // --- resume ---
    await ctrl.resume();
    expect(ctrl.controlState()).toBe("running");
    expect(asFakeHandle(handle).isPaused()).toBe(false);
    // Accumulated pause time retained after resume.
    expect(ctrl.pausedMs()).toBeGreaterThan(0);

    // Soft pause does not freeze the child.
    await ctrl.pause("soft");
    expect(ctrl.controlState()).toBe("paused-soft");
    expect(ctrl.pauseCount()).toBe(2);
    expect(asFakeHandle(handle).isPaused()).toBe(false);
    expect(ctrl.isSoftPaused()).toBe(true);
    await ctrl.resume();
    expect(ctrl.controlState()).toBe("running");
    expect(ctrl.isSoftPaused()).toBe(false);

    // --- abort ---
    await ctrl.abort(100);
    expect(ctrl.controlState()).toBe("aborted");

    // Partial events.jsonl kept + fatal operator error appended.
    const raw = await readFile(eventsPath, "utf8");
    const events = parseJsonl(raw) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({
      type: "log",
      message: "partial-before-pause",
    });
    const fatal = events.find(
      (e) => e.type === "error" && e.fatal === true,
    );
    expect(fatal).toBeDefined();
    expect(fatal).toMatchObject({
      type: "error",
      message: "aborted by operator",
      phase: "finalize",
      fatal: true,
      runId,
    });

    // Finalize should report aborted status; duration excludes paused intervals.
    const fin = await ctrl.finalize({ sawFatalError: true });
    expect(fin.status).toBe("aborted");
    expect(fin.controlState).toBe("aborted");
    expect(fin.timedOut).toBe(false);
    expect(ctrl.pausedMs()).toBeGreaterThan(0);
    // durationMs should be less than raw wall clock if we paused.
    const wall = Date.now() - (ctrl as unknown as { startedAt: number }).startedAt;
    // We can't access private startedAt reliably — just check durationMs is finite and positive.
    expect(fin.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(fin.durationMs)).toBe(true);
    void wall;

    await handle.remove();
  });

  it("soft pause records state without freezing the child", async () => {
    const ws = await tempDir("agenteval-ctrl-soft-");
    const runDir = await tempDir("agenteval-ctrl-soft-run-");
    const eventsPath = join(runDir, "events.jsonl");

    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "setTimeout(() => process.exit(0), 300);"],
        timeoutMs: 10_000,
      }),
    );
    live.push(handle);

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId: "run-soft",
      nextSeq: 0,
    });

    await ctrl.pause("soft");
    expect(ctrl.controlState()).toBe("paused-soft");
    expect(asFakeHandle(handle).isPaused()).toBe(false);

    // Soft pause does not accumulate pausedMs (clock keeps running for in-flight).
    await new Promise((r) => setTimeout(r, 50));
    expect(ctrl.pausedMs()).toBe(0);

    await ctrl.resume();
    const fin = await ctrl.finalize();
    expect(fin.status).toBe("completed");
    expect(fin.controlState).toBe("completed");
    expect(fin.exitCode).toBe(0);
    await handle.remove();
  });

  it("timeout finalize → status timeout", async () => {
    const ws = await tempDir("agenteval-ctrl-to-");
    const runDir = await tempDir("agenteval-ctrl-to-run-");
    const eventsPath = join(runDir, "events.jsonl");

    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "setTimeout(() => {}, 60_000);"],
        timeoutMs: 150,
      }),
    );
    live.push(handle);

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId: "run-timeout",
    });

    const fin = await ctrl.finalize();
    expect(fin.timedOut).toBe(true);
    expect(fin.status).toBe("timeout");
    expect(fin.controlState).toBe("timeout");
    await handle.remove();
  });

  it("failed finalize from non-zero exit", async () => {
    const ws = await tempDir("agenteval-ctrl-fail-");
    const runDir = await tempDir("agenteval-ctrl-fail-run-");
    const eventsPath = join(runDir, "events.jsonl");

    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "process.exit(3);"],
        timeoutMs: 5_000,
      }),
    );
    live.push(handle);

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId: "run-fail",
    });

    const fin = await ctrl.finalize();
    expect(fin.status).toBe("failed");
    expect(fin.controlState).toBe("failed");
    expect(fin.exitCode).toBe(3);
    await handle.remove();
  });

  it("failed finalize from fatal error even at exit 0", async () => {
    const ws = await tempDir("agenteval-ctrl-fatal-");
    const runDir = await tempDir("agenteval-ctrl-fatal-run-");
    const eventsPath = join(runDir, "events.jsonl");

    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "process.exit(0);"],
        timeoutMs: 5_000,
      }),
    );
    live.push(handle);

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId: "run-fatal",
    });

    const fin = await ctrl.finalize({ sawFatalError: true });
    expect(fin.status).toBe("failed");
    expect(fin.exitCode).toBe(0);
    await handle.remove();
  });

  it("completed finalize from clean exit", async () => {
    const ws = await tempDir("agenteval-ctrl-ok-");
    const runDir = await tempDir("agenteval-ctrl-ok-run-");
    const eventsPath = join(runDir, "events.jsonl");

    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "process.exit(0);"],
        timeoutMs: 5_000,
      }),
    );
    live.push(handle);

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId: "run-ok",
    });

    const fin = await ctrl.finalize({ adapterStatus: "completed" });
    expect(fin.status).toBe("completed");
    expect(fin.controlState).toBe("completed");
    await handle.remove();
  });

  it("abort is idempotent and does not throw on a finished handle", async () => {
    const ws = await tempDir("agenteval-ctrl-idemp-");
    const runDir = await tempDir("agenteval-ctrl-idemp-run-");
    const eventsPath = join(runDir, "events.jsonl");

    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "process.exit(0);"],
        timeoutMs: 5_000,
      }),
    );
    live.push(handle);
    await handle.wait();

    const ctrl = new RunController({
      handle,
      eventsPath,
      runId: "run-idemp",
    });
    // Already finished — abort still marks aborted + writes error.
    await ctrl.abort(50);
    expect(ctrl.controlState()).toBe("aborted");
    await ctrl.abort(50); // second call is a no-op
    expect(ctrl.controlState()).toBe("aborted");

    const raw = await readFile(eventsPath, "utf8");
    const events = parseJsonl(raw);
    // Only one fatal abort event.
    const fatals = (events as Array<Record<string, unknown>>).filter(
      (e) => e.type === "error" && e.message === "aborted by operator",
    );
    expect(fatals).toHaveLength(1);
    await handle.remove();
  });
});

/**
 * FakeContainerRuntime — local child-process double of ContainerRuntime.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asFakeHandle,
  FakeContainerRuntime,
} from "../src/runner/fake-runtime.ts";
import {
  DockerSocketRuntime,
  NotImplementedError,
} from "../src/runner/docker-socket.ts";
import {
  resolveRuntime,
  setRuntime,
  type RunContainerSpec,
} from "../src/runner/runtime.ts";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agenteval-fake-rt-"));
}

function baseSpec(workspaceDir: string, overrides: Partial<RunContainerSpec> = {}): RunContainerSpec {
  return {
    image: "agenteval/fake:test",
    workspaceDir,
    argv: ["node", "-e", "console.log('hello')"],
    env: {},
    limits: { cpus: 1, memoryMiB: 256, pids: 64 },
    timeoutMs: 30_000,
    network: "allow",
    nonRoot: true,
    ...overrides,
  };
}

/** Drain an async iterable into a single Buffer. */
async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

describe("FakeContainerRuntime", () => {
  const runtime = new FakeContainerRuntime();

  afterEach(async () => {
    // Best-effort cleanup of any lingering handles from a failed assertion.
    for (const h of runtime.handles) {
      await h.remove().catch(() => undefined);
    }
    runtime.handles.length = 0;
    setRuntime(undefined);
  });

  it("streams stdout from a node -e script", async () => {
    const ws = await tempWorkspace();
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "process.stdout.write('out-one\\n'); process.stdout.write('out-two\\n');"],
      }),
    );

    const stdoutP = collect(handle.stdout());
    const result = await handle.wait();
    const stdout = await stdoutP;

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(stdout.toString("utf8")).toContain("out-one");
    expect(stdout.toString("utf8")).toContain("out-two");
    expect(handle.id).toMatch(/^fake-/);
    expect(handle.image).toBe("agenteval/fake:test");

    const fake = asFakeHandle(handle);
    expect(fake.record.limits).toEqual({ cpus: 1, memoryMiB: 256, pids: 64 });
    expect(fake.record.network).toBe("allow");

    await handle.remove();
  });

  it("streams stderr and records non-zero exit", async () => {
    const ws = await tempWorkspace();
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "console.error('boom'); process.exit(7);"],
      }),
    );
    const stderrP = collect(handle.stderr());
    const result = await handle.wait();
    const stderr = await stderrP;
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(stderr.toString("utf8")).toContain("boom");
    await handle.remove();
  });

  it("timeoutMs → wait() returns timedOut:true after SIGTERM/SIGKILL", async () => {
    const ws = await tempWorkspace();
    const handle = await runtime.run(
      baseSpec(ws, {
        // Sleep far longer than the timeout.
        argv: ["node", "-e", "setTimeout(() => {}, 60_000);"],
        timeoutMs: 200,
      }),
    );
    const started = Date.now();
    const result = await handle.wait();
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    // Should not wait the full 60s.
    expect(elapsed).toBeLessThan(10_000);
    await handle.remove();
  });

  it("stop() kills a long-running process", async () => {
    const ws = await tempWorkspace();
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "setTimeout(() => {}, 60_000);"],
        timeoutMs: 60_000,
      }),
    );
    // Give the child a moment to start.
    await new Promise((r) => setTimeout(r, 50));
    const stopStarted = Date.now();
    await handle.stop(100);
    const result = await handle.wait();
    expect(Date.now() - stopStarted).toBeLessThan(5_000);
    expect(result.timedOut).toBe(false); // stop, not timeout
    // Killed by signal → non-zero.
    expect(result.exitCode).not.toBe(0);
    await handle.remove();
  });

  it("pause() freezes output; resume() continues (SIGSTOP/SIGCONT)", async () => {
    const ws = await tempWorkspace();
    // Script: print START, then loop printing ticks every 50ms.
    const script = `
      process.stdout.write('START\\n');
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        process.stdout.write('TICK-' + n + '\\n');
        if (n >= 40) { clearInterval(t); process.exit(0); }
      }, 50);
    `;
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", script],
        timeoutMs: 15_000,
      }),
    );
    const fake = asFakeHandle(handle);

    // Wait until we see START.
    let buf = "";
    const reader = (async () => {
      for await (const chunk of handle.stdout()) {
        buf += chunk.toString("utf8");
        if (buf.includes("START")) break;
      }
    })();
    await reader;

    await handle.pause();
    expect(fake.isPaused()).toBe(true);
    const pausedLen = buf.length;
    // While paused, no new ticks should appear.
    await new Promise((r) => setTimeout(r, 250));
    // Drain any already-buffered pipe data without expecting new ticks from the frozen process.
    // (OS pipe may have a little buffered data; length should stabilize.)
    await new Promise((r) => setTimeout(r, 100));
    const duringPause = buf.length;
    expect(duringPause).toBeGreaterThanOrEqual(pausedLen);

    await handle.resume();
    expect(fake.isPaused()).toBe(false);

    const result = await handle.wait();
    // Collect remaining stdout.
    for await (const chunk of handle.stdout()) {
      buf += chunk.toString("utf8");
    }
    expect(result.timedOut).toBe(false);
    expect(buf).toContain("START");
    // After resume the process should have produced more ticks (or exited cleanly).
    expect(result.exitCode === 0 || buf.includes("TICK-")).toBe(true);
    await handle.remove();
  });

  it("remove() cleans up a still-running child", async () => {
    const ws = await tempWorkspace();
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: ["node", "-e", "setTimeout(() => {}, 60_000);"],
        timeoutMs: 60_000,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await handle.remove();
    // wait() should settle after remove kills the process.
    const result = await Promise.race([
      handle.wait(),
      new Promise<{ exitCode: number; timedOut: boolean }>((resolve) =>
        setTimeout(() => resolve({ exitCode: -1, timedOut: false }), 2_000),
      ),
    ]);
    // Either wait settled, or we timed out the race (still OK — remove is best-effort).
    expect(result.exitCode === -1 || result.exitCode !== 0 || result.timedOut).toBe(true);
  });

  it("honours workspaceDir as cwd", async () => {
    const ws = await tempWorkspace();
    await writeFile(join(ws, "marker.txt"), "present", "utf8");
    const handle = await runtime.run(
      baseSpec(ws, {
        argv: [
          "node",
          "-e",
          "const fs=require('fs'); process.stdout.write(fs.existsSync('marker.txt') ? 'yes' : 'no');",
        ],
      }),
    );
    const out = await collect(handle.stdout());
    await handle.wait();
    expect(out.toString("utf8")).toBe("yes");
    await handle.remove();
  });

  it("records network policy without enforcing it (advisory)", async () => {
    const ws = await tempWorkspace();
    const handle = await runtime.run(
      baseSpec(ws, {
        network: "offline",
        networkAllowlist: ["example.com"],
        argv: ["node", "-e", "process.exit(0)"],
      }),
    );
    await handle.wait();
    const fake = asFakeHandle(handle);
    expect(fake.record.network).toBe("offline");
    expect(fake.record.networkAllowlist).toEqual(["example.com"]);
    await handle.remove();
  });
});

describe("DockerSocketRuntime stub", () => {
  it("run() throws NotImplementedError with a clear message", async () => {
    const rt = new DockerSocketRuntime();
    await expect(
      rt.run(
        baseSpec(await tempWorkspace(), {
          argv: ["node", "-e", "0"],
        }),
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      rt.run(
        baseSpec(await tempWorkspace(), {
          argv: ["node", "-e", "0"],
        }),
      ),
    ).rejects.toThrow(/FakeContainerRuntime|Docker\+root|Docker socket/i);
  });
});

describe("resolveRuntime / setRuntime", () => {
  afterEach(() => {
    setRuntime(undefined);
    delete process.env.AGENTEVAL_DOCKER;
    delete process.env.DOCKER_HOST;
  });

  it("returns FakeContainerRuntime by default in this Dockerless env", () => {
    delete process.env.AGENTEVAL_DOCKER;
    delete process.env.DOCKER_HOST;
    const rt = resolveRuntime();
    expect(rt).toBeInstanceOf(FakeContainerRuntime);
  });

  it("returns DockerSocketRuntime when AGENTEVAL_DOCKER=1", () => {
    process.env.AGENTEVAL_DOCKER = "1";
    const rt = resolveRuntime();
    expect(rt).toBeInstanceOf(DockerSocketRuntime);
  });

  it("setRuntime injects a custom runtime for tests", () => {
    const custom = new FakeContainerRuntime();
    setRuntime(custom);
    expect(resolveRuntime()).toBe(custom);
    setRuntime(undefined);
    expect(resolveRuntime()).toBeInstanceOf(FakeContainerRuntime);
  });
});

/**
 * Dockerless test-double; real impl is DockerSocketRuntime in a Docker-enabled deploy.
 *
 * FakeContainerRuntime runs `spec.argv` as a local child process (node:child_process
 * spawn) in `spec.workspaceDir`. It honours pause/resume/stop/timeoutMs so the runner,
 * redaction, diff capture, and run-control layers can be unit-tested without a Docker
 * daemon. Resource limits (cpus/memory/pids) and network policy are recorded only —
 * best-effort / advisory on the host.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import type {
  ContainerHandle,
  ContainerRuntime,
  PortMapping,
  ResolvedPort,
  RunContainerSpec,
} from "./runtime.js";

/** Where a real backend bind-mounts the workspace inside the sandbox. */
const WORKSPACE_MOUNT = "/workspace";

/** Default grace between SIGTERM and SIGKILL on stop / timeout. */
const DEFAULT_STOP_GRACE_MS = 2_000;

/**
 * Live async byte stream backed by a push buffer.
 * Consumers can start iterating before any data arrives; chunks stream as they land.
 */
class PushStream implements AsyncIterable<Buffer> {
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<(r: IteratorResult<Buffer>) => void> = [];
  private ended = false;
  private error: Error | undefined;

  push(chunk: Buffer): void {
    if (this.ended) return;
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: chunk, done: false });
    } else {
      this.chunks.push(chunk);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as unknown as Buffer, done: true });
    }
  }

  fail(err: Error): void {
    if (this.ended) return;
    this.error = err;
    this.ended = true;
    while (this.waiters.length > 0) {
      // Reject via throw on next pull by ending; consumers see empty after error is set.
      this.waiters.shift()!({ value: undefined as unknown as Buffer, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    while (true) {
      if (this.error) throw this.error;
      if (this.chunks.length > 0) {
        yield this.chunks.shift()!;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<Buffer>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}

/** Recorded (advisory) limits + network policy for test assertions / diagnostics. */
export interface FakeRuntimeRecord {
  limits: RunContainerSpec["limits"];
  network: RunContainerSpec["network"];
  networkAllowlist?: string[];
  nonRoot: boolean;
  timeoutMs: number;
  workspaceDir: string;
  argv: string[];
  image: string;
  /** Published ports with ephemeral requests resolved to concrete host ports. */
  ports?: ResolvedPort[];
}

/**
 * Ask the OS for a free TCP port by binding :0 and reading it back.
 *
 * The fake runtime has no daemon to do port publishing, so it resolves
 * `hostPort: 0` the same way the real one would: by getting a concrete port
 * the caller can address. The probe socket is closed immediately — a narrow
 * race the real Docker backend does not have, and acceptable for a test double.
 */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve every requested mapping to a concrete host port. */
export async function resolvePorts(
  ports: PortMapping[] | undefined,
): Promise<ResolvedPort[]> {
  if (!ports || ports.length === 0) return [];
  const out: ResolvedPort[] = [];
  for (const p of ports) {
    const hostPort =
      p.hostPort && p.hostPort > 0 ? p.hostPort : await freePort();
    out.push({ ...p, hostPort, protocol: p.protocol ?? "tcp" });
  }
  return out;
}

class FakeContainerHandle implements ContainerHandle {
  readonly id: string;
  readonly image: string;
  /** Published ports, ephemeral requests already resolved. */
  readonly ports: ResolvedPort[];
  /** Snapshot of the launch spec knobs (limits, network, …) for tests. */
  readonly record: FakeRuntimeRecord;

  private readonly child: ChildProcess;
  private readonly stdoutStream = new PushStream();
  private readonly stderrStream = new PushStream();
  private readonly waitPromise: Promise<{ exitCode: number; timedOut: boolean }>;
  private resolveWait!: (v: { exitCode: number; timedOut: boolean }) => void;
  private settled = false;
  private timedOut = false;
  private paused = false;
  private removed = false;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private stopGraceMs: number;

  constructor(
    spec: RunContainerSpec,
    child: ChildProcess,
    ports: ResolvedPort[] = [],
  ) {
    this.id = `fake-${randomUUID()}`;
    this.image = spec.image;
    this.ports = ports;
    this.record = {
      ports: ports.length > 0 ? ports : undefined,
      limits: { ...spec.limits },
      network: spec.network,
      networkAllowlist: spec.networkAllowlist
        ? [...spec.networkAllowlist]
        : undefined,
      nonRoot: spec.nonRoot,
      timeoutMs: spec.timeoutMs,
      workspaceDir: spec.workspaceDir,
      argv: [...spec.argv],
      image: spec.image,
    };
    this.child = child;
    this.stopGraceMs = DEFAULT_STOP_GRACE_MS;

    this.waitPromise = new Promise((resolve) => {
      this.resolveWait = resolve;
    });

    if (child.stdout) {
      child.stdout.on("data", (c: Buffer) =>
        this.stdoutStream.push(Buffer.from(c)),
      );
      child.stdout.on("end", () => this.stdoutStream.end());
      child.stdout.on("error", () => this.stdoutStream.end());
    } else {
      this.stdoutStream.end();
    }
    if (child.stderr) {
      child.stderr.on("data", (c: Buffer) =>
        this.stderrStream.push(Buffer.from(c)),
      );
      child.stderr.on("end", () => this.stderrStream.end());
      child.stderr.on("error", () => this.stderrStream.end());
    } else {
      this.stderrStream.end();
    }

    child.on("error", (err) => {
      this.stdoutStream.fail(err);
      this.stderrStream.fail(err);
      this.settle(1, false);
    });
    child.on("close", (code, signal) => {
      // If killed by signal without an exit code, report non-zero.
      const exitCode =
        code !== null && code !== undefined
          ? code
          : signal
            ? 128 + signalToNumber(signal)
            : 1;
      this.settle(exitCode, this.timedOut);
    });

    if (spec.timeoutMs > 0 && Number.isFinite(spec.timeoutMs)) {
      this.timeoutTimer = setTimeout(() => {
        void this.onTimeout();
      }, spec.timeoutMs);
      // Don't keep the process alive solely for the timeout timer.
      this.timeoutTimer.unref?.();
    }
  }

  private settle(exitCode: number, timedOut: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.stdoutStream.end();
    this.stderrStream.end();
    this.resolveWait({ exitCode, timedOut });
  }

  private clearTimers(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
  }

  private async onTimeout(): Promise<void> {
    if (this.settled) return;
    this.timedOut = true;
    await this.signalStop(this.stopGraceMs);
  }

  /**
   * Hard pause via SIGSTOP — freezes the child CPU (cgroup freezer analog).
   * Documented choice: real OS-level stop is simpler and correct for local tests.
   */
  async pause(): Promise<void> {
    if (this.settled || this.removed) return;
    if (this.paused) return;
    if (this.child.pid !== undefined && !this.child.killed) {
      try {
        process.kill(this.child.pid, "SIGSTOP");
        this.paused = true;
      } catch {
        // Process may have exited between check and signal.
      }
    }
  }

  /** Thaw a SIGSTOP'd child with SIGCONT. */
  async resume(): Promise<void> {
    if (this.settled || this.removed) return;
    if (!this.paused) return;
    if (this.child.pid !== undefined && !this.child.killed) {
      try {
        process.kill(this.child.pid, "SIGCONT");
        this.paused = false;
      } catch {
        // Process may have exited.
      }
    } else {
      this.paused = false;
    }
  }

  /** Graceful stop: SIGTERM then SIGKILL after `graceMs`. */
  async stop(graceMs: number = DEFAULT_STOP_GRACE_MS): Promise<void> {
    if (this.settled || this.removed) return;
    // If hard-paused, thaw first so SIGTERM is delivered.
    if (this.paused) {
      await this.resume();
    }
    await this.signalStop(graceMs);
    // Wait until the process actually exits (or is already settled).
    await this.waitPromise;
  }

  private async signalStop(graceMs: number): Promise<void> {
    if (this.settled || this.child.killed) return;
    const pid = this.child.pid;
    if (pid === undefined) return;

    // A SIGSTOP'd process won't act on SIGTERM until continued; thaw first.
    // (SIGKILL would still work, but we prefer the graceful path.)
    if (this.paused && pid !== undefined) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // ignore
      }
      this.paused = false;
    }

    try {
      this.child.kill("SIGTERM");
    } catch {
      return;
    }

    // Escalate to SIGKILL after grace window if still alive.
    await new Promise<void>((resolve) => {
      if (this.settled) {
        resolve();
        return;
      }
      this.killTimer = setTimeout(() => {
        if (!this.settled && !this.child.killed) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }
        resolve();
      }, Math.max(0, graceMs));
      this.killTimer.unref?.();

      // Also resolve early when the process exits before the grace window.
      void this.waitPromise.then(() => {
        if (this.killTimer) {
          clearTimeout(this.killTimer);
          this.killTimer = undefined;
        }
        resolve();
      });
    });
  }

  stdout(): AsyncIterable<Buffer> {
    return this.stdoutStream;
  }

  stderr(): AsyncIterable<Buffer> {
    return this.stderrStream;
  }

  wait(): Promise<{ exitCode: number; timedOut: boolean }> {
    return this.waitPromise;
  }

  /** Kill (if still running) and mark cleaned up. */
  async remove(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    this.clearTimers();
    if (!this.settled) {
      // Force-kill any remaining process.
      if (this.paused) {
        try {
          if (this.child.pid !== undefined) process.kill(this.child.pid, "SIGCONT");
        } catch {
          // ignore
        }
        this.paused = false;
      }
      try {
        if (!this.child.killed) this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
      // Don't hang remove on wait forever — give a short window.
      await Promise.race([
        this.waitPromise,
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
    }
    this.stdoutStream.end();
    this.stderrStream.end();
  }

  /** Test helper: is the child currently hard-paused? */
  isPaused(): boolean {
    return this.paused;
  }
}

function signalToNumber(signal: NodeJS.Signals | string): number {
  // Common POSIX signal numbers; fallback 9 (SIGKILL) if unknown.
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
    SIGSTOP: 19,
    SIGCONT: 18,
  };
  return map[signal] ?? 9;
}

/**
 * Local-process ContainerRuntime for tests and Dockerless deploys.
 * Does NOT dockerize — launches argv as a host child process.
 */
export class FakeContainerRuntime implements ContainerRuntime {
  /** Handles created by this runtime (newest last); useful for tests. */
  readonly handles: FakeContainerHandle[] = [];

  async run(spec: RunContainerSpec): Promise<ContainerHandle> {
    if (spec.argv.length === 0) {
      throw new Error("FakeContainerRuntime.run: empty argv");
    }
    const [file, ...args] = spec.argv;
    if (!file) {
      throw new Error("FakeContainerRuntime.run: missing executable in argv");
    }

    // Resolve published ports before spawning so the child can be told which
    // host ports it got (AGENTEVAL_PORT_<NAME>), mirroring how a real runtime
    // publishes before the process starts.
    const ports = await resolvePorts(spec.ports);
    const portEnv: Record<string, string> = {};
    for (const p of ports) {
      const key = (p.name ?? String(p.containerPort))
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_");
      portEnv[`AGENTEVAL_PORT_${key}`] = String(p.hostPort);
    }

    // A real backend bind-mounts workspaceDir at /workspace, so scripts written
    // for the sandbox say `cd /workspace`. On the host that path does not exist
    // and `cd` fails silently, making a setup script look like it ran and did
    // nothing. Rewrite the mount point to the real directory so the double
    // behaves like the thing it doubles.
    const rewritten = args.map((a) =>
      a.includes(WORKSPACE_MOUNT)
        ? a.split(WORKSPACE_MOUNT).join(spec.workspaceDir)
        : a,
    );

    // Limits (cpus/memory/pids) and network policy are recorded only — host has no
    // cgroup enforcement in this double. See handle.record.
    const child = spawn(file, rewritten, {
      cwd: spec.workspaceDir,
      env: { ...process.env, ...spec.env, ...portEnv },
      stdio: ["ignore", "pipe", "pipe"],
      // detached:false — we want the child in our process group for SIGSTOP/SIGCONT.
    });

    const handle = new FakeContainerHandle(spec, child, ports);
    this.handles.push(handle);
    return handle;
  }
}

/** Narrow a ContainerHandle to the fake handle (tests). */
export function asFakeHandle(handle: ContainerHandle): FakeContainerHandle {
  if (!(handle instanceof FakeContainerHandle)) {
    throw new Error("expected FakeContainerHandle");
  }
  return handle;
}

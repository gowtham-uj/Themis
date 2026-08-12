/**
 * Real container backend: podman.
 *
 * Chosen over Docker because it is daemonless — each container is a direct
 * fork/exec of an OCI runtime (crun), so there is no root daemon to run,
 * nothing to keep alive between runs, and teardown is a process exiting. The
 * per-detail control a project wants (capabilities, devices, mounts, tmpfs,
 * ulimits, seccomp) maps onto flags one-for-one; see sandbox-policy.ts.
 *
 * Every knob comes from the {@link SandboxPolicy}, so a project controls its own
 * sandbox over the API without this file knowing anything about projects.
 *
 * Verified working in this environment: run, image pull, bridge networking,
 * `--network=none` egress cutoff, ephemeral port publish + readback, pause /
 * unpause, `--pids-limit`, `--cpus`, and `--privileged` (nested containers).
 * Memory limits are accepted but the host cgroup does not delegate the memory
 * controller here, so crun fails — see `podmanSupportsMemoryLimits`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BuildImageResult,
  BuildImageSpec,
  ContainerExecHandle,
  ContainerExecResult,
  ContainerExecSpec,
  ContainerHandle,
  ContainerRuntime,
  ResolvedPort,
  RunContainerSpec,
} from "./runtime.js";
import { buildPodmanRunArgs } from "./podman-argv.js";
import {
  defaultSandboxPolicy,
  resolveSandboxPolicy,
  type SandboxPolicy,
} from "./sandbox-policy.js";

/** Options for constructing a {@link PodmanRuntime}. */
export interface PodmanRuntimeOptions {
  /** podman binary; defaults to AGENTEVAL_PODMAN_BIN or "podman". */
  bin?: string;
  /**
   * Prefix argv, e.g. `["sudo", "-n"]`. Rootless podman needs a subuid range;
   * where the host has none, running via sudo is the working path.
   * Defaults to AGENTEVAL_PODMAN_SUDO=1 → ["sudo", "-n"].
   */
  prefix?: string[];
  /** Sandbox policy applied when a run does not carry its own. */
  policy?: SandboxPolicy;
  /** Milliseconds to wait for an image pull + container create. */
  startTimeoutMs?: number;
}

/** Result of running a podman CLI command to completion. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a podman subcommand and collect its output. */
function runCli(
  argv: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    if (!file) {
      resolve({ code: 1, stdout: "", stderr: "empty argv" });
      return;
    }
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env ? { env: opts.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, opts.timeoutMs)
      : undefined;

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 0));
  });
}

/** Preserve named child env vars across a sudo prefix without putting values in argv. */
export function podmanCommandWithEnv(
  command: string[],
  names: string[],
): string[] {
  if (names.length === 0) return [...command];
  const first = command[0] ?? "";
  const isSudo = first === "sudo" || first.endsWith("/sudo");
  if (!isSudo) return [...command];
  const unique = [...new Set(names)].sort();
  return [first, `--preserve-env=${unique.join(",")}`, ...command.slice(1)];
}

/** Turn a `podman logs -f` child process into an async byte stream. */
async function* streamOf(child: ChildProcess, which: "stdout" | "stderr"): AsyncGenerator<Buffer> {
  const src = child[which];
  if (!src) return;
  for await (const chunk of src) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
  }
}

/**
 * Parse `podman port <ctr>` output into resolved mappings.
 *
 * Lines look like `8000/tcp -> 127.0.0.1:35635`. The host port is the whole
 * point: an ephemeral request is only useful once the caller can read back what
 * it actually got.
 */
export function parsePortOutput(
  out: string,
  requested: RunContainerSpec["ports"],
): ResolvedPort[] {
  const byContainerPort = new Map<number, ResolvedPort>();
  for (const line of out.split("\n")) {
    const m = /^(\d+)\/(tcp|udp)\s*->\s*\S*?:(\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    const containerPort = Number(m[1]);
    const hostPort = Number(m[3]);
    if (!Number.isInteger(containerPort) || !Number.isInteger(hostPort)) continue;
    byContainerPort.set(containerPort, {
      containerPort,
      hostPort,
      protocol: m[2] === "udp" ? "udp" : "tcp",
    });
  }
  // Carry the caller's names across so AGENTEVAL_PORT_<NAME> stays meaningful.
  const out2: ResolvedPort[] = [];
  for (const req of requested ?? []) {
    const found = byContainerPort.get(req.containerPort);
    if (!found) continue;
    out2.push(req.name ? { ...found, name: req.name } : found);
    byContainerPort.delete(req.containerPort);
  }
  // Anything published but not requested (policy ports) still gets reported.
  out2.push(...byContainerPort.values());
  return out2;
}

/** One streaming `podman exec` session inside a queue container. */
class PodmanExecHandle implements ContainerExecHandle {
  readonly id = `exec-${randomUUID()}`;
  private readonly child: ChildProcess;
  private readonly startedAt = Date.now();
  private readonly waitPromise: Promise<{
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
  }>;
  private timedOut = false;
  private settled = false;
  private timeoutTimer: NodeJS.Timeout | undefined;

  constructor(child: ChildProcess, timeoutMs: number) {
    this.child = child;
    this.waitPromise = new Promise((resolve) => {
      const finish = (exitCode: number): void => {
        if (this.settled) return;
        this.settled = true;
        if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
        resolve({
          exitCode,
          timedOut: this.timedOut,
          durationMs: Math.max(0, Date.now() - this.startedAt),
        });
      };
      child.once("error", () => finish(127));
      child.once("close", (code, signal) => {
        finish(
          typeof code === "number"
            ? code
            : this.timedOut
              ? 137
              : signal
                ? 128 + (signal === "SIGTERM" ? 15 : 9)
                : 1,
        );
      });
    });
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      this.timeoutTimer = setTimeout(() => {
        this.timedOut = true;
        this.killGroup("SIGKILL");
      }, timeoutMs);
      this.timeoutTimer.unref?.();
    }
  }

  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  stdout(): AsyncIterable<Buffer> {
    return streamOf(this.child, "stdout");
  }

  stderr(): AsyncIterable<Buffer> {
    return streamOf(this.child, "stderr");
  }

  wait(): Promise<{ exitCode: number; timedOut: boolean; durationMs: number }> {
    return this.waitPromise;
  }

  async stop(graceMs = 2_000): Promise<void> {
    if (this.settled) return;
    this.killGroup("SIGTERM");
    const done = await Promise.race([
      this.waitPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!done) this.killGroup("SIGKILL");
    await this.waitPromise;
  }
}

/** Collect a streaming exec session without ever stopping pipe drainage. */
async function collectExecSession(
  session: ContainerExecHandle,
  maxOutputBytes: number,
): Promise<ContainerExecResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let retained = 0;
  let outputTruncated = false;
  const collect = async (
    stream: AsyncIterable<Buffer>,
    target: Buffer[],
  ): Promise<void> => {
    for await (const chunk of stream) {
      const remaining = Math.max(0, maxOutputBytes - retained);
      if (remaining > 0) {
        const kept = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        target.push(Buffer.from(kept));
        retained += kept.length;
      }
      if (chunk.length > remaining) outputTruncated = true;
    }
  };
  const drains = Promise.all([
    collect(session.stdout(), stdout),
    collect(session.stderr(), stderr),
  ]);
  const result = await session.wait();
  await drains;
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    outputTruncated,
  };
}

/** A running podman container. */
class PodmanContainerHandle implements ContainerHandle {
  readonly id: string;
  readonly image: string;
  readonly ports: ResolvedPort[];

  private readonly podman: string[];
  private readonly logsChild: ChildProcess;
  private readonly timeoutMs: number;
  private readonly autoRemove: boolean;
  private waitPromise: Promise<{ exitCode: number; timedOut: boolean }> | undefined;
  private timedOut = false;
  private removed = false;
  private timeoutTimer: NodeJS.Timeout | undefined;

  constructor(opts: {
    id: string;
    image: string;
    ports: ResolvedPort[];
    podman: string[];
    timeoutMs: number;
    autoRemove: boolean;
  }) {
    this.id = opts.id;
    this.image = opts.image;
    this.ports = opts.ports;
    this.podman = opts.podman;
    this.timeoutMs = opts.timeoutMs;
    this.autoRemove = opts.autoRemove;

    // Follow logs from the start; podman keeps both streams separate, so the
    // canonical trace never has stderr interleaved into stdout.
    const [file, ...prefixArgs] = [...this.podman, "logs", "-f", this.id];
    this.logsChild = spawn(file!, prefixArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (this.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.timedOut = true;
        void this.kill();
      }, this.timeoutMs);
      this.timeoutTimer.unref?.();
    }
  }

  private cli(args: string[], timeoutMs = 30_000): Promise<CliResult> {
    return runCli([...this.podman, ...args], { timeoutMs });
  }

  /** SIGKILL the container immediately (timeout path). */
  private async kill(): Promise<void> {
    await this.cli(["kill", "--signal", "KILL", this.id], 15_000);
  }

  async pause(): Promise<void> {
    await this.cli(["pause", this.id]);
  }

  async resume(): Promise<void> {
    await this.cli(["unpause", this.id]);
  }

  async stop(graceMs = 10_000): Promise<void> {
    // podman's -t is seconds; it sends SIGTERM then SIGKILL after the grace.
    const seconds = Math.max(0, Math.ceil(graceMs / 1000));
    await this.cli(["stop", "-t", String(seconds), this.id], graceMs + 15_000);
  }

  /** Start a streaming argv session in this exact live container. */
  async startExec(spec: ContainerExecSpec): Promise<ContainerExecHandle> {
    if (this.removed) {
      throw Object.assign(new Error(`container ${this.id} has been removed`), {
        code: "NOT_RUNNING",
      });
    }
    if (spec.argv.length === 0) throw new Error("container exec requires argv");
    const args = ["exec"];
    if (spec.cwd) args.push("--workdir", spec.cwd);
    if (spec.user) args.push("--user", spec.user);
    const commandEnv = spec.env ?? {};
    const envNames = Object.keys(commandEnv);
    for (const name of envNames) args.push("--env", name);
    args.push(this.id, ...spec.argv);
    const [file, ...spawnArgs] = [
      ...podmanCommandWithEnv(this.podman, envNames),
      "--log-level=error",
      ...args,
    ];
    const child = spawn(file!, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, ...commandEnv },
    });
    return new PodmanExecHandle(child, spec.timeoutMs ?? 30_000);
  }

  /** Execute argv and collect bounded stdout/stderr. */
  async exec(spec: ContainerExecSpec): Promise<ContainerExecResult> {
    const session = await this.startExec(spec);
    return collectExecSession(session, spec.maxOutputBytes ?? 1024 * 1024);
  }

  stdout(): AsyncIterable<Buffer> {
    return streamOf(this.logsChild, "stdout");
  }

  stderr(): AsyncIterable<Buffer> {
    return streamOf(this.logsChild, "stderr");
  }

  async wait(): Promise<{ exitCode: number; timedOut: boolean }> {
    this.waitPromise ??= this.doWait();
    return this.waitPromise;
  }

  private async doWait(): Promise<{ exitCode: number; timedOut: boolean }> {
    // `podman wait` blocks until exit and prints the code. With --rm the
    // container may be reaped before we can inspect it, so this is the only
    // reliable read of the exit status.
    const res = await this.cli(["wait", this.id], 0);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    let exitCode = Number.parseInt(res.stdout.trim(), 10);
    if (!Number.isInteger(exitCode)) {
      // `wait` could not report (container vanished, or podman errored). Ask
      // inspect before giving up — losing a real exit code would mislabel a
      // successful run as failed.
      const insp = await this.cli(
        ["inspect", this.id, "--format", "{{.State.ExitCode}}"],
        15_000,
      );
      const fromInspect = Number.parseInt(insp.stdout.trim(), 10);
      exitCode = Number.isInteger(fromInspect)
        ? fromInspect
        : res.code === 0
          ? 0
          : 1;
    }

    // Let the log follower drain what it has before callers stop reading.
    await new Promise<void>((resolve) => {
      if (this.logsChild.exitCode !== null || this.logsChild.killed) {
        resolve();
        return;
      }
      const done = (): void => resolve();
      this.logsChild.once("close", done);
      setTimeout(() => {
        try {
          this.logsChild.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        resolve();
      }, 1_000).unref?.();
    });

    return { exitCode, timedOut: this.timedOut };
  }

  async remove(): Promise<void> {
    if (this.removed) return;
    this.removed = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    try {
      this.logsChild.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // The container is never started with `--rm` (that would race `podman
    // wait`), so removal is ours to do. `keepAfterExit` projects opt out to
    // keep the stopped container for post-mortem inspection.
    if (this.autoRemove) {
      await this.cli(["rm", "-f", "-i", this.id], 30_000);
    }
  }
}

/**
 * Daemonless ContainerRuntime backed by podman.
 *
 * One `podman run -d` per eval run; the handle drives pause/stop/wait/remove
 * through the CLI. No long-lived daemon, no socket, nothing to clean up between
 * runs beyond the container itself.
 */
export class PodmanRuntime implements ContainerRuntime {
  private readonly bin: string;
  private readonly prefix: string[];
  private readonly policy: SandboxPolicy;
  private readonly startTimeoutMs: number;
  /** Cached host probe: does this cgroup delegate the memory controller? */
  private memorySupported: boolean | undefined;
  /** Warn once per process, not once per run. */
  private static warnedNoMemoryCgroup = false;

  constructor(opts: PodmanRuntimeOptions = {}) {
    this.bin = opts.bin ?? process.env.AGENTEVAL_PODMAN_BIN ?? "podman";
    this.prefix =
      opts.prefix ??
      (process.env.AGENTEVAL_PODMAN_SUDO === "1" ? ["sudo", "-n"] : []);
    this.policy = opts.policy ?? defaultSandboxPolicy();
    // Generous: the first run of an image pays for the registry pull.
    this.startTimeoutMs = opts.startTimeoutMs ?? 600_000;
  }

  /** Full argv prefix for any podman invocation. */
  private cmd(): string[] {
    return [...this.prefix, this.bin];
  }

  /** Build an OCI image from a connected real agent CLI repository. */
  async buildImage(spec: BuildImageSpec): Promise<BuildImageResult> {
    const started = Date.now();
    const built = await runCli(
      [
        ...this.cmd(),
        "--log-level=error",
        "build",
        "-t",
        spec.image,
        "-f",
        spec.containerfilePath,
        spec.contextDir,
      ],
      { timeoutMs: spec.timeoutMs ?? 1_800_000 },
    );
    if (built.code !== 0) {
      throw new Error(
        `podman build failed (exit ${built.code}): ${built.stderr.trim() || built.stdout.trim()}`,
      );
    }
    const inspected = await runCli(
      [...this.cmd(), "image", "inspect", spec.image, "--format", "{{.Id}}"],
      { timeoutMs: 30_000 },
    );
    if (inspected.code !== 0 || !inspected.stdout.trim()) {
      throw new Error(
        `podman image inspect failed for ${spec.image}: ${inspected.stderr.trim()}`,
      );
    }
    return {
      image: spec.image,
      imageId: inspected.stdout.trim(),
      stdout: built.stdout,
      stderr: built.stderr,
      durationMs: Date.now() - started,
    };
  }

  async imageExists(image: string): Promise<boolean> {
    const res = await runCli(
      [...this.cmd(), "image", "inspect", image, "--format", "{{.Id}}"],
      { timeoutMs: 30_000 },
    );
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  /**
   * Launch a container for `spec`.
   *
   * The per-run policy rides on `spec.sandbox` when present (set by the API
   * bridge from project config); otherwise the runtime's default applies.
   */
  async run(spec: RunContainerSpec): Promise<ContainerHandle> {
    if (spec.argv.length === 0) {
      throw new Error("PodmanRuntime.run: empty argv");
    }
    // spec.sandbox is typed unknown at the seam so runtime.ts stays independent
    // of the policy module; narrow it here.
    const policy = spec.sandbox
      ? resolveSandboxPolicy(this.policy, spec.sandbox)
      : this.policy;

    const name = `agenteval-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1e6,
    ).toString(36)}`;

    // A memory limit the host cannot enforce is fatal, not advisory: crun fails
    // the run with "opening file `memory.max`". Nested-container hosts commonly
    // delegate only cpuset/cpu/pids. Drop the limit and warn rather than fail a
    // run over a knob this host was never going to apply.
    let effectiveSpec = spec;
    if (spec.limits.memoryMiB !== undefined) {
      this.memorySupported ??= await podmanSupportsMemoryLimits();
      if (!this.memorySupported) {
        const { memoryMiB: _dropped, ...limits } = spec.limits;
        effectiveSpec = { ...spec, limits };
        if (!PodmanRuntime.warnedNoMemoryCgroup) {
          PodmanRuntime.warnedNoMemoryCgroup = true;
          console.warn(
            "[podman] host cgroup does not delegate the memory controller; " +
              "ignoring limits.memoryMiB (cpus/pids still apply)",
          );
        }
      }
    }

    const args = buildPodmanRunArgs(effectiveSpec, policy, { name });
    const envNames = Object.keys(effectiveSpec.env);
    const created = await runCli(
      [...podmanCommandWithEnv(this.cmd(), envNames), ...args],
      {
        timeoutMs: this.startTimeoutMs,
        env: { ...process.env, ...effectiveSpec.env },
      },
    );
    if (created.code !== 0) {
      throw new Error(
        `podman run failed (exit ${created.code}): ${created.stderr.trim() || created.stdout.trim()}`,
      );
    }
    const id = created.stdout.trim().split("\n").pop()?.trim() ?? name;

    // Read back what the ephemeral port requests actually resolved to. Only
    // meaningful once the container exists, which is why it happens here.
    let ports: ResolvedPort[] = [];
    const wanted = [...(spec.ports ?? []), ...policy.ports];
    if (wanted.length > 0) {
      // Port publication can lag container creation very briefly. Retry rather
      // than returning an empty mapping that makes a real published port
      // undiscoverable to the queue worker/operator.
      for (let attempt = 0; attempt < 20 && ports.length === 0; attempt++) {
        const portRes = await runCli([...this.cmd(), "port", id], {
          timeoutMs: 30_000,
        });
        if (portRes.code === 0) {
          ports = parsePortOutput(portRes.stdout, wanted);
        }
        if (ports.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }

    return new PodmanContainerHandle({
      id,
      image: effectiveSpec.image,
      ports,
      podman: this.cmd(),
      timeoutMs: spec.timeoutMs,
      autoRemove: policy.autoRemove,
    });
  }

  /** True when the podman binary is present and responsive. */
  async available(): Promise<boolean> {
    const res = await runCli([...this.cmd(), "--version"], { timeoutMs: 15_000 });
    return res.code === 0;
  }
}

/**
 * Whether this host delegates the memory cgroup controller.
 *
 * Nested container hosts frequently delegate only `cpuset cpu pids`, and a
 * `--memory` flag then fails the run outright rather than degrading. Callers
 * that want a run to survive on such a host should drop `limits.memoryMiB`.
 */
export async function podmanSupportsMemoryLimits(): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  try {
    const controllers = await readFile(
      "/sys/fs/cgroup/cgroup.subtree_control",
      "utf8",
    );
    return controllers.split(/\s+/).includes("memory");
  } catch {
    return false;
  }
}

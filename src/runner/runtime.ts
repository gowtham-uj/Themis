/**
 * The container-runtime seam.
 *
 * Domain code (the runner, run-control, diff capture) never calls `docker` directly. It goes through
 * this interface so the container-execution path is unit-testable in this Dockerless build environment
 * against a fake implementation, and switchable to a real Docker-socket-backed implementation in a
 * deployment that has Docker + root. See plan/execution.md and CLAUDE.md ("Execution environment
 * constraint").
 */

import { existsSync } from "node:fs";
import { DockerSocketRuntime } from "./docker-socket.js";
import { FakeContainerRuntime } from "./fake-runtime.js";

/** A container that has been started and can be controlled. */
export interface ContainerHandle {
  readonly id: string;
  readonly image: string;
  /** Pause the container's CPU (cgroup freezer / `docker pause`). Hard-pause only. */
  pause(): Promise<void>;
  /** Thaw a paused container and resume execution. */
  resume(): Promise<void>;
  /** Graceful stop: SIGTERM then SIGKILL after `graceMs`. Returns once stopped (not removed). */
  stop(graceMs?: number): Promise<void>;
  /** Attach to stdout/stderr as an async stream of bytes/chunks. */
  stdout(): AsyncIterable<Buffer>;
  stderr(): AsyncIterable<Buffer>;
  /** Wait for the container to exit; returns exit code + whether it was killed by timeout. */
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  /** Remove the container's filesystem (best-effort, on finalize). */
  remove(): Promise<void>;
}

/** Launch spec fed to {@link ContainerRuntime.run}. Records every reproducibility knob. */
export interface RunContainerSpec {
  image: string;
  /** Host path mounted read-write as the agent workspace at `/workspace`. */
  workspaceDir: string;
  /** argv to launch the agent headlessly inside the container. */
  argv: string[];
  /** Env injected at launch; secrets are redacted from logs by the runner, never here unsanitized. */
  env: Record<string, string>;
  /** Resource limits — pinned for reproducibility (plan/execution.md). */
  limits: { cpus?: number; memoryMiB?: number; pids?: number };
  /** Hard wall-clock timeout. On expiry the runtime SIGTERM→SIGKILL and wait() returns timedOut. */
  timeoutMs: number;
  network: "allow" | "allowlist" | "offline";
  networkAllowlist?: string[];
  /** Non-root inside the container. */
  nonRoot: boolean;
}

export interface ContainerRuntime {
  /**
   * Pull the image if missing (registry policy), then launch and return a handle. The caller owns the
   * lifecycle: stream stdout via the handle, then `wait()`, then `remove()`.
   *
   * Implementations:
   *  - `DockerSocketRuntime` (real; used where Docker exists) — builds the `docker run` argv from
   *    `spec` and drives the daemon over the socket.
   *  - `FakeContainerRuntime` (tests; this build) — simulates a process: runs `argv` as a local
   *    child process honoring `pause`/`stop`/`timeoutMs`, so runner + redaction + diff + run-control
   *    logic are exercised without a daemon.
   */
  run(spec: RunContainerSpec): Promise<ContainerHandle>;
}

/** Test/injection override; when set, {@link resolveRuntime} returns it. */
let injectedRuntime: ContainerRuntime | undefined;

/**
 * Inject a ContainerRuntime for tests (or custom deploys). Pass `undefined` to clear.
 * Prefer this over env mutation so parallel tests stay isolated.
 */
export function setRuntime(rt: ContainerRuntime | undefined): void {
  injectedRuntime = rt;
}

/**
 * True when a real Docker backend should be selected:
 *  - `AGENTEVAL_DOCKER=1`, or
 *  - `DOCKER_HOST` is set, or
 *  - the default docker socket path exists on disk.
 */
export function isDockerEnvironment(): boolean {
  if (process.env.AGENTEVAL_DOCKER === "1") return true;
  if (process.env.DOCKER_HOST && process.env.DOCKER_HOST.length > 0) return true;
  try {
    if (existsSync("/var/run/docker.sock")) return true;
  } catch {
    // ignore fs errors
  }
  return false;
}

/**
 * Resolved at app startup from env: real Docker socket if `DOCKER_HOST`/socket/
 * AGENTEVAL_DOCKER present, else {@link FakeContainerRuntime}.
 * Tests may inject via {@link setRuntime}.
 */
export function resolveRuntime(): ContainerRuntime {
  if (injectedRuntime) return injectedRuntime;
  if (isDockerEnvironment()) {
    // DockerSocketRuntime.run() currently throws NotImplementedError in this build;
    // live container smoke is deferred to a Docker+root environment (@needs-docker).
    return new DockerSocketRuntime();
  }
  return new FakeContainerRuntime();
}

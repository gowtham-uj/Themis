/**
 * The container-runtime seam.
 *
 * Domain code (the runner, run-control, diff capture) never calls `docker` directly. It goes through
 * this interface so the container-execution path is unit-testable in this Dockerless build environment
 * against a fake implementation, and switchable to a real Docker-socket-backed implementation in a
 * deployment that has Docker + root. See plan/execution.md and CLAUDE.md ("Execution environment
 * constraint").
 */

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

/** Resolved at app startup from env: real Docker socket if `DOCKER_HOST`/socket present, else fake. */
export function resolveRuntime(): ContainerRuntime {
  // P2 implements both + the socket detection. Placeholder lands the seam + import path for P1.
  throw new Error("ContainerRuntime not configured — implemented in Phase 2.");
}

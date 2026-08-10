/**
 * The container-runtime seam.
 *
 * Domain code (the runner, run-control, diff capture) never calls `podman`/`docker` directly. It goes
 * through this interface so every execution path uses a real container backend while remaining
 * switchable between Podman and a future Docker-socket implementation. See plan/execution.md.
 */

import { existsSync } from "node:fs";
import { DockerSocketRuntime } from "./docker-socket.js";
import { PodmanRuntime } from "./podman-runtime.js";

/** One command executed inside an already-running container. */
export interface ContainerExecSpec {
  /** Exact argv passed to the container runtime. */
  argv: string[];
  /** Working directory inside the container (default `/workspace`). */
  cwd?: string;
  /** Additional environment variables for this command only. */
  env?: Record<string, string>;
  /** Container user for this command, e.g. `root`. */
  user?: string;
  /** Hard wall-clock limit for this command. */
  timeoutMs?: number;
  /** Combined stdout/stderr bytes retained in the result before truncation. */
  maxOutputBytes?: number;
}

/** A streaming command session inside an already-running container. */
export interface ContainerExecHandle {
  readonly id: string;
  stdout(): AsyncIterable<Buffer>;
  stderr(): AsyncIterable<Buffer>;
  wait(): Promise<{ exitCode: number; timedOut: boolean; durationMs: number }>;
  /** Stop this command session without stopping the queue container. */
  stop(graceMs?: number): Promise<void>;
}

/** Captured result of a command run through {@link ContainerHandle.exec}. */
export interface ContainerExecResult {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

/** A container that has been started and can be controlled. */
export interface ContainerHandle {
  readonly id: string;
  readonly image: string;
  /**
   * Ports actually published, with ephemeral (hostPort: 0) requests resolved
   * to concrete host ports. Empty when the spec requested none.
   */
  readonly ports?: ResolvedPort[];
  /** Pause the container's CPU (cgroup freezer / `docker pause`). Hard-pause only. */
  pause(): Promise<void>;
  /** Thaw a paused container and resume execution. */
  resume(): Promise<void>;
  /** Graceful stop: SIGTERM then SIGKILL after `graceMs`. Returns once stopped (not removed). */
  stop(graceMs?: number): Promise<void>;
  /** Start a streaming command session inside this same live container. */
  startExec(spec: ContainerExecSpec): Promise<ContainerExecHandle>;
  /** Execute argv inside this same live container and collect bounded output. */
  exec(spec: ContainerExecSpec): Promise<ContainerExecResult>;
  /** Attach to stdout/stderr as an async stream of bytes/chunks. */
  stdout(): AsyncIterable<Buffer>;
  stderr(): AsyncIterable<Buffer>;
  /** Wait for the container to exit; returns exit code + whether it was killed by timeout. */
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  /** Remove the container's filesystem (best-effort, on finalize). */
  remove(): Promise<void>;
}

/**
 * A port the sandbox exposes to the host.
 *
 * Agents that start a dev server, or drive a headless browser over a debug
 * port (CDP), need reachable ports. `hostPort: 0` asks the runtime to pick a
 * free ephemeral port — the assignment is reported back on the handle so the
 * caller can address it without racing.
 */
export interface PortMapping {
  /** Port inside the sandbox the agent listens on. */
  containerPort: number;
  /** Host port to publish on; 0 (or omitted) → runtime picks a free one. */
  hostPort?: number;
  protocol?: "tcp" | "udp";
  /** Optional label surfaced in the UI/telemetry (e.g. "devserver", "cdp"). */
  name?: string;
}

/** A port mapping after the runtime has resolved any ephemeral assignment. */
export interface ResolvedPort extends PortMapping {
  /** Always concrete once the container is running. */
  hostPort: number;
}

/** Launch spec fed to {@link ContainerRuntime.run}. Records every reproducibility knob. */
export interface RunContainerSpec {
  image: string;
  /** Host path mounted read-write as the agent workspace at `/workspace`. */
  workspaceDir: string;
  /** argv to launch the agent headlessly inside the container. */
  argv: string[];
  /** Environment injected at container launch. */
  env: Record<string, string>;
  /** Resource limits — pinned for reproducibility (plan/execution.md). */
  limits: { cpus?: number; memoryMiB?: number; pids?: number };
  /** Hard wall-clock timeout. On expiry the runtime SIGTERM→SIGKILL and wait() returns timedOut. */
  timeoutMs: number;
  network: "allow" | "allowlist" | "offline";
  networkAllowlist?: string[];
  /**
   * Ports published from the sandbox to the host. Needed by agents that run a
   * dev server or drive a headless browser over a debug port. Independent of
   * `network`: an offline sandbox may still publish a loopback port.
   */
  ports?: PortMapping[];
  /** Non-root inside the container. */
  nonRoot: boolean;
  /**
   * Per-project sandbox controls (capabilities, mounts, devices, tmpfs, …).
   * Typed as unknown here so the seam does not depend on the policy module;
   * real backends narrow it via `resolveSandboxPolicy`. Absent → backend default.
   */
  sandbox?: unknown;
}

export interface BuildImageSpec {
  /** Host directory used as the OCI build context. */
  contextDir: string;
  /** Containerfile/Dockerfile path inside the context directory. */
  containerfilePath: string;
  /** Resulting local image tag or fully-qualified name. */
  image: string;
  /** Hard build timeout. */
  timeoutMs?: number;
}

export interface BuildImageResult {
  image: string;
  imageId: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ContainerRuntime {
  /** Build a real CLI-agent image from a connected source repository. */
  buildImage(spec: BuildImageSpec): Promise<BuildImageResult>;
  /**
   * Pull the image if missing (registry policy), then launch and return a handle. The caller owns the
   * lifecycle: stream stdout via the handle, then `wait()`, then `remove()`.
   *
   * Implementations:
   *  - `PodmanRuntime` (real, default) — daemonless OCI containers through the Podman CLI.
   *  - `DockerSocketRuntime` (future real backend) — selected only when explicitly configured.
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
 * True when the real Podman backend is selected.
 *
 * Podman is the default. `AGENTEVAL_PODMAN=1` and
 * `AGENTEVAL_RUNTIME=podman` make that choice explicit.
 */
export function isPodmanEnvironment(): boolean {
  if (process.env.AGENTEVAL_PODMAN === "1") return true;
  const selected = (process.env.AGENTEVAL_RUNTIME ?? "").toLowerCase();
  return selected === "" || selected === "podman";
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
 * Resolve the configured real container backend.
 *
 * Podman is the operational and test default. There is deliberately no local
 * process fallback: a missing container runtime is a hard configuration error,
 * not permission to run agent code on the host.
 */
export function resolveRuntime(): ContainerRuntime {
  if (injectedRuntime) return injectedRuntime;
  const selected = (process.env.AGENTEVAL_RUNTIME ?? "").toLowerCase();
  if (process.env.AGENTEVAL_PODMAN === "1" || selected === "podman") {
    return new PodmanRuntime();
  }
  if (selected === "docker" || isDockerEnvironment()) {
    return new DockerSocketRuntime();
  }
  if (selected === "") return new PodmanRuntime();
  throw new Error(`unsupported AGENTEVAL_RUNTIME=${selected}; use podman`);
}

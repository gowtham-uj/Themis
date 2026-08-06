/**
 * Real Docker-socket-backed ContainerRuntime seam.
 *
 * In a Docker + root deployment this class would drive the daemon over the socket
 * (or DOCKER_HOST) to honour mounts, limits, network policy, and cgroup pause.
 * This build environment is Dockerless, so `run()` throws {@link NotImplementedError}
 * with a clear message. Tests always use {@link FakeContainerRuntime}.
 *
 * Do NOT call the docker CLI from domain code — go through ContainerRuntime.
 */

import type {
  ContainerHandle,
  ContainerRuntime,
  RunContainerSpec,
} from "./runtime.js";

/** Raised when a real Docker backend is selected but not implemented/available. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Stub for the production Docker-socket backend.
 * Keeps the ContainerRuntime seam honest: resolveRuntime() can return this when a
 * socket / AGENTEVAL_DOCKER is present, and callers get a clear failure at run().
 */
export class DockerSocketRuntime implements ContainerRuntime {
  async run(_spec: RunContainerSpec): Promise<ContainerHandle> {
    throw new NotImplementedError(
      "real Docker socket backend — enable in a Docker+root environment; tests use FakeContainerRuntime",
    );
  }
}

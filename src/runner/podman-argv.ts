/**
 * Pure `podman run` argv builder.
 *
 * Split out from {@link PodmanRuntime} so the mapping from spec+policy → CLI
 * flags is unit-testable without a container daemon: the interesting logic is
 * the translation, not the spawn. Nothing here touches the filesystem or the
 * network.
 */

import type { RunContainerSpec } from "./runtime.js";
import type { SandboxPolicy } from "./sandbox-policy.js";

/** Where the agent workspace is mounted inside every sandbox. */
export const WORKSPACE_MOUNT = "/workspace";

/**
 * Publish spec for one port, in podman's `-p` syntax.
 *
 * An absent/0 host port becomes `127.0.0.1::<container>`, podman's ephemeral
 * form — note `-p 0:8000` is REJECTED by podman ("port must be 1-65535"), so
 * the empty middle field is load-bearing. Binding to 127.0.0.1 keeps a sandbox
 * port off any external interface unless a host port was named explicitly.
 */
export function portFlag(p: {
  containerPort: number;
  hostPort?: number;
  protocol?: "tcp" | "udp";
}): string {
  const proto = p.protocol === "udp" ? "/udp" : "";
  if (p.hostPort && p.hostPort > 0) {
    return `127.0.0.1:${p.hostPort}:${p.containerPort}${proto}`;
  }
  return `127.0.0.1::${p.containerPort}${proto}`;
}

/** Podman's `--network` value for a policy. */
export function networkFlag(network: RunContainerSpec["network"]): string {
  // `allowlist` gets a normal network here; egress filtering is enforced by
  // NetworkCutoff at the firewall level, not by podman's network mode.
  return network === "offline" ? "none" : "bridge";
}

/**
 * Build the full `podman run` argv (excluding the leading `podman`).
 *
 * Order matters only for readability — podman accepts flags in any order — so
 * these are grouped: identity, isolation, resources, network, mounts, env.
 */
export function buildPodmanRunArgs(
  spec: RunContainerSpec,
  policy: SandboxPolicy,
  opts: { name: string; detach?: boolean } = { name: "" },
): string[] {
  const args: string[] = ["run"];

  if (opts.detach !== false) args.push("-d");
  if (opts.name) args.push("--name", opts.name);
  // Deliberately NO `--rm`: podman reaps an auto-removed container before
  // `podman wait` can read its exit code, so every successful run would report
  // a failure. The handle removes the container itself in remove(), which the
  // ContainerHandle contract already requires callers to invoke.

  // ---- isolation posture ----
  if (policy.privileged || policy.profile === "privileged") {
    args.push("--privileged");
  } else if (policy.profile === "locked") {
    args.push("--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges");
  }
  for (const cap of policy.capAdd) args.push("--cap-add", cap);
  // Drops come after adds so an explicit drop always wins.
  for (const cap of policy.capDrop) args.push("--cap-drop", cap);
  if (policy.seccomp) args.push("--security-opt", `seccomp=${policy.seccomp}`);
  if (policy.init) args.push("--init");

  // `nonRoot` on the spec is the platform-level guarantee; an explicit policy
  // user overrides it, since a project that asked for a specific uid meant it.
  if (policy.user) args.push("--user", policy.user);
  else if (spec.nonRoot && !policy.privileged) args.push("--user", "1000:1000");

  // ---- resources ----
  if (spec.limits.cpus !== undefined) args.push("--cpus", String(spec.limits.cpus));
  if (spec.limits.memoryMiB !== undefined) {
    args.push("--memory", `${spec.limits.memoryMiB}m`);
  }
  if (spec.limits.pids !== undefined) {
    args.push("--pids-limit", String(spec.limits.pids));
  }
  if (policy.shmSizeMiB !== undefined) {
    args.push("--shm-size", `${policy.shmSizeMiB}m`);
  }
  for (const [name, value] of Object.entries(policy.ulimits)) {
    args.push("--ulimit", `${name}=${value}`);
  }

  // ---- network ----
  args.push("--network", networkFlag(spec.network));
  for (const server of policy.dns) args.push("--dns", server);
  for (const [host, ip] of Object.entries(policy.extraHosts)) {
    args.push("--add-host", `${host}:${ip}`);
  }
  if (policy.hostname) args.push("--hostname", policy.hostname);
  for (const p of policy.ports) args.push("-p", portFlag(p));
  for (const p of spec.ports ?? []) args.push("-p", portFlag(p));

  // ---- filesystem ----
  args.push("-v", `${spec.workspaceDir}:${WORKSPACE_MOUNT}:rw`);
  for (const m of policy.mounts) {
    args.push("-v", `${m.source}:${m.target}:${m.readOnly ? "ro" : "rw"}`);
  }
  for (const t of policy.tmpfs) {
    args.push(
      "--tmpfs",
      t.sizeMiB !== undefined ? `${t.target}:size=${t.sizeMiB}m` : t.target,
    );
  }
  for (const d of policy.devices) args.push("--device", d);
  args.push("-w", policy.workdir ?? WORKSPACE_MOUNT);

  // ---- env ----
  // Values go through argv, not a shell, so no quoting concerns.
  for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);

  args.push(spec.image, ...spec.argv);
  return args;
}

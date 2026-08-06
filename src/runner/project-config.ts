/**
 * Resolve per-project execution config into the shape the runner needs.
 *
 * A project refines the *global* agent for its codebase (plan/projects.md §82):
 * pin a default model/image, inject project env, restrict the tool allowlist,
 * and set a network policy. This module is the single, pure place that turns
 * the stored `projects` columns into `AdapterOverrides` + a container network
 * mode, so the bridge stays a thin wire and the precedence rules are testable
 * without a DB or a container.
 */

import type { AdapterOverrides } from "../adapters/types.js";
import type { PortMapping } from "./runtime.js";

/** Network modes a container may be launched with (runtime.RunContainerSpec). */
export type NetworkMode = "allow" | "allowlist" | "offline";

/** The project columns that affect execution. Deliberately a narrow slice. */
export interface ProjectExecConfig {
  /** Base workspace image for this project; refines the adapter default. */
  workspaceImage?: string | null;
  /** Free-form overrides blob (adapter_overrides_json). */
  adapterOverrides?: Record<string, unknown> | null;
  /** Stored network policy string; unknown values fall back to "allow". */
  networkPolicy?: string | null;
}

const NETWORK_MODES = new Set<NetworkMode>(["allow", "allowlist", "offline"]);

/**
 * Coerce a stored network_policy string to a container network mode.
 * Unknown/absent values fall back to "allow" (the column default) rather than
 * throwing — a malformed setting must never wedge a project's runs.
 */
export function resolveNetworkMode(policy: string | null | undefined): NetworkMode {
  if (typeof policy !== "string") return "allow";
  const v = policy.trim().toLowerCase();
  return NETWORK_MODES.has(v as NetworkMode) ? (v as NetworkMode) : "allow";
}

function asStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a loose ports array from the stored JSON blob.
 *
 * Accepts either a bare number (`8080` → publish 8080 on an ephemeral host
 * port) or an object. Entries without a usable containerPort are dropped
 * rather than launching a container with a nonsense mapping.
 */
export function parsePorts(v: unknown): PortMapping[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PortMapping[] = [];
  for (const raw of v) {
    if (typeof raw === "number") {
      if (isValidPort(raw)) out.push({ containerPort: raw });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const containerPort = toPort(o.containerPort ?? o.container_port ?? o.port);
    if (containerPort === undefined) continue;
    const hostPort = toPort(o.hostPort ?? o.host_port);
    const mapping: PortMapping = { containerPort };
    if (hostPort !== undefined) mapping.hostPort = hostPort;
    if (o.protocol === "udp" || o.protocol === "tcp") mapping.protocol = o.protocol;
    if (typeof o.name === "string" && o.name.trim()) mapping.name = o.name.trim();
    out.push(mapping);
  }
  return out.length > 0 ? out : undefined;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function toPort(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return isValidPort(n) ? n : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length > 0 ? r : undefined;
}

/**
 * Build the `AdapterOverrides` a run should carry, from the project row plus
 * any per-run overrides (queue entry / watcher action), which win on conflict.
 *
 * Precedence, narrowest-first: runOverrides > project.adapterOverrides >
 * project.workspaceImage. Returns undefined when nothing is configured, so
 * callers can leave `RunContext.overrides` absent and adapters keep their
 * built-in defaults.
 *
 * Only known-typed fields are lifted out of the untyped JSON blob; malformed
 * entries are dropped rather than passed to the adapter.
 */
export function resolveAdapterOverrides(
  project: ProjectExecConfig | null | undefined,
  runOverrides?: Record<string, unknown> | null,
): AdapterOverrides | undefined {
  const merged: Record<string, unknown> = {
    ...(project?.adapterOverrides ?? {}),
    ...(runOverrides ?? {}),
  };

  const out: AdapterOverrides = {};

  // `imageTag` is the queue/watcher spelling of an image pin (queries.ts
  // promoteQueueEntry); `image` is the adapter-facing name. Either may appear.
  const image =
    (typeof merged.image === "string" ? merged.image : undefined) ??
    (typeof merged.imageTag === "string" ? merged.imageTag : undefined) ??
    (project?.workspaceImage ?? undefined) ??
    undefined;
  if (image) out.image = image;

  if (typeof merged.model === "string") out.model = merged.model;
  if (typeof merged.provider === "string") out.provider = merged.provider;

  const env = asStringRecord(merged.env);
  if (env) out.env = env;

  const params = asRecord(merged.params);
  if (params) out.params = params;

  const allowedTools = asStringArray(merged.allowedTools);
  if (allowedTools) out.allowedTools = allowedTools;

  const network = resolveNetworkMode(
    typeof merged.network === "string" ? merged.network : undefined,
  );
  if (typeof merged.network === "string") out.network = network;

  const ports = parsePorts(merged.ports);
  if (ports) out.ports = ports;

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the container network mode for a run: an explicit per-run/adapter
 * `network` override wins over the project's stored `network_policy`.
 */
export function resolveRunNetwork(
  project: ProjectExecConfig | null | undefined,
  overrides?: AdapterOverrides,
): NetworkMode {
  if (overrides?.network) return resolveNetworkMode(overrides.network);
  return resolveNetworkMode(project?.networkPolicy);
}

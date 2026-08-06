/**
 * Per-project sandbox policy — the fine-grained knobs a project sets to shape
 * the container its agents run in, resolved from the stored JSON blob.
 *
 * The platform's default posture is deliberately permissive: an eval sandbox
 * exists so the agent can do whatever the task needs — install packages, start
 * servers, drive a browser, run nested containers. The policy is how a project
 * tightens (or further loosens) that per its own risk appetite, and every field
 * here is settable over the API.
 *
 * Everything is a pure resolver: loose input in, typed + validated policy out.
 * Malformed entries are dropped rather than handed to the runtime, so a bad API
 * payload can never turn into a broken container invocation.
 */

import type { PortMapping } from "./runtime.js";

/** How much the sandbox is allowed to do. */
export type SandboxProfile = "locked" | "standard" | "privileged";

const PROFILES = new Set<SandboxProfile>(["locked", "standard", "privileged"]);

/** A host path exposed inside the sandbox. */
export interface SandboxMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

/** A tmpfs mounted inside the sandbox (fast scratch that never hits disk). */
export interface SandboxTmpfs {
  target: string;
  sizeMiB?: number;
}

/** Fully-resolved sandbox controls for one run. */
export interface SandboxPolicy {
  /**
   * Baseline posture:
   *  - `locked`     drop all capabilities, read-only rootfs, no privilege gain
   *  - `standard`   runtime defaults (the default)
   *  - `privileged` full capabilities + device access; needed for nested
   *                 containers, some browser sandboxes, and kernel-level tools
   */
  profile: SandboxProfile;
  /** Capabilities to add on top of the profile (e.g. SYS_ADMIN, NET_RAW). */
  capAdd: string[];
  /** Capabilities to drop; applied after capAdd so a drop always wins. */
  capDrop: string[];
  /** Run as root inside the sandbox. Ignored when the spec forces non-root. */
  privileged: boolean;
  /** Extra host paths visible to the agent, beyond its workspace. */
  mounts: SandboxMount[];
  /** Scratch filesystems in RAM. */
  tmpfs: SandboxTmpfs[];
  /** Extra devices to expose (e.g. /dev/fuse for nested containers). */
  devices: string[];
  /** Ports published to the host; hostPort 0/absent → ephemeral. */
  ports: PortMapping[];
  /** Shared-memory size; browsers (Chrome) crash on the 64 MiB default. */
  shmSizeMiB?: number;
  /** User to run as inside the sandbox ("root", "1000:1000", …). */
  user?: string;
  /** Working directory inside the sandbox. */
  workdir?: string;
  /** Hostname the sandbox sees. */
  hostname?: string;
  /** Extra /etc/hosts entries: host → ip. */
  extraHosts: Record<string, string>;
  /** DNS servers to use inside the sandbox. */
  dns: string[];
  /** ulimits, e.g. {nofile: 65536}. */
  ulimits: Record<string, number>;
  /** Seccomp: "unconfined" disables filtering; a path loads a custom profile. */
  seccomp?: string;
  /** Keep the container after exit for post-mortem inspection. */
  keepAfterExit: boolean;
  /** Init process to reap zombies (agents that spawn many children). */
  init: boolean;
  /** Auto-remove is the default; this is the escape hatch for debugging. */
  autoRemove: boolean;
}

/** The policy applied when a project configures nothing. */
export function defaultSandboxPolicy(): SandboxPolicy {
  return {
    profile: "standard",
    capAdd: [],
    capDrop: [],
    privileged: false,
    mounts: [],
    tmpfs: [],
    devices: [],
    ports: [],
    extraHosts: {},
    dns: [],
    ulimits: {},
    keepAfterExit: false,
    init: false,
    autoRemove: true,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function posInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Strings from a loose array, trimmed, empties dropped. */
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Capability names, normalized to bare uppercase (CAP_SYS_ADMIN → SYS_ADMIN).
 * `ALL` is preserved — it is how a project asks for everything.
 */
function capList(v: unknown): string[] {
  return strList(v).map((c) => c.toUpperCase().replace(/^CAP_/, ""));
}

/** Bind mounts; entries missing source or target are dropped. */
export function parseMounts(v: unknown): SandboxMount[] {
  if (!Array.isArray(v)) return [];
  const out: SandboxMount[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const source = str(o.source ?? o.src ?? o.host);
    const target = str(o.target ?? o.dest ?? o.destination ?? o.container);
    if (!source || !target) continue;
    const mount: SandboxMount = { source, target };
    const ro = bool(o.readOnly ?? o.read_only ?? o.ro);
    if (ro !== undefined) mount.readOnly = ro;
    out.push(mount);
  }
  return out;
}

/** tmpfs mounts; entries missing a target are dropped. */
export function parseTmpfs(v: unknown): SandboxTmpfs[] {
  if (!Array.isArray(v)) return [];
  const out: SandboxTmpfs[] = [];
  for (const raw of v) {
    // A bare string is the common case: just a path.
    const asPath = str(raw);
    if (asPath) {
      out.push({ target: asPath });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const target = str(o.target ?? o.dest ?? o.path);
    if (!target) continue;
    const entry: SandboxTmpfs = { target };
    const size = posInt(o.sizeMiB ?? o.size_mib ?? o.size);
    if (size !== undefined) entry.sizeMiB = size;
    out.push(entry);
  }
  return out;
}

/** ulimit map; non-numeric values dropped. */
function parseUlimits(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = posInt(raw);
    if (n !== undefined) out[k.trim().toLowerCase()] = n;
  }
  return out;
}

/** host → ip map; non-string values dropped. */
function parseExtraHosts(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const ip = str(raw);
    const host = k.trim();
    if (ip && host) out[host] = ip;
  }
  return out;
}

/** Normalize a profile value; unknown → standard. */
export function resolveSandboxProfile(v: unknown): SandboxProfile {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return PROFILES.has(s as SandboxProfile) ? (s as SandboxProfile) : "standard";
}

/**
 * Resolve a sandbox policy from the project's stored blob, with an optional
 * per-run override layered on top (run wins, key by key).
 *
 * Accepts camelCase and snake_case for every field, since the API, the watcher,
 * and hand-written config all spell things differently.
 */
export function resolveSandboxPolicy(
  projectBlob: unknown,
  runOverride?: unknown,
): SandboxPolicy {
  const merged: Record<string, unknown> = {};
  for (const src of [projectBlob, runOverride]) {
    if (src && typeof src === "object" && !Array.isArray(src)) {
      Object.assign(merged, src as Record<string, unknown>);
    }
  }

  const policy = defaultSandboxPolicy();
  if (Object.keys(merged).length === 0) return policy;

  policy.profile = resolveSandboxProfile(merged.profile);
  policy.capAdd = capList(merged.capAdd ?? merged.cap_add);
  policy.capDrop = capList(merged.capDrop ?? merged.cap_drop);
  policy.mounts = parseMounts(merged.mounts ?? merged.binds);
  policy.tmpfs = parseTmpfs(merged.tmpfs);
  policy.devices = strList(merged.devices);
  policy.dns = strList(merged.dns);
  policy.ulimits = parseUlimits(merged.ulimits);
  policy.extraHosts = parseExtraHosts(merged.extraHosts ?? merged.extra_hosts);

  // `privileged` is implied by the profile but can also be set outright.
  const priv = bool(merged.privileged);
  policy.privileged = priv ?? policy.profile === "privileged";

  const shm = posInt(merged.shmSizeMiB ?? merged.shm_size_mib);
  if (shm !== undefined) policy.shmSizeMiB = shm;
  const user = str(merged.user);
  if (user) policy.user = user;
  const workdir = str(merged.workdir ?? merged.working_dir);
  if (workdir) policy.workdir = workdir;
  const hostname = str(merged.hostname);
  if (hostname) policy.hostname = hostname;
  const seccomp = str(merged.seccomp);
  if (seccomp) policy.seccomp = seccomp;

  const keep = bool(merged.keepAfterExit ?? merged.keep_after_exit);
  if (keep !== undefined) {
    policy.keepAfterExit = keep;
    // Keeping the container for inspection and auto-removing it are the same
    // decision spelled two ways; keep wins so the debug flag actually works.
    policy.autoRemove = !keep;
  }
  const init = bool(merged.init);
  if (init !== undefined) policy.init = init;
  const autoRemove = bool(merged.autoRemove ?? merged.auto_remove);
  if (autoRemove !== undefined && keep === undefined) {
    policy.autoRemove = autoRemove;
  }

  return policy;
}

/**
 * Sandbox profile tuned for agents that drive a headless browser.
 *
 * Chrome needs more than the 64 MiB default /dev/shm or it dies mid-page, and
 * its own sandbox needs either SYS_ADMIN or to be disabled. Exposed as a named
 * preset so projects get a working browser without knowing that.
 */
export function browserSandboxPolicy(): SandboxPolicy {
  return {
    ...defaultSandboxPolicy(),
    shmSizeMiB: 1024,
    capAdd: ["SYS_ADMIN"],
    init: true,
  };
}

/**
 * Sandbox profile for agents that need to run containers themselves
 * (docker-in-docker style tasks). Requires the privileged profile.
 */
export function nestedContainerSandboxPolicy(): SandboxPolicy {
  return {
    ...defaultSandboxPolicy(),
    profile: "privileged",
    privileged: true,
    devices: ["/dev/fuse"],
    init: true,
  };
}

/** Named presets addressable by API without spelling out every knob. */
export const SANDBOX_PRESETS: Record<string, () => SandboxPolicy> = {
  default: defaultSandboxPolicy,
  browser: browserSandboxPolicy,
  nested: nestedContainerSandboxPolicy,
};

/** Resolve a preset name to a policy; unknown names fall back to the default. */
export function sandboxPreset(name: unknown): SandboxPolicy {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  return (SANDBOX_PRESETS[key] ?? defaultSandboxPolicy)();
}

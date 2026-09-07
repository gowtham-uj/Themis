/**
 * Egress allowlist enforcement for a running sandbox.
 *
 * `network: "allowlist"` used to be indistinguishable from `"allow"`: the list
 * was computed, stored in the generation signature, and passed down to the
 * container spec, but nothing ever applied it, so an eval declaring three
 * allowed hosts got unrestricted internet.
 *
 * Enforcement happens inside the container's own network namespace with
 * nftables, entered by pid. Doing it there rather than on the host means the
 * rules die with the container, cannot be reached by anything inside it (the
 * agent has no CAP_NET_ADMIN under the default profile), and cannot affect host
 * traffic if cleanup is missed.
 *
 * Hostnames are resolved once at install time and pinned to their addresses.
 * That is a deliberate limitation, not an oversight: a name-based filter would
 * need a resolving proxy, and pinning matches how the rest of the platform
 * treats reproducibility. Names that move mid-run are re-resolved only on the
 * next container generation.
 */

import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";

/** nftables table name, scoped so a stray rule is identifiable as ours. */
const TABLE = "agenteval_egress";

/** One allowlist entry after resolution. */
export interface ResolvedAllowEntry {
  /** The entry as written in the eval package. */
  source: string;
  /** IPv4 literals this entry resolved to. Empty when resolution failed. */
  addresses: string[];
  /** Why an entry produced no addresses, for the run timeline. */
  error?: string;
}

/**
 * Resolve allowlist entries to IPv4 literals.
 *
 * Accepts a bare host, a `host:port`, a CIDR, or a URL. An entry that fails to
 * resolve is reported rather than dropped silently, because a typo in a package
 * allowlist would otherwise look identical to a host that is simply unreachable.
 */
export async function resolveAllowlist(entries: readonly string[]): Promise<ResolvedAllowEntry[]> {
  const out: ResolvedAllowEntry[] = [];
  for (const raw of entries) {
    const source = raw.trim();
    if (!source) continue;
    const host = normalizeHost(source);
    if (host === null) {
      out.push({ source, addresses: [], error: "unparseable allowlist entry" });
      continue;
    }
    // Already an address or CIDR: nftables takes it directly.
    if (/^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(host)) {
      out.push({ source, addresses: [host] });
      continue;
    }
    try {
      const records = await lookup(host, { all: true, family: 4 });
      const addresses = [...new Set(records.map((r) => r.address))];
      out.push(
        addresses.length > 0
          ? { source, addresses }
          : { source, addresses: [], error: "no IPv4 address" },
      );
    } catch (err) {
      out.push({
        source,
        addresses: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Strip scheme, credentials, port, and path down to a host or CIDR. */
function normalizeHost(entry: string): string | null {
  let value = entry;
  const scheme = value.indexOf("://");
  if (scheme !== -1) value = value.slice(scheme + 3);
  const slash = value.indexOf("/");
  // A CIDR suffix is numeric; a URL path is not.
  if (slash !== -1 && !/^\/\d+$/.test(value.slice(slash))) value = value.slice(0, slash);
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? null : value.slice(1, close);
  }
  const colon = value.indexOf(":");
  if (colon !== -1) value = value.slice(0, colon);
  return value.length > 0 ? value : null;
}

/**
 * The nftables ruleset for one allowlist.
 *
 * Output policy is drop. Loopback, established flows, and DNS stay open: the
 * agent must be able to resolve the very names it is allowed to reach, and a
 * blanket drop would also break the return path of its own allowed requests.
 */
export function buildRuleset(addresses: readonly string[]): string {
  const elements = addresses.length > 0 ? `elements = { ${addresses.join(", ")} }` : "";
  return [
    // `nft -f` merges into an existing table rather than replacing it, so a
    // second apply would stack a duplicate chain on the same hook. Declaring an
    // empty table and deleting it makes the apply idempotent whether or not one
    // is already there.
    `table inet ${TABLE} {}`,
    `delete table inet ${TABLE}`,
    `table inet ${TABLE} {`,
    "  set allowed {",
    "    type ipv4_addr",
    "    flags interval",
    ...(elements ? [`    ${elements}`] : []),
    "  }",
    "  chain output {",
    "    type filter hook output priority 0; policy drop;",
    "    ct state established,related accept",
    '    oifname "lo" accept',
    "    udp dport 53 accept",
    "    tcp dport 53 accept",
    "    ip daddr @allowed accept",
    "  }",
    "}",
  ].join("\n");
}

export interface AllowlistInstallResult {
  applied: boolean;
  entries: ResolvedAllowEntry[];
  /** Every address the container may reach. */
  addresses: string[];
  /** Present when the rules could not be installed. */
  error?: string;
}

/**
 * Install the allowlist into a running container's network namespace.
 *
 * `pid` is the container's host-visible init pid. A failure here is returned,
 * not thrown: the caller decides whether an unenforceable allowlist should
 * taint the run, and that policy does not belong in the enforcement mechanic.
 */
export async function installAllowlist(input: {
  pid: number;
  entries: readonly string[];
  sudo?: boolean;
  timeoutMs?: number;
}): Promise<AllowlistInstallResult> {
  const entries = await resolveAllowlist(input.entries);
  const addresses = [...new Set(entries.flatMap((e) => e.addresses))];
  const prefix = input.sudo ? ["sudo", "-n"] : [];
  const res = await nftApply(
    [...prefix, "nsenter", "-n", "-t", String(input.pid), "nft", "-f", "-"],
    buildRuleset(addresses),
    input.timeoutMs ?? 30_000,
  );
  if (res.code !== 0) {
    return {
      applied: false,
      entries,
      addresses,
      error: res.stderr.trim() || `nft exited ${res.code}`,
    };
  }
  return { applied: true, entries, addresses };
}

/** Feed a ruleset to `nft -f -` and collect its exit status. */
function nftApply(
  argv: string[],
  ruleset: string,
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    if (!file) {
      resolve({ code: 1, stderr: "empty argv" });
      return;
    }
    const child = spawn(file, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    };
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 0));
    child.stdin?.end(ruleset);
  });
}

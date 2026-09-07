/**
 * Egress allowlist enforcement.
 *
 * The pure half checks entry parsing and ruleset shape. The real half starts a
 * container and proves an unlisted host is actually unreachable, because the
 * previous behavior (accept the policy, enforce nothing) would pass any test
 * that only inspected configuration.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { buildRuleset, resolveAllowlist } from "../src/runner/network-allowlist.js";
import { networkFlag } from "../src/runner/podman-argv.js";

const run = promisify(execFile);
const LIVE = process.env.AGENTEVAL_PODMAN === "1";

describe("allowlist entry resolution", () => {
  it("passes an address or CIDR straight through", async () => {
    const out = await resolveAllowlist(["1.1.1.1", "10.0.0.0/8"]);
    expect(out[0]?.addresses).toEqual(["1.1.1.1"]);
    expect(out[1]?.addresses).toEqual(["10.0.0.0/8"]);
  });

  it("strips scheme, credentials, port, and path", async () => {
    const out = await resolveAllowlist([
      "https://1.2.3.4:8443/some/path",
      "user:pw@5.6.7.8",
    ]);
    expect(out[0]?.addresses).toEqual(["1.2.3.4"]);
    expect(out[1]?.addresses).toEqual(["5.6.7.8"]);
  });

  it("reports a name that does not resolve instead of dropping it", async () => {
    // A typo in a package allowlist must not look like a host that is merely
    // down, or the eval author never learns the entry was dead.
    const out = await resolveAllowlist(["definitely-not-a-real-host.invalid"]);
    expect(out[0]?.addresses).toEqual([]);
    expect(out[0]?.error).toBeTruthy();
  });
});

describe("ruleset", () => {
  it("drops by default and keeps DNS and established flows open", () => {
    const rules = buildRuleset(["1.1.1.1"]);
    expect(rules).toContain("policy drop");
    expect(rules).toContain("ct state established,related accept");
    expect(rules).toContain("udp dport 53 accept");
    expect(rules).toContain("elements = { 1.1.1.1 }");
  });

  it("still drops everything when the allowlist resolved to nothing", () => {
    const rules = buildRuleset([]);
    expect(rules).toContain("policy drop");
    expect(rules).not.toContain("elements");
  });

  it("gives allowlist a real interface to filter on", () => {
    expect(networkFlag("allowlist")).toBe("bridge");
    expect(networkFlag("offline")).toBe("none");
  });
});

describe.runIf(LIVE)("real container egress", () => {
  const name = `aeallow-${Date.now().toString(36)}`;

  afterAll(async () => {
    await run("podman", ["rm", "-f", name]).catch(() => undefined);
  });

  it("reaches an allowed address and cannot reach an unlisted one", async () => {
    const { PodmanRuntime } = await import("../src/runner/podman-runtime.js");
    const runtime = new PodmanRuntime();
    const handle = await runtime.run({
      image: "docker.io/library/alpine:latest",
      argv: ["sleep", "300"],
      env: {},
      network: "allowlist",
      networkAllowlist: ["1.1.1.1"],
      limits: {},
      mounts: [],
      timeoutMs: 300_000,
    });
    try {
      // A plain TCP connect, not an HTTP fetch: https://1.1.1.1 redirects to
      // one.one.one.one, which resolves to 1.0.0.1 and is correctly blocked, so
      // a wget here would report a failure the filter is supposed to produce.
      const allowed = await run("podman", [
        "exec", handle.id, "sh", "-c",
        "nc -w 5 -z 1.1.1.1 443 && echo OK || echo FAIL",
      ]);
      expect(allowed.stdout.trim()).toBe("OK");

      const blocked = await run("podman", [
        "exec", handle.id, "sh", "-c",
        "nc -w 5 -z 93.184.216.34 443 && echo LEAK || echo BLOCKED",
      ]);
      expect(blocked.stdout.trim()).toBe("BLOCKED");
    } finally {
      await handle.remove().catch(() => undefined);
    }
  }, 120_000);
});

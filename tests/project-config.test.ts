/**
 * Per-project execution config (plan/projects.md §82): a project refines the
 * global adapter for its codebase — image pin, project env, tool allowlist,
 * network policy — without forking the adapter.
 *
 * Covers the pure resolvers (precedence + malformed-input tolerance). The
 * end-to-end consumption of this config now happens inside the queue worker
 * (startQueueContainer resolves adapter overrides + network mode at launch),
 * which has its own coverage in the queue tests.
 */

import { describe, expect, it } from "vitest";
import {
  resolveAdapterOverrides,
  resolveNetworkMode,
} from "../src/runner/project-config.ts";

// ---------------------------------------------------------------------------
// 1. pure resolver
// ---------------------------------------------------------------------------

describe("resolveNetworkMode", () => {
  it("passes through the valid modes, case/space tolerant", () => {
    expect(resolveNetworkMode("allow")).toBe("allow");
    expect(resolveNetworkMode("allowlist")).toBe("allowlist");
    expect(resolveNetworkMode("offline")).toBe("offline");
    expect(resolveNetworkMode("Allow")).toBe("allow");
  });

  it("falls back to allow for unknown/absent values (never throws)", () => {
    expect(resolveNetworkMode(" ")).toBe("allow");
    expect(resolveNetworkMode("anything-else")).toBe("allow");
    expect(resolveNetworkMode(null)).toBe("allow");
    expect(resolveNetworkMode(undefined)).toBe("allow");
  });
});

describe("resolveAdapterOverrides", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveAdapterOverrides(undefined)).toBeUndefined();
    expect(resolveAdapterOverrides(null)).toBeUndefined();
  });

  it("lifts workspaceImage into the adapter-facing image field", () => {
    const out = resolveAdapterOverrides({ workspaceImage: "ghcr.io/acme/ws" });
    expect(out?.image).toBe("ghcr.io/acme/ws");
  });

  it("prefers an explicit adapterOverrides.image over workspaceImage", () => {
    const out = resolveAdapterOverrides(
      { workspaceImage: "ws", adapterOverrides: { image: "pinned" } },
    );
    expect(out?.image).toBe("pinned");
  });

  it("accepts imageTag (the queue/watcher spelling of an image pin)", () => {
    const out = resolveAdapterOverrides({ adapterOverrides: { imageTag: "tag" } });
    expect(out?.image).toBe("tag");
  });

  it("lets per-run overrides win over project config", () => {
    const out = resolveAdapterOverrides(
      { adapterOverrides: { image: "project-img", env: { A: "project" } } },
      { image: "run-img", env: { A: "run", B: "b" } },
    );
    expect(out?.image).toBe("run-img");
    expect(out?.env).toEqual({ A: "run", B: "b" });
  });

  it("carries env, params, allowedTools, provider and network", () => {
    const out = resolveAdapterOverrides(
      {
        adapterOverrides: {
          env: { REGISTRY: "ghcr.io/acme" },
          params: { attempts: 2 },
          allowedTools: ["read", "write"],
          provider: "nuralwatt",
          network: "offline",
        },
      },
    );
    expect(out?.env).toEqual({ REGISTRY: "ghcr.io/acme" });
    expect(out?.params).toEqual({ attempts: 2 });
    expect(out?.allowedTools).toEqual(["read", "write"]);
    expect(out?.provider).toBe("nuralwatt");
    expect(out?.network).toBe("offline");
  });

  it("drops malformed entries rather than passing them to the adapter", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: {
        env: "not-an-object",
        params: 42,
        allowedTools: "read",
      },
    });
    expect(out?.env).toBeUndefined();
    expect(out?.params).toBeUndefined();
    expect(out?.allowedTools).toBeUndefined();
  });

  it("normalizes an invalid network override to allow", () => {
    const out = resolveAdapterOverrides({
      adapterOverrides: { network: "wide-open" },
    });
    expect(out?.network).toBe("allow");
  });
});

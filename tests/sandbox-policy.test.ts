/**
 * Per-project sandbox controls: the resolver, the podman argv it produces, and
 * the API that exposes both.
 *
 * The contract worth protecting is that a malformed value never reaches the
 * container CLI — it is dropped, and the API's `resolved` block shows the
 * caller what actually survived.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserSandboxPolicy,
  defaultSandboxPolicy,
  nestedContainerSandboxPolicy,
  parseMounts,
  parseTmpfs,
  resolveSandboxPolicy,
  resolveSandboxProfile,
  sandboxPreset,
} from "../src/runner/sandbox-policy.ts";
import {
  buildPodmanRunArgs,
  networkFlag,
  portFlag,
  WORKSPACE_MOUNT,
} from "../src/runner/podman-argv.ts";
import { parsePortOutput } from "../src/runner/podman-runtime.ts";
import type { RunContainerSpec } from "../src/runner/runtime.ts";
import { createServer, type ApiServer } from "../src/api/server.ts";

// ---------------------------------------------------------------------------
// resolver
// ---------------------------------------------------------------------------

describe("resolveSandboxPolicy", () => {
  it("returns permissive-but-plain defaults with no config", () => {
    const p = resolveSandboxPolicy(null);
    expect(p.profile).toBe("standard");
    expect(p.privileged).toBe(false);
    expect(p.autoRemove).toBe(true);
    expect(p.capAdd).toEqual([]);
    expect(p.mounts).toEqual([]);
  });

  it("normalizes capability names to bare uppercase", () => {
    const p = resolveSandboxPolicy({
      capAdd: ["cap_sys_admin", "NET_RAW", " sys_ptrace "],
    });
    expect(p.capAdd).toEqual(["SYS_ADMIN", "NET_RAW", "SYS_PTRACE"]);
  });

  it("accepts snake_case as well as camelCase", () => {
    const p = resolveSandboxPolicy({
      cap_add: ["SYS_ADMIN"],
      shm_size_mib: 512,
      extra_hosts: { "api.local": "10.0.0.5" },
      keep_after_exit: true,
    });
    expect(p.capAdd).toEqual(["SYS_ADMIN"]);
    expect(p.shmSizeMiB).toBe(512);
    expect(p.extraHosts).toEqual({ "api.local": "10.0.0.5" });
    expect(p.keepAfterExit).toBe(true);
  });

  it("infers privileged from the profile, and honors it set outright", () => {
    expect(resolveSandboxPolicy({ profile: "privileged" }).privileged).toBe(true);
    expect(resolveSandboxPolicy({ privileged: true }).privileged).toBe(true);
    expect(resolveSandboxPolicy({ profile: "locked" }).privileged).toBe(false);
  });

  it("keepAfterExit turns off auto-remove (they are one decision)", () => {
    const p = resolveSandboxPolicy({ keepAfterExit: true });
    expect(p.keepAfterExit).toBe(true);
    expect(p.autoRemove).toBe(false);
  });

  it("lets a run override layer on top of project config", () => {
    const p = resolveSandboxPolicy(
      { profile: "standard", shmSizeMiB: 64 },
      { profile: "privileged", shmSizeMiB: 2048 },
    );
    expect(p.profile).toBe("privileged");
    expect(p.shmSizeMiB).toBe(2048);
  });

  it("drops malformed values rather than passing them to the CLI", () => {
    const p = resolveSandboxPolicy({
      profile: "godmode", // unknown → standard
      capAdd: ["SYS_ADMIN", 7, "", null], // non-strings dropped
      shmSizeMiB: -5, // non-positive dropped
      ulimits: { nofile: 65536, bogus: "lots" }, // non-numeric dropped
      dns: ["1.1.1.1", 42],
      devices: "not-an-array",
    });
    expect(p.profile).toBe("standard");
    expect(p.capAdd).toEqual(["SYS_ADMIN"]);
    expect(p.shmSizeMiB).toBeUndefined();
    expect(p.ulimits).toEqual({ nofile: 65536 });
    expect(p.dns).toEqual(["1.1.1.1"]);
    expect(p.devices).toEqual([]);
  });
});

describe("resolveSandboxProfile", () => {
  it("accepts the three profiles and defaults everything else to standard", () => {
    expect(resolveSandboxProfile("locked")).toBe("locked");
    expect(resolveSandboxProfile(" PRIVILEGED ")).toBe("privileged");
    expect(resolveSandboxProfile("standard")).toBe("standard");
    expect(resolveSandboxProfile("nonsense")).toBe("standard");
    expect(resolveSandboxProfile(undefined)).toBe("standard");
  });
});

describe("parseMounts / parseTmpfs", () => {
  it("accepts several spellings and drops incomplete entries", () => {
    expect(
      parseMounts([
        { source: "/host/a", target: "/a" },
        { src: "/host/b", dest: "/b", ro: true },
        { source: "/host/c" }, // no target → dropped
        { target: "/d" }, // no source → dropped
        "nope",
      ]),
    ).toEqual([
      { source: "/host/a", target: "/a" },
      { source: "/host/b", target: "/b", readOnly: true },
    ]);
  });

  it("accepts a bare string as a tmpfs path", () => {
    expect(parseTmpfs(["/scratch", { target: "/fast", sizeMiB: 256 }])).toEqual([
      { target: "/scratch" },
      { target: "/fast", sizeMiB: 256 },
    ]);
  });
});

describe("presets", () => {
  it("browser gets big shm (Chrome dies on the 64 MiB default)", () => {
    const p = browserSandboxPolicy();
    expect(p.shmSizeMiB).toBeGreaterThan(512);
    expect(p.capAdd).toContain("SYS_ADMIN");
    expect(p.init).toBe(true);
  });

  it("nested gets privileged + /dev/fuse", () => {
    const p = nestedContainerSandboxPolicy();
    expect(p.privileged).toBe(true);
    expect(p.devices).toContain("/dev/fuse");
  });

  it("unknown preset names fall back to the default", () => {
    expect(sandboxPreset("nope")).toEqual(defaultSandboxPolicy());
  });
});

// ---------------------------------------------------------------------------
// podman argv
// ---------------------------------------------------------------------------

function spec(over: Partial<RunContainerSpec> = {}): RunContainerSpec {
  return {
    image: "alpine:3.19",
    workspaceDir: "/data/ws",
    argv: ["sh", "-c", "echo hi"],
    env: {},
    limits: { cpus: 2, pids: 128 },
    timeoutMs: 60_000,
    network: "allow",
    nonRoot: false,
    ...over,
  };
}

/** Value that follows `flag` in an argv array. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Every value that follows each occurrence of `flag`. */
function allValuesAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  }
  return out;
}

describe("portFlag", () => {
  it("uses podman's empty-middle syntax for ephemeral ports", () => {
    // `-p 0:8000` is rejected by podman outright; the empty field is required.
    expect(portFlag({ containerPort: 8000 })).toBe("127.0.0.1::8000");
    expect(portFlag({ containerPort: 8000, hostPort: 0 })).toBe("127.0.0.1::8000");
  });

  it("pins an explicitly requested host port", () => {
    expect(portFlag({ containerPort: 8000, hostPort: 13000 })).toBe(
      "127.0.0.1:13000:8000",
    );
  });

  it("carries the protocol", () => {
    expect(portFlag({ containerPort: 53, protocol: "udp" })).toBe(
      "127.0.0.1::53/udp",
    );
  });
});

describe("networkFlag", () => {
  it("maps offline to none and everything else to bridge", () => {
    expect(networkFlag("offline")).toBe("none");
    expect(networkFlag("allow")).toBe("bridge");
    // allowlist is enforced by the firewall layer, not podman's network mode.
    expect(networkFlag("allowlist")).toBe("bridge");
  });
});

describe("buildPodmanRunArgs", () => {
  it("never passes --rm (it races podman wait for the exit code)", () => {
    const args = buildPodmanRunArgs(spec(), defaultSandboxPolicy(), { name: "c" });
    expect(args).not.toContain("--rm");
  });

  it("mounts the workspace read-write and sets it as the workdir", () => {
    const args = buildPodmanRunArgs(spec(), defaultSandboxPolicy(), { name: "c" });
    expect(allValuesAfter(args, "-v")).toContain(`/data/ws:${WORKSPACE_MOUNT}:rw`);
    expect(valueAfter(args, "-w")).toBe(WORKSPACE_MOUNT);
  });

  it("passes resource limits through", () => {
    const args = buildPodmanRunArgs(
      spec({ limits: { cpus: 2, memoryMiB: 512, pids: 64 } }),
      defaultSandboxPolicy(),
      { name: "c" },
    );
    expect(valueAfter(args, "--cpus")).toBe("2");
    expect(valueAfter(args, "--memory")).toBe("512m");
    expect(valueAfter(args, "--pids-limit")).toBe("64");
  });

  it("applies the locked profile as drop-all + read-only + no-new-privileges", () => {
    const args = buildPodmanRunArgs(
      spec(),
      { ...defaultSandboxPolicy(), profile: "locked" },
      { name: "c" },
    );
    expect(allValuesAfter(args, "--cap-drop")).toContain("ALL");
    expect(args).toContain("--read-only");
    expect(allValuesAfter(args, "--security-opt")).toContain("no-new-privileges");
  });

  it("applies the privileged profile and skips the non-root user pin", () => {
    const args = buildPodmanRunArgs(
      spec({ nonRoot: true }),
      nestedContainerSandboxPolicy(),
      { name: "c" },
    );
    expect(args).toContain("--privileged");
    // A privileged sandbox that then drops to uid 1000 defeats the point.
    expect(args).not.toContain("--user");
    expect(allValuesAfter(args, "--device")).toContain("/dev/fuse");
  });

  it("honors nonRoot when not privileged, and an explicit user always wins", () => {
    const asNonRoot = buildPodmanRunArgs(
      spec({ nonRoot: true }),
      defaultSandboxPolicy(),
      { name: "c" },
    );
    expect(valueAfter(asNonRoot, "--user")).toBe("1000:1000");

    const explicit = buildPodmanRunArgs(
      spec({ nonRoot: true }),
      { ...defaultSandboxPolicy(), user: "root" },
      { name: "c" },
    );
    expect(valueAfter(explicit, "--user")).toBe("root");
  });

  it("puts cap drops after adds so a drop always wins", () => {
    const args = buildPodmanRunArgs(
      spec(),
      { ...defaultSandboxPolicy(), capAdd: ["SYS_ADMIN"], capDrop: ["NET_RAW"] },
      { name: "c" },
    );
    expect(args.indexOf("--cap-drop")).toBeGreaterThan(args.indexOf("--cap-add"));
  });

  it("emits mounts, tmpfs, devices, dns, hosts, ulimits and shm", () => {
    const args = buildPodmanRunArgs(
      spec(),
      {
        ...defaultSandboxPolicy(),
        mounts: [{ source: "/cache", target: "/cache", readOnly: true }],
        tmpfs: [{ target: "/scratch", sizeMiB: 256 }],
        devices: ["/dev/fuse"],
        dns: ["1.1.1.1"],
        extraHosts: { "api.local": "10.0.0.5" },
        ulimits: { nofile: 65536 },
        shmSizeMiB: 1024,
      },
      { name: "c" },
    );
    expect(allValuesAfter(args, "-v")).toContain("/cache:/cache:ro");
    expect(allValuesAfter(args, "--tmpfs")).toContain("/scratch:size=256m");
    expect(allValuesAfter(args, "--device")).toContain("/dev/fuse");
    expect(valueAfter(args, "--dns")).toBe("1.1.1.1");
    expect(valueAfter(args, "--add-host")).toBe("api.local:10.0.0.5");
    expect(valueAfter(args, "--ulimit")).toBe("nofile=65536");
    expect(valueAfter(args, "--shm-size")).toBe("1024m");
  });

  it("publishes both spec ports and policy ports", () => {
    const args = buildPodmanRunArgs(
      spec({ ports: [{ containerPort: 3000 }] }),
      { ...defaultSandboxPolicy(), ports: [{ containerPort: 9222, hostPort: 19222 }] },
      { name: "c" },
    );
    const published = allValuesAfter(args, "-p");
    expect(published).toContain("127.0.0.1::3000");
    expect(published).toContain("127.0.0.1:19222:9222");
  });

  it("ends with the image followed by the agent argv", () => {
    const args = buildPodmanRunArgs(
      spec({ argv: ["node", "agent.js", "--flag"] }),
      defaultSandboxPolicy(),
      { name: "c" },
    );
    expect(args.slice(-4)).toEqual(["alpine:3.19", "node", "agent.js", "--flag"]);
  });

  it("passes env as separate argv entries (no shell quoting concerns)", () => {
    const args = buildPodmanRunArgs(
      spec({ env: { TOKEN: "a b'c\"d", EMPTY: "" } }),
      defaultSandboxPolicy(),
      { name: "c" },
    );
    expect(allValuesAfter(args, "-e")).toContain(`TOKEN=a b'c"d`);
    expect(allValuesAfter(args, "-e")).toContain("EMPTY=");
  });
});

describe("parsePortOutput", () => {
  it("reads back resolved host ports and preserves caller-supplied names", () => {
    const out = parsePortOutput(
      "8000/tcp -> 127.0.0.1:35635\n9222/tcp -> 0.0.0.0:41001\n",
      [
        { containerPort: 8000, name: "web" },
        { containerPort: 9222, name: "cdp" },
      ],
    );
    expect(out).toEqual([
      { containerPort: 8000, hostPort: 35635, protocol: "tcp", name: "web" },
      { containerPort: 9222, hostPort: 41001, protocol: "tcp", name: "cdp" },
    ]);
  });

  it("ignores noise and still reports unrequested published ports", () => {
    const out = parsePortOutput("garbage\n53/udp -> 127.0.0.1:15353\n", []);
    expect(out).toEqual([
      { containerPort: 53, hostPort: 15353, protocol: "udp" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function boot(): Promise<{ base: string; api: ApiServer; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-sandbox-api-"));
  const api = createServer({ dataDir, concurrency: 1 });
  const port = await api.listen(0);
  return { base: `http://127.0.0.1:${port}`, api, dataDir };
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* keep {} */
  }
  return { status: res.status, json };
}

describe("sandbox API", () => {
  it("supports the full get/put/patch/delete lifecycle", async () => {
    const { base, api, dataDir } = await boot();
    try {
      const proj = await http(base, "POST", "/api/projects", {
        name: "Sandboxed",
        slug: "sandboxed",
      });
      expect(proj.status).toBe(201);
      const id = proj.json.id as string;

      // Unset → null blob, but a resolved default policy is still reported.
      const initial = await http(base, "GET", `/api/projects/${id}/sandbox`);
      expect(initial.status).toBe(200);
      expect(initial.json.sandbox).toBeNull();
      expect((initial.json.resolved as Record<string, unknown>).profile).toBe(
        "standard",
      );

      // PUT replaces.
      const put = await http(base, "PUT", `/api/projects/${id}/sandbox`, {
        profile: "privileged",
        capAdd: ["SYS_ADMIN"],
        shmSizeMiB: 1024,
      });
      expect(put.status).toBe(200);
      const resolved = put.json.resolved as Record<string, unknown>;
      expect(resolved.profile).toBe("privileged");
      expect(resolved.privileged).toBe(true);
      expect(resolved.cap_add).toEqual(["SYS_ADMIN"]);
      expect(resolved.shm_size_mib).toBe(1024);

      // PATCH merges: shm survives, devices are added.
      const patch = await http(base, "PATCH", `/api/projects/${id}/sandbox`, {
        devices: ["/dev/fuse"],
      });
      const merged = patch.json.resolved as Record<string, unknown>;
      expect(merged.shm_size_mib).toBe(1024);
      expect(merged.devices).toEqual(["/dev/fuse"]);

      // It is visible on the project too.
      const projGet = await http(base, "GET", `/api/projects/${id}`);
      expect((projGet.json.sandbox as Record<string, unknown>).profile).toBe(
        "privileged",
      );

      // DELETE clears back to defaults.
      const del = await http(base, "DELETE", `/api/projects/${id}/sandbox`);
      expect(del.json.sandbox).toBeNull();
      expect((del.json.resolved as Record<string, unknown>).profile).toBe(
        "standard",
      );
    } finally {
      await api.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("expands a named preset and lets explicit fields override it", async () => {
    const { base, api, dataDir } = await boot();
    try {
      const proj = await http(base, "POST", "/api/projects", {
        name: "Browser",
        slug: "browser-proj",
      });
      const id = proj.json.id as string;

      const put = await http(base, "PUT", `/api/projects/${id}/sandbox`, {
        preset: "browser",
        shmSizeMiB: 2048, // override just this
      });
      const resolved = put.json.resolved as Record<string, unknown>;
      expect(resolved.cap_add).toContain("SYS_ADMIN"); // from the preset
      expect(resolved.shm_size_mib).toBe(2048); // from the override
    } finally {
      await api.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an unknown preset and a non-object body", async () => {
    const { base, api, dataDir } = await boot();
    try {
      const proj = await http(base, "POST", "/api/projects", {
        name: "Bad",
        slug: "bad-sandbox",
      });
      const id = proj.json.id as string;

      const bad = await http(base, "PUT", `/api/projects/${id}/sandbox`, {
        preset: "nonexistent",
      });
      expect(bad.status).toBe(400);

      const notObject = await http(base, "PUT", `/api/projects/${id}/sandbox`, [
        1, 2,
      ]);
      expect(notObject.status).toBe(400);

      // Nothing was persisted by the rejected calls.
      const after = await http(base, "GET", `/api/projects/${id}/sandbox`);
      expect(after.json.sandbox).toBeNull();
    } finally {
      await api.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("lists the named presets", async () => {
    const { base, api, dataDir } = await boot();
    try {
      const res = await http(base, "GET", "/api/sandbox/presets");
      expect(res.status).toBe(200);
      const names = (res.json.presets as Array<{ name: string }>).map(
        (p) => p.name,
      );
      expect(names).toContain("browser");
      expect(names).toContain("nested");
    } finally {
      await api.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("404s for an unknown project", async () => {
    const { base, api, dataDir } = await boot();
    try {
      const res = await http(base, "GET", "/api/projects/nope/sandbox");
      expect(res.status).toBe(404);
    } finally {
      await api.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

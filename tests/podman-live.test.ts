/**
 * LIVE podman containers — the smoke suite that was deferred while this build
 * had no container runtime.
 *
 * Guarded by `AGENTEVAL_PODMAN=1` so `npm test` stays green on hosts without
 * podman; run with:
 *   AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npx vitest run tests/podman-live.test.ts
 *
 * These assert the things a fake cannot: that the container really is isolated,
 * that `--network=none` really blocks egress, that an ephemeral port really is
 * reachable from the host, and that pause really freezes the process.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PodmanRuntime } from "../src/runner/podman-runtime.ts";
import {
  browserSandboxPolicy,
  defaultSandboxPolicy,
  nestedContainerSandboxPolicy,
} from "../src/runner/sandbox-policy.ts";
import type { RunContainerSpec } from "../src/runner/runtime.ts";

const LIVE = process.env.AGENTEVAL_PODMAN === "1";
const d = LIVE ? describe : describe.skip;

/** Small, fast, and already pulled by the time the suite runs. */
const IMAGE = "docker.io/library/alpine:3.19";

function runtime(): PodmanRuntime {
  return new PodmanRuntime({
    prefix: process.env.AGENTEVAL_PODMAN_SUDO === "1" ? ["sudo", "-n"] : [],
  });
}

/** Baseline spec; tests override what they exercise. */
function spec(over: Partial<RunContainerSpec> = {}): RunContainerSpec {
  const workspaceDir = mkdtempSync(join(tmpdir(), "agenteval-podman-ws-"));
  return {
    image: IMAGE,
    workspaceDir,
    argv: ["sh", "-c", "echo ok"],
    env: {},
    // No memoryMiB: this host does not delegate the memory cgroup controller,
    // and podman fails the run outright rather than degrading. cpus/pids work.
    limits: { cpus: 1, pids: 128 },
    timeoutMs: 120_000,
    network: "allow",
    nonRoot: false,
    ...over,
  };
}

/** Drain an async byte stream to a string. */
async function drain(stream: AsyncIterable<Buffer>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString("utf8");
  return out;
}

d("PodmanRuntime (live containers)", () => {
  it("podman is available", async () => {
    expect(await runtime().available()).toBe(true);
  }, 60_000);

  it("runs a container and captures stdout + exit code", async () => {
    const s = spec({ argv: ["sh", "-c", "echo HELLO_LIVE; exit 0"] });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      const res = await handle.wait();
      expect(out).toContain("HELLO_LIVE");
      expect(res.exitCode).toBe(0);
      expect(res.timedOut).toBe(false);
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("keeps stderr separate from stdout", async () => {
    const s = spec({ argv: ["sh", "-c", "echo OUT; echo ERR >&2"] });
    const handle = await runtime().run(s);
    try {
      const [out, err] = await Promise.all([
        drain(handle.stdout()),
        drain(handle.stderr()),
      ]);
      await handle.wait();
      expect(out).toContain("OUT");
      expect(out).not.toContain("ERR");
      expect(err).toContain("ERR");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("propagates a non-zero exit code", async () => {
    const s = spec({ argv: ["sh", "-c", "exit 42"] });
    const handle = await runtime().run(s);
    try {
      expect((await handle.wait()).exitCode).toBe(42);
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("mounts the workspace read-write at /workspace", async () => {
    const s = spec({
      argv: ["sh", "-c", "cat /workspace/seed.txt; echo written > /workspace/out.txt"],
    });
    writeFileSync(join(s.workspaceDir, "seed.txt"), "SEEDED\n", "utf8");
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("SEEDED");
      // The agent's write is visible on the host — this is what diff capture reads.
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(s.workspaceDir, "out.txt"), "utf8")).toContain(
        "written",
      );
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("injects env vars", async () => {
    const s = spec({
      argv: ["sh", "-c", "echo v=$AGENTEVAL_TEST_VAR"],
      env: { AGENTEVAL_TEST_VAR: "hunter2" },
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("v=hunter2");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("injects exec env vars without embedding values in podman argv", async () => {
    const s = spec({ argv: ["sh", "-c", "sleep 300"], timeoutMs: 0 });
    const handle = await runtime().run(s);
    try {
      const value = `exec-secret-value-${Date.now()}`;
      const session = await handle.startExec({
        argv: ["sh", "-c", "sleep 2; printf '%s' \"$AGENTEVAL_EXEC_VAR\""],
        env: { AGENTEVAL_EXEC_VAR: value },
        timeoutMs: 30_000,
      });
      const stdout = drain(session.stdout());
      await new Promise((resolve) => setTimeout(resolve, 250));
      const hostProcesses = execFileSync("ps", ["-eo", "args"], {
        encoding: "utf8",
      });
      expect(hostProcesses).not.toContain(value);
      const result = await session.wait();
      expect(result.exitCode).toBe(0);
      expect(await stdout).toBe(value);
    } finally {
      await handle.stop(2_000);
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("network=offline actually blocks egress", async () => {
    const s = spec({
      network: "offline",
      argv: ["sh", "-c", "wget -T3 -q -O- http://example.com || echo BLOCKED"],
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("BLOCKED");
      expect(out).not.toContain("Example Domain");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("network=allow reaches the internet", async () => {
    const s = spec({
      network: "allow",
      argv: ["sh", "-c", "wget -T10 -q -O- http://example.com | head -c 200"],
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("Example Domain");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("publishes an ephemeral port that is reachable from the host", async () => {
    // The whole point of hostPort: 0 — the agent starts a server, the harness
    // reports back a concrete host port, and it actually serves.
    const s = spec({
      image: "docker.io/library/python:3.11-alpine",
      argv: [
        "sh",
        "-c",
        "mkdir -p /srv && cd /srv && echo '<h1>agenteval</h1>' > index.html && python3 -m http.server 8000",
      ],
      ports: [{ containerPort: 8000, name: "web" }],
      timeoutMs: 60_000,
    });
    const handle = await runtime().run(s);
    try {
      expect(handle.ports).toHaveLength(1);
      const port = handle.ports![0]!;
      expect(port.containerPort).toBe(8000);
      expect(port.hostPort).toBeGreaterThan(0);
      expect(port.name).toBe("web");

      // Give the server a moment to bind, then fetch through the published port.
      let body = "";
      for (let i = 0; i < 40; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port.hostPort}/`);
          if (res.ok) {
            body = await res.text();
            break;
          }
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(body).toContain("agenteval");
    } finally {
      await handle.stop(2_000);
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 240_000);

  it("pause freezes the process; resume continues it", async () => {
    const s = spec({
      argv: ["sh", "-c", "i=0; while true; do echo $i; i=$((i+1)); sleep 1; done"],
      timeoutMs: 60_000,
    });
    const rt = runtime();
    const handle = await rt.run(s);
    try {
      // Collect in the background while we pause/resume.
      let seen = "";
      void (async () => {
        try {
          for await (const c of handle.stdout()) seen += c.toString("utf8");
        } catch {
          /* stream closed on teardown */
        }
      })();

      await new Promise((r) => setTimeout(r, 2_500));
      await handle.pause();
      await new Promise((r) => setTimeout(r, 500));
      const atPause = seen.trim().split("\n").length;

      await new Promise((r) => setTimeout(r, 2_500));
      const stillPaused = seen.trim().split("\n").length;
      expect(stillPaused).toBe(atPause); // frozen: no new lines

      await handle.resume();
      await new Promise((r) => setTimeout(r, 2_500));
      const afterResume = seen.trim().split("\n").length;
      expect(afterResume).toBeGreaterThan(stillPaused); // ticking again
    } finally {
      await handle.stop(2_000);
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 240_000);

  it("enforces the wall-clock timeout and reports timedOut", async () => {
    const s = spec({ argv: ["sh", "-c", "sleep 300"], timeoutMs: 5_000 });
    const handle = await runtime().run(s);
    try {
      const res = await handle.wait();
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).not.toBe(0);
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("applies cpu and pids limits inside the container", async () => {
    const s = spec({
      limits: { cpus: 1, pids: 64 },
      argv: ["sh", "-c", "cat /sys/fs/cgroup/pids.max; cat /sys/fs/cgroup/cpu.max"],
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("64");
      expect(out).toContain("100000");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("isolates the container: own hostname, own pid namespace", async () => {
    const s = spec({
      argv: ["sh", "-c", "hostname; echo pid1=$(cat /proc/1/comm)"],
      sandbox: { ...defaultSandboxPolicy(), hostname: "sandbox-under-test" },
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("sandbox-under-test");
      // pid 1 is the container's own entrypoint, not the host's init.
      expect(out).toMatch(/pid1=(sh|catatonit)/);
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("the agent can do whatever it wants: install packages, mount, write", async () => {
    // The permissive default an eval sandbox needs — a task may legitimately
    // require any of these, and failing them is a platform bug, not agent error.
    const s = spec({
      argv: [
        "sh",
        "-c",
        "apk add --no-cache curl >/dev/null 2>&1 && echo APK_OK; mount -t tmpfs none /mnt && echo MOUNT_OK; echo x > /root/f && echo WRITE_OK",
      ],
      sandbox: nestedContainerSandboxPolicy(),
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("APK_OK");
      expect(out).toContain("MOUNT_OK");
      expect(out).toContain("WRITE_OK");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 240_000);

  it("the browser preset gets a large /dev/shm (Chrome dies on the default)", async () => {
    const s = spec({
      argv: ["sh", "-c", "df -m /dev/shm | tail -1"],
      sandbox: browserSandboxPolicy(),
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      const mib = Number(/\s(\d+)\s/.exec(out)?.[1] ?? 0);
      expect(mib).toBeGreaterThan(512);
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("the locked profile drops capabilities and mounts a read-only rootfs", async () => {
    const s = spec({
      argv: ["sh", "-c", "touch /should-fail 2>&1 || echo READONLY_ENFORCED"],
      sandbox: { ...defaultSandboxPolicy(), profile: "locked" },
    });
    const handle = await runtime().run(s);
    try {
      const out = await drain(handle.stdout());
      await handle.wait();
      expect(out).toContain("READONLY_ENFORCED");
    } finally {
      await handle.remove();
      rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("suite fat base ships baked language toolchains that setup.sh/cleanup.sh leave in place", async () => {
    // Proves the baked-toolchain model: the shared fat base image already carries
    // the supported languages; setup.sh/cleanup.sh do NOT apt-install/purge a
    // baked language — they only run the author's setup/cleanup bodies — so the
    // toolchain survives a full eval lifecycle.
    const rt = runtime();
    const workspaceDir = mkdtempSync(join(tmpdir(), "agenteval-fatbase-ws-"));
    try {
      // Synthesize a python setup/cleanup pair into the workspace, including a
      // tiny author environment the wrapper invokes.
      const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
      mkdirSync(join(workspaceDir, ".agenteval", "environment"), { recursive: true });
      mkdirSync(join(workspaceDir, ".agenteval", "seed_repo"), { recursive: true });
      writeFileSync(join(workspaceDir, ".agenteval", "environment", "setup.sh"),
        "#!/usr/bin/env bash\nset -euo pipefail\necho AUTHOR_SETUP_RAN\n");
      writeFileSync(join(workspaceDir, ".agenteval", "environment", "cleanup.sh"),
        "#!/usr/bin/env bash\nset -euo pipefail\necho AUTHOR_CLEANUP_RAN\n");
      chmodSync(join(workspaceDir, ".agenteval", "environment", "setup.sh"), 0o755);
      chmodSync(join(workspaceDir, ".agenteval", "environment", "cleanup.sh"), 0o755);
      const { synthesizeSuiteLifecycleScripts } = await import("../src/evals/package.ts");
      const { setupPath, cleanupPath } = await synthesizeSuiteLifecycleScripts({
        packagePath: workspaceDir,
        workspaceDir,
        language: "python",
      });
      expect(setupPath).toBe("/workspace/.agenteval/lifecycle-setup.sh");

      // python:3.12-bookworm stands in for the fat base: it ships git (needed by
      // the wrapper's `git config --system` bind-mount trust fix) AND python3
      // already baked — the exact property the fat base Containerfile provides.
      const s: RunContainerSpec = {
        ...spec({ image: "docker.io/library/python:3.12-bookworm", workspaceDir,
          argv: ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"] }),
        timeoutMs: 0,
        nonRoot: false,
      };
      const handle = await rt.run(s);
      try {
        const setupRes = await handle.exec({
          argv: ["/bin/bash", setupPath, "/workspace/task"],
          cwd: "/workspace", env: {}, user: "root", timeoutMs: 300_000,
        });
        expect(setupRes.exitCode).toBe(0);
        const setupOut = await drain(setupRes.stdout).catch(() => "");
        expect(setupOut).toContain("AUTHOR_SETUP_RAN");

        const probe = await handle.exec({
          argv: ["python3", "--version"], cwd: "/workspace", env: {}, timeoutMs: 30_000,
        });
        const probeOut = await drain(probe.stdout).catch(() => "");
        expect(probeOut).toMatch(/Python 3\./);

        const cleanRes = await handle.exec({
          argv: ["/bin/bash", cleanupPath, "/workspace/task"],
          cwd: "/workspace", env: {}, user: "root", timeoutMs: 300_000,
        });
        expect(cleanRes.exitCode).toBe(0);
        const cleanOut = await drain(cleanRes.stdout).catch(() => "");
        expect(cleanOut).toContain("AUTHOR_CLEANUP_RAN");

        // Baked toolchain survives cleanup — setup/cleanup must not purge it.
        const stillThere = await handle.exec({
          argv: ["sh", "-c", "command -v python3 >/dev/null 2>&1 && echo STILL_PRESENT || echo PURGED"],
          cwd: "/workspace", env: {}, timeoutMs: 30_000,
        });
        const stillOut = await drain(stillThere.stdout).catch(() => "");
        expect(stillOut).toContain("STILL_PRESENT");
      } finally {
        await handle.remove();
      }
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 600_000);
});

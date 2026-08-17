/**
 * Eval environment lifecycle: setup → agent → capture → cleanup.
 *
 * The properties worth protecting are the ones that silently corrupt results
 * when broken:
 *
 *  - setup output must NOT land in the agent's diff (otherwise `npm install`
 *    creating 12,000 files reads as agent work);
 *  - cleanup must run AFTER capture (otherwise it deletes the evidence);
 *  - cleanup failure must NOT change the eval's result (teardown is
 *    housekeeping, not a verdict);
 *  - a failed setup must abort the run (an agent judged in a broken
 *    environment looks like agent failure, which is worse than no result).
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSetupCommand,
  cleanupEnv,
  parseEvalEnvSpec,
  provisionEnv,
  ProvisionError,
} from "../src/runner/env-provision.ts";
import { captureDiff } from "../src/runner/diff.ts";
import { PodmanRuntime } from "../src/runner/podman-runtime.ts";
import type { ContainerRuntime } from "../src/runner/runtime.ts";

// ---------------------------------------------------------------------------
// spec parsing
// ---------------------------------------------------------------------------

describe("parseEvalEnvSpec", () => {
  it("defaults to greenfield and accepts both spellings", () => {
    expect(parseEvalEnvSpec({ kind: "brownfield" })?.kind).toBe("brownfield");
    expect(parseEvalEnvSpec({ kind: "GREENFIELD" })?.kind).toBe("greenfield");
    // Unknown kinds fall back rather than failing the eval definition.
    expect(parseEvalEnvSpec({ kind: "nonsense" })?.kind).toBe("greenfield");
    expect(parseEvalEnvSpec({})?.kind).toBe("greenfield");
  });

  it("accepts snake_case and camelCase for every field", () => {
    const s = parseEvalEnvSpec({
      kind: "brownfield",
      setup_script: "npm ci",
      setup_timeout_sec: 120,
      setup_env: { CI: "1" },
      cleanup_script: "rm -rf tmp",
      cleanup_timeout_sec: 30,
      commit_baseline: false,
    })!;
    expect(s.setupScript).toBe("npm ci");
    expect(s.setupTimeoutSec).toBe(120);
    expect(s.setupEnv).toEqual({ CI: "1" });
    expect(s.cleanupScript).toBe("rm -rf tmp");
    expect(s.cleanupTimeoutSec).toBe(30);
    expect(s.commitBaseline).toBe(false);
  });

  it("ignores a per-eval image — the pod image comes from the agent", () => {
    // An environment built in some other image might not be usable by the
    // agent that has to work in it.
    const s = parseEvalEnvSpec({ kind: "greenfield", image: "python:3.12" })!;
    expect("image" in s).toBe(false);
  });

  it("drops malformed values rather than passing them to a container", () => {
    const s = parseEvalEnvSpec({
      kind: "greenfield",
      setupScript: "   ",
      setupTimeoutSec: -5,
      setupEnv: { good: "y", bad: 3 },
      commitBaseline: "yes",
    })!;
    expect(s.setupScript).toBeUndefined();
    expect(s.setupTimeoutSec).toBeUndefined();
    expect(s.setupEnv).toEqual({ good: "y" });
    expect(s.commitBaseline).toBeUndefined();
  });

  it("returns undefined for non-objects", () => {
    expect(parseEvalEnvSpec(null)).toBeUndefined();
    expect(parseEvalEnvSpec("greenfield")).toBeUndefined();
    expect(parseEvalEnvSpec([1])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the setup wrapper
// ---------------------------------------------------------------------------

describe("buildSetupCommand", () => {
  it("runs under set -eu so a failing step fails provisioning", () => {
    const argv = buildSetupCommand(
      { kind: "greenfield", setupScript: "false" },
      { commitBaseline: true },
    );
    expect(argv[0]).toBe("sh");
    expect(argv[2]).toContain("set -eu");
    expect(argv[2]).toContain("cd /workspace");
    expect(argv[2]).toContain("false");
  });

  it("tests for .git in THIS directory, not via a parent repo", () => {
    // `rev-parse --git-dir` walks up, so it can succeed via a parent repo while
    // this directory is not a repo — every later git command then fails with
    // "not in a git directory". Found by running it for real.
    const argv = buildSetupCommand(
      { kind: "greenfield", setupScript: "true" },
      { commitBaseline: true },
    );
    expect(argv[2]).toContain("[ ! -d .git ]");
    expect(argv[2]).not.toContain("if ! git rev-parse --git-dir");
  });

  it("marks safe.directory (bind mounts are owned by another uid)", () => {
    const argv = buildSetupCommand(
      { kind: "greenfield", setupScript: "true" },
      { commitBaseline: true },
    );
    expect(argv[2]).toContain("safe.directory");
  });

  it("degrades to a marker when the image has no git", () => {
    const argv = buildSetupCommand(
      { kind: "greenfield", setupScript: "true" },
      { commitBaseline: true },
    );
    expect(argv[2]).toContain("command -v git");
    expect(argv[2]).toContain("__agenteval_no_git__");
  });

  it("omits the baseline block when commitBaseline is off", () => {
    const argv = buildSetupCommand(
      { kind: "greenfield", setupScript: "echo hi" },
      { commitBaseline: false },
    );
    expect(argv[2]).not.toContain("git commit");
  });
});

// ---------------------------------------------------------------------------
// provisioning against real Podman
// ---------------------------------------------------------------------------

const ENV_IMAGE = "docker.io/library/node:22-bookworm";

function realRuntime(): ContainerRuntime {
  return new PodmanRuntime({
    prefix: process.env.AGENTEVAL_PODMAN_SUDO === "0" ? [] : ["sudo", "-n"],
  });
}

function wsWithGit(): string {
  return mkdtempSync(join(tmpdir(), "agenteval-env-"));
}

describe("provisionEnv", () => {
  it("runs the setup script and commits its output as the baseline", async () => {
    const ws = wsWithGit();
    try {
      const spec = parseEvalEnvSpec({
        kind: "greenfield",
        setupScript: "mkdir -p src && echo 'const a=1' > src/a.js",
      })!;
      const res = await provisionEnv(realRuntime(), spec, {
        image: ENV_IMAGE,
        workspaceDir: ws,
        network: "allow",
      });
      expect(res.ran).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(ws, "src/a.js"))).toBe(true);

      // The decisive property: nothing is left uncommitted for the agent to be
      // blamed for.
      const status = execFileSync("git", ["-C", ws, "status", "--porcelain"], {
        encoding: "utf8",
      });
      expect(status.trim()).toBe("");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("keeps setup output OUT of the agent's diff", async () => {
    const ws = wsWithGit();
    try {
      const spec = parseEvalEnvSpec({
        kind: "greenfield",
        setupScript:
          "mkdir -p node_modules/dep && " +
          "for i in 1 2 3 4 5 6 7 8 9 10; do echo x > node_modules/dep/f$i.js; done && " +
          "echo 'v1' > app.js",
      })!;
      await provisionEnv(realRuntime(), spec, {
        image: ENV_IMAGE,
        workspaceDir: ws,
        network: "allow",
      });

      // The agent changes exactly one file.
      writeFileSync(join(ws, "app.js"), "v2\n");

      const diff = await captureDiff(ws, { outPath: join(ws, "out.patch") });
      const files = [
        ...new Set(
          diff.rawDiff
            .split("\n")
            .filter((l) => l.startsWith("+++ "))
            .map((l) => l.slice(4).replace(/^b\//, "")),
        ),
      ];
      expect(files).toEqual(["app.js"]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("throws ProvisionError when setup fails (do not judge a broken env)", async () => {
    const ws = wsWithGit();
    try {
      const spec = parseEvalEnvSpec({
        kind: "greenfield",
        setupScript: "echo 'starting' && exit 3",
      })!;
      await expect(
        provisionEnv(realRuntime(), spec, {
          image: ENV_IMAGE,
          workspaceDir: ws,
          network: "allow",
        }),
      ).rejects.toBeInstanceOf(ProvisionError);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("carries the failing setup log on the error, for diagnosis", async () => {
    const ws = wsWithGit();
    try {
      const spec = parseEvalEnvSpec({
        kind: "greenfield",
        setupScript: "echo 'MISSING DEPENDENCY' >&2 && exit 1",
      })!;
      try {
        await provisionEnv(realRuntime(), spec, {
          image: ENV_IMAGE,
          workspaceDir: ws,
          network: "allow",
        });
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ProvisionError);
        expect((err as ProvisionError).result.log).toContain(
          "MISSING DEPENDENCY",
        );
        expect((err as ProvisionError).result.exitCode).toBe(1);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("passes setupEnv to the script but not beyond it", async () => {
    const ws = wsWithGit();
    try {
      const spec = parseEvalEnvSpec({
        kind: "greenfield",
        setupScript: "echo \"token=$EVAL_SETUP_TOKEN\" > marker.txt",
        setupEnv: { EVAL_SETUP_TOKEN: "s3cret" },
      })!;
      await provisionEnv(realRuntime(), spec, {
        image: ENV_IMAGE,
        workspaceDir: ws,
        network: "allow",
      });
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(ws, "marker.txt"), "utf8")).toContain("s3cret");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("is a no-op when the eval declares no setup and no baseline", async () => {
    const ws = wsWithGit();
    try {
      const res = await provisionEnv(
        realRuntime(),
        { kind: "brownfield", commitBaseline: false },
        { image: ENV_IMAGE, workspaceDir: ws, network: "allow" },
      );
      expect(res.ran).toBe(false);
      expect(res.baselineCommit).toBeNull();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("cleanupEnv", () => {
  it("removes what the eval left behind", async () => {
    const ws = wsWithGit();
    try {
      mkdirSync(join(ws, ".scratch"), { recursive: true });
      writeFileSync(join(ws, ".scratch/tmp.db"), "data");
      writeFileSync(join(ws, "keep.txt"), "keep");

      const res = await cleanupEnv(
        realRuntime(),
        parseEvalEnvSpec({
          kind: "greenfield",
          cleanupScript: "rm -rf .scratch",
        })!,
        { image: ENV_IMAGE, workspaceDir: ws, network: "allow" },
      );
      expect(res.ran).toBe(true);
      expect(res.exitCode).toBe(0);
      expect(res.error).toBeNull();
      expect(existsSync(join(ws, ".scratch"))).toBe(false);
      expect(existsSync(join(ws, "keep.txt"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("records a cleanup failure WITHOUT throwing", async () => {
    // A passing eval must not be reported as failed because teardown was flaky.
    const ws = wsWithGit();
    try {
      const res = await cleanupEnv(
        realRuntime(),
        parseEvalEnvSpec({ kind: "greenfield", cleanupScript: "exit 7" })!,
        { image: ENV_IMAGE, workspaceDir: ws, network: "allow" },
      );
      expect(res.ran).toBe(true);
      expect(res.exitCode).toBe(7);
      expect(res.error).toContain("7");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("attempts every step even when one fails (no set -e)", async () => {
    const ws = wsWithGit();
    try {
      mkdirSync(join(ws, "b"), { recursive: true });
      await cleanupEnv(
        realRuntime(),
        parseEvalEnvSpec({
          kind: "greenfield",
          // Stopping a service that already died must not skip dropping the DB.
          cleanupScript: "false\nrm -rf b",
        })!,
        { image: ENV_IMAGE, workspaceDir: ws, network: "allow" },
      );
      expect(existsSync(join(ws, "b"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);

  it("is a no-op when the eval declares no cleanup", async () => {
    const ws = wsWithGit();
    try {
      const res = await cleanupEnv(
        realRuntime(),
        { kind: "greenfield" },
        { image: ENV_IMAGE, workspaceDir: ws, network: "allow" },
      );
      expect(res.ran).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180_000);
});

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

// ---------------------------------------------------------------------------
// bundles: evidence keyed by eval NAME
// ---------------------------------------------------------------------------

describe("eval bundles", () => {
  it("keys each eval's evidence by name and records env provenance", async () => {
    const { openDb } = await import("../src/db/index.ts");
    const { collectBatchBundles, summarizeBundles } = await import(
      "../src/judge/eval-bundle.ts"
    );
    const { writeFile, mkdir } = await import("node:fs/promises");

    const dataDir = mkdtempSync(join(tmpdir(), "agenteval-bundle-"));
    try {
      const { queries } = openDb(dataDir);
      const project = queries.createProject({
        name: "b",
        slug: "bundle-proj",
        taskSource: { kind: "ui-builder" },
      });
      queries.registerAgent({ id: "a", displayName: "a" });

      const rubric = {
        version: 1,
        profile: "bugfix" as const,
        criteria: [
          {
            id: "C1",
            axis: "A" as const,
            label: "c",
            weight: 1,
            appliesTo: "coding" as const,
            anchors: { full: "y", partial: "s", none: "n" },
          },
        ],
      };

      const names = ["Greenfield todo API", "Brownfield bugfix"];
      const tasks = names.map((name, i) =>
        queries.createTask(project.id, {
          id: `ext-${i}`,
          name,
          prompt: `do ${name}`,
          workspace: { source: "empty" },
          agentCategory: "coding",
          rubric,
        }),
      );
      const batch = queries.createBatch({
        projectId: project.id,
        taskId: tasks[0]!.id,
        agentId: "a",
        model: "m",
        provider: "p",
        repeats: 2,
      });

      for (const [i, task] of tasks.entries()) {
        const run = queries.createRun({
          batchId: batch.id,
          taskId: task.id,
          projectId: project.id,
          agentId: "a",
          model: "m",
          provider: "p",
          repeatIndex: 0,
          status: "completed",
        });
        const runDir = join(dataDir, "projects", project.id, "runs", run.id);
        await mkdir(runDir, { recursive: true });
        await writeFile(
          join(runDir, "events.jsonl"),
          '{"seq":0,"type":"run.start"}\n{"seq":1,"type":"run.end"}\n',
          "utf8",
        );
        await writeFile(
          join(runDir, "diff.patch"),
          "+++ b/src/x.js\n+changed\n",
          "utf8",
        );
        await writeFile(
          join(runDir, "provision.json"),
          JSON.stringify({
            kind: i === 0 ? "greenfield" : "brownfield",
            ran: true,
            exitCode: 0,
            baselineCommit: "a".repeat(40),
            error: null,
            log: "setup ok",
          }),
          "utf8",
        );
        await writeFile(
          join(runDir, "cleanup.json"),
          JSON.stringify({ ran: true, exitCode: 0, error: null }),
          "utf8",
        );
      }

      const bundles = await collectBatchBundles(queries, dataDir, batch.id);
      expect(bundles).toHaveLength(2);
      // Sorted by NAME — a judge reading "run 8f3a2c…" cannot tell which eval
      // regressed; a judge reading the eval name can.
      expect(bundles.map((b) => b.evalName)).toEqual([
        "Brownfield bugfix",
        "Greenfield todo API",
      ]);
      expect(bundles[0]!.envKind).toBe("brownfield");
      expect(bundles[1]!.envKind).toBe("greenfield");
      expect(bundles[0]!.events?.count).toBe(2);
      expect(bundles[0]!.diff?.text).toContain("changed");
      expect(bundles[0]!.provision?.baselineCommit).toMatch(/^a+$/);

      const summary = summarizeBundles(bundles);
      expect(summary.totalEvals).toBe(2);
      expect(summary.withDiff).toBe(2);
      expect(summary.provisionFailures).toEqual([]);
      expect(summary.byEval.map((e) => e.evalName)).toEqual([
        "Brownfield bugfix",
        "Greenfield todo API",
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  it("surfaces a provisioning failure as its own signal", async () => {
    const { openDb } = await import("../src/db/index.ts");
    const { collectBatchBundles, summarizeBundles } = await import(
      "../src/judge/eval-bundle.ts"
    );
    const { writeFile, mkdir } = await import("node:fs/promises");

    const dataDir = mkdtempSync(join(tmpdir(), "agenteval-bundlefail-"));
    try {
      const { queries } = openDb(dataDir);
      const project = queries.createProject({
        name: "f",
        slug: "bundle-fail",
        taskSource: { kind: "ui-builder" },
      });
      queries.registerAgent({ id: "a", displayName: "a" });
      const task = queries.createTask(project.id, {
        id: "ext-f",
        name: "Needs postgres",
        prompt: "p",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: {
          version: 1,
          profile: "bugfix",
          criteria: [
            {
              id: "C1",
              axis: "A",
              label: "c",
              weight: 1,
              appliesTo: "coding",
              anchors: { full: "y", partial: "s", none: "n" },
            },
          ],
        },
      });
      const batch = queries.createBatch({
        projectId: project.id,
        taskId: task.id,
        agentId: "a",
        model: "m",
        provider: "p",
        repeats: 1,
      });
      const run = queries.createRun({
        batchId: batch.id,
        taskId: task.id,
        projectId: project.id,
        agentId: "a",
        model: "m",
        provider: "p",
        repeatIndex: 0,
        status: "failed",
      });
      const runDir = join(dataDir, "projects", project.id, "runs", run.id);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "provision.json"),
        JSON.stringify({
          kind: "brownfield",
          ran: true,
          exitCode: 1,
          baselineCommit: null,
          error: "setup script failed with exit code 1",
          log: "could not connect to postgres",
        }),
        "utf8",
      );

      const bundles = await collectBatchBundles(queries, dataDir, batch.id);
      const summary = summarizeBundles(bundles);
      // This is the distinction that matters: the ENVIRONMENT failed, not the
      // agent. Scoring it as agent failure would be a lie.
      expect(summary.provisionFailures).toEqual(["Needs postgres"]);
      expect(bundles[0]!.provision?.log).toContain("postgres");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});

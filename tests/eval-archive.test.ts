/** Immutable content-addressed eval evidence archives. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryQueries } from "../src/db/queries.ts";
import {
  buildEvalContext,
  resealEvalArchive,
  restructureSuiteArchive,
  sealEvalArchive,
  verifyEvalArchive,
} from "../src/runner/eval-archive.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(async () => {
      // Restore directory permissions only for test teardown if the platform seal succeeded.
      const { chmod } = await import("node:fs/promises");
      await chmod(dir, 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    });
  }
});

describe("eval archive", () => {
  it("seals exact evidence once, verifies hashes, and makes it read-only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-archive-"));
    dirs.push(dataDir);
    const queries = new MemoryQueries(dataDir);
    queries.registerAgent({ id: "pi", displayName: "Pi" });
    const project = queries.createProject({ name: "P", slug: "archive-p" });
    const task = queries.createTask(project.id, {
      id: "eval",
      name: "Eval",
      prompt: "work",
      workspace: { source: "empty" },
      agentCategory: "coding",
      rubric: { version: 1, profile: "bugfix", criteria: [] },
    });
    const batch = queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId: "pi",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      repeats: 1,
    });
    const run = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: "pi",
      model: batch.model,
      provider: batch.provider,
      repeatIndex: 0,
    });
    const runDir = join(dataDir, "projects", project.id, "evals", run.id);
    await mkdir(join(runDir, "retained"), { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), '{"type":"message"}\n');
    await writeFile(join(runDir, "retained", "trace.jsonl"), "native\n");

    const sealed = await sealEvalArchive(queries, runDir, {
      runId: run.id,
      projectId: project.id,
      batchId: batch.id,
    });
    expect(sealed.manifest.files.map((entry) => entry.path)).toEqual([
      "events.jsonl",
      "retained/trace.jsonl",
    ]);
    expect(await verifyEvalArchive(sealed.archive)).toMatchObject({ ok: true, errors: [] });
    // A privileged host user can bypass mode bits, but the immutable manifest
    // must detect any byte change and sealing can never overwrite the revision.
    await writeFile(join(runDir, "events.jsonl"), "changed\n");
    expect(await verifyEvalArchive(sealed.archive)).toMatchObject({ ok: false });
    await expect(
      sealEvalArchive(queries, runDir, {
        runId: run.id,
        projectId: project.id,
        batchId: batch.id,
      }),
    ).rejects.toThrow(/already sealed/);
  });

  it("hoists adapter evidence by manifest role into the browsable layout", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-hoist-"));
    dirs.push(dataDir);
    const runDir = join(dataDir, "run");
    // Retained agent tree mirrors what copyRetainedEvidence produces:
    // retained/agent/<evidence-root>/... (suite: task/.reaper).
    const reaperRoot = join(runDir, "retained", "agent", "task", ".reaper");
    const runLogs = join(reaperRoot, "logs", "exec-1000");
    await mkdir(runLogs, { recursive: true });
    await mkdir(join(reaperRoot, "tmp"), { recursive: true });
    await writeFile(join(runLogs, "session.jsonl"), '{"type":"message"}\n');
    await writeFile(join(runLogs, "conversation.md"), "# conversation\n");
    await writeFile(join(runLogs, "result.json"), '{"reward":1}\n');
    await writeFile(join(reaperRoot, "tmp", "scratch.txt"), "tmp-data\n");

    // The adapter evidence manifest snapshot (what Task #200 writes at claim).
    await writeFile(
      join(runDir, "adapter-evidence.json"),
      JSON.stringify({
        paths: ["task"],
        manifest: [
          { id: "trace", role: "trace", path: "task/.reaper/logs/*/session.jsonl", format: "jsonl", primary: true, select: "latest_mtime" },
          { id: "transcript", role: "transcript", path: "task/.reaper/logs/*/conversation.md", format: "md", primary: true, select: "latest_mtime" },
          { id: "result", role: "result", path: "task/.reaper/logs/*/result.json", format: "json", select: "latest_mtime" },
          { id: "tmp", role: "tmp", path: "task/.reaper/tmp", format: "dir", select: "all" },
        ],
      }, null, 2),
    );

    await restructureSuiteArchive(runDir);

    // Role-typed hoist flattens the deep maze into the browsable layout.
    const { readFile: rf } = await import("node:fs/promises");
    expect(await rf(join(runDir, "session", "session.jsonl"), "utf8")).toContain("message");
    expect(await rf(join(runDir, "session", "conversation.md"), "utf8")).toContain("conversation");
    expect(await rf(join(runDir, "session", "result.json"), "utf8")).toContain("reward");
    expect(await rf(join(runDir, "tmp", "scratch.txt"), "utf8")).toContain("tmp-data");
    // The retained tree is untouched.
    expect(await rf(join(reaperRoot, "logs", "exec-1000", "session.jsonl"), "utf8")).toContain("message");
  });

  it("builds a judge-facing evalContext that binds roles to archive paths", () => {
    const context = buildEvalContext([
      { id: "trace", role: "trace", path: "task/.reaper/logs/*/session.jsonl", format: "jsonl", primary: true, select: "latest_mtime" },
      { id: "transcript", role: "transcript", path: "task/.reaper/logs/*/conversation.md", format: "md" },
      { id: "result", role: "result", path: "task/.reaper/logs/*/result.json", format: "json" },
      { id: "model_calls", role: "model_calls", path: "task/.reaper/logs/*/model-calls", format: "dir" },
      { id: "tmp", role: "tmp", path: "task/.reaper/tmp", format: "dir", select: "all" },
    ]);
    expect(context.roles).toHaveLength(5);
    const byId = new Map(context.roles.map((r) => [r.id, r]));
    // High-signal roles bind to session/; dir roles bind to their folders
    // (the hoist copies the directory's contents INTO the folder); a trailing
    // glob binds the folder since the resolved filename is dynamic.
    expect(byId.get("trace")?.archivePath).toBe("session/session.jsonl");
    expect(byId.get("transcript")?.archivePath).toBe("session/conversation.md");
    expect(byId.get("result")?.archivePath).toBe("session/result.json");
    expect(byId.get("model_calls")?.archivePath).toBe("model-calls");
    expect(byId.get("tmp")?.archivePath).toBe("tmp");
  });

  it("seals and verifies the reorganized archive with a nested manifest location", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-reorg-"));
    dirs.push(dataDir);
    const queries = new MemoryQueries(dataDir);
    queries.registerAgent({ id: "reapercode", displayName: "Reaper" });
    const project = queries.createProject({ name: "P", slug: "reorg-p" });
    const task = queries.createTask(project.id, {
      id: "eval",
      name: "Eval",
      prompt: "work",
      workspace: { source: "empty" },
      agentCategory: "coding",
      rubric: { version: 1, profile: "bugfix", criteria: [] },
    });
    const batch = queries.createBatch({
      taskId: task.id, projectId: project.id, agentId: "reapercode",
      model: "deepseek-v4-flash", provider: "nuralwatt", repeats: 1,
    });
    const run = queries.createRun({
      batchId: batch.id, taskId: task.id, projectId: project.id,
      agentId: "reapercode", model: batch.model, provider: batch.provider, repeatIndex: 0,
    });
    const runDir = join(dataDir, "projects", project.id, "evals", run.id);

    // Retained agent tree + platform files + manifest snapshot (the claim-time state).
    const reaperLogs = join(runDir, "retained", "agent", "task", ".reaper", "logs", "exec-1");
    await mkdir(reaperLogs, { recursive: true });
    await mkdir(join(runDir, "retained", "agent", "task", ".reaper", "tmp"), { recursive: true });
    await writeFile(join(reaperLogs, "session.jsonl"), '{"type":"message"}\n');
    await writeFile(join(reaperLogs, "conversation.md"), "# conversation\n");
    await writeFile(join(reaperLogs, "result.json"), '{"reward":1}\n');
    await writeFile(join(runDir, "retained", "agent", "task", ".reaper", "tmp", "s.txt"), "tmp\n");
    await writeFile(join(runDir, "adapter-evidence.json"), JSON.stringify({
      paths: ["task"],
      manifest: [
        { id: "trace", role: "trace", path: "task/.reaper/logs/*/session.jsonl", format: "jsonl", primary: true, select: "latest_mtime" },
        { id: "transcript", role: "transcript", path: "task/.reaper/logs/*/conversation.md", format: "md", select: "latest_mtime" },
        { id: "result", role: "result", path: "task/.reaper/logs/*/result.json", format: "json", select: "latest_mtime" },
        { id: "tmp", role: "tmp", path: "task/.reaper/tmp", format: "dir", select: "all" },
      ],
    }));
    await writeFile(join(runDir, "run.json"), '{"id":"r"}\n');
    await writeFile(join(runDir, "verifier.json"), '{"officialReward":1}\n');
    await writeFile(join(runDir, "raw-stdout.log"), "stdout\n");
    await writeFile(join(runDir, "raw-stderr.log"), "stderr\n");
    await writeFile(join(runDir, "diff.patch"), "diff\n");
    await writeFile(join(runDir, "events.jsonl"), '{"type":"message"}\n');

    // Full pipeline: manifest hoist → organize → seal → verify.
    await restructureSuiteArchive(runDir);
    const sealed = await sealEvalArchive(queries, runDir, {
      runId: run.id, projectId: project.id, queueId: null, batchId: batch.id,
    });

    const paths = sealed.manifest.files.map((e) => e.path);
    // Reorganized layout: session/, verifier_res/, diffs/, raw_std/, eval_lifecycle_logs/, tmp/.
    expect(paths).toContain("session/session.jsonl");
    expect(paths).toContain("session/conversation.md");
    expect(paths).toContain("session/result.json");
    expect(paths).toContain("verifier_res/verifier-result.json");
    expect(paths).toContain("diffs/diff.patch");
    expect(paths).toContain("raw_std/raw-stdout.log");
    expect(paths).toContain("tmp/s.txt");
    expect(paths).toContain("eval_lifecycle_logs/run.json");
    // The canonical event trace is retained once under lifecycle logs.
    expect(paths).toContain("eval_lifecycle_logs/events.jsonl");
    expect(paths).not.toContain("events.jsonl");
    // No duplication: moved lifecycle files must NOT remain at the run root.
    const rootLevel = paths.filter((p) => !p.includes("/"));
    expect(rootLevel).not.toContain("run.json");
    expect(rootLevel).not.toContain("verifier-result.json");
    expect(rootLevel).not.toContain("diff.patch");
    expect(rootLevel).not.toContain("raw-stdout.log");
    expect(rootLevel).not.toContain("adapter-evidence.json");
    // The manifest records its own nested location.
    expect(sealed.manifest.manifestRel).toBe("eval_lifecycle_logs/archive.json");

    // verifyEvalArchive round-trips through the nested manifest location.
    expect(await verifyEvalArchive(sealed.archive)).toMatchObject({ ok: true, errors: [] });
  });
});

describe("eval archive reseal", () => {
  /** A sealed one-file archive plus a registry that owns its row. */
  async function sealed(runId: string) {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-reseal-"));
    dirs.push(dataDir);
    const root = join(dataDir, "evals", runId);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "evidence.txt"), "base bytes\n");
    const queries = new MemoryQueries(dataDir);
    await sealEvalArchive(queries, root, {
      runId,
      projectId: "proj_1",
      queueId: null,
      batchId: "batch_1",
    });
    return { root, queries, dataDir };
  }

  it("adds a layer in place, records provenance, and updates the archive row", async () => {
    const { root, queries, dataDir } = await sealed("run_reseal_1");
    const src = join(dataDir, "judge-src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "evalJudge.yaml"), "verdict: principled\n");

    const before = queries.getEvalArchive("run_reseal_1")!;
    const { archive, manifest } = await resealEvalArchive({
      runId: "run_reseal_1",
      archiveDir: root,
      layers: [{ name: "judge", sourceDir: src }],
      queries,
    });

    expect(manifest.layers).toEqual(["judge"]);
    expect(manifest.files.map((f) => f.path)).toContain("judge/evalJudge.yaml");
    expect(manifest.files.map((f) => f.path)).toContain("evidence.txt");
    expect(archive!.manifestSha256).not.toBe(before.manifestSha256);
    expect(archive!.sizeBytes).toBeGreaterThan(0);
    expect(archive!.sealedAt).toBe(before.sealedAt);
    expect(await verifyEvalArchive(archive!)).toMatchObject({ ok: true, errors: [] });
  });

  // A repeat of an identical reseal is a no-op, not a failure. Treating it as
  // an error cost one live run its publication: its judge/ was already complete,
  // the retry added nothing, and the item was marked failed beside a sealed
  // ruling.
  it("treats a second reseal of the same layer as a no-op", async () => {
    const { root, queries, dataDir } = await sealed("run_reseal_2");
    const src = join(dataDir, "judge-src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "evalJudge.yaml"), "verdict: principled\n");
    const args = {
      runId: "run_reseal_2",
      archiveDir: root,
      layers: [{ name: "judge", sourceDir: src }],
      queries,
    };
    const first = await resealEvalArchive(args);
    const again = await resealEvalArchive(args);

    expect(again.manifest.layers).toEqual(["judge"]);
    expect(again.manifest.resealedAt).toBe(first.manifest.resealedAt);
    expect(again.archive!.manifestSha256).toBe(first.archive!.manifestSha256);
    expect(await verifyEvalArchive(again.archive!)).toMatchObject({ ok: true, errors: [] });
  });

  it("aborts when a base path changed under the seal", async () => {
    const { root, queries, dataDir } = await sealed("run_reseal_3");
    const src = join(dataDir, "judge-src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "evalJudge.yaml"), "verdict: principled\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(root, 0o755);
    await chmod(join(root, "evidence.txt"), 0o644);
    await writeFile(join(root, "evidence.txt"), "tampered\n");

    await expect(
      resealEvalArchive({
        runId: "run_reseal_3",
        archiveDir: root,
        layers: [{ name: "judge", sourceDir: src }],
        queries,
      }),
    ).rejects.toThrow(/reseal changed a sealed path: evidence\.txt/);
  });

  it("skips a layer whose source is missing and fails when none exist", async () => {
    const { root, queries, dataDir } = await sealed("run_reseal_4");
    const src = join(dataDir, "judge-src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "evalJudge.yaml"), "verdict: principled\n");

    const { manifest } = await resealEvalArchive({
      runId: "run_reseal_4",
      archiveDir: root,
      layers: [
        { name: "judge", sourceDir: src },
        { name: "phase1", sourceDir: join(dataDir, "absent") },
      ],
      queries,
    });
    expect(manifest.layers).toEqual(["judge"]);

    await expect(
      resealEvalArchive({
        runId: "run_reseal_4",
        archiveDir: root,
        layers: [{ name: "phase2", sourceDir: join(dataDir, "absent") }],
        queries,
      }),
    ).rejects.toThrow(/no reseal layer source exists/);
  });
});

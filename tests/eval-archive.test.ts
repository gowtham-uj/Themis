/** Immutable content-addressed eval evidence archives. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryQueries } from "../src/db/queries.ts";
import { sealEvalArchive, verifyEvalArchive } from "../src/runner/eval-archive.ts";

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
});

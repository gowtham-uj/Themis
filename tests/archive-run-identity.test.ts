/** Archive API joins eval evidence to its project-level run and serves resealed bytes. */
import Database from "better-sqlite3";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createServer, type ApiServer } from "../src/api/server.ts";
import { MemoryQueries } from "../src/db/queries.ts";
import { createSqlitePhase2Db } from "../src/db/phase2/sqlite-store.ts";
import { resealEvalArchive, sealEvalArchive } from "../src/runner/eval-archive.ts";

const dirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

describe("archive project-run identity", () => {
  it("lists the run name and reads the archive after an in-place reseal", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-archive-run-"));
    dirs.push(dataDir);
    const queries = new MemoryQueries(dataDir);
    queries.registerAgent({ id: "reapercode", displayName: "ReaperCode" });
    const project = queries.createProject({ name: "Human project", slug: "human-project" });
    const task = queries.createTask(project.id, {
      id: "eval-one",
      name: "Eval one",
      prompt: "work",
      workspace: { source: "empty" },
      agentCategory: "coding",
      rubric: { version: 1, profile: "bugfix", criteria: [] },
    });
    const batch = queries.createBatch({
      taskId: task.id,
      projectId: project.id,
      agentId: "reapercode",
      model: "zai-org/GLM-5.3-Flash",
      provider: "deepinfra",
      repeats: 1,
    });
    const run = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: "reapercode",
      model: batch.model,
      provider: batch.provider,
      repeatIndex: 0,
    });

    const runDir = join(dataDir, "projects", project.id, "evals", run.id);
    await mkdir(join(runDir, "retained"), { recursive: true });
    await writeFile(join(runDir, "retained", "evidence.txt"), "base\n");
    await sealEvalArchive(queries, runDir, {
      runId: run.id,
      projectId: project.id,
      batchId: batch.id,
    });
    const judgeDir = join(dataDir, "judge-source");
    await mkdir(judgeDir, { recursive: true });
    await writeFile(join(judgeDir, "evalJudge.yaml"), "verdict: sound\n");
    await resealEvalArchive({
      runId: run.id,
      archiveDir: runDir,
      layers: [{ name: "judge", sourceDir: judgeDir }],
      queries,
    });

    const pipeline = createSqlitePhase2Db(new Database(join(dataDir, "themis.sqlite")));
    const queue = await pipeline.pipeline.createQueue({
      projectId: project.id,
      evalQueueId: "eval-queue",
      name: "pipeline",
    });
    const generation = await pipeline.pipeline.createGeneration({
      queueId: queue.id,
      name: "Release candidate",
      configJson: "{}",
    });
    const item = await pipeline.pipeline.addItem({ generationId: generation.id, evalId: task.id, ordinal: 1 });
    await pipeline.pipeline.updateItem(item.id, "eval_pending", {
      state: "phase1_published",
      runId: run.id,
      baseArchiveId: run.id,
    });
    await pipeline.close();

    const server = createServer({ dataDir, queries, reconcileOrphans: false });
    servers.push(server);
    const port = await server.listen(0);
    const base = `http://127.0.0.1:${port}`;

    const listed = await fetch(`${base}/api/archives`).then((response) => response.json());
    expect(listed.archives[0]).toMatchObject({
      projectName: "Human project",
      pipelineRunId: generation.id,
      runName: "Release candidate",
      runOrdinal: 1,
      agent: { id: "reapercode", name: "ReaperCode" },
    });
    expect(listed.archives[0]).not.toHaveProperty("dataDir");
    expect(listed.archives[0]).not.toHaveProperty("storagePath");

    const contents = await fetch(`${base}/api/archives/${run.id}/contents`).then((response) => response.json());
    expect(contents.layers).toEqual(["judge"]);
    expect(contents.files.map((file: { path: string }) => file.path)).toContain("judge/evalJudge.yaml");

    const file = await fetch(`${base}/api/archives/${run.id}/file?path=${encodeURIComponent("judge/evalJudge.yaml")}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("verdict: sound\n");
  });
});

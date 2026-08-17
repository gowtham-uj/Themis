/** Central eval-res archive listing, filtering, and file retrieval API. */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { storeEvalArchive } from "../src/runner/archive-store.ts";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function createArchive(dataDir: string, input: {
  projectId: string;
  commit: string;
  queueId: string;
  batchId: string;
  runId: string;
  taskId: string;
  taskName: string;
  model: string;
  provider: string;
  status: string;
  reward: number;
  archivedAt: string;
}): Promise<void> {
  const sealed = join(dataDir, "sealed", input.runId);
  await mkdir(join(sealed, "retained"), { recursive: true });
  await writeFile(join(sealed, "retained", "trace.jsonl"), '{"type":"message"}\n');
  const dest = await storeEvalArchive({
    dataDir,
    sealedArchiveDir: sealed,
    entry: {
      projectId: input.projectId,
      projectName: `Project ${input.projectId}`,
      queueId: input.queueId,
      queueName: `Queue ${input.queueId}`,
      batchId: input.batchId,
      runId: input.runId,
      taskId: input.taskId,
      taskName: input.taskName,
      agentId: "reapercode",
      agentCommit: input.commit,
      agentImage: "localhost/reapercode:test",
      agentImageId: null,
      agentVersion: input.commit.slice(0, 8),
      buildId: null,
      queueRevision: null,
      model: input.model,
      provider: input.provider,
      status: input.status,
      reward: input.reward,
      sealedAt: input.archivedAt,
    },
  });
  // Pin archivedAt so pagination tests are deterministic.
  const manifestPath = join(dest, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.archivedAt = input.archivedAt;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const indexPath = join(dataDir, "archives", "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as { archives: Array<Record<string, unknown>> };
  const row = index.archives.find((item) => item.runId === input.runId);
  if (row) row.archivedAt = input.archivedAt;
  index.archives.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

async function boot(): Promise<{ dataDir: string; base: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-archive-api-"));
  tempDirs.push(dataDir);
  const api = createServer({ dataDir, reconcileOrphans: false });
  servers.push(api);
  const port = await api.listen(0);
  return { dataDir, base: `http://127.0.0.1:${port}` };
}

describe("archive API", () => {
  it("stores archives as siblings of one index, not nested by project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenteval-archive-flat-"));
    tempDirs.push(dataDir);
    const sealed = join(dataDir, "sealed");
    await mkdir(sealed, { recursive: true });
    await writeFile(join(sealed, "run-metrics.json"), '{"schemaVersion":1}\n');
    await storeEvalArchive({
      dataDir,
      sealedArchiveDir: sealed,
      entry: {
        projectId: "proj-1",
        projectName: "Demo",
        queueId: "queue-1",
        queueName: "Nightly",
        batchId: "batch-1",
        runId: "run-1",
        taskId: "task-1",
        taskName: "Ring queue",
        agentId: "reapercode",
        agentCommit: "abc123def456",
        agentImage: "localhost/reapercode:test",
        agentImageId: "sha256:deadbeef",
        agentVersion: "abc123def456".slice(0, 12),
        buildId: "build-1",
        queueRevision: 3,
        model: "deepseek-v4-flash",
        provider: "nuralwatt",
        status: "completed",
        reward: 1,
        sealedAt: "2026-08-13T00:00:00.000Z",
      },
    });

    const names = (await readdir(join(dataDir, "archives"))).sort();
    expect(names).toEqual(["index.json", "run-1"]);
    const index = JSON.parse(await readFile(join(dataDir, "archives", "index.json"), "utf8")) as {
      archives: Array<{ runId: string; projectId: string; agentCommit: string }>;
    };
    expect(index.archives).toHaveLength(1);
    expect(index.archives[0]).toMatchObject({
      runId: "run-1",
      projectId: "proj-1",
      agentCommit: "abc123def456",
    });
  });

  it("lists all project archives with granular filters and pagination", async () => {
    const { dataDir, base } = await boot();
    await createArchive(dataDir, {
      projectId: "p1",
      commit: "abc123",
      queueId: "q1",
      batchId: "b1",
      runId: "r1",
      taskId: "javascript-batch-packer",
      taskName: "JavaScript batch packer",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      status: "completed",
      reward: 1,
      archivedAt: "2026-08-13T00:00:00.000Z",
    });
    await createArchive(dataDir, {
      projectId: "p2",
      commit: "def456",
      queueId: "q2",
      batchId: "b2",
      runId: "r2",
      taskId: "python-retry",
      taskName: "Python retry",
      model: "other-model",
      provider: "other-provider",
      status: "failed",
      reward: 0,
      archivedAt: "2026-08-13T01:00:00.000Z",
    });

    const all = await fetch(`${base}/api/archives`).then((response) => response.json());
    expect(all).toMatchObject({ total: 2, count: 2 });
    expect(all.archives.map((entry: { runId: string }) => entry.runId)).toEqual(["r2", "r1"]);
    expect(all.archives.every((entry: Record<string, unknown>) => !("storagePath" in entry))).toBe(true);

    const filtered = await fetch(
      `${base}/api/archives?project_id=p1&agent_commit=abc&queue_id=q1&batch_id=b1&run_id=r1&task_id=javascript&task_name=batch&agent_id=reapercode&model=deepseek&provider=nural&status=COMPLETED&reward=1`,
    ).then((response) => response.json());
    expect(filtered).toMatchObject({ total: 1, count: 1 });
    expect(filtered.archives[0]).toMatchObject({ projectId: "p1", runId: "r1", taskId: "javascript-batch-packer" });

    const page = await fetch(`${base}/api/archives?limit=1&offset=1`).then((response) => response.json());
    expect(page).toMatchObject({ total: 2, count: 1, limit: 1, offset: 1 });
    expect(page.archives[0].runId).toBe("r1");
  });

  it("addresses one archive by run id and keeps nested project/commit aliases", async () => {
    const { dataDir, base } = await boot();
    await createArchive(dataDir, {
      projectId: "p1",
      commit: "abc123",
      queueId: "q1",
      batchId: "b1",
      runId: "r1",
      taskId: "task-1",
      taskName: "Task one",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      status: "completed",
      reward: 1,
      archivedAt: "2026-08-13T00:00:00.000Z",
    });

    const project = await fetch(`${base}/api/projects/p1/archives`).then((response) => response.json());
    expect(project).toMatchObject({ projectId: "p1", total: 1 });

    const byRun = await fetch(`${base}/api/archives/r1`).then((response) => response.json());
    expect(byRun.archive).toMatchObject({ runId: "r1", taskId: "task-1", projectId: "p1" });

    const fileResponse = await fetch(`${base}/api/archives/r1/files/retained/trace.jsonl`);
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers.get("content-disposition")).toContain("attachment");
    expect(await fileResponse.text()).toBe('{"type":"message"}\n');

    const missing = await fetch(`${base}/api/archives/r1/files/missing.txt`);
    expect(missing.status).toBe(404);

    const traversal = await fetch(`${base}/api/archives/r1/files/..%2F..%2Fsecret.txt`);
    expect(traversal.status).toBe(404);

    const commit = await fetch(`${base}/api/archives/p1/abc123`).then((response) => response.json());
    expect(commit).toMatchObject({ projectId: "p1", agentCommit: "abc123", total: 1 });

    const manifest = await fetch(`${base}/api/archives/p1/abc123/r1`).then((response) => response.json());
    expect(manifest.archive).toMatchObject({ runId: "r1", taskId: "task-1" });

    const nestedFile = await fetch(`${base}/api/archives/p1/abc123/r1/files/retained/trace.jsonl`);
    expect(nestedFile.status).toBe(200);
    expect(await nestedFile.text()).toBe('{"type":"message"}\n');
  });
});

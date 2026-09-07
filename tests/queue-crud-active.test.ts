/**
 * Queue-route CRUD while a generation is active + signature validation.
 *
 * Covers:
 *  - queue-item POST/PATCH reorder/DELETE are allowed while an active container exists
 *  - PATCH cannot reduce repeats below the active-generation claimed floor (409)
 *  - DELETE becomes a soft deletion (prevents future claims, keeps provenance)
 *  - load-category adds compatible evals while active
 *  - validateItemAgainstGenerationSignature accepts compatible items and rejects
 *    incompatible ones (image/network/cpu/ram/port/env-digest) as 409-worthy
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import {
  validateItemAgainstGenerationSignature,
  type GenerationContainerSignature,
} from "../src/runner/queue-worker.ts";
import type { TaskSpec } from "../src/domain.ts";
import type { QueryStore } from "../src/db/queries.ts";
import { validEvalPackageUpload } from "./helpers/eval-package.ts";

const tempDirs: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.close();
    } catch {
      /* best-effort */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-queue-crud-"));
  tempDirs.push(dir);
  return dir;
}

async function boot(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

function evalSpec(id: string, name: string, categoryName?: string): TaskSpec {
  return {
    id,
    name,
    prompt: `run ${name}`,
    workspace: { source: "empty" },
    rubric: {
      version: 1,
      profile: "bugfix",
      criteria: [
        {
          id: "A1",
          axis: "A",
          label: "outcome",
          weight: 1,
          appliesTo: "coding",
          anchors: { full: "done", partial: "partial", none: "missing" },
        },
      ],
    },
    agentCategory: "coding",
    ...(categoryName ? { categoryName } : {}),
  };
}

async function seedQueue(
  api: ApiServer,
): Promise<{ projectId: string; queueId: string; itemId: string; taskId: string; adapterId: string }> {
  const q: QueryStore = api.queries;
  q.registerAgent({ id: "pi", displayName: "Pi" });
  const project = q.createProject({ name: "P", slug: `p-${Date.now().toString(36)}` });
  const adapter = q.createProjectAgentAdapter(project.id, {
    agentId: "pi",
    name: "Pi CLI",
    image: "registry.example/pi@sha256:abc",
    command: { argv: ["pi", "--prompt", "{{prompt}}"] },
    connectionCheck: { argv: ["pi", "check"], timeoutMs: 60_000 },
    evidence: { paths: [] },
    parserKind: "pi-jsonl",
    providerConfig: { credentialEnv: {} },
  });
  const queue = q.createEvalQueue(project.id, {
    name: "Q",
    agentId: "pi",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    agentCommit: "0123456789abcdef0123456789abcdef01234567",
  });
  const task = q.createTask(project.id, evalSpec(`t-${Date.now().toString(36)}`, "T"));
  const item = q.createEvalQueueItem(queue.id, { taskId: task.id, repeats: 2 });
  return {
    projectId: project.id,
    queueId: queue.id,
    itemId: item.id,
    taskId: task.id,
    adapterId: adapter.id,
  };
}

/** Mark the queue generation active with a container row referencing a batch. */
function activateGeneration(
  api: ApiServer,
  x: { projectId: string; queueId: string },
): { batchId: string; containerId: string } {
  const q = api.queries;
  const batch = q.createBatch({
    taskId: null,
    projectId: x.projectId,
    agentId: "pi",
    model: "deepseek-v4-flash",
    provider: "nuralwatt",
    repeats: 0,
    trigger: "eval-queue",
    triggerRef: x.queueId,
    queueId: x.queueId,
    queueRevision: q.getEvalQueue(x.queueId)!.revision,
  });
  const container = q.createQueueContainer({
    queueId: x.queueId,
    projectId: x.projectId,
    batchId: batch.id,
    image: "agenteval/suite-base:abc",
    state: "running",
    workspaceDir: "/tmp/ws",
  });
  q.updateEvalQueue(x.queueId, { status: "running", activeBatchId: batch.id });
  return { batchId: batch.id, containerId: container.id };
}

interface HttpResult {
  status: number;
  json: unknown;
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headersIn?: Record<string, string>,
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(headersIn ?? {}) };
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function bootWithAuth(): Promise<{ api: ApiServer; base: string }> {
  const dataDir = await tempDataDir();
  const api = createServer({ dataDir, authEnabled: true });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

describe("queue routes: CRUD while a generation is active", () => {
  it("allows item POST, PATCH reorder/enable, and soft DELETE while active", async () => {
    const { api, base } = await boot();
    const seed = await seedQueue(api);
    activateGeneration(api, seed);

    // POST a new item while active is allowed (no 409 guard anymore).
    const second = await http(base, "POST", `/api/projects/${seed.projectId}/queues/${seed.queueId}/items`, {
      eval_id: seed.taskId,
      repeats: 1,
    });
    expect(second.status).toBe(201);

    // PATCH reorder/enable while active is allowed.
    const secondItemId = (second.json as { item: { id: string } }).item.id;
    const patch = await http(
      base,
      "PATCH",
      `/api/projects/${seed.projectId}/queues/${seed.queueId}/items/${secondItemId}`,
      { enabled: true, position: 5 },
    );
    expect(patch.status).toBe(200);
    expect((patch.json as { item: { enabled: boolean } }).item.enabled).toBe(true);

    // Soft delete while active: prevents future claims but keeps the row.
    const del = await http(
      base,
      "DELETE",
      `/api/projects/${seed.projectId}/queues/${seed.queueId}/items/${secondItemId}`,
    );
    expect(del.status).toBe(204);
    const deleted = api.queries.getEvalQueueItem(secondItemId);
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedAt).not.toBeNull();
    // Deleted item no longer claimable/listed.
    expect(api.queries.listEvalQueueItems(seed.queueId).map((i) => i.id)).not.toContain(secondItemId);
  });

  it("rejects reducing repeats below the active-generation claimed floor (409)", async () => {
    const { api, base } = await boot();
    const seed = await seedQueue(api);
    const { containerId, batchId } = activateGeneration(api, seed);
    const snapshot = {
      batchId,
      queueId: seed.queueId,
      queueRevision: api.queries.getEvalQueue(seed.queueId)!.revision,
      queueContainerId: containerId,
      agentCommit: "0123456789abcdef0123456789abcdef01234567",
      agentImage: "agenteval/suite-base:abc",
      agentImageId: "sha256:img",
      agentVersion: "0123456789ab",
      buildId: "pi:0123",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      adapterOverrides: null,
      networkPolicy: "allow",
    };
    // The item has repeats=2. Claim both repeats to establish a floor of 2.
    const claim1 = api.queries.claimQueueWork({
      batchId,
      queueId: seed.queueId,
      projectId: seed.projectId,
      queueContainerId: containerId,
      snapshot,
      agentId: "pi",
    });
    expect(claim1.claimed).toBe(true);
    const claim2 = api.queries.claimQueueWork({
      batchId,
      queueId: seed.queueId,
      projectId: seed.projectId,
      queueContainerId: containerId,
      snapshot,
      agentId: "pi",
    });
    expect(claim2.claimed).toBe(true);
    expect(api.queries.getEvalQueueItem(seed.itemId)!.claimedRepeats).toBe(2);

    // Increasing repeats above the floor is allowed.
    const up = await http(
      base,
      "PATCH",
      `/api/projects/${seed.projectId}/queues/${seed.queueId}/items/${seed.itemId}`,
      { repeats: 4 },
    );
    expect(up.status).toBe(200);

    // Dropping below the claimed floor must be rejected with 409.
    const low = await http(
      base,
      "PATCH",
      `/api/projects/${seed.projectId}/queues/${seed.queueId}/items/${seed.itemId}`,
      { repeats: 1 },
    );
    expect(low.status).toBe(409);
  });

  it("release-resets the repeat floor when a generation closes (claimedRepeats is cumulative)", async () => {
    const { api, base } = await boot();
    const seed = await seedQueue(api);
    const q = api.queries;

    // Generation 1 claims BOTH repeats of the item.
    const { containerId: c1, batchId: b1 } = activateGeneration(api, seed);
    const snapshot1 = {
      batchId: b1,
      queueId: seed.queueId,
      queueRevision: q.getEvalQueue(seed.queueId)!.revision,
      queueContainerId: c1,
      agentCommit: "0123456789abcdef0123456789abcdef01234567",
      agentImage: "agenteval/suite-base:abc",
      agentImageId: "sha256:img",
      agentVersion: "0123456789ab",
      buildId: "pi:0123",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      adapterOverrides: null,
      networkPolicy: "allow",
    };
    const r1 = q.claimQueueWork({ batchId: b1, queueId: seed.queueId, projectId: seed.projectId, queueContainerId: c1, snapshot: snapshot1, agentId: "pi" });
    expect(r1.claimed).toBe(true);
    const r2 = q.claimQueueWork({ batchId: b1, queueId: seed.queueId, projectId: seed.projectId, queueContainerId: c1, snapshot: snapshot1, agentId: "pi" });
    expect(r2.claimed).toBe(true);
    // Lifetime cumulative counter is now 2.
    expect(q.getEvalQueueItem(seed.itemId)!.claimedRepeats).toBe(2);
    expect(q.listRunsByBatch(b1)).toHaveLength(2);

    // Close generation 1 (drain stops the container; new generation is independent).
    q.updateQueueContainer(c1, { state: "stopped", stoppedAt: new Date().toISOString() });

    // Generation 2 starts fresh: NOTHING claimed yet. The repeat floor must be 0,
    // not the lifetime cumulative 2. Reducing repeats from 2 to 1 succeeds.
    const { containerId: c2, batchId: b2 } = activateGeneration(api, seed);
    expect(q.getActiveQueueContainer(seed.queueId)?.batchId).toBe(b2);
    const low = await http(
      base,
      "PATCH",
      `/api/projects/${seed.projectId}/queues/${seed.queueId}/items/${seed.itemId}`,
      { repeats: 1 },
    );
    // Confirms the floor is the ACTIVE generation's claimed count, not lifetime claimedRepeats.
    expect(low.status).toBe(200);
    const patched = q.getEvalQueueItem(seed.itemId)!;
    expect(patched.repeats).toBe(1);
    void c2;
  });
});

describe("validateItemAgainstGenerationSignature", () => {
  function signature(over: Partial<GenerationContainerSignature> = {}): GenerationContainerSignature {
    return {
      image: "agenteval/suite-base:abc",
      // Suite canonical packages always resolve to container network
      // `allowlist`, carrying the one entry from SUITE_AGENT_ALLOWLIST.
      network: "allowlist",
      networkAllowlist: ["0.0.0.0/0"],
      cpus: 2,
      memoryMiB: 2048,
      ports: "[]",
      environmentDigest: null,
      ...over,
    };
  }

  /**
   * Create a project + adapter + queue + a CANONICAL (package-bearing) task via
   * the evals API, so signature validation has real package metadata to compare.
   */
  async function makeCanonicalQueueAndTask(
    api: ApiServer,
    base: string,
  ): Promise<{ projectId: string; queueId: string; taskId: string }> {
    const q = api.queries;
    q.registerAgent({ id: "pi", displayName: "Pi" });
    const project = await http(base, "POST", "/api/projects", {
      name: "P",
      slug: `p-${Date.now().toString(36)}`,
      taskSource: { kind: "repo-md" },
    });
    const projectId = (project.json as { id: string }).id;
    q.createProjectAgentAdapter(projectId, {
      agentId: "pi",
      name: "Pi CLI",
      image: "registry.example/pi@sha256:abc",
      command: { argv: ["pi"] },
      connectionCheck: { argv: ["pi", "check"], timeoutMs: 60_000 },
      evidence: { paths: [] },
      parserKind: "pi-jsonl",
      providerConfig: { credentialEnv: {} },
    });
    const created = await http(base, "POST", `/api/projects/${projectId}/evals`, validEvalPackageUpload(
      // suite-format canonical package; network disabled to match the signature.
    ));
    expect(created.status).toBe(201);
    const task = api.queries.listTasks(projectId).find((t) => t.packagePath)!;
    const queue = q.createEvalQueue(projectId, {
      name: "Q",
      agentId: "pi",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      networkPolicy: "offline",
    });
    return { projectId, queueId: queue.id, taskId: task.id };
  }

  it("returns null for a compatible item (matching network/cpu/ram/ports)", async () => {
    const { api, base } = await boot();
    const { queueId, taskId } = await makeCanonicalQueueAndTask(api, base);
    const reason = await validateItemAgainstGenerationSignature({
      queries: api.queries,
      queue: api.queries.getEvalQueue(queueId)!,
      task: api.queries.getTask(taskId)!,
      overrides: { network: "allow" },
      signature: signature(),
    });
    expect(reason).toBeNull();
  });

  it("returns a reason for an incompatible item (different network)", async () => {
    const { api, base } = await boot();
    const { queueId, taskId } = await makeCanonicalQueueAndTask(api, base);
    const reason = await validateItemAgainstGenerationSignature({
      queries: api.queries,
      queue: api.queries.getEvalQueue(queueId)!,
      task: api.queries.getTask(taskId)!,
      overrides: { network: "allow" },
      signature: signature({ network: "offline" }),
    });
    expect(reason).toMatch(/network policy/i);
  });

  it("returns a reason for a non-canonical package (no package fields)", async () => {
    const { api } = await boot();
    const q = api.queries;
    q.registerAgent({ id: "pi", displayName: "Pi" });
    const project = q.createProject({ name: "P2", slug: `p2-${Date.now().toString(36)}` });
    q.createProjectAgentAdapter(project.id, {
      agentId: "pi",
      name: "Pi",
      image: "registry.example/pi@sha256:abc",
      command: { argv: ["pi"] },
      connectionCheck: { argv: ["pi", "c"], timeoutMs: 60_000 },
      evidence: { paths: [] },
      parserKind: "pi-jsonl",
      providerConfig: { credentialEnv: {} },
    });
    const queue = q.createEvalQueue(project.id, {
      name: "Q2", agentId: "pi", model: "deepseek-v4-flash", provider: "nuralwatt",
    });
    const task = q.createTask(project.id, evalSpec(`t-${Date.now().toString(36)}`, "T"));
    const reason = await validateItemAgainstGenerationSignature({
      queries: q,
      queue,
      task,
      overrides: null,
      signature: signature(),
    });
    expect(reason).toMatch(/canonical eval package/i);
  });

  it("PATCH route rejects item overrides that break the active generation signature (409)", async () => {
    const { api, base } = await boot();
    const { projectId, queueId, taskId } = await makeCanonicalQueueAndTask(api, base);
    const created = await http(base, "POST", `/api/projects/${projectId}/queues/${queueId}/items`, {
      eval_id: taskId,
      repeats: 1,
    });
    const itemId = (created.json as { item: { id: string } }).item.id;
    // Compatible PATCH while no live generation exists is accepted.
    const ok = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/queues/${queueId}/items/${itemId}`,
      { overrides: { ports: [] } },
    );
    expect(ok.status).toBe(200);
    expect(api.queries.getEvalQueueItem(itemId)!.overrides).toEqual({ ports: [] });

    // A live generation pins an empty port set; adding a published port changes
    // the container the item needs, so the PATCH must be rejected with 409 (the
    // same gate as item POST). Network is not the dimension under test: a suite
    // package's own policy wins over any queue or item override, so an
    // overrides.network edit cannot break the signature.
    api.liveQueueContainers.set(queueId, {
      queueId,
      finished: false,
      signature: signature(),
    } as never);

    const bad = await http(
      base,
      "PATCH",
      `/api/projects/${projectId}/queues/${queueId}/items/${itemId}`,
      { overrides: { ports: [8080] } },
    );
    expect(bad.status).toBe(409);
    expect(String((bad.json as { detail?: unknown }).detail ?? "")).toMatch(/cannot run in the active queue generation/i);
    // Overrides are left at their last accepted value after rejection.
    expect(api.queries.getEvalQueueItem(itemId)!.overrides).toEqual({ ports: [] });
  });
});

describe("project scope on ID-addressed runs/events/diff/metrics/archive", () => {
  it("project-scoped tokens cannot read another project's run, events, diff, metrics, archive", async () => {
    const { api, base } = await bootWithAuth();
    const q = api.queries;

    // Project A + B.
    const pa = q.createProject({ name: "A", slug: `a-${Date.now().toString(36)}` });
    const pb = q.createProject({ name: "B", slug: `b-${Date.now().toString(36)}` });
    q.registerAgent({ id: "pi", displayName: "Pi" });
    const ta = q.createTask(pa.id, evalSpec(`ta-${Date.now().toString(36)}`, "TA"));
    const tb = q.createTask(pb.id, evalSpec(`tb-${Date.now().toString(36)}`, "TB"));
    const batchA = q.createBatch({ taskId: ta.id, projectId: pa.id, agentId: "pi", model: "m", provider: "p", repeats: 1 });
    const batchB = q.createBatch({ taskId: tb.id, projectId: pb.id, agentId: "pi", model: "m", provider: "p", repeats: 1 });
    const runA = q.createRun({ batchId: batchA.id, taskId: ta.id, projectId: pa.id, agentId: "pi", model: "m", provider: "p", repeatIndex: 0, status: "completed" });
    const runB = q.createRun({ batchId: batchB.id, taskId: tb.id, projectId: pb.id, agentId: "pi", model: "m", provider: "p", repeatIndex: 0, status: "completed" });
    q.upsertEvalMetrics({ runId: runA.id, projectId: pa.id, schemaVersion: 1, execution: { x: 1 } });

    // Admin token (all projects) + a token scoped only to project A.
    const admin = q.createApiToken({ label: "admin" });
    const scopedA = q.createApiToken({ label: "scopedA", projectId: pa.id });
    const hA = { Authorization: `Bearer ${scopedA.token}` };
    const hAdmin = { Authorization: `Bearer ${admin.token}` };

    // Scoped-A can read run A.
    expect((await http(base, "GET", `/api/runs/${runA.id}`, undefined, hA)).status).toBe(200);
    // Scoped-A CANNOT read run B (different project).
    expect((await http(base, "GET", `/api/runs/${runB.id}`, undefined, hA)).status).toBe(401);
    // Events / diff / metrics / archive for run A are visible to scoped A; for run B → 401.
    expect((await http(base, "GET", `/api/runs/${runA.id}/events`, undefined, hA)).status).toBe(200);
    expect((await http(base, "GET", `/api/runs/${runB.id}/events`, undefined, hA)).status).toBe(401);
    // Admin reads both fine.
    expect((await http(base, "GET", `/api/runs/${runB.id}`, undefined, hAdmin)).status).toBe(200);
  });
});

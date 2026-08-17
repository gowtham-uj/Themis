/**
 * Eval-res archive listing + filtering API.
 *
 * Archives live flat on disk (`archives/<runId>/`) with one catalog file
 * (`archives/index.json`). Listing never walks the store.
 *
 * GET /api/archives                              → list all archived evals
 * GET /api/projects/:projectId/archives           → list one project's archives
 * GET /api/archives/:runId                        → one archive manifest
 * GET /api/archives/:runId/files/:path            → one archived file
 *
 * Nested project/commit URLs remain as aliases of the same catalog.
 *
 * Query params (optional, combinable):
 *   agent_commit, agent_version, image_id, build_id, queue_id, queue_revision,
 *   batch_id, task_name, model, provider, status, reward, project_id, run_id,
 *   task_id, agent_id, limit, offset
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, resolve, sep } from "node:path";
import { getRequestAuth } from "./auth.js";
import { HttpError, notFound } from "./errors.js";
import { sendJson, type RequestContext, type Router } from "./router.js";
import {
  archiveStoreDir,
  assertSafeRunId,
  listArchiveIndex,
  type ArchiveIndexRecord,
} from "../runner/archive-store.js";

export interface ArchiveEntry {
  projectId: string;
  projectName: string | null;
  queueId: string;
  queueName: string | null;
  batchId: string;
  runId: string;
  taskId: string;
  taskName: string | null;
  agent: {
    id: string | null;
    commit: string | null;
    image: string | null;
    imageId: string | null;
    version: string | null;
    buildId: string | null;
  };
  /** eval_queues.revision observed at generation close. */
  queueRevision: number | null;
  model: string;
  provider: string;
  status: string;
  reward: number | null;
  sealedAt: string | null;
  archivedAt: string;
  /** Internal storage location; never serialized to API clients. */
  storagePath: string;
}

interface AppCtxLike {
  dataDir: string;
  authEnabled: boolean;
}

function appOf(ctx: RequestContext): AppCtxLike {
  return ctx.app as AppCtxLike;
}

function assertArchiveScope(req: IncomingMessage, app: AppCtxLike, projectId: string): void {
  if (!app.authEnabled) return;
  const auth = getRequestAuth(req);
  if (auth?.projectId != null && auth.projectId !== projectId) {
    throw new HttpError(401, "Unauthorized", "token is not scoped to this project", {
      type: "https://agenteval.dev/errors/unauthorized",
    });
  }
}

function archiveJson(entry: ArchiveEntry): Omit<ArchiveEntry, "storagePath"> {
  const { storagePath: _storagePath, ...publicEntry } = entry;
  return publicEntry;
}

function entryFromRecord(dataDir: string, record: ArchiveIndexRecord): ArchiveEntry {
  return {
    projectId: record.projectId,
    projectName: record.projectName,
    queueId: record.queueId,
    queueName: record.queueName,
    batchId: record.batchId,
    runId: record.runId,
    taskId: record.taskId,
    taskName: record.taskName,
    agent: {
      id: record.agentId,
      commit: record.agentCommit,
      image: record.agentImage,
      imageId: record.agentImageId,
      version: record.agentVersion,
      buildId: record.buildId,
    },
    queueRevision: record.queueRevision,
    model: record.model,
    provider: record.provider,
    status: record.status,
    reward: record.reward,
    sealedAt: record.sealedAt,
    archivedAt: record.archivedAt,
    storagePath: archiveStoreDir(dataDir, record.dir || record.runId),
  };
}

/**
 * Load catalog rows. Project filter is applied in the index, not by walking dirs.
 */
export async function listArchiveEntries(dataDir: string, projectIdFilter?: string): Promise<ArchiveEntry[]> {
  const records = await listArchiveIndex(dataDir);
  const entries = records.map((record) => entryFromRecord(dataDir, record));
  return projectIdFilter ? entries.filter((entry) => entry.projectId === projectIdFilter) : entries;
}

/** Apply query-param filters to the list of archive entries. */
export function filterArchiveEntries(entries: ArchiveEntry[], params: Record<string, string | undefined>): ArchiveEntry[] {
  const get = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === "string" ? v : undefined;
  };

  let filtered = entries;

  const agentCommit = get("agent_commit") ?? get("agentCommit");
  if (agentCommit) filtered = filtered.filter((e) => e.agent.commit?.includes(agentCommit));

  const agentVersion = get("agent_version") ?? get("agentVersion");
  if (agentVersion) {
    filtered = filtered.filter(
      (e) =>
        e.agent.version?.includes(agentVersion) ||
        e.agent.commit?.startsWith(agentVersion),
    );
  }

  const imageId = get("image_id") ?? get("imageId");
  if (imageId) filtered = filtered.filter((e) => e.agent.imageId === imageId || e.agent.imageId?.includes(imageId));

  const buildId = get("build_id") ?? get("buildId");
  if (buildId) filtered = filtered.filter((e) => e.agent.buildId === buildId || e.agent.buildId?.includes(buildId));

  const queueRevision = get("queue_revision") ?? get("queueRevision");
  if (queueRevision !== undefined) {
    const rev = Number(queueRevision);
    if (Number.isFinite(rev)) filtered = filtered.filter((e) => e.queueRevision === rev);
  }

  const queueId = get("queue_id") ?? get("queueId");
  if (queueId) filtered = filtered.filter((e) => e.queueId === queueId || e.queueId.includes(queueId));

  const batchId = get("batch_id") ?? get("batchId");
  if (batchId) filtered = filtered.filter((e) => e.batchId === batchId || e.batchId.includes(batchId));

  const taskName = get("task_name") ?? get("taskName");
  if (taskName) filtered = filtered.filter((e) => e.taskName?.toLowerCase().includes(taskName.toLowerCase()));

  const model = get("model");
  if (model) filtered = filtered.filter((e) => e.model.toLowerCase().includes(model.toLowerCase()));

  const provider = get("provider");
  if (provider) filtered = filtered.filter((e) => e.provider.toLowerCase().includes(provider.toLowerCase()));

  const projectId = get("project_id") ?? get("projectId");
  if (projectId) filtered = filtered.filter((e) => e.projectId === projectId);

  const runId = get("run_id") ?? get("runId");
  if (runId) filtered = filtered.filter((e) => e.runId === runId || e.runId.includes(runId));

  const taskId = get("task_id") ?? get("taskId");
  if (taskId) filtered = filtered.filter((e) => e.taskId === taskId || e.taskId.includes(taskId));

  const agentId = get("agent_id") ?? get("agentId");
  if (agentId) filtered = filtered.filter((e) => e.agent.id === agentId);

  const status = get("status");
  if (status) filtered = filtered.filter((e) => e.status.toLowerCase() === status.toLowerCase());

  const rewardStr = get("reward");
  if (rewardStr !== undefined) {
    const reward = parseInt(rewardStr, 10);
    if (reward === 0 || reward === 1) filtered = filtered.filter((e) => e.reward === reward);
  }

  return filtered;
}

function paginate(entries: ArchiveEntry[], params: Record<string, string | undefined>): {
  total: number;
  offset: number;
  limit: number;
  page: ArchiveEntry[];
} {
  const limit = Math.min(parseInt(getStr(params, "limit") ?? "100", 10) || 100, 500);
  const offset = Math.max(parseInt(getStr(params, "offset") ?? "0", 10) || 0, 0);
  return { total: entries.length, offset, limit, page: entries.slice(offset, offset + limit) };
}

async function findArchive(dataDir: string, runId: string, projectId?: string): Promise<ArchiveEntry | null> {
  try {
    assertSafeRunId(runId);
  } catch {
    return null;
  }
  const entries = await listArchiveEntries(dataDir, projectId);
  return entries.find((entry) => entry.runId === runId) ?? null;
}

function requestedFilePath(params: Record<string, string | undefined>): string {
  return ["p1", "p2", "p3", "p4", "p5", "p6"]
    .map((key) => params[key])
    .filter((value): value is string => Boolean(value))
    .join("/");
}

async function sendArchiveFile(res: ServerResponse, entry: ArchiveEntry, requested: string): Promise<void> {
  const filePath = resolve(entry.storagePath, requested);
  const rel = relative(resolve(entry.storagePath), filePath);
  if (!requested || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(sep)) {
    throw notFound(`archive file not found: ${requested}`);
  }
  await serveArchiveFile(res, filePath, requested);
}

const FILE_SUFFIXES = [
  "/files/:p1",
  "/files/:p1/:p2",
  "/files/:p1/:p2/:p3",
  "/files/:p1/:p2/:p3/:p4",
  "/files/:p1/:p2/:p3/:p4/:p5",
  "/files/:p1/:p2/:p3/:p4/:p5/:p6",
];

export function registerArchiveRoutes(router: Router): void {
  /** GET /api/archives — list ALL archived eval runs across all projects (with filters). */
  router.get("/api/archives", async (req, res, ctx) => {
    const app = appOf(ctx);
    const params = ctx.query ?? {};
    const authProjectId = app.authEnabled ? getRequestAuth(req)?.projectId ?? null : null;
    let entries = await listArchiveEntries(app.dataDir, authProjectId ?? undefined);
    entries = filterArchiveEntries(entries, params);
    const { total, offset, limit, page } = paginate(entries, params);
    sendJson(res, 200, {
      total,
      count: page.length,
      offset,
      limit,
      archives: page.map(archiveJson),
    });
  });

  /** GET /api/projects/:projectId/archives — list archived eval runs for one project. */
  router.get("/api/projects/:projectId/archives", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.projectId!;
    assertArchiveScope(req, app, projectId);
    const params = ctx.query ?? {};
    let entries = await listArchiveEntries(app.dataDir, projectId);
    entries = filterArchiveEntries(entries, params);
    const { total, offset, limit, page } = paginate(entries, params);
    sendJson(res, 200, {
      projectId,
      total,
      count: page.length,
      offset,
      limit,
      archives: page.map(archiveJson),
    });
  });

  /** GET /api/archives/:runId — one archive, addressed by the store key. */
  router.get("/api/archives/:runId", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const entry = await findArchive(app.dataDir, runId);
    if (!entry) throw notFound(`eval archive not found: ${runId}`);
    assertArchiveScope(req, app, entry.projectId);
    sendJson(res, 200, { archive: archiveJson(entry) });
  });

  for (const suffix of FILE_SUFFIXES) {
    router.get(`/api/archives/:runId${suffix}`, async (req, res, ctx) => {
      const app = appOf(ctx);
      const runId = ctx.params.runId!;
      const entry = await findArchive(app.dataDir, runId);
      if (!entry) throw notFound(`eval archive not found: ${runId}`);
      assertArchiveScope(req, app, entry.projectId);
      await sendArchiveFile(res, entry, requestedFilePath(ctx.params));
    });
  }

  /** GET /api/archives/:projectId/:agentCommit — list archives for a specific agent commit/version. */
  router.get("/api/archives/:projectId/:agentCommit", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.projectId!;
    assertArchiveScope(req, app, projectId);
    const agentCommit = ctx.params.agentCommit!;
    const params = ctx.query ?? {};
    let entries = await listArchiveEntries(app.dataDir, projectId);
    entries = entries.filter((e) => e.agent.commit === agentCommit || e.agent.commit?.includes(agentCommit));
    entries = filterArchiveEntries(entries, params);
    const { total, offset, limit, page } = paginate(entries, params);
    sendJson(res, 200, {
      projectId,
      agentCommit,
      total,
      count: page.length,
      offset,
      limit,
      archives: page.map(archiveJson),
    });
  });

  /** GET /api/archives/:projectId/:agentCommit/:runId — one archive manifest. */
  router.get("/api/archives/:projectId/:agentCommit/:runId", async (req, res, ctx) => {
    const app = appOf(ctx);
    assertArchiveScope(req, app, ctx.params.projectId!);
    const entry = await findArchive(app.dataDir, ctx.params.runId!, ctx.params.projectId);
    if (!entry || entry.agent.commit !== ctx.params.agentCommit) {
      throw notFound(`eval archive not found: ${ctx.params.runId}`);
    }
    sendJson(res, 200, { archive: archiveJson(entry) });
  });

  for (const suffix of FILE_SUFFIXES) {
    router.get(`/api/archives/:projectId/:agentCommit/:runId${suffix}`, async (req, res, ctx) => {
      const app = appOf(ctx);
      assertArchiveScope(req, app, ctx.params.projectId!);
      const entry = await findArchive(app.dataDir, ctx.params.runId!, ctx.params.projectId);
      if (!entry || entry.agent.commit !== ctx.params.agentCommit) {
        throw notFound(`eval archive not found: ${ctx.params.runId}`);
      }
      await sendArchiveFile(res, entry, requestedFilePath(ctx.params));
    });
  }
}

async function serveArchiveFile(res: ServerResponse, filePath: string, requested: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    throw notFound(`archive file not found: ${requested}`);
  }
  if (!metadata.isFile()) throw notFound(`archive file not found: ${requested}`);

  const filename = requested.slice(requested.lastIndexOf("/") + 1).replace(/["\\]/g, "_");
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", metadata.size);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolveStream);
    stream.pipe(res);
  });
}

function getStr(params: Record<string, string | undefined>, key: string): string | undefined {
  return params[key];
}

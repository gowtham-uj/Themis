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

import { constants as fsConstants, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { getRequestAuth, requireAdminRequest } from "./auth.js";
import {
  BASE_PHASE_STATE,
  readArchiveCatalogMetadata,
  type ArchivePhaseState,
  type ArchivePipelineRun,
} from "./archive-phase-state.js";
import { create as createTar } from "tar";
import { HttpError, notFound } from "./errors.js";
import { sendJson, type RequestContext, type Router } from "./router.js";
import type { QueryStore, EvalArchive } from "../db/queries.js";
import type { EvalArchiveFile, EvalArchiveManifest } from "../runner/eval-archive.js";
import { createLocalArtifactStore } from "../storage/local-artifact-store.js";
import { blobKey } from "../storage/content-address.js";
import { normalizeArchivePath, parseManifest } from "../storage/archive-service.js";
import {
  archivesRoot,
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
  /** Eval execution id. */
  runId: string;
  /** Project-level start that owns this eval execution. */
  pipelineRunId: string | null;
  runName: string | null;
  runOrdinal: number | null;
  taskId: string;
  taskName: string | null;
  agent: {
    id: string | null;
    name: string | null;
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
  /**
   * Which phase views are sealed over this archive's base evidence. Tells a
   * reader whether they are looking at raw execution evidence, a Phase-1
   * judged archive, or one resealed by a Phase-2 campaign.
   */
  phase: ArchivePhaseState;
  /** Canonical immutable manifest key (new archives); internal only. */
  manifestKey: string | null;
  /** Internal compatibility materialization; never serialized to API clients. */
  storagePath: string;
  /** Server storage root; never serialized to API clients. */
  dataDir: string;
}

interface AppCtxLike {
  dataDir: string;
  authEnabled: boolean;
  queries: QueryStore;
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

function archiveJson(entry: ArchiveEntry): Omit<ArchiveEntry, "storagePath" | "manifestKey" | "dataDir"> {
  const { storagePath: _storagePath, manifestKey: _manifestKey, dataDir: _dataDir, ...publicEntry } = entry;
  return publicEntry;
}

function entryFromRecord(
  dataDir: string,
  record: ArchiveIndexRecord,
  phases: Map<string, ArchivePhaseState>,
  pipelineRuns: Map<string, ArchivePipelineRun>,
): ArchiveEntry {
  const pipelineRun = pipelineRuns.get(record.runId);
  return {
    projectId: record.projectId,
    projectName: record.projectName,
    queueId: record.queueId,
    queueName: record.queueName,
    batchId: record.batchId,
    runId: record.runId,
    pipelineRunId: pipelineRun?.generationId ?? null,
    runName: pipelineRun?.name ?? null,
    runOrdinal: pipelineRun?.ordinal ?? null,
    taskId: record.taskId,
    taskName: record.taskName,
    agent: {
      id: record.agentId,
      name: record.agentId,
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
    phase: phases.get(record.runId) ?? BASE_PHASE_STATE,
    manifestKey: null,
    storagePath: archiveStoreDir(dataDir, record.dir || record.runId),
    dataDir,
  };
}

/**
 * The verifier's authoritative 0/1 for one run, read from the metrics outcome.
 * Returns null for runs finalized before the outcome was persisted.
 */
function officialRewardOf(queries: QueryStore, runId: string): number | null {
  const outcome = queries.getEvalMetrics(runId)?.outcome as { officialReward?: unknown } | null | undefined;
  return typeof outcome?.officialReward === "number" ? outcome.officialReward : null;
}

/** DB-backed catalog row — no archives/index.json scan. */
function entryFromArchive(
  dataDir: string,
  queries: QueryStore,
  archive: EvalArchive,
  phases: Map<string, ArchivePhaseState>,
  pipelineRuns: Map<string, ArchivePipelineRun>,
): ArchiveEntry {
  const run = queries.getRun(archive.runId);
  const pipelineRun = pipelineRuns.get(archive.runId);
  const project = queries.getProject(archive.projectId);
  const queue = archive.queueId ? queries.getEvalQueue(archive.queueId) : null;
  const task = run ? queries.getTask(run.taskId) : null;
  return {
    projectId: archive.projectId,
    projectName: project?.name ?? null,
    queueId: archive.queueId ?? "",
    queueName: queue?.name ?? null,
    batchId: archive.batchId,
    runId: archive.runId,
    pipelineRunId: pipelineRun?.generationId ?? null,
    runName: pipelineRun?.name ?? null,
    runOrdinal: pipelineRun?.ordinal ?? null,
    taskId: run?.taskId ?? "",
    taskName: task?.name ?? null,
    agent: {
      id: run?.agentId ?? null,
      name: run?.agentId ? queries.getAgent(run.agentId)?.displayName ?? run.agentId : null,
      commit: run?.agentCommit ?? null,
      image: run?.agentImage ?? null,
      imageId: null,
      version: run?.agentVersion ?? run?.agentCommit?.slice(0, 12) ?? null,
      buildId: run?.buildId ?? null,
    },
    queueRevision: null,
    model: run?.model ?? "",
    provider: run?.provider ?? "",
    status: String(run?.status ?? "unknown"),
    // The verifier's official 0/1, stored on the metrics outcome at finalization.
    // An eval can finish with status "completed" and still have failed its checks.
    reward: officialRewardOf(queries, archive.runId),
    sealedAt: archive.sealedAt,
    archivedAt: archive.archivedAt ?? archive.sealedAt,
    phase: phases.get(archive.runId) ?? BASE_PHASE_STATE,
    manifestKey: archive.manifestKey,
    // The project archive is the one mutable-by-reseal directory. CAS remains a
    // fallback for imported archives whose local tree is no longer present.
    storagePath: join(dataDir, "projects", archive.projectId, "evals", archive.runId),
    dataDir,
  };
}

/**
 * Load catalog rows. Project filter is applied in the index, not by walking dirs.
 */
export async function listArchiveEntries(
  dataDir: string,
  projectIdFilter?: string,
  queries?: QueryStore,
): Promise<ArchiveEntry[]> {
  // One Themis read per listing, not one query per archive row.
  const metadata = readArchiveCatalogMetadata(dataDir);
  if (queries) {
    const archives = queries.listEvalArchives(projectIdFilter ? { projectId: projectIdFilter } : {});
    if (archives.length > 0) {
      return archives.map((archive) =>
        entryFromArchive(dataDir, queries, archive, metadata.phases, metadata.pipelineRuns),
      );
    }
    // Migration compatibility for legacy archives not yet backfilled into
    // eval_archives. New seals always write the DB row + canonical manifest, so
    // this fallback disappears once the one-time backfill is complete.
  }
  // Migration-only compatibility for callers/data with no DB catalog row.
  const records = await listArchiveIndex(dataDir);
  const entries = records.map((record) =>
    entryFromRecord(dataDir, record, metadata.phases, metadata.pipelineRuns),
  );
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

  const pipelineRunId = get("pipeline_run_id") ?? get("pipelineRunId");
  if (pipelineRunId) filtered = filtered.filter((e) => e.pipelineRunId === pipelineRunId);

  const runName = get("run_name") ?? get("runName");
  if (runName) filtered = filtered.filter((e) => e.runName?.toLowerCase().includes(runName.toLowerCase()));

  const projectName = get("project_name") ?? get("projectName");
  if (projectName) filtered = filtered.filter((e) => e.projectName?.toLowerCase().includes(projectName.toLowerCase()));

  const taskId = get("task_id") ?? get("taskId");
  if (taskId) filtered = filtered.filter((e) => e.taskId === taskId || e.taskId.includes(taskId));

  const agentId = get("agent_id") ?? get("agentId");
  if (agentId) filtered = filtered.filter((e) => e.agent.id === agentId);

  const agentName = get("agent_name") ?? get("agentName");
  if (agentName) filtered = filtered.filter((e) => e.agent.name?.toLowerCase().includes(agentName.toLowerCase()));

  const status = get("status");
  if (status) filtered = filtered.filter((e) => e.status.toLowerCase() === status.toLowerCase());

  const rewardStr = get("reward");
  if (rewardStr !== undefined) {
    const reward = parseInt(rewardStr, 10);
    if (reward === 0 || reward === 1) filtered = filtered.filter((e) => e.reward === reward);
  }

  return filtered;
}

/**
 * Prefer keyset pagination on (archivedAt DESC, runId DESC). Offset remains
 * accepted for compatibility but is not the WP-4 authority — clients should
 * follow next_cursor. Catalog rows still load from the structured index helper
 * (not a filesystem walk); index.json is an implementation detail of that
 * helper, not something routes may open directly.
 */
function paginate(entries: ArchiveEntry[], params: Record<string, string | undefined>): {
  total: number;
  offset: number;
  limit: number;
  page: ArchiveEntry[];
  has_more: boolean;
  next_cursor: string | null;
} {
  const limit = Math.min(parseInt(getStr(params, "limit") ?? "100", 10) || 100, 500);
  const sorted = [...entries].sort((a, b) => {
    const byTime = b.archivedAt.localeCompare(a.archivedAt);
    return byTime !== 0 ? byTime : b.runId.localeCompare(a.runId);
  });

  const cursor = getStr(params, "cursor") ?? getStr(params, "next_cursor");
  let start = 0;
  if (cursor) {
    try {
      const [archivedAt, runId] = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as [string, string];
      start = sorted.findIndex(
        (e) =>
          e.archivedAt < archivedAt ||
          (e.archivedAt === archivedAt && e.runId < runId),
      );
      if (start < 0) start = sorted.length;
    } catch {
      start = 0;
    }
  } else {
    // Legacy offset path — kept so existing clients do not break during cutover.
    start = Math.max(parseInt(getStr(params, "offset") ?? "0", 10) || 0, 0);
  }

  const page = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  const last = page.at(-1);
  const next_cursor =
    hasMore && last
      ? Buffer.from(JSON.stringify([last.archivedAt, last.runId]), "utf8").toString("base64url")
      : null;
  return {
    total: sorted.length,
    offset: start,
    limit,
    page,
    has_more: hasMore,
    next_cursor,
  };
}

async function findArchive(
  dataDir: string,
  queries: QueryStore,
  runId: string,
  projectId?: string,
): Promise<ArchiveEntry | null> {
  try {
    assertSafeRunId(runId);
  } catch {
    return null;
  }
  const archive = queries.getEvalArchive(runId);
  if (archive) {
    if (projectId && archive.projectId !== projectId) return null;
    const metadata = readArchiveCatalogMetadata(dataDir);
    return entryFromArchive(dataDir, queries, archive, metadata.phases, metadata.pipelineRuns);
  }
  // Legacy row not backfilled yet — bounded lookup in the compatibility index.
  const legacy = await listArchiveEntries(dataDir, projectId);
  return legacy.find((entry) => entry.runId === runId) ?? null;
}

async function readArchiveContents(entry: ArchiveEntry): Promise<{
  files: EvalArchiveFile[];
  layers: string[];
  sealedAt: string | null;
  resealedAt: string | null;
  totalBytes: number;
}> {
  const manifestPath = join(entry.storagePath, "eval_lifecycle_logs", "archive.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvalArchiveManifest;
    if (manifest.runId !== entry.runId || !Array.isArray(manifest.files)) throw new Error("invalid archive manifest");
    return {
      files: manifest.files,
      layers: Array.isArray(manifest.layers) ? manifest.layers : [],
      sealedAt: manifest.sealedAt ?? entry.sealedAt,
      resealedAt: manifest.resealedAt ?? null,
      totalBytes: Number(manifest.totalBytes ?? 0),
    };
  } catch {
    // Imported archives may have CAS bytes only. Their manifest has the same
    // useful path/hash/size tuples but no reseal metadata.
    if (entry.manifestKey) {
      const store = createLocalArtifactStore(resolve(entry.dataDir, "artifacts"));
      const parsed = parseManifest(
        (await readObject(store, entry.manifestKey, 16 * 1024 * 1024)).toString("utf8"),
      );
      if (parsed.ok) {
        return {
          files: parsed.manifest.entries.map((file) => ({
            path: file.path,
            kind: file.kind,
            bytes: file.bytes,
            sha256: file.sha256 ?? "",
            ...(file.symlinkTarget !== null ? { target: file.symlinkTarget } : {}),
          })),
          layers: [],
          sealedAt: entry.sealedAt,
          resealedAt: null,
          totalBytes: parsed.manifest.entries.reduce((sum, file) => sum + file.bytes, 0),
        };
      }
    }
    throw notFound(`archive manifest is unreadable: ${entry.runId}`);
  }
}

/** Restore write permission across a sealed tree so it can be removed. */
async function unharden(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o755).catch(() => undefined);
    for (const name of await readdir(path).catch(() => [] as string[])) {
      await unharden(join(path, name));
    }
    return;
  }
  await chmod(path, 0o644).catch(() => undefined);
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

  // Prefer the eval's own archive directory. Phase 1 and Phase 2 reseal this
  // tree in place, while the generation-1 CAS manifest describes only the base.
  try {
    await serveArchiveFile(res, filePath, requested);
    return;
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
  }

  // Imported or migrated archives may have only their canonical CAS objects.
  if (entry.manifestKey) {
    try {
      await serveCanonicalArchiveFile(res, entry, requested);
      return;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 404) throw err;
    }
  }
  throw notFound(`archive file not found: ${requested}`);
}

/** Read one artifact-store object fully into memory, with a hard size cap. */
async function readObject(store: ReturnType<typeof createLocalArtifactStore>, key: string, capBytes: number): Promise<Buffer> {
  const read = await store.get(key);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of read.stream) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > capBytes) throw new Error(`object ${key} exceeds ${capBytes} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/**
 * Stream one whole archive as a gzipped tar.
 *
 * Canonical archives are content-addressed, so there is no directory to pack.
 * Rebuild the tree from the manifest into a scratch directory, tar it, and
 * delete it. Legacy archives that still have a browsable copy are packed in
 * place.
 */
async function sendArchiveDownload(res: ServerResponse, entry: ArchiveEntry): Promise<void> {
  let root = resolve(entry.storagePath);
  let scratch: string | null = null;
  const local = await lstat(root).catch(() => null);

  if (!local?.isDirectory()) {
    if (!entry.manifestKey) throw notFound(`archive files not found: ${entry.runId}`);
    const store = createLocalArtifactStore(resolve(entry.dataDir, "artifacts"));
    const parsed = parseManifest((await readObject(store, entry.manifestKey, 16 * 1024 * 1024)).toString("utf8"));
    if (!parsed.ok) throw notFound(`archive manifest is unreadable: ${entry.runId}`);
    scratch = await mkdtemp(join(tmpdir(), `ae-dl-${entry.runId}-`));
    root = scratch;
    for (const file of parsed.manifest.entries) {
      if (file.kind !== "file") continue;
      const target = join(scratch, file.path);
      await mkdir(dirname(target), { recursive: true });
      const read = await store.get(blobKey(file.sha256));
      await pipeline(read.stream, createWriteStream(target));
    }
  }

  try {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="archive-${entry.runId}.tar.gz"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const stream = createTar({ gzip: true, cwd: root, portable: true, follow: false }, ["."]);
    await new Promise<void>((resolveStream, reject) => {
      stream.on("error", reject);
      stream.on("end", resolveStream);
      res.on("close", () => {
        if (!stream.destroyed) stream.destroy();
      });
      stream.pipe(res);
    });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
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
    let entries = await listArchiveEntries(app.dataDir, authProjectId ?? undefined, app.queries);
    entries = filterArchiveEntries(entries, params);
    const { total, offset, limit, page, has_more, next_cursor } = paginate(entries, params);
    sendJson(res, 200, {
      total,
      count: page.length,
      offset,
      limit,
      has_more,
      next_cursor,
      archives: page.map(archiveJson),
    });
  });

  /** GET /api/projects/:projectId/archives — list archived eval runs for one project. */
  router.get("/api/projects/:projectId/archives", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.projectId!;
    assertArchiveScope(req, app, projectId);
    const params = ctx.query ?? {};
    let entries = await listArchiveEntries(app.dataDir, projectId, app.queries);
    entries = filterArchiveEntries(entries, params);
    const { total, offset, limit, page, has_more, next_cursor } = paginate(entries, params);
    sendJson(res, 200, {
      projectId,
      total,
      count: page.length,
      offset,
      limit,
      has_more,
      next_cursor,
      archives: page.map(archiveJson),
    });
  });

  /** GET /api/archives/:runId — one archive, addressed by the store key. */
  router.get("/api/archives/:runId", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const entry = await findArchive(app.dataDir, app.queries, runId);
    if (!entry) throw notFound(`eval archive not found: ${runId}`);
    assertArchiveScope(req, app, entry.projectId);
    sendJson(res, 200, { archive: archiveJson(entry) });
  });

  /** GET /api/archives/:runId/contents — the actual resealed file inventory. */
  router.get("/api/archives/:runId/contents", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const entry = await findArchive(app.dataDir, app.queries, runId);
    if (!entry) throw notFound(`eval archive not found: ${runId}`);
    assertArchiveScope(req, app, entry.projectId);
    sendJson(res, 200, { archive: archiveJson(entry), ...(await readArchiveContents(entry)) });
  });

  /** GET /api/archives/:runId/file?path=... — one file at any nesting depth. */
  router.get("/api/archives/:runId/file", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const entry = await findArchive(app.dataDir, app.queries, runId);
    if (!entry) throw notFound(`eval archive not found: ${runId}`);
    assertArchiveScope(req, app, entry.projectId);
    await sendArchiveFile(res, entry, ctx.query?.path ?? "");
  });

  /** GET /api/archives/:runId/download — the whole sealed archive as one tar.gz. */
  router.get("/api/archives/:runId/download", async (req, res, ctx) => {
    const app = appOf(ctx);
    const runId = ctx.params.runId!;
    const entry = await findArchive(app.dataDir, app.queries, runId);
    if (!entry) throw notFound(`eval archive not found: ${runId}`);
    assertArchiveScope(req, app, entry.projectId);
    await sendArchiveDownload(res, entry);
  });

  /**
   * DELETE /api/archives — remove every archive: catalog rows, the browsable
   * copies, and the content-addressed blobs and manifests behind them.
   */
  router.delete("/api/archives", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdminRequest(req, app.queries, app.authEnabled);
    const rows = app.queries.deleteAllEvalArchives();
    const root = archivesRoot(app.dataDir);
    let dirs = 0;
    for (const name of await readdir(root).catch(() => [] as string[])) {
      await rm(resolve(root, name), { recursive: true, force: true });
      dirs += 1;
    }
    // The per-project evals tree is where an archive actually lives. It is
    // sealed read-only, so restore write permission before removing it.
    const projectsRoot = resolve(app.dataDir, "projects");
    for (const projectId of await readdir(projectsRoot).catch(() => [] as string[])) {
      const evalsRoot = join(projectsRoot, projectId, "evals");
      for (const name of await readdir(evalsRoot).catch(() => [] as string[])) {
        const target = join(evalsRoot, name);
        await unharden(target);
        await rm(target, { recursive: true, force: true });
        dirs += 1;
      }
    }
    await rm(resolve(app.dataDir, "artifacts"), { recursive: true, force: true });
    sendJson(res, 200, { deleted_rows: rows, deleted_dirs: dirs });
  });

  for (const suffix of FILE_SUFFIXES) {
    router.get(`/api/archives/:runId${suffix}`, async (req, res, ctx) => {
      const app = appOf(ctx);
      const runId = ctx.params.runId!;
      const entry = await findArchive(app.dataDir, app.queries, runId);
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
    let entries = await listArchiveEntries(app.dataDir, projectId, app.queries);
    entries = entries.filter((e) => e.agent.commit === agentCommit || e.agent.commit?.includes(agentCommit));
    entries = filterArchiveEntries(entries, params);
    const { total, offset, limit, page, has_more, next_cursor } = paginate(entries, params);
    sendJson(res, 200, {
      projectId,
      agentCommit,
      total,
      count: page.length,
      offset,
      limit,
      has_more,
      next_cursor,
      archives: page.map(archiveJson),
    });
  });

  /** GET /api/archives/:projectId/:agentCommit/:runId — one archive manifest. */
  router.get("/api/archives/:projectId/:agentCommit/:runId", async (req, res, ctx) => {
    const app = appOf(ctx);
    assertArchiveScope(req, app, ctx.params.projectId!);
    const entry = await findArchive(app.dataDir, app.queries, ctx.params.runId!, ctx.params.projectId);
    if (!entry || entry.agent.commit !== ctx.params.agentCommit) {
      throw notFound(`eval archive not found: ${ctx.params.runId}`);
    }
    sendJson(res, 200, { archive: archiveJson(entry) });
  });

  for (const suffix of FILE_SUFFIXES) {
    router.get(`/api/archives/:projectId/:agentCommit/:runId${suffix}`, async (req, res, ctx) => {
      const app = appOf(ctx);
      assertArchiveScope(req, app, ctx.params.projectId!);
      const entry = await findArchive(app.dataDir, app.queries, ctx.params.runId!, ctx.params.projectId);
      if (!entry || entry.agent.commit !== ctx.params.agentCommit) {
        throw notFound(`eval archive not found: ${ctx.params.runId}`);
      }
      await sendArchiveFile(res, entry, requestedFilePath(ctx.params));
    });
  }
}

async function serveCanonicalArchiveFile(
  res: ServerResponse,
  entry: ArchiveEntry,
  requested: string,
): Promise<void> {
  const normalized = normalizeArchivePath(requested);
  if (!normalized) throw notFound(`archive file not found: ${requested}`);

  const store = createLocalArtifactStore(resolve(entry.dataDir, "artifacts"));
  try {
    const manifestRead = await store.get(entry.manifestKey!);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of manifestRead.stream) {
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > 16 * 1024 * 1024) throw new Error("manifest too large");
      chunks.push(b);
    }
    const parsed = parseManifest(Buffer.concat(chunks).toString("utf8"));
    if (!parsed.ok) throw new Error("invalid canonical manifest");
    const file = parsed.manifest.entries.find((e) => e.path === normalized && e.kind === "file");
    if (!file || file.kind !== "file") throw notFound(`archive file not found: ${requested}`);

    const read = await store.get(blobKey(file.sha256));
    const filename = normalized
      .slice(normalized.lastIndexOf("/") + 1)
      .replace(/[\u0000-\u001f\u007f"\\]/g, "_")
      .trim() || "download";
    res.statusCode = 200;
    res.setHeader("Content-Type", read.contentType ?? "application/octet-stream");
    res.setHeader("Content-Length", file.bytes);
    res.setHeader("ETag", `"${file.sha256}"`);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    await new Promise<void>((resolveStream, reject) => {
      read.stream.on("error", reject);
      read.stream.on("end", resolveStream);
      res.on("close", () => {
        if (!read.stream.destroyed) read.stream.destroy();
      });
      read.stream.pipe(res);
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw notFound(`archive file not found: ${requested}`);
  }
}

async function serveArchiveFile(res: ServerResponse, filePath: string, requested: string): Promise<void> {
  // lstat (not stat) so a symlink planted inside a sealed archive can never be
  // followed to a host file. Refuse symlinks and non-regular files outright.
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw notFound(`archive file not found: ${requested}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw notFound(`archive file not found: ${requested}`);
  }

  // Strip CR/LF and control chars so a hostile path segment cannot inject a
  // header line via Content-Disposition (or abort the response).
  const filename = requested
    .slice(requested.lastIndexOf("/") + 1)
    .replace(/[\u0000-\u001f\u007f"\\]/g, "_")
    .replace(/^\s+|\s+$/g, "") || "download";
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", metadata.size);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Open with O_NOFOLLOW as defense in depth against a link swapped in between
  // the lstat above and the read below. Use FileHandle.createReadStream so the
  // handle owns its lifetime — passing the raw fd into fs.createReadStream
  // leaves the FileHandle object unclosed and crashes Node 22+ on GC
  // (ERR_INVALID_STATE), which previously took down the whole API mid-queue.
  const fh = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  await new Promise<void>((resolveStream, reject) => {
    const stream = fh.createReadStream({ autoClose: true });
    const fail = (err: Error) => {
      void fh.close().catch(() => undefined);
      reject(err);
    };
    stream.on("error", fail);
    res.on("close", () => {
      // Client abort: ensure the handle cannot outlive the response.
      if (!stream.destroyed) stream.destroy();
    });
    stream.on("end", resolveStream);
    stream.pipe(res);
  });
}

function getStr(params: Record<string, string | undefined>, key: string): string | undefined {
  return params[key];
}

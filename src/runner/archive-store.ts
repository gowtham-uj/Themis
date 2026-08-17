/**
 * Central eval-archive store.
 *
 * Every sealed eval lives in a flat directory keyed only by run id. Metadata
 * used for listing and filtering lives in one sibling index file — project,
 * commit, queue, and batch are index fields, not filesystem folders.
 *
 *   <dataDir>/archives/index.json
 *   <dataDir>/archives/<runId>/
 *     manifest.json
 *     ...copy of the sealed eval archive...
 *
 * The per-run sealed tree under projects/<projectId>/evals/<runId> is unchanged.
 * This store is a browsable copy plus a catalog.
 */

import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ArchiveStoreEntry {
  projectId: string;
  projectName: string | null;
  queueId: string;
  queueName: string | null;
  batchId: string;
  runId: string;
  taskId: string;
  taskName: string | null;
  agentId: string | null;
  agentCommit: string | null;
  agentImage: string | null;
  /** Commit-addressed image id (generation snapshot). */
  agentImageId: string | null;
  agentVersion: string | null;
  /** adapter_builds row id the generation built from. */
  buildId: string | null;
  /** eval_queues.revision observed at generation close. */
  queueRevision: number | null;
  model: string;
  provider: string;
  status: string;
  reward: number | null;
  sealedAt: string | null;
}

/** One catalog row. `dir` is the basename under archives/ (always the run id). */
export interface ArchiveIndexRecord extends ArchiveStoreEntry {
  archivedAt: string;
  dir: string;
}

export interface ArchiveIndex {
  schemaVersion: 1;
  updatedAt: string;
  archives: ArchiveIndexRecord[];
}

const INDEX_NAME = "index.json";
const INDEX_SCHEMA_VERSION = 1 as const;

/** Serialize in-process index reads/writes so two seals cannot clobber the catalog. */
let indexChain: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexChain.then(fn, fn);
  indexChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Reject path-shaped run ids so archives stay one level under the store root. */
export function assertSafeRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === "." || runId === "..") {
    throw new Error(`invalid archive run id: ${runId}`);
  }
  return runId;
}

export function archivesRoot(dataDir: string): string {
  return join(dataDir, "archives");
}

export function archiveIndexPath(dataDir: string): string {
  return join(archivesRoot(dataDir), INDEX_NAME);
}

/** On-disk directory for one archived run. */
export function archiveStoreDir(dataDir: string, runId: string): string {
  return join(archivesRoot(dataDir), assertSafeRunId(runId));
}

function emptyIndex(): ArchiveIndex {
  return { schemaVersion: INDEX_SCHEMA_VERSION, updatedAt: new Date().toISOString(), archives: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse a catalog row from either the index or a per-archive manifest.json. */
export function recordFromManifest(
  manifest: Record<string, unknown>,
  fallback: { runId?: string; archivedAt?: string } = {},
): ArchiveIndexRecord | null {
  const project = isRecord(manifest.project) ? manifest.project : {};
  const queue = isRecord(manifest.queue) ? manifest.queue : {};
  const run = isRecord(manifest.run) ? manifest.run : {};
  const agent = isRecord(manifest.agent) ? manifest.agent : {};
  const runId = asString(run.id) || fallback.runId || "";
  if (!runId) return null;
  try {
    assertSafeRunId(runId);
  } catch {
    return null;
  }
  const archivedAt =
    asString(manifest.archivedAt) || fallback.archivedAt || asString(manifest.sealedAt) || "";
  return {
    projectId: asString(project.id),
    projectName: asNullableString(project.name),
    queueId: asString(queue.id),
    queueName: asNullableString(queue.name),
    queueRevision: asNullableNumber(queue.revision),
    batchId: asString(manifest.batchId),
    runId,
    taskId: asString(run.taskId),
    taskName: asNullableString(run.taskName),
    agentId: asNullableString(agent.id),
    agentCommit: asNullableString(agent.commit),
    agentImage: asNullableString(agent.image),
    agentImageId: asNullableString(agent.imageId),
    agentVersion: asNullableString(agent.version),
    buildId: asNullableString(agent.buildId),
    model: asString(run.model),
    provider: asString(run.provider),
    status: asString(run.status),
    reward: asNullableNumber(run.reward),
    sealedAt: asNullableString(manifest.sealedAt),
    archivedAt,
    dir: runId,
  };
}

function recordFromEntry(entry: ArchiveStoreEntry, archivedAt: string): ArchiveIndexRecord {
  assertSafeRunId(entry.runId);
  return {
    ...entry,
    archivedAt,
    dir: entry.runId,
  };
}

function manifestBody(entry: ArchiveStoreEntry, archivedAt: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: { id: entry.projectId, name: entry.projectName },
    queue: { id: entry.queueId, name: entry.queueName, revision: entry.queueRevision },
    batchId: entry.batchId,
    run: {
      id: entry.runId,
      taskId: entry.taskId,
      taskName: entry.taskName,
      status: entry.status,
      reward: entry.reward,
      model: entry.model,
      provider: entry.provider,
    },
    agent: {
      id: entry.agentId,
      commit: entry.agentCommit,
      image: entry.agentImage,
      imageId: entry.agentImageId,
      version: entry.agentVersion,
      buildId: entry.buildId,
    },
    sealedAt: entry.sealedAt,
    archivedAt,
  };
}

function parseIndex(raw: string): ArchiveIndex | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.archives)) return null;
    const archives: ArchiveIndexRecord[] = [];
    for (const item of parsed.archives) {
      if (!isRecord(item)) continue;
      const record = recordFromManifest(
        {
          project: { id: item.projectId, name: item.projectName },
          queue: { id: item.queueId, name: item.queueName, revision: item.queueRevision },
          batchId: item.batchId,
          run: {
            id: item.runId,
            taskId: item.taskId,
            taskName: item.taskName,
            status: item.status,
            reward: item.reward,
            model: item.model,
            provider: item.provider,
          },
          agent: {
            id: item.agentId,
            commit: item.agentCommit,
            image: item.agentImage,
            imageId: item.agentImageId,
            version: item.agentVersion,
            buildId: item.buildId,
          },
          sealedAt: item.sealedAt,
          archivedAt: item.archivedAt,
        },
        { runId: asString(item.runId), archivedAt: asString(item.archivedAt) },
      );
      if (record) {
        record.dir = asString(item.dir) || record.runId;
        try {
          assertSafeRunId(record.dir);
        } catch {
          continue;
        }
        archives.push(record);
      }
    }
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      updatedAt: asString(parsed.updatedAt) || new Date().toISOString(),
      archives,
    };
  } catch {
    return null;
  }
}

/** Rebuild the catalog by reading one-level sibling archive directories. */
export async function rebuildArchiveIndex(dataDir: string): Promise<ArchiveIndex> {
  const root = archivesRoot(dataDir);
  const index = emptyIndex();
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return index;
  }
  for (const name of names) {
    try {
      assertSafeRunId(name);
    } catch {
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(join(root, name, "manifest.json"), "utf8")) as unknown;
      if (!isRecord(manifest)) continue;
      const record = recordFromManifest(manifest, { runId: name });
      if (record) index.archives.push(record);
    } catch {
      // skip incomplete copies
    }
  }
  index.archives.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  return index;
}

async function writeIndexFile(dataDir: string, index: ArchiveIndex): Promise<void> {
  const root = archivesRoot(dataDir);
  await mkdir(root, { recursive: true });
  const encoded = `${JSON.stringify(
    {
      schemaVersion: INDEX_SCHEMA_VERSION,
      updatedAt: index.updatedAt,
      archives: index.archives,
    },
    null,
    2,
  )}\n`;
  const tmp = join(root, `.${INDEX_NAME}.${process.pid}.tmp`);
  await writeFile(tmp, encoded, "utf8");
  await rename(tmp, archiveIndexPath(dataDir));
}

/** Load the catalog. Rebuilds from sibling directories if the file is missing or corrupt. */
export async function readArchiveIndex(dataDir: string): Promise<ArchiveIndex> {
  try {
    const parsed = parseIndex(await readFile(archiveIndexPath(dataDir), "utf8"));
    if (parsed) return parsed;
  } catch {
    // missing or unreadable
  }
  const rebuilt = await rebuildArchiveIndex(dataDir);
  if (rebuilt.archives.length > 0) {
    try {
      await writeIndexFile(dataDir, rebuilt);
    } catch {
      // listing still works from the in-memory rebuild
    }
  }
  return rebuilt;
}

/**
 * Copy a sealed eval archive into the flat store and upsert its catalog row.
 * Safe to call after sealing; returns the destination path.
 */
export async function storeEvalArchive(input: {
  dataDir: string;
  sealedArchiveDir: string;
  entry: ArchiveStoreEntry;
}): Promise<string> {
  const { dataDir, sealedArchiveDir, entry } = input;
  assertSafeRunId(entry.runId);
  const destRoot = archiveStoreDir(dataDir, entry.runId);
  const archivedAt = new Date().toISOString();
  await rm(destRoot, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });
  await cp(sealedArchiveDir, destRoot, { recursive: true, force: false });
  await writeFile(join(destRoot, "manifest.json"), `${JSON.stringify(manifestBody(entry, archivedAt), null, 2)}\n`, "utf8");

  await withIndexLock(async () => {
    const index = await readArchiveIndex(dataDir);
    const next = recordFromEntry(entry, archivedAt);
    index.archives = index.archives.filter((row) => row.runId !== entry.runId);
    index.archives.push(next);
    index.archives.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    index.updatedAt = archivedAt;
    await writeIndexFile(dataDir, index);
  });

  return destRoot;
}

/** Catalog rows, newest first. Does not leak host paths. */
export async function listArchiveIndex(dataDir: string): Promise<ArchiveIndexRecord[]> {
  const index = await readArchiveIndex(dataDir);
  return [...index.archives].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/** Best-effort: read a previous per-archive manifest (for dedup / verification). */
export async function readArchiveStoreManifest(destRoot: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(destRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

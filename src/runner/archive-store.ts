/**
 * Central eval-archive store: give every sealed eval archive a stable, browsable
 * home keyed by the agent version that produced it, so all logs/traces are in one
 * place identified by (project, queue, agent commit/version, batch, run).
 *
 * Layout:
 *   <dataDir>/archives/<projectId>/<agentCommit|unknown>/<queueId>/<batchId>/<runId>/
 *     ... (a copy of the sealed archive)
 *     manifest.json   <- identifying metadata
 *
 * This is additive: the canonical sealed archive stays under evals/<runId>; the
 * central store is a versioned, browsable index/copy for retrieval by agent.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  agentVersion: string | null;
  model: string;
  provider: string;
  status: string;
  reward: number | null;
  sealedAt: string | null;
}

/**
 * Copy a sealed eval archive into the central store keyed by agent version and
 * project/queue, writing a manifest.json with all identifying metadata. Safe to
 * call after sealing; returns the destination path.
 */
export async function storeEvalArchive(input: {
  dataDir: string;
  sealedArchiveDir: string; // the evals/<runId> dir that was just sealed
  entry: ArchiveStoreEntry;
}): Promise<string> {
  const { dataDir, sealedArchiveDir, entry } = input;
  const agentCommit = entry.agentCommit || "unknown";
  const destRoot = join(
    dataDir,
    "archives",
    entry.projectId,
    agentCommit,
    entry.queueId,
    entry.batchId,
    entry.runId,
  );
  await rm(destRoot, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });
  // Copy the sealed archive dir (excluding any nested copy of itself).
  await cp(sealedArchiveDir, destRoot, { recursive: true, force: false });
  await writeFile(
    join(destRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: { id: entry.projectId, name: entry.projectName },
        queue: { id: entry.queueId, name: entry.queueName },
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
          version: entry.agentVersion,
        },
        sealedAt: entry.sealedAt,
        archivedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return destRoot;
}

/** Best-effort: read a previous manifest (for dedup / verification). */
export async function readArchiveStoreManifest(destRoot: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(destRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

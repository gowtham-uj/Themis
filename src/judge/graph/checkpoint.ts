/** Deterministic JSON checkpoints for Phase-1 nodes. */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Phase1GraphState } from "./state.js";

/** Persist graph state under workDir/checkpoints/<node>.json. */
export async function saveCheckpoint(state: Phase1GraphState): Promise<string> {
  const path = join(state.workDir, "checkpoints", `${state.node}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

/** Marker file a pause writes so Nodes 0-3 stop at their next boundary. */
const PAUSE_MARKER = ".paused";

/**
 * Ask the graph to stop after the node it is currently running.
 *
 * A pause during Nodes 0-3 used to be a silent no-op: `pausePiWorkDir` only
 * kills the PI court, and no `pi.pid` exists until Node 4 starts. So the console
 * said "Judge paused. Resume continues the PI session." while the clerk kept
 * spending model calls. The marker is checked between nodes, which is where a
 * committed checkpoint already exists, so resume loses no work.
 */
export async function markGraphPaused(workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, PAUSE_MARKER), `${new Date().toISOString()}\n`);
}

/** Clear the pause marker so a resumed case can run past the next boundary. */
export async function clearGraphPause(workDir: string): Promise<void> {
  await rm(join(workDir, PAUSE_MARKER), { force: true });
}

/** True while an operator pause is standing against this case. */
export async function isGraphPaused(workDir: string): Promise<boolean> {
  try {
    await readFile(join(workDir, PAUSE_MARKER), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Thrown at a node boundary when an operator pause is standing. */
export class GraphPaused extends Error {
  constructor(readonly node: Phase1GraphState["node"]) {
    super(`Phase 1 paused after ${node}`);
    this.name = "GraphPaused";
  }
}

/** Load a checkpoint if present. */
export async function loadCheckpoint(
  workDir: string,
  node: Phase1GraphState["node"],
): Promise<Phase1GraphState | null> {
  try {
    const raw = await readFile(join(workDir, "checkpoints", `${node}.json`), "utf8");
    return JSON.parse(raw) as Phase1GraphState;
  } catch {
    return null;
  }
}

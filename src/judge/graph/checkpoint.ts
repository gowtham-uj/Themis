/** Deterministic JSON checkpoints for Phase-1 nodes. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Phase1GraphState } from "./state.js";

/** Persist graph state under workDir/checkpoints/<node>.json. */
export async function saveCheckpoint(state: Phase1GraphState): Promise<string> {
  const path = join(state.workDir, "checkpoints", `${state.node}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
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

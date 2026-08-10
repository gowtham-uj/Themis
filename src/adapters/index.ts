/**
 * Global adapter registry. Projects refine adapters via overrides (plan/projects.md).
 */

import { piAdapter } from "./pi.js";
import { reaperCodeAdapter } from "./reapercode.js";
import type { Adapter } from "./types.js";

export type {
  Adapter,
  AdapterCommand,
  AdapterConnectionCheck,
  AdapterEvidenceSpec,
  AdapterOverrides,
  AgentStreams,
  ProjectRef,
  RunContext,
  WorkspaceSpec,
} from "./types.js";
export { piAdapter } from "./pi.js";
export { reaperCodeAdapter, ADAPTER_STATUS as REAPER_ADAPTER_STATUS } from "./reapercode.js";
const REGISTRY: Map<string, Adapter> = new Map();

function registerDefaults(): void {
  if (REGISTRY.size > 0) return;
  REGISTRY.set(piAdapter.id, piAdapter);
  REGISTRY.set(reaperCodeAdapter.id, reaperCodeAdapter);
}

/** Look up a registered adapter by id. Throws if unknown. */
export function getAdapter(id: string): Adapter {
  registerDefaults();
  const adapter = REGISTRY.get(id);
  if (!adapter) {
    const known = [...REGISTRY.keys()].sort().join(", ");
    throw new Error(`Unknown adapter "${id}". Known: ${known || "(none)"}`);
  }
  return adapter;
}

/** Register (or replace) an adapter implementation. */
export function registerAdapter(adapter: Adapter): void {
  registerDefaults();
  REGISTRY.set(adapter.id, adapter);
}

/** List registered adapter ids. */
export function listAdapters(): string[] {
  registerDefaults();
  return [...REGISTRY.keys()].sort();
}

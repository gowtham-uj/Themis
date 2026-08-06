/**
 * Adapter interface — the only agent-specific boundary.
 * Source of truth: plan/adapters.md.
 */

import type { CanonicalEvent } from "../schema/events.js";

export type WorkspaceSpec =
  | { source: "git"; repo: string; ref?: string }
  | { source: "empty" };

export interface ProjectRef {
  id: string;
  name?: string;
}

export interface AdapterOverrides {
  image?: string;
  model?: string;
  provider?: string;
  env?: Record<string, string>;
  params?: Record<string, unknown>;
  allowedTools?: string[];
  network?: "allow" | "allowlist" | "offline";
}

export interface RunContext {
  runId: string;
  project: ProjectRef;
  task: { prompt: string; workspace: WorkspaceSpec };
  model: string;
  provider: string;
  params: Record<string, unknown>;
  workspaceDir: string;
  apiKeys: Record<string, string>;
  overrides?: AdapterOverrides;
}

/** Streams produced by the agent process / container. */
export interface AgentStreams {
  stdout: AsyncIterable<string | Buffer>;
  stderr: AsyncIterable<string | Buffer>;
  /** Optional exit metadata available once the process ends. */
  exitCode?: number | Promise<number>;
  /** Wall-clock duration of the agent process when known. */
  durationMs?: number | Promise<number>;
}

export interface AdapterCommand {
  argv: string[];
  env: Record<string, string>;
}

/**
 * Turns a task + run config into a stream of canonical events.
 * Everything downstream is agent-agnostic.
 */
export interface Adapter {
  id: "reapercode" | "pi" | string;
  /** Docker image this adapter runs the agent in. */
  image(ctx: RunContext): string;
  /** argv + env to launch the agent headlessly. */
  command(ctx: RunContext): AdapterCommand;
  /**
   * Consume the agent's stdout/stderr (and/or a mounted trajectory file) and
   * yield canonical events. The runner handles persistence, SSE, and diff.
   */
  parse(streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent>;
}

/**
 * Adapter interface — the only agent-specific boundary.
 * Source of truth: plan/adapters.md.
 */

import type { CanonicalEvent } from "../schema/events.js";
import type { PortMapping } from "../runner/runtime.js";

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
  /**
   * Ports the sandbox should publish (dev servers, headless-browser debug
   * ports). `hostPort` omitted/0 → the runtime picks a free one and reports it
   * back on the container handle.
   */
  ports?: PortMapping[];
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

/** Real provider/model connectivity probe executed through the supported agent. */
export interface AdapterConnectionCheck {
  command: AdapterCommand;
  /** Working directory inside the queue container. Default `/workspace`. */
  cwd?: string;
  /** Probe timeout in milliseconds. Default 60 seconds. */
  timeoutMs?: number;
}

/** Native agent evidence locations copied after each eval. */
export interface AdapterEvidenceSpec {
  /** Paths relative to `/workspace`; files or directories are accepted. */
  paths: string[];
  /** Paths that must exist for evidence extraction to be considered complete. */
  requiredPaths?: string[];
}

/**
 * Turns a task + run config into a stream of canonical events.
 * Everything downstream is agent-agnostic.
 */
export interface Adapter {
  id: "reapercode" | "pi" | string;
  /** Docker image this adapter runs the agent in. */
  image(ctx: RunContext): string;
  /**
   * Configure and invoke a real connectivity probe through this agent using the
   * selected provider/model. A successful process must also yield a real model
   * message when parsed; the queue worker enforces both conditions.
   */
  connectionCheck(ctx: RunContext): AdapterConnectionCheck;
  /** argv + env to launch the agent headlessly for the eval prompt. */
  command(ctx: RunContext): AdapterCommand;
  /**
   * Optional: run once after the container starts + connection check passes,
   * before any eval. Lets the agent write its own provider/model/API-key config
   * that it reads at run time. Returns null when env injection alone suffices.
   */
  configure?(ctx: RunContext): AdapterConnectionCheck | null;
  /** Declare where this agent stores native trajectories/logs in the workspace. */
  evidence(ctx: RunContext): AdapterEvidenceSpec;
  /**
   * Consume the agent's stdout/stderr (and/or a mounted trajectory file) and
   * yield canonical events. The runner handles persistence, SSE, and diff.
   */
  parse(streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent>;
}

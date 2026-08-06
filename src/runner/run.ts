/**
 * Local (Dockerless) run orchestrator for Phase 1.
 *
 * prepare workspace → spawn agent (live local process) → parse → append events
 * → captureDiff → run.end. Spec: plan/roadmap.md P1, plan/adapters.md.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getAdapter,
  type Adapter,
  type RunContext,
  type WorkspaceSpec,
} from "../adapters/index.js";
import { ADAPTER_STATUS as REAPER_STATUS } from "../adapters/reapercode.js";
import type { CanonicalEvent, RunStatus, Usage } from "../schema/events.js";
import { appendEvent } from "../schema/append.js";
import { captureDiff, type CaptureDiffResult } from "./diff.js";
import { redactEvent } from "./redact.js";
import {
  ensureGitRepo,
  prepareWorkspace,
  type PreparedWorkspace,
} from "./workspace.js";

// Re-export reaper + redaction entry points so callers can hook a CrashReaper
// without reaching into the individual modules (P2 in-process shape; P3 wires DB).
export {
  CrashReaper,
  createCrashReaper,
  DEFAULT_HEARTBEAT_WINDOW_MS,
  type InFlightRun,
  type ListInFlightRuns,
  type ReapOptions,
} from "./reaper.js";
export {
  redactEvent,
  redactString,
  redactEnv,
  registerKnownSecrets,
  clearKnownSecrets,
  type RedactionKind,
} from "./redact.js";
export {
  captureDiffByCategory,
  categoryToDiffKind,
  type AgentCategory,
  type CategoryDiffResult,
  type DiffKind,
} from "./diff-category.js";

export interface RunOptions {
  agent: string;
  task: string;
  /** Host path of the workspace the agent edits. */
  workspace: string;
  provider?: string;
  model?: string;
  /** Override run id (default: random UUID). */
  runId?: string;
  /** Root data dir (default: ./data). */
  dataDir?: string;
  /** Project id used for on-disk layout (default: "local"). */
  projectId?: string;
  params?: Record<string, unknown>;
  apiKeys?: Record<string, string>;
  /**
   * Workspace source for run.start provenance.
   * When omitted, the CLI treats `--workspace` as an existing host dir
   * (ensured to be a git repo) rather than cloning.
   */
  workspaceSpec?: WorkspaceSpec;
  /** If true, skip spawning the agent (dry-run / fixture-only). */
  skipAgent?: boolean;
  /** Optional: inject a pre-built adapter (tests). */
  adapter?: Adapter;
  /** Optional: custom spawn (tests). */
  spawnAgent?: (
    ctx: RunContext,
    adapter: Adapter,
  ) => Promise<{
    stdout: AsyncIterable<string | Buffer>;
    stderr: AsyncIterable<string | Buffer>;
    exitCode: number;
    durationMs: number;
  }>;
}

export interface RunResult {
  runId: string;
  runDir: string;
  eventsPath: string;
  diffPath?: string;
  hunkIndexPath?: string;
  status: RunStatus;
  durationMs: number;
  prepared?: PreparedWorkspace;
  diff?: CaptureDiffResult;
}

function collectApiKeys(extra?: Record<string, string>): Record<string, string> {
  const keys: Record<string, string> = { ...extra };
  const fromEnv = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "MINIMAX_API_KEY",
    "ANTHROPIC_BASE_URL",
  ];
  for (const name of fromEnv) {
    const v = process.env[name];
    if (v && !keys[name]) keys[name] = v;
  }
  // pi / anthropic SDK often want ANTHROPIC_API_KEY; map AUTH_TOKEN if needed.
  if (!keys.ANTHROPIC_API_KEY && keys.ANTHROPIC_AUTH_TOKEN) {
    keys.ANTHROPIC_API_KEY = keys.ANTHROPIC_AUTH_TOKEN;
  }
  return keys;
}

function defaultDataDir(): string {
  return resolve(process.cwd(), "data");
}

/**
 * Execute one eval run end-to-end (local process; no Docker).
 * Writes under `<dataDir>/runs/<runId>/` (P1 layout; projects/ lands in P3).
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const agentId = options.agent;
  if (agentId === "reapercode" && REAPER_STATUS === "spec-ahead-of-reaper") {
    throw new Error(
      "Adapter `reapercode` is not liveable yet: ReaperCode is missing " +
        "structured `thinking`, `--stream-events`, and `run_end` " +
        "(see plan/reapercode-changes.md). Use `pi` for live runs, or feed " +
        "a post-change trajectory fixture into the parse() path.",
    );
  }

  const adapter = options.adapter ?? getAdapter(agentId);
  const runId = options.runId ?? randomUUID();
  const dataDir = options.dataDir ?? defaultDataDir();
  const runDir = join(dataDir, "runs", runId);
  const eventsPath = join(runDir, "events.jsonl");
  await mkdir(runDir, { recursive: true });

  const workspaceDir = resolve(options.workspace);
  let prepared: PreparedWorkspace | undefined;
  const workspaceSpec: WorkspaceSpec =
    options.workspaceSpec ?? { source: "empty" };

  // When a WorkspaceSpec is explicitly git, clone into workspaceDir.
  // Otherwise treat --workspace as an existing host directory.
  if (options.workspaceSpec?.source === "git") {
    prepared = await prepareWorkspace(options.workspaceSpec, {
      targetDir: workspaceDir,
    });
  } else {
    await ensureGitRepo(workspaceDir);
    prepared = {
      dir: workspaceDir,
      source: workspaceSpec.source,
      ...(workspaceSpec.source === "git"
        ? { repo: workspaceSpec.repo }
        : {}),
    };
  }

  const provider =
    options.provider ??
    process.env.AGENTEVAL_PROVIDER ??
    "anthropic";
  const model =
    options.model ??
    process.env.AGENTEVAL_MODEL ??
    "claude-sonnet-4-20250514";

  const ctx: RunContext = {
    runId,
    project: { id: options.projectId ?? "local" },
    task: {
      prompt: options.task,
      workspace: prepared
        ? prepared.source === "git"
          ? {
              source: "git",
              repo: prepared.repo ?? (options.workspaceSpec && options.workspaceSpec.source === "git" ? options.workspaceSpec.repo : workspaceDir),
              ...(prepared.ref ? { ref: prepared.ref } : {}),
            }
          : { source: "empty" }
        : workspaceSpec,
    },
    model,
    provider,
    params: { ...(options.params ?? {}) },
    workspaceDir,
    apiKeys: collectApiKeys(options.apiKeys),
  };

  // Snapshot run.json for provenance.
  await writeFile(
    join(runDir, "run.json"),
    `${JSON.stringify(
      {
        runId,
        agent: adapter.id,
        model: ctx.model,
        provider: ctx.provider,
        params: ctx.params,
        workspace: {
          dir: workspaceDir,
          source: prepared?.source ?? "empty",
          repo: prepared?.repo,
          commit: prepared?.commit,
          ref: prepared?.ref,
        },
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const started = Date.now();
  let seq = -1;
  let status: RunStatus = "completed";
  let usageTotal: Usage | undefined;
  let sawTerminal = false;
  // Track fatal errors so a clean-exit-but-crashed run still reads "failed".
  // Spec (plan/adapters.md): "Never trust clean exit alone: derive run.end.status
  // from exit code AND presence of a terminal event; a crash mid-stream → failed".
  let sawFatalError = false;
  let lastErrorMessage: string | undefined;

  const record = async (event: CanonicalEvent): Promise<void> => {
    // Ensure monotonic seq even if adapter restarted counters.
    if (event.seq <= seq) {
      seq += 1;
      event = { ...event, seq };
    } else {
      seq = event.seq;
    }
    if (event.type === "usage") {
      usageTotal = accumulate(usageTotal, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        reasoningTokens: event.reasoningTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        totalTokens: event.totalTokens,
        cost: event.cost,
      });
    }
    if (event.type === "run.end") {
      sawTerminal = true;
      status = event.status;
    }
    if (event.type === "error" && event.fatal) {
      sawFatalError = true;
      lastErrorMessage = event.message;
    }
    // Redaction pass on ingest — secrets must never reach events.jsonl.
    // Spec: plan/execution.md § Secrets, CLAUDE.md quality gate.
    await appendEvent(eventsPath, redactEvent(event));
  };

  // Emit harness-owned run.start so provenance is always present.
  await record({
    v: 1,
    runId,
    seq: 0,
    ts: new Date().toISOString(),
    type: "run.start",
    agent: adapter.id === "reapercode" ? "reapercode" : "pi",
    model: ctx.model,
    provider: ctx.provider,
    workspace: {
      source: prepared?.source ?? "empty",
      ...(prepared?.repo ? { repo: prepared.repo } : {}),
      ...(prepared?.commit ? { commit: prepared.commit } : {}),
    },
    params: { ...ctx.params },
  });

  let exitCode = 0;
  let agentDurationMs = 0;

  if (!options.skipAgent) {
    try {
      const streams = options.spawnAgent
        ? await options.spawnAgent(ctx, adapter)
        : await spawnLocalAgent(ctx, adapter);

      exitCode = streams.exitCode;
      agentDurationMs = streams.durationMs;

      for await (const event of adapter.parse(
        {
          stdout: streams.stdout,
          stderr: streams.stderr,
          exitCode: streams.exitCode,
          durationMs: streams.durationMs,
        },
        ctx,
      )) {
        // Skip adapter-emitted run.start / run.end — harness owns boundaries.
        if (event.type === "run.start" || event.type === "run.end") continue;
        await record(event);
      }

      // Derive final status from exit code AND fatal-error signal — never from
      // exit code alone. A crash mid-stream may still exit 0 (e.g. adapter
      // flushed a fatal error then exited cleanly); that run is "failed".
      // Spec: plan/adapters.md "Never trust clean exit alone".
      status = deriveRunStatus({
        adapterStatus: sawTerminal ? status : undefined,
        exitCode,
        sawFatalError,
      });
    } catch (err) {
      status = "failed";
      const message = err instanceof Error ? err.message : String(err);
      await record({
        v: 1,
        runId,
        seq: seq + 1,
        ts: new Date().toISOString(),
        type: "error",
        message,
        phase: "agent",
        fatal: true,
      });
    }
  }

  // Diff capture (coding/git categories).
  let diff: CaptureDiffResult | undefined;
  try {
    diff = await captureDiff(workspaceDir, {
      outPath: join(runDir, "diff.patch"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record({
      v: 1,
      runId,
      seq: seq + 1,
      ts: new Date().toISOString(),
      type: "error",
      message: `diff capture failed: ${message}`,
      phase: "finalize",
    });
  }

  const durationMs = Date.now() - started;
  if (!sawTerminal) {
    await record({
      v: 1,
      runId,
      seq: seq + 1,
      ts: new Date().toISOString(),
      type: "run.end",
      status,
      durationMs: agentDurationMs || durationMs,
      ...(diff ? { diffPath: diff.patchPath } : {}),
      ...(usageTotal ? { usageTotal } : {}),
    });
  }

  return {
    runId,
    runDir,
    eventsPath,
    ...(diff
      ? { diffPath: diff.patchPath, hunkIndexPath: diff.indexPath, diff }
      : {}),
    status,
    durationMs,
    prepared,
  };
}

/**
 * Derive run.end.status from exit code, fatal-error, timeout, and abort signals,
 * optionally letting the adapter's own self-reported terminal status win.
 *
 * Priority (plan/adapters.md "Never trust clean exit alone" + plan/execution.md
 * run-control):
 *  1. Operator abort → "aborted" (takes precedence; the operator cut the run short).
 *  2. Wall-clock timeout → "timeout".
 *  3. A fatal error event → "failed" (crash mid-stream), even at exit 0.
 *  4. A non-zero exit code → "failed".
 *  5. Otherwise honor an adapter-reported terminal status if present; else "completed".
 *
 * Shared by the local orchestrator and {@link RunController.finalize}.
 */
export function deriveRunStatus(input: {
  adapterStatus?: RunStatus;
  exitCode: number;
  sawFatalError: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}): RunStatus {
  if (input.aborted) return "aborted";
  if (input.timedOut) return "timeout";
  if (input.sawFatalError) return "failed";
  if (input.exitCode !== 0) return "failed";
  if (input.adapterStatus) return input.adapterStatus;
  return "completed";
}

function accumulate(total: Usage | undefined, next: Usage): Usage {
  if (!total) return { ...next };
  const merged: Usage = {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
  if (total.reasoningTokens !== undefined || next.reasoningTokens !== undefined) {
    merged.reasoningTokens =
      (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  }
  if (total.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined) {
    merged.cacheReadTokens =
      (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  }
  if (
    total.cacheWriteTokens !== undefined ||
    next.cacheWriteTokens !== undefined
  ) {
    merged.cacheWriteTokens =
      (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
  }
  if (total.totalTokens !== undefined || next.totalTokens !== undefined) {
    merged.totalTokens = (total.totalTokens ?? 0) + (next.totalTokens ?? 0);
  }
  return merged;
}

/**
 * Spawn the agent as a local child process (Dockerless P1 path).
 * Streams stdout/stderr line-buffered via the child's pipes.
 */
export async function spawnLocalAgent(
  ctx: RunContext,
  adapter: Adapter,
): Promise<{
  stdout: AsyncIterable<string | Buffer>;
  stderr: AsyncIterable<string | Buffer>;
  exitCode: number;
  durationMs: number;
}> {
  const { argv, env } = adapter.command(ctx);
  if (argv.length === 0) {
    throw new Error(`Adapter ${adapter.id} returned empty argv`);
  }
  const [file, ...args] = argv;
  const started = Date.now();

  const child = spawn(file!, args, {
    cwd: ctx.workspaceDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Multiplex: collect chunks into async iterables that complete on close.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutDone = new Promise<void>((resolveDone) => {
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stdout?.on("end", () => resolveDone());
    child.stdout?.on("error", () => resolveDone());
  });
  const stderrDone = new Promise<void>((resolveDone) => {
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    child.stderr?.on("end", () => resolveDone());
    child.stderr?.on("error", () => resolveDone());
  });

  const exitCode: number = await new Promise((resolveExit, reject) => {
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
  await Promise.all([stdoutDone, stderrDone]);

  async function* once(bufs: Buffer[]): AsyncIterable<Buffer> {
    if (bufs.length === 0) return;
    yield Buffer.concat(bufs);
  }

  return {
    stdout: once(stdoutChunks),
    stderr: once(stderrChunks),
    exitCode,
    durationMs: Date.now() - started,
  };
}

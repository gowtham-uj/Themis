/**
 * Bridge DB runs → P2 RunController + NetworkCutoff (in-process worker).
 *
 * P3 keeps live runs in memory; P8 replaces this with a real worker/queue.
 * In this Dockerless env every run executes via {@link FakeContainerRuntime}.
 *
 * Test seam: pass `{ adapter }` (or set via {@link setDefaultAdapter}) so tests
 * can inject a fixture adapter that yields a couple of events then exits
 * promptly — never hit a real model.
 *
 * Spec: plan/api.md (run control), plan/execution.md (run lifecycle).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, RunContext } from "../adapters/types.js";
import { getAdapter } from "../adapters/index.js";
import type { DbQueries, Run } from "../db/queries.js";
import type { CanonicalEvent, RunStatus as EventRunStatus } from "../schema/events.js";
import { appendEvent } from "../schema/append.js";
import { RunController, type ControlState } from "../runner/control.js";
import { FakeContainerRuntime } from "../runner/fake-runtime.js";
import { NetworkCutoff } from "../runner/network-control.js";
import { redactEvent } from "../runner/redact.js";
import { prepareWorkspace, ensureGitRepo } from "../runner/workspace.js";
import type { ContainerHandle } from "../runner/runtime.js";
import { runChecks } from "../runner/check-runner.js";
import { captureDiff } from "../runner/diff.js";
import {
  resolveAdapterOverrides,
  resolveRunNetwork,
} from "../runner/project-config.js";

/** Terminal run statuses (control actions return 409). */
export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "aborted",
  "timeout",
]);

export function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Emit run.completed once after a run reaches terminal status.
 * No-ops when dispatcher is undefined (outbound webhooks off).
 */
function emitRunCompletedHook(
  dispatcher: OutboundWebhookEmitter | undefined,
  queries: DbQueries,
  runId: string,
  projectId: string,
  status: string,
): void {
  if (!dispatcher) return;
  try {
    const run = queries.getRun(runId);
    const endedAt = run?.endedAt ?? new Date().toISOString();
    void dispatcher.dispatchEvent({
      type: "run.completed",
      projectId: run?.projectId ?? projectId,
      resourceId: runId,
      data: {
        status: run?.status ?? status,
        endedAt,
      },
      timestamp: endedAt,
    });
  } catch {
    // never break the runner for webhook delivery
  }
}

/** In-memory handle for a live (or recently finished) run. */
export interface LiveRun {
  runId: string;
  projectId: string;
  taskId: string;
  eventsPath: string;
  runDir: string;
  workspaceDir: string;
  controller: RunController;
  network: NetworkCutoff;
  handle: ContainerHandle;
  /** Promise that resolves when the run finishes (success or abort). */
  done: Promise<void>;
  /** True once finalize has written terminal status to the DB. */
  finished: boolean;
}

/**
 * Minimal outbound-webhook surface used by the runner at terminal finalization.
 * Kept structural to avoid a hard cycle with the dispatcher module.
 */
export interface OutboundWebhookEmitter {
  dispatchEvent(event: {
    type: string;
    projectId: string;
    resourceId: string;
    data: Record<string, unknown>;
    timestamp: string;
  }): void | Promise<void>;
}

/** Options for {@link startRun}. */
export interface StartRunOptions {
  /**
   * Inject a fixture adapter for tests. Prefer this over real pi/reaper so
   * tests stay fast + deterministic (no model calls).
   */
  adapter?: Adapter;
  /** Override FakeContainerRuntime (tests). */
  runtime?: FakeContainerRuntime;
  /** Hard wall-clock timeout for the child process (ms). */
  timeoutMs?: number;
  /** When true, skip spawning the agent process (events-only dry run). */
  skipAgent?: boolean;
  /**
   * Optional outbound webhook dispatcher (P8c). When present, emits
   * run.completed exactly once after terminal finalize. No-ops when omitted
   * so runner stays unchanged for callers that do not enable outbound webhooks.
   */
  outboundWebhooks?: OutboundWebhookEmitter;
}

/** Mutable in-memory registry of live runs (P8 will replace with a queue). */
export type LiveRunsMap = Map<string, LiveRun>;

export function createLiveRunsMap(): LiveRunsMap {
  return new Map();
}

/** Process-wide default adapter override (tests). Cleared with undefined. */
let defaultAdapter: Adapter | undefined;

/**
 * Set a process-default adapter used when startRun is not given one.
 * Tests should call `setDefaultAdapter(fixture)` in beforeAll and clear after.
 */
export function setDefaultAdapter(adapter: Adapter | undefined): void {
  defaultAdapter = adapter;
}

export function getDefaultAdapter(): Adapter | undefined {
  return defaultAdapter;
}

/** On-disk dir for a run: `<dataDir>/projects/<pid>/runs/<rid>`. */
export function runDirPath(dataDir: string, projectId: string, runId: string): string {
  return join(dataDir, "projects", projectId, "runs", runId);
}

function eventsPathFor(dataDir: string, projectId: string, runId: string): string {
  return join(runDirPath(dataDir, projectId, runId), "events.jsonl");
}

function collectApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "MINIMAX_API_KEY",
    "ANTHROPIC_BASE_URL",
  ]) {
    const v = process.env[name];
    if (v) keys[name] = v;
  }
  if (!keys.ANTHROPIC_API_KEY && keys.ANTHROPIC_AUTH_TOKEN) {
    keys.ANTHROPIC_API_KEY = keys.ANTHROPIC_AUTH_TOKEN;
  }
  return keys;
}

/**
 * Start a previously-created DB run: prepare workspace, launch via
 * FakeContainerRuntime, stream redacted events to events.jsonl, and register
 * the RunController in `liveRuns`.
 *
 * Marks the run as executing via FakeContainerRuntime in this Dockerless env.
 * Returns the live entry (also stored in the map).
 */
export async function startRun(
  dataDir: string,
  queries: DbQueries,
  runId: string,
  liveRuns: LiveRunsMap,
  opts: StartRunOptions = {},
): Promise<LiveRun> {
  if (liveRuns.has(runId)) {
    return liveRuns.get(runId)!;
  }

  const run = queries.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (isTerminalStatus(run.status)) {
    throw new Error(`run ${runId} is already terminal (${run.status})`);
  }

  const task = queries.getTask(run.taskId);
  if (!task) throw new Error(`task not found: ${run.taskId}`);

  const projectId = run.projectId;
  const runDir = runDirPath(dataDir, projectId, runId);
  const eventsPath = eventsPathFor(dataDir, projectId, runId);
  const workspaceDir = join(runDir, "workspace");
  await mkdir(runDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  // Resolve adapter: explicit opt > process default > registry by agentId.
  const adapter: Adapter =
    opts.adapter ?? defaultAdapter ?? getAdapter(run.agentId);

  // Prepare workspace from the task's WorkspaceSpec.
  let workspaceCommit: string | undefined;
  if (task.workspace.source === "git") {
    const prepared = await prepareWorkspace(task.workspace, {
      targetDir: workspaceDir,
    });
    workspaceCommit = prepared.commit;
  } else {
    await ensureGitRepo(workspaceDir);
  }

  const runtime = opts.runtime ?? new FakeContainerRuntime();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const network = new NetworkCutoff();

  // Per-project execution config refines the global adapter for this codebase
  // (plan/projects.md §82): image pin, project env, tool allowlist, network
  // policy. Absent config → undefined overrides → adapter defaults unchanged.
  const projectRow = queries.getProject(projectId);
  const overrides = resolveAdapterOverrides(projectRow);
  const networkMode = resolveRunNetwork(projectRow, overrides);

  const ctx: RunContext = {
    runId,
    project: { id: projectId },
    task: {
      prompt: task.prompt,
      workspace: task.workspace,
    },
    model: run.model,
    provider: run.provider,
    params: overrides?.params ?? {},
    workspaceDir,
    apiKeys: collectApiKeys(),
    ...(overrides ? { overrides } : {}),
  };

  // Snapshot run.json for provenance (alongside DB row).
  await writeFile(
    join(runDir, "run.json"),
    `${JSON.stringify(
      {
        runId,
        projectId,
        taskId: task.id,
        agent: adapter.id,
        model: run.model,
        provider: run.provider,
        runtime: "FakeContainerRuntime",
        workspace: {
          dir: workspaceDir,
          source: task.workspace.source,
          ...(task.workspace.source === "git"
            ? { repo: task.workspace.repo, commit: workspaceCommit }
            : {}),
        },
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();

  // Mark running in DB before launching. eventsPath is conventional
  // (projects/<pid>/runs/<runId>/events.jsonl); SSE resolves it without a DB write.
  queries.updateRunStatus(runId, "running");
  queries.updateRunControlState(runId, {
    controlState: "running",
    status: "running",
  });

  let handle: ContainerHandle;
  let nextSeq = 0;

  const record = async (event: CanonicalEvent): Promise<void> => {
    let e = event;
    if (e.seq <= nextSeq - 1 && nextSeq > 0) {
      e = { ...e, seq: nextSeq };
    }
    nextSeq = e.seq + 1;
    await appendEvent(eventsPath, redactEvent(e));
  };

  // Emit harness-owned run.start.
  await record({
    v: 1,
    runId,
    seq: 0,
    ts: startedAtIso,
    type: "run.start",
    agent: adapter.id === "reapercode" ? "reapercode" : "pi",
    model: run.model,
    provider: run.provider,
    workspace: {
      source: task.workspace.source === "git" ? "git" : "empty",
      ...(task.workspace.source === "git" ? { repo: task.workspace.repo } : {}),
      ...(workspaceCommit ? { commit: workspaceCommit } : {}),
    },
    params: {},
  });
  nextSeq = 1;

  if (opts.skipAgent) {
    // No process — a dummy handle that is already "done".
    handle = await runtime.run({
      image: adapter.image(ctx),
      workspaceDir,
      argv: ["node", "-e", "process.exit(0)"],
      env: {},
      limits: { cpus: 1, memoryMiB: 256, pids: 64 },
      timeoutMs: 5_000,
      network: networkMode,
      nonRoot: true,
    });
  } else {
    const { argv, env } = adapter.command(ctx);
    handle = await runtime.run({
      image: adapter.image(ctx),
      workspaceDir,
      argv: argv.length > 0 ? argv : ["node", "-e", "process.exit(0)"],
      env,
      limits: { cpus: 1, memoryMiB: 512, pids: 128 },
      timeoutMs,
      network: networkMode,
      ...(overrides?.ports ? { ports: overrides.ports } : {}),
      nonRoot: true,
    });
  }

  // Resolved execution provenance — which image/network/overrides this run
  // actually launched with after the project's config was applied, plus the
  // ports the sandbox published (ephemeral requests now resolved to concrete
  // host ports, so a dev server / browser debug port is addressable). Written
  // post-launch for exactly that reason. Kept in its own artifact because
  // run.json is owned by the query layer, which rewrites it from the DB row on
  // every status transition.
  await writeFile(
    join(runDir, "exec.json"),
    `${JSON.stringify(
      {
        runId,
        image: adapter.image(ctx),
        network: networkMode,
        adapterOverrides: overrides ?? null,
        ports: handle.ports ?? [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const controller = new RunController({
    handle,
    eventsPath,
    runId,
    startedAt,
    nextSeq,
  });

  const live: LiveRun = {
    runId,
    projectId,
    taskId: task.id,
    eventsPath,
    runDir,
    workspaceDir,
    controller,
    network,
    handle,
    finished: false,
    done: Promise.resolve(),
  };

  // Kick off the async execution pipeline; store the done promise.
  live.done = (async () => {
    let sawFatalError = false;
    let adapterStatus: EventRunStatus | undefined;
    try {
      if (!opts.skipAgent) {
        // Parse adapter streams while the process runs.
        for await (const event of adapter.parse(
          {
            stdout: handle.stdout(),
            stderr: handle.stderr(),
            exitCode: handle.wait().then((w) => w.exitCode),
            durationMs: undefined,
          },
          ctx,
        )) {
          if (event.type === "run.start" || event.type === "run.end") continue;
          if (event.type === "error" && event.fatal) sawFatalError = true;
          await record(event);
          // Keep controller's nextSeq roughly in sync for abort error events.
        }
      }

      // Capture diff best-effort.
      let diffPath: string | undefined;
      try {
        const diff = await captureDiff(workspaceDir, {
          outPath: join(runDir, "diff.patch"),
        });
        diffPath = diff.patchPath;
      } catch {
        // ignore — empty workspaces may not produce a meaningful diff
      }

      const final = await controller.finalize({
        adapterStatus,
        sawFatalError,
      });

      // If abort already set control state, trust it.
      const status = final.status;
      const durationMs = final.durationMs;

      if (!live.finished) {
        // Emit run.end if abort didn't already push a terminal path.
        const current = queries.getRun(runId);
        const alreadyTerminal =
          current != null && isTerminalStatus(current.status);

        if (!alreadyTerminal || current?.status === "running" || current?.status === "paused") {
          await record({
            v: 1,
            runId,
            seq: nextSeq++,
            ts: new Date().toISOString(),
            type: "run.end",
            status,
            durationMs,
            ...(diffPath ? { diffPath } : {}),
          });
        }

        queries.finalizeRun(runId, {
          status,
          durationMs,
          eventsPath,
          ...(diffPath ? { diffPath } : {}),
          controlState: final.controlState === "aborted" ? "aborted" : "done",
        });
        live.finished = true;

        // P9: run deterministic checks (rubric.checks) post-exec on a successful
        // run, writing checks.json + mirroring to the DB. The judge worker loads
        // these via loadCheckResults and folds pass-rates into the verdict
        // (plan/rubric.md §5). Best-effort: never breaks the run for checks.
        // Opt-in: tasks without rubric.checks run unchanged (runChecks no-ops).
        if (status === "completed") {
          try {
            // Project may have been archived/deleted mid-run; checks are
            // best-effort + opt-in, so fall back to a config-less project
            // slice rather than skipping (default runner mapping applies).
            const project = queries.getProject(projectId);
            const checkProject = project
              ? { id: project.id, checkRunners: project.checkRunners }
              : { id: projectId };
            await runChecks(queries, runtime, checkProject, task, runDir, {
              workspaceDir,
              runId,
              timeoutMs,
            });
          } catch {
            // a check-runner failure must not affect run finalization
          }
        }

        // P8c: emit run.completed exactly once at terminal finalization.
        emitRunCompletedHook(opts.outboundWebhooks, queries, runId, projectId, status);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await record({
          v: 1,
          runId,
          seq: nextSeq++,
          ts: new Date().toISOString(),
          type: "error",
          message,
          phase: "agent",
          fatal: true,
        });
        await record({
          v: 1,
          runId,
          seq: nextSeq++,
          ts: new Date().toISOString(),
          type: "run.end",
          status: "failed",
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // best-effort
      }
      try {
        queries.finalizeRun(runId, {
          status: "failed",
          eventsPath,
          error: message,
          controlState: "done",
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // best-effort
      }
      live.finished = true;
      // P8c: emit run.completed for the failed path too.
      emitRunCompletedHook(opts.outboundWebhooks, queries, runId, projectId, "failed");
    } finally {
      try {
        await handle.remove();
      } catch {
        // best-effort cleanup
      }
    }
  })();

  liveRuns.set(runId, live);
  return live;
}

/**
 * Soft or hard pause. Updates DB control_state. No-op (throws conflict path
 * upstream) when terminal.
 */
export async function pauseRun(
  runId: string,
  mode: "soft" | "hard",
  queries: DbQueries,
  liveRuns: LiveRunsMap,
): Promise<Run> {
  const run = queries.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (isTerminalStatus(run.status)) {
    throw Object.assign(new Error(`run ${runId} is terminal (${run.status})`), {
      code: "TERMINAL",
    });
  }

  const live = liveRuns.get(runId);
  if (live) {
    await live.controller.pause(mode);
  }

  const controlState: ControlState = mode === "hard" ? "paused-hard" : "paused-soft";
  return queries.updateRunControlState(runId, {
    controlState,
    status: "paused",
    pausedAt: new Date().toISOString(),
    incrementPauseCount: true,
  });
}

/** Resume a soft/hard paused run. */
export async function resumeRun(
  runId: string,
  queries: DbQueries,
  liveRuns: LiveRunsMap,
): Promise<Run> {
  const run = queries.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (isTerminalStatus(run.status)) {
    throw Object.assign(new Error(`run ${runId} is terminal (${run.status})`), {
      code: "TERMINAL",
    });
  }

  const live = liveRuns.get(runId);
  if (live) {
    await live.controller.resume();
  }

  return queries.updateRunControlState(runId, {
    controlState: "running",
    status: "running",
    resumedAt: new Date().toISOString(),
  });
}

/** Abort a run (SIGTERM→KILL). Keeps partial events. */
export async function abortRun(
  runId: string,
  queries: DbQueries,
  liveRuns: LiveRunsMap,
  outboundWebhooks?: OutboundWebhookEmitter,
): Promise<Run> {
  const run = queries.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (isTerminalStatus(run.status)) {
    throw Object.assign(new Error(`run ${runId} is terminal (${run.status})`), {
      code: "TERMINAL",
    });
  }

  const projectId = run.projectId;
  const live = liveRuns.get(runId);
  if (live) {
    // Mark aborting in DB first so concurrent readers see it.
    queries.updateRunControlState(runId, {
      controlState: "aborting",
      status: "running",
    });
    await live.controller.abort();
    // Controller.abort emits a fatal error event; finalize via the done pipeline
    // or write terminal status now.
    if (!live.finished) {
      queries.finalizeRun(runId, {
        status: "aborted",
        eventsPath: live.eventsPath,
        controlState: "aborted",
        durationMs: live.controller.durationMs(),
      });
      live.finished = true;
      // P8c: emit run.completed for the abort path too — "aborted" is terminal,
      // so subscribers learn the run ended. No-ops when no dispatcher; never
      // throws (emit helper swallows). Exactly-once: this only runs when we just
      // set live.finished (the done pipeline's emit is guarded by !live.finished).
      emitRunCompletedHook(
        outboundWebhooks,
        queries,
        runId,
        projectId,
        "aborted",
      );
    }
  } else {
    // No live handle (e.g. still queued) — mark aborted in DB.
    queries.finalizeRun(runId, {
      status: "aborted",
      controlState: "aborted",
    });
    emitRunCompletedHook(outboundWebhooks, queries, runId, projectId, "aborted");
  }

  return queries.getRun(runId)!;
}

/**
 * Toggle live network cutoff for a run.
 * `enabled: false` cuts egress; `enabled: true` restores it.
 */
export function setNetwork(
  runId: string,
  enabled: boolean,
  liveRuns: LiveRunsMap,
): { runId: string; egressEnabled: boolean; cutoffAt: string | null } {
  const live = liveRuns.get(runId);
  if (!live) {
    throw Object.assign(new Error(`run ${runId} is not live`), {
      code: "NOT_LIVE",
    });
  }
  if (enabled) {
    live.network.restore();
  } else {
    live.network.cutoff();
  }
  return {
    runId,
    egressEnabled: !live.network.isBlocked(),
    cutoffAt: live.network.cutoffAt(),
  };
}

/**
 * Conventional on-disk events path for a run (whether or not it is live).
 */
export function resolveEventsPath(
  dataDir: string,
  projectId: string,
  runId: string,
  dbPath?: string | null,
): string {
  if (dbPath) return dbPath;
  return eventsPathFor(dataDir, projectId, runId);
}

/**
 * Conventional on-disk diff path for a run.
 */
export function resolveDiffPath(
  dataDir: string,
  projectId: string,
  runId: string,
  dbPath?: string | null,
): string {
  if (dbPath) return dbPath;
  return join(runDirPath(dataDir, projectId, runId), "diff.patch");
}

/**
 * Build a minimal fixture adapter for tests.
 * Yields a `log` event (and optional extras) then exits via a short node -e.
 *
 * Documented test seam: pass the result to createServer({ adapter }) or
 * startRun(..., { adapter }).
 */
export function createFixtureAdapter(
  opts: {
    id?: string;
    /** Extra stdout lines the fake process prints (parsed as log messages). */
    messages?: string[];
    /** Exit code of the child process. */
    exitCode?: number;
    /** Hold the process open for N ms (for pause/abort tests). */
    holdMs?: number;
  } = {},
): Adapter {
  const id = opts.id ?? "fixture";
  const messages = opts.messages ?? ["fixture-hello"];
  const exitCode = opts.exitCode ?? 0;
  const holdMs = opts.holdMs ?? 50;

  // Encode messages as JSON lines on stdout so parse() can pick them up.
  const stdoutScript = [
    ...messages.map(
      (m) => `process.stdout.write(${JSON.stringify(m + "\\n")});`,
    ),
    holdMs > 0
      ? `await new Promise(r => setTimeout(r, ${holdMs}));`
      : "",
    `process.exit(${exitCode});`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id,
    image: () => "agenteval/fixture:test",
    command: () => ({
      argv: ["node", "--input-type=module", "-e", stdoutScript],
      env: {},
    }),
    async *parse(streams, ctx) {
      // Drain stdout into log events; ignore stderr.
      let seq = 1;
      let buf = "";
      for await (const chunk of streams.stdout) {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          yield {
            v: 1 as const,
            runId: ctx.runId,
            seq: seq++,
            ts: new Date().toISOString(),
            type: "log" as const,
            level: "info" as const,
            message: line,
          };
        }
      }
      if (buf.trim()) {
        yield {
          v: 1 as const,
          runId: ctx.runId,
          seq: seq++,
          ts: new Date().toISOString(),
          type: "log" as const,
          level: "info" as const,
          message: buf.trim(),
        };
      }
    },
  };
}

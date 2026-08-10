/**
 * Bridge DB runs → P2 RunController + NetworkCutoff (in-process worker).
 *
 * P3 keeps live runs in memory; P8 replaces this with a real worker/queue.
 * Every run executes through a real OCI container backend; Podman is default.
 *
 * Spec: plan/api.md (run control), plan/execution.md (run lifecycle).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, RunContext } from "../adapters/types.js";
import { getAdapter } from "../adapters/index.js";
import { createDeclarativeAdapter } from "../adapters/declarative.js";
import type { DbQueries, Run } from "../db/queries.js";
import type { CanonicalEvent, RunStatus as EventRunStatus } from "../schema/events.js";
import { appendEvent } from "../schema/append.js";
import { RunController, type ControlState } from "../runner/control.js";
import { NetworkCutoff } from "../runner/network-control.js";
import { prepareWorkspace, ensureGitRepo } from "../runner/workspace.js";
import {
  resolveRuntime,
  type ContainerExecResult,
  type ContainerExecSpec,
  type ContainerHandle,
  type ContainerRuntime,
} from "../runner/runtime.js";
import { runChecks } from "../runner/check-runner.js";
import { captureDiff } from "../runner/diff.js";
import {
  resolveAdapterOverrides,
  resolveRunNetwork,
} from "../runner/project-config.js";
import {
  cleanupEnv,
  parseEvalEnvSpec,
  provisionEnv,
  ProvisionError,
} from "../runner/env-provision.js";

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

/**
 * Invoke the run-finalized callback, swallowing anything it throws.
 *
 * Judging is downstream bookkeeping: a judge that fails must leave the run's
 * recorded status untouched, not turn a completed run into a failed one.
 */
async function notifyRunFinalized(
  opts: StartRunOptions,
  queries: DbQueries,
  runId: string,
  projectId: string,
  status: string,
): Promise<void> {
  if (!opts.onRunFinalized) return;
  try {
    const run = queries.getRun(runId);
    await opts.onRunFinalized({
      runId,
      projectId,
      batchId: run?.batchId ?? "",
      status,
    });
  } catch {
    // never let judging affect the run outcome
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
  /** Execute inside this exact live container and append an operator exec event. */
  exec(spec: ContainerExecSpec): Promise<ContainerExecResult>;
  /** False once agent execution has ended and final diff capture has begun. */
  acceptingExec: boolean;
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
   * Container backend for this run. Any {@link ContainerRuntime} — the fake
   * (tests), or a real one such as PodmanRuntime. Defaults to the fake.
   */
  runtime?: ContainerRuntime;
  /** Hard wall-clock timeout for the child process (ms). */
  timeoutMs?: number;
  /** When true, skip spawning the agent process (events-only dry run). */
  skipAgent?: boolean;
  /**
   * Optional injected adapter. When omitted, startRun resolves the project's
   * configured CLI adapter (declarative project adapter, else a built-in).
   * Tests that exercise container-config plumbing with a real Podman container
   * (no model: a `sh -c exit 0` adapter) may pass one explicitly.
   */
  adapter?: Adapter;
  /**
   * Optional outbound webhook dispatcher (P8c). When present, emits
   * run.completed exactly once after terminal finalize. No-ops when omitted
   * so runner stays unchanged for callers that do not enable outbound webhooks.
   */
  outboundWebhooks?: OutboundWebhookEmitter;
  /**
   * Called exactly once after a run reaches terminal status, with the batch it
   * belonged to. The API layer uses this to auto-judge the run and, when the
   * run was the LAST of its batch, to judge the release as a whole.
   *
   * A callback rather than a direct call so the runner keeps no dependency on
   * the judge. Failures here never affect the run's recorded status.
   */
  onRunFinalized?: (info: {
    runId: string;
    projectId: string;
    batchId: string;
    status: string;
  }) => void | Promise<void>;
}

/** Mutable in-memory registry of live runs (P8 will replace with a queue). */
export type LiveRunsMap = Map<string, LiveRun>;

export function createLiveRunsMap(): LiveRunsMap {
  return new Map();
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
    "NEURALWATT_API_KEY",
    "NURALWATT_API_KEY",
    "NURALWATT_BASE_URL",
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
 * Start a previously-created DB run: prepare workspace, launch through the
 * configured real container runtime, stream events to events.jsonl,
 * and register the RunController in `liveRuns`.
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

  // Resolve the project's one real CLI agent adapter, falling back to a
  // built-in adapter only when the project has not created a declarative one.
  // An explicitly injected adapter (real-container config tests) short-circuits
  // this so they do not depend on a project adapter row.
  const projectAdapter = opts.adapter
    ? undefined
    : queries.getProjectAgentAdapterByAgentId(run.projectId, run.agentId);
  if (!opts.adapter) {
    const configuredAdapters = queries.listProjectAgentAdapters(run.projectId, {
      includeDisabled: true,
    });
    if (
      configuredAdapters.length > 0 &&
      (!projectAdapter || !projectAdapter.enabled)
    ) {
      throw new Error(
        `run ${run.id} does not use the project's enabled agent adapter`,
      );
    }
  }
  const adapter: Adapter =
    opts.adapter ??
    (projectAdapter ? createDeclarativeAdapter(projectAdapter) : getAdapter(run.agentId));

  // Prepare the workspace.
  //
  // A run may PIN the commit it evaluates, overriding the task's own ref. That
  // is the "evaluate this commit" flow: the same eval suite, aimed at whichever
  // revision you want to measure — a PR head, a release tag, a specific sha —
  // without editing every task definition.
  //
  // The repo may also be overridden, so one suite can be pointed at a fork.
  let workspaceCommit: string | undefined;
  const pinnedRepo = run.workspaceRepo ?? null;
  const pinnedRef = run.workspaceRef ?? null;
  const taskRepo =
    task.workspace.source === "git" ? task.workspace.repo : undefined;
  const effectiveRepo = pinnedRepo ?? taskRepo;

  if (effectiveRepo) {
    const prepared = await prepareWorkspace(
      {
        source: "git",
        repo: effectiveRepo,
        // Explicit pin wins; otherwise the task's own ref.
        ...(pinnedRef
          ? { ref: pinnedRef }
          : task.workspace.source === "git" && task.workspace.ref
            ? { ref: task.workspace.ref }
            : {}),
      },
      { targetDir: workspaceDir },
    );
    workspaceCommit = prepared.commit;
  } else {
    await ensureGitRepo(workspaceDir);
  }

  const runtime = opts.runtime ?? resolveRuntime();

  // ---- eval environment ----
  // The eval declares what it needs (greenfield scaffold or brownfield repo
  // prep) via a setup script. It runs INSIDE the pod, and its output becomes
  // the git baseline, so nothing setup produced is later attributed to the
  // agent. A failed setup aborts the run: judging an agent in a broken
  // environment produces a result that looks like agent failure but isn't.
  const envSpec = parseEvalEnvSpec(task.env);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const network = new NetworkCutoff();

  // Per-project execution config refines the global adapter for this codebase
  // (plan/projects.md §82): image pin, project env, tool allowlist, network
  // policy. Absent config → undefined overrides → adapter defaults unchanged.
  const projectRow = queries.getProject(projectId);
  // A per-run image pin (POST /runs adapterOverrides.image, stored on the run/
  // batch as agentImage) is more specific than the project's workspaceImage, so
  // it layers on top.
  // The run's own overrides (env, params, tools) layer over the project's.
  // agentImage is kept as a fallback for runs created before the blob was
  // stored, and for queue promotes that only carry an image tag.
  const runOverrides =
    run.adapterOverrides ??
    (run.agentImage ? { image: run.agentImage } : undefined);
  const overrides = resolveAdapterOverrides(projectRow, runOverrides);
  const networkMode = resolveRunNetwork(projectRow, overrides);
  // Per-project sandbox controls (caps, mounts, devices, tmpfs, ...). Passed
  // through the spec so real backends apply them; the fake ignores it.
  const sandbox = projectRow?.sandbox ?? undefined;

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

  if (envSpec && (envSpec.setupScript || envSpec.commitBaseline !== false)) {
    try {
      const provision = await provisionEnv(runtime, envSpec, {
        // The AGENT's image — setup builds the environment in the same
        // toolchain the agent will work in, not a separate one.
        image: adapter.image(ctx),
        workspaceDir,
        network: networkMode,
        ...(sandbox ? { sandbox } : {}),
      });
      await writeFile(
        join(runDir, "provision.json"),
        `${JSON.stringify(provision, null, 2)}\n`,
        "utf8",
      );
      workspaceCommit = provision.baselineCommit ?? workspaceCommit;
    } catch (err) {
      const result =
        err instanceof ProvisionError
          ? err.result
          : { error: err instanceof Error ? err.message : String(err) };
      await writeFile(
        join(runDir, "provision.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
      queries.finalizeRun(runId, {
        status: "failed",
        error: `environment provisioning failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        eventsPath,
      });
      throw err;
    }
  }


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
        runtime: runtime.constructor.name,
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
  let recordTail: Promise<void> = Promise.resolve();

  // Adapter output and operator introspection can arrive concurrently. Serialize
  // assignment + append so events.jsonl remains monotonic and append-only.
  const record = (event: CanonicalEvent): Promise<void> => {
    const write = recordTail.then(async () => {
      let e = event;
      if (e.seq < nextSeq) e = { ...e, seq: nextSeq };
      nextSeq = e.seq + 1;
      await appendEvent(eventsPath, e);
    });
    recordTail = write.catch(() => undefined);
    return write;
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
      ...(sandbox ? { sandbox } : {}),
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
        sandbox: sandbox ?? null,
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

  const activeExecs = new Set<Promise<ContainerExecResult>>();
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
    acceptingExec: true,
    exec(spec) {
      if (!live.acceptingExec || live.finished) {
        throw Object.assign(
          new Error(`run ${runId} is no longer accepting container exec`),
          { code: "NOT_LIVE" },
        );
      }
      const startedAt = Date.now();
      const execution = (async () => {
        const result = await handle.exec(spec);
        await record({
          v: 1,
          runId,
          seq: -1,
          ts: new Date().toISOString(),
          type: "exec",
          actor: "operator",
          source: "introspection",
          argv: [...spec.argv],
          cwd: spec.cwd ?? "/workspace",
          user: "container-default",
          exitCode: result.timedOut ? null : result.exitCode,
          durationMs: result.durationMs || Date.now() - startedAt,
        });
        return result;
      })();
      activeExecs.add(execution);
      void execution.finally(() => activeExecs.delete(execution)).catch(() => undefined);
      return execution;
    },
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

      // Close the bridge before final capture, then wait for every command that
      // was accepted while the agent was live. This prevents a command racing
      // diff capture or continuing after container teardown.
      live.acceptingExec = false;
      await Promise.allSettled([...activeExecs]);

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

        // Tear down the eval's environment so the next eval starts clean.
        // Deliberately AFTER the diff, checks and traces are captured —
        // cleanup that ran earlier would delete the evidence the judge needs.
        // Never affects the run's recorded status.
        if (envSpec?.cleanupScript) {
          const cleanup = await cleanupEnv(runtime, envSpec, {
            image: adapter.image(ctx),
            workspaceDir,
            network: networkMode,
            ...(sandbox ? { sandbox } : {}),
          });
          await writeFile(
            join(runDir, "cleanup.json"),
            `${JSON.stringify(cleanup, null, 2)}\n`,
            "utf8",
          ).catch(() => undefined);
        }

        // P8c: emit run.completed exactly once at terminal finalization.
        emitRunCompletedHook(opts.outboundWebhooks, queries, runId, projectId, status);

        // Auto-judge + batch rollup. Deliberately after finalizeRun so the
        // judge reads a run whose terminal state is already durable.
        await notifyRunFinalized(opts, queries, runId, projectId, status);
      }
    } catch (err) {
      live.acceptingExec = false;
      await Promise.allSettled([...activeExecs]);
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
      await notifyRunFinalized(opts, queries, runId, projectId, "failed");
    } finally {
      live.acceptingExec = false;
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
    live.acceptingExec = false;
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


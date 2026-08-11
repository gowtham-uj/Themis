/** Sequential eval execution inside one persistent queue-owned container. */

import { cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Adapter, RunContext } from "../adapters/types.js";
import { getAdapter } from "../adapters/index.js";
import { createDeclarativeAdapter } from "../adapters/declarative.js";
import type {
  DbQueries,
  EvalQueue,
  EvalQueueItem,
  QueueContainer,
  Run,
  Task,
} from "../db/queries.js";
import {
  evalEnvironmentDigest,
  loadEvalPackageRuntimeConfig,
  prepareEvalPackageWorkspace,
  restoreEvalLifecycleScript,
  type EvalPackageRuntimeConfig,
} from "../evals/package.js";
import type { CanonicalEvent, RunStatus as EventRunStatus } from "../schema/events.js";
import { appendEvent } from "../schema/append.js";
import { captureDiffByCategory } from "./diff-category.js";
import {
  cleanupEnvInContainer,
  parseEvalEnvSpec,
  provisionEnvInContainer,
  ProvisionError,
  verifyCleanupInContainer,
} from "./env-provision.js";
import { sealEvalArchive } from "./eval-archive.js";
import { analyzeEvidenceIntegrity } from "./evidence-integrity.js";
import { deriveRunMetrics } from "./metrics.js";
import { buildEvalAgentImage } from "./package-image.js";
import { runCanonicalPackageVerifier } from "./package-verifier.js";
import { resolveAdapterOverrides, resolveNetworkMode } from "./project-config.js";
import { resolveRuntime } from "./runtime.js";
import type {
  ContainerExecHandle,
  ContainerExecResult,
  ContainerExecSpec,
  ContainerHandle,
  ContainerRuntime,
} from "./runtime.js";
import { deriveRunStatus } from "./run.js";
import { commitWorkspaceBaseline } from "./workspace.js";

const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
const RAW_STDOUT = "raw-stdout.log";
const RAW_STDERR = "raw-stderr.log";
const EVENTS = "events.jsonl";

export interface StartQueueContainerOptions {
  runtime?: ContainerRuntime;
  timeoutMs?: number;
  onQueueDrained?: (info: {
    queueId: string;
    projectId: string;
    batchId: string;
    runIds: string[];
    tainted: boolean;
  }) => void | Promise<void>;
}

/** In-memory controller for one live queue-owned container. */
export interface LiveQueueContainer {
  queueId: string;
  projectId: string;
  batchId: string;
  queueContainerId: string;
  workspaceDir: string;
  handle: ContainerHandle;
  currentRunId: string | null;
  currentQueueItemId: string | null;
  acceptingExec: boolean;
  paused: boolean;
  stopRequested: boolean;
  finished: boolean;
  done: Promise<void>;
  startExec(spec: ContainerExecSpec): Promise<ContainerExecHandle>;
  exec(spec: ContainerExecSpec): Promise<ContainerExecResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

export type LiveQueueContainersMap = Map<string, LiveQueueContainer>;

/** Create the process-local registry used by queue routes and introspection. */
export function createLiveQueueContainersMap(): LiveQueueContainersMap {
  return new Map();
}

interface ExpandedRun {
  run: Run;
  item: EvalQueueItem;
  task: Task;
  packageRuntime: EvalPackageRuntimeConfig;
  overrides: Record<string, unknown> | null;
}

interface EventRecorder {
  append(event: CanonicalEvent): Promise<void>;
  operator(spec: ContainerExecSpec, result: ContainerExecResult): Promise<void>;
}

/** Spawn one persistent container and begin draining its snapshotted eval queue. */
export async function startQueueContainer(
  dataDir: string,
  queries: DbQueries,
  queueId: string,
  liveQueues: LiveQueueContainersMap,
  opts: StartQueueContainerOptions = {},
): Promise<LiveQueueContainer> {
  const existing = liveQueues.get(queueId);
  if (existing && !existing.finished) {
    throw Object.assign(new Error(`queue ${queueId} already has a live container`), {
      code: "ALREADY_ACTIVE",
    });
  }
  if (queries.getActiveQueueContainer(queueId)) {
    throw Object.assign(new Error(`queue ${queueId} already has an active container record`), {
      code: "ALREADY_ACTIVE",
    });
  }

  const queue = queries.getEvalQueue(queueId);
  if (!queue) throw new Error(`eval queue not found: ${queueId}`);
  const project = queries.getProject(queue.projectId);
  if (!project) throw new Error(`project not found: ${queue.projectId}`);
  const items = queries.listEvalQueueItems(queueId).filter((item) => item.enabled);
  if (items.length === 0) throw new Error(`queue ${queueId} has no enabled evals`);

  const sharedAdapter = queue.sharedAdapterId
    ? queries.getProjectAgentAdapter(queue.sharedAdapterId)
    : null;
  if (queue.sharedAdapterId && (!sharedAdapter || !sharedAdapter.shared || !sharedAdapter.enabled)) {
    throw new Error(`referenced shared adapter ${queue.sharedAdapterId} is unavailable`);
  }
  if (sharedAdapter && sharedAdapter.agentId !== queue.agentId) {
    throw new Error(`queue ${queue.id} agent_id does not match shared adapter ${sharedAdapter.id}`);
  }
  const projectAdapter = sharedAdapter
    ? null
    : queries.getProjectAgentAdapterByAgentId(queue.projectId, queue.agentId);
  if (projectAdapter && !projectAdapter.enabled) {
    throw new Error(`project agent adapter ${projectAdapter.id} is disabled`);
  }
  const adapterDef = sharedAdapter ?? projectAdapter;
  if (adapterDef?.containerfile && adapterDef.buildStatus !== "ready") {
    throw new Error(
      `agent adapter ${adapterDef.id} image is not ready; build it through the adapter API first`,
    );
  }
  const configuredAdapters = queries.listProjectAgentAdapters(queue.projectId, {
    includeDisabled: true,
  });
  if (!sharedAdapter && configuredAdapters.length > 0 && !projectAdapter) {
    throw new Error(
      `queue ${queue.id} does not use project ${queue.projectId}'s configured agent`,
    );
  }
  const queueAdapter = adapterDef
    ? createDeclarativeAdapter(adapterDef)
    : getAdapter(queue.agentId);
  const runtime = opts.runtime ?? resolveRuntime();
  const tasks = new Map<string, Task>();
  const packageRuntimes = new Map<string, EvalPackageRuntimeConfig>();
  for (const item of items) {
    const task = queries.getTask(item.taskId);
    if (!task || task.projectId !== queue.projectId || task.archived) {
      throw new Error(`queue item ${item.id} references unavailable eval ${item.taskId}`);
    }
    if (!task.packagePath || !task.packageDigest || !task.packageManifest) {
      throw new Error(`queue item ${item.id} references a non-canonical eval package`);
    }
    tasks.set(task.id, task);
    if (!packageRuntimes.has(task.id)) {
      packageRuntimes.set(task.id, await loadEvalPackageRuntimeConfig({
        packagePath: task.packagePath,
        packageDigest: task.packageDigest,
        manifest: task.packageManifest,
      }));
    }
  }

  const workspaceDir = join(
    dataDir,
    "projects",
    queue.projectId,
    "queues",
    queue.id,
    "workspace",
  );
  await mkdir(workspaceDir, { recursive: true });
  await clearDirectory(workspaceDir);

  const firstItem = items[0]!;
  const firstTask = tasks.get(firstItem.taskId)!;
  const firstOverrides = mergeOverrides(queue.adapterOverrides, firstItem.overrides);
  const firstCtx = makeRunContext(
    `queue-image-${queue.id}`,
    queue,
    firstTask,
    workspaceDir,
    resolveAdapterOverrides(project, firstOverrides),
  );
  const adapterImage = queueAdapter.image(firstCtx);
  const firstEnvironmentDigest = evalEnvironmentDigest(firstTask.packageManifest!);
  const builtEvalImage = await buildEvalAgentImage({
    runtime,
    task: firstTask,
    adapterImage,
    buildRoot: join(
      dataDir,
      "projects",
      queue.projectId,
      "queues",
      queue.id,
      "environment-builds",
    ),
  });
  const image = builtEvalImage.image;
  const firstResolved = resolveAdapterOverrides(project, firstOverrides);
  const firstPackageRuntime = packageRuntimes.get(firstTask.id)!;
  const configuredNetwork = resolveNetworkMode(firstResolved?.network ?? queue.networkPolicy);
  if (configuredNetwork !== firstPackageRuntime.network) {
    throw new Error(
      `queue ${queue.id} network policy ${configuredNetwork} does not match eval package policy ${firstPackageRuntime.network}`,
    );
  }
  const containerNetwork = firstPackageRuntime.network;
  const containerNetworkAllowlist = firstPackageRuntime.networkAllowlist;
  const containerPorts = queue.ports.length > 0 ? queue.ports : (firstResolved?.ports ?? []);

  // Container-level settings are immutable for the lifetime of a persistent
  // queue. Reject item overrides that would only appear to change them.
  for (const item of items) {
    const task = tasks.get(item.taskId)!;
    const raw = mergeOverrides(queue.adapterOverrides, item.overrides);
    const resolved = resolveAdapterOverrides(project, raw);
    const itemAdapterImage = queueAdapter.image(
      makeRunContext(
        `queue-image-${queue.id}-${item.id}`,
        queue,
        task,
        workspaceDir,
        resolved,
      ),
    );
    if (itemAdapterImage !== adapterImage) {
      throw new Error(
        `queue ${queue.id} resolves multiple adapter images (${adapterImage}, ${itemAdapterImage}); one persistent queue requires one image`,
      );
    }
    const itemEnvironmentDigest = evalEnvironmentDigest(task.packageManifest!);
    if (itemEnvironmentDigest !== firstEnvironmentDigest) {
      throw new Error(
        `queue ${queue.id} contains multiple agent environment digests; split them into separate queues`,
      );
    }
    const itemNetwork = resolveNetworkMode(resolved?.network ?? queue.networkPolicy);
    const itemPackageRuntime = packageRuntimes.get(task.id)!;
    if (itemNetwork !== containerNetwork || itemPackageRuntime.network !== containerNetwork) {
      throw new Error(
        `queue ${queue.id} resolves incompatible queue/package network policies; one persistent queue requires one policy`,
      );
    }
    if (JSON.stringify(itemPackageRuntime.networkAllowlist) !== JSON.stringify(containerNetworkAllowlist)) {
      throw new Error(
        `queue ${queue.id} contains multiple package network allowlists; split them into separate queues`,
      );
    }
    if (
      itemPackageRuntime.cpus !== firstPackageRuntime.cpus ||
      itemPackageRuntime.memoryMiB !== firstPackageRuntime.memoryMiB
    ) {
      throw new Error(
        `queue ${queue.id} contains multiple package CPU/RAM limits; split them into separate queues`,
      );
    }
    const itemPorts = queue.ports.length > 0 ? queue.ports : (resolved?.ports ?? []);
    if (JSON.stringify(itemPorts) !== JSON.stringify(containerPorts)) {
      throw new Error(
        `queue ${queue.id} resolves multiple port sets; one persistent queue requires one port set`,
      );
    }
  }

  const expandedCount = items.reduce((sum, item) => sum + item.repeats, 0);
  const batch = queries.createBatch({
    taskId: firstTask.id,
    projectId: queue.projectId,
    agentId: queue.agentId,
    model: queue.model,
    provider: queue.provider,
    params: resolveAdapterOverrides(project, firstOverrides)?.params ?? {},
    repeats: expandedCount,
    trigger: "eval-queue",
    triggerRef: queue.id,
    agentImage: image,
    queueId: queue.id,
    queueRevision: queue.revision,
  });
  const containerRow = queries.createQueueContainer({
    queueId: queue.id,
    projectId: queue.projectId,
    batchId: batch.id,
    image,
    state: "starting",
    workspaceDir,
  });

  const expanded: ExpandedRun[] = [];
  for (const item of items) {
    const task = tasks.get(item.taskId)!;
    const rawOverrides = mergeOverrides(queue.adapterOverrides, item.overrides);
    for (let repeatIndex = 0; repeatIndex < item.repeats; repeatIndex++) {
      const run = queries.createRun({
        batchId: batch.id,
        taskId: task.id,
        projectId: queue.projectId,
        queueId: queue.id,
        queueItemId: item.id,
        queueContainerId: containerRow.id,
        agentId: queue.agentId,
        model: queue.model,
        provider: queue.provider,
        repeatIndex,
        evalVersion: task.version,
        evalSnapshot: taskSnapshot(task),
        status: "queued",
        agentImage: image,
        adapterOverrides: rawOverrides,
        trigger: "eval-queue",
        triggerRef: queue.id,
        controlState: "running",
      });
      expanded.push({
        run,
        item,
        task,
        packageRuntime: packageRuntimes.get(task.id)!,
        overrides: rawOverrides,
      });
    }
  }

  queries.updateEvalQueue(queue.id, {
    status: "starting",
    activeBatchId: batch.id,
  });

  let handle: ContainerHandle;
  try {
    const sandbox = {
      ...(project.sandbox ?? {}),
      ...(queue.sandbox ?? {}),
    };
    handle = await runtime.run({
      image,
      workspaceDir,
      argv: [
        "sh",
        "-c",
        "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
      ],
      env: {},
      limits: { cpus: firstPackageRuntime.cpus, pids: 512 },
      timeoutMs: 0,
      network: containerNetwork,
      ...(containerNetwork === "allowlist"
        ? { networkAllowlist: containerNetworkAllowlist }
        : {}),
      ports: containerPorts,
      nonRoot: false,
      ...(Object.keys(sandbox).length > 0 ? { sandbox } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    queries.updateQueueContainer(containerRow.id, {
      state: "failed",
      stoppedAt: new Date().toISOString(),
      error: message,
    });
    queries.updateEvalQueue(queue.id, {
      status: "failed",
      activeBatchId: null,
    });
    for (const entry of expanded) {
      queries.finalizeRun(entry.run.id, {
        status: "failed",
        error: `queue container failed to start: ${message}`,
        controlState: "done",
      });
    }
    throw err;
  }

  queries.updateQueueContainer(containerRow.id, {
    runtimeContainerId: handle.id,
    state: "running",
    ports: handle.ports ?? [],
    startedAt: new Date().toISOString(),
  });
  queries.updateEvalQueue(queue.id, { status: "running" });

  let currentRecorder: EventRecorder | null = null;
  let currentExec: ContainerExecHandle | null = null;
  const live: LiveQueueContainer = {
    queueId: queue.id,
    projectId: queue.projectId,
    batchId: batch.id,
    queueContainerId: containerRow.id,
    workspaceDir,
    handle,
    currentRunId: null,
    currentQueueItemId: null,
    acceptingExec: true,
    paused: false,
    stopRequested: false,
    finished: false,
    done: Promise.resolve(),
    async startExec(spec) {
      if (!live.acceptingExec || live.finished) {
        throw Object.assign(new Error(`queue ${queue.id} has no live container`), {
          code: "NOT_LIVE",
        });
      }
      if (live.paused) {
        throw Object.assign(new Error(`queue ${queue.id} container is paused`), {
          code: "PAUSED",
        });
      }
      const session = await handle.startExec(spec);
      const startedAt = Date.now();
      void session.wait().then(async (result) => {
        if (!currentRecorder) return;
        await currentRecorder.operator(spec, {
          ...result,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          durationMs: result.durationMs || Date.now() - startedAt,
        });
      }).catch(() => undefined);
      return session;
    },
    async exec(spec) {
      if (!live.acceptingExec || live.finished) {
        throw Object.assign(new Error(`queue ${queue.id} has no live container`), {
          code: "NOT_LIVE",
        });
      }
      if (live.paused) {
        throw Object.assign(new Error(`queue ${queue.id} container is paused`), {
          code: "PAUSED",
        });
      }
      const result = await handle.exec(spec);
      if (currentRecorder) await currentRecorder.operator(spec, result);
      return result;
    },
    async pause() {
      if (live.finished) throw new Error(`queue ${queue.id} is stopped`);
      await handle.pause();
      live.paused = true;
      queries.updateQueueContainer(containerRow.id, { state: "paused" });
      queries.updateEvalQueue(queue.id, { status: "paused" });
    },
    async resume() {
      if (live.finished) throw new Error(`queue ${queue.id} is stopped`);
      await handle.resume();
      live.paused = false;
      queries.updateQueueContainer(containerRow.id, {
        state: live.currentRunId ? "running" : "idle",
      });
      queries.updateEvalQueue(queue.id, {
        status: live.currentRunId ? "running" : "completed",
      });
    },
    async stop(graceMs = 10_000) {
      if (live.finished) return;
      live.stopRequested = true;
      live.acceptingExec = false;
      if (currentExec) await currentExec.stop(Math.min(graceMs, 2_000)).catch(() => undefined);
      queries.updateQueueContainer(containerRow.id, { state: "stopping" });
      await handle.stop(graceMs).catch(() => undefined);
      await handle.remove().catch(() => undefined);
      live.finished = true;
      queries.updateQueueContainer(containerRow.id, {
        state: "stopped",
        stoppedAt: new Date().toISOString(),
      });
      queries.updateEvalQueue(queue.id, {
        status: "stopped",
        activeBatchId: null,
      });
      liveQueues.delete(queue.id);
    },
  };
  liveQueues.set(queue.id, live);

  live.done = (async () => {
    let tainted = false;
    const runIds: string[] = [];
    try {
      const connection = await verifyAdapterConnection({
        dataDir,
        queue,
        batchId: batch.id,
        adapter: queueAdapter,
        handle,
        workspaceDir,
        task: firstTask,
        overrides: resolveAdapterOverrides(project, firstOverrides),
      });
      const connectionReset = await clearWorkspaceInContainer(handle);
      if (!connectionReset.ok) {
        connection.error = connection.error ?? connectionReset.error;
        connection.ok = false;
      }
      if (!connection.ok) {
        const message = `agent/provider connection check failed: ${connection.error ?? "no real model response"}`;
        queries.updateQueueContainer(containerRow.id, {
          state: "running",
          error: message,
        });
        queries.updateEvalQueue(queue.id, { status: "failed" });
        for (const entry of expanded) {
          queries.finalizeRun(entry.run.id, {
            status: "failed",
            error: message,
            controlState: "done",
          });
        }
        return;
      }

      // Run the adapter's optional configure step (provider connection + model
      // selection) once before any eval. A non-zero exit taints the queue.
      if (queueAdapter.configure) {
        const configureCtx: RunContext = makeRunContext(
          `configure-${batch.id}`,
          queue,
          firstTask,
          workspaceDir,
          resolveAdapterOverrides(project, firstOverrides),
        );
        const configureProbe = queueAdapter.configure(configureCtx);
        if (configureProbe) {
          const configureResult = await handle.exec({
            argv: configureProbe.command.argv,
            env: configureProbe.command.env,
            cwd: configureProbe.cwd ?? "/workspace",
            user: "root",
            timeoutMs: configureProbe.timeoutMs ?? 120_000,
            maxOutputBytes: 1024 * 1024,
          });
          const configureDir = join(
            dataDir,
            "projects",
            queue.projectId,
            "queues",
            queue.id,
            "batches",
            batch.id,
            "configure",
          );
          await mkdir(configureDir, { recursive: true }).catch(() => undefined);
          await writeJson(join(configureDir, "configure.json"), {
            adapterId: adapterDef?.id ?? queue.agentId,
            provider: configureCtx.provider,
            model: configureCtx.model,
            command: configureProbe.command.argv,
            cwd: configureProbe.cwd ?? "/workspace",
            exitCode: configureResult.exitCode,
            stdout: configureResult.stdout,
            stderr: configureResult.stderr,
            timedOut: configureResult.timedOut,
            durationMs: configureResult.durationMs,
          }).catch(() => undefined);
          if (configureResult.exitCode !== 0) {
            const message = `agent configure step failed (exit ${configureResult.exitCode}): ${configureResult.stderr.slice(0, 500)}`;
            queries.updateQueueContainer(containerRow.id, { state: "running", error: message });
            queries.updateEvalQueue(queue.id, { status: "failed" });
            for (const entry of expanded) {
              queries.finalizeRun(entry.run.id, { status: "failed", error: message, controlState: "done" });
            }
            return;
          }
        }
      }

      for (const entry of expanded) {
        if (live.stopRequested || tainted) break;
        live.currentRunId = entry.run.id;
        live.currentQueueItemId = entry.item.id;
        queries.updateQueueContainer(containerRow.id, { state: "running" });
        const outcome = await executeEval({
          dataDir,
          queries,
          runtime,
          queue,
          containerRow,
          handle,
          adapter: queueAdapter,
          entry,
          workspaceDir,
          timeoutMs: opts.timeoutMs ?? entry.packageRuntime.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
          isStopRequested: () => live.stopRequested,
          setExec: (session) => {
            currentExec = session;
          },
          setRecorder: (recorder) => {
            currentRecorder = recorder;
          },
        });
        runIds.push(entry.run.id);
        tainted = outcome.tainted;
        currentExec = null;
        currentRecorder = null;
      }

      live.currentRunId = null;
      live.currentQueueItemId = null;
      if (live.stopRequested) return;
      queries.updateQueueContainer(containerRow.id, {
        state: tainted ? "failed" : "idle",
        ...(tainted ? { error: "queue workspace cleanup/reset failed" } : {}),
      });
      queries.updateEvalQueue(queue.id, {
        status: tainted ? "tainted" : "completed",
      });
      if (opts.onQueueDrained) {
        await opts.onQueueDrained({
          queueId: queue.id,
          projectId: queue.projectId,
          batchId: batch.id,
          runIds,
          tainted,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queries.updateQueueContainer(containerRow.id, {
        state: "failed",
        error: message,
      });
      queries.updateEvalQueue(queue.id, { status: "failed" });
    } finally {
      currentExec = null;
      currentRecorder = null;
    }
  })();

  return live;
}

async function executeEval(input: {
  dataDir: string;
  queries: DbQueries;
  runtime: ContainerRuntime;
  queue: EvalQueue;
  containerRow: QueueContainer;
  handle: ContainerHandle;
  adapter: Adapter;
  entry: ExpandedRun;
  workspaceDir: string;
  timeoutMs: number;
  isStopRequested: () => boolean;
  setExec: (session: ContainerExecHandle | null) => void;
  setRecorder: (recorder: EventRecorder | null) => void;
}): Promise<{ tainted: boolean }> {
  const { queries, queue, containerRow, handle, adapter, entry, workspaceDir } = input;
  const run = entry.run;
  const task = entry.task;
  const runDir = join(
    input.dataDir,
    "projects",
    queue.projectId,
    "evals",
    run.id,
  );
  const eventsPath = join(runDir, EVENTS);
  await mkdir(runDir, { recursive: true });
  await clearDirectory(workspaceDir);

  if (!task.packagePath || !task.packageDigest || !task.packageManifest) {
    throw new Error(`eval ${task.id} is not a validated canonical eval package`);
  }
  await prepareEvalPackageWorkspace({
    packagePath: task.packagePath,
    packageDigest: task.packageDigest,
    manifest: task.packageManifest,
    workspaceDir,
  });
  let workspaceCommit: string | undefined = await commitWorkspaceBaseline(workspaceDir);
  const packageRuntime = entry.packageRuntime;

  const project = queries.getProject(queue.projectId);
  if (!project) throw new Error(`project not found: ${queue.projectId}`);
  const overrides = resolveAdapterOverrides(project, entry.overrides);
  const ctx = makeRunContext(run.id, queue, task, workspaceDir, overrides);
  const envSpec = parseEvalEnvSpec(task.env);
  const startedAt = Date.now();
  let nextSeq = 0;
  let recordTail: Promise<void> = Promise.resolve();
  const recordedEvents: CanonicalEvent[] = [];

  const record: EventRecorder = {
    append(event) {
      const pending = recordTail.then(async () => {
        const normalized = event.seq < nextSeq ? { ...event, seq: nextSeq } : event;
        nextSeq = normalized.seq + 1;
        await appendEvent(eventsPath, normalized);
        recordedEvents.push(normalized);
      });
      recordTail = pending.catch(() => undefined);
      return pending;
    },
    operator(spec, result) {
      return this.append({
        v: 1,
        runId: run.id,
        seq: -1,
        ts: new Date().toISOString(),
        type: "exec",
        actor: "operator",
        source: "introspection",
        argv: [...spec.argv],
        cwd: spec.cwd ?? "/workspace",
        user: spec.user ?? "container-default",
        exitCode: result.timedOut ? null : result.exitCode,
        durationMs: result.durationMs,
      });
    },
  };
  input.setRecorder(record);

  await writeJson(join(runDir, "eval.json"), taskSnapshot(task));
  await writeJson(join(runDir, "queue.json"), {
    queue,
    queueItem: entry.item,
    batchId: run.batchId,
    queueContainerId: containerRow.id,
    runtimeContainerId: handle.id,
  });
  await writeJson(join(runDir, "run.json"), {
    ...run,
    evalVersion: task.version,
    workspaceCommit,
    startedAt: new Date(startedAt).toISOString(),
  });
  await writeJson(join(runDir, "exec.json"), {
    image: handle.image,
    network: resolveNetworkMode(overrides?.network ?? queue.networkPolicy),
    adapterOverrides: overrides ?? null,
    sandbox:
      Object.keys({ ...(project.sandbox ?? {}), ...(queue.sandbox ?? {}) }).length > 0
        ? { ...(project.sandbox ?? {}), ...(queue.sandbox ?? {}) }
        : null,
    ports: handle.ports ?? [],
    runtimeContainerId: handle.id,
  });

  queries.updateRunStatus(run.id, "running");
  queries.updateRunControlState(run.id, {
    controlState: "running",
    status: "running",
  });

  let status: EventRunStatus = "failed";
  let runError: string | null = null;
  let diffPath: string | undefined;
  let sawFatalError = false;
  let adapterStatus: EventRunStatus | undefined;
  let agentStarted = false;

  try {
    if (packageRuntime.setupPath) {
      const setup = await handle.exec({
        argv: ["/bin/bash", packageRuntime.setupPath],
        cwd: "/workspace",
        env: {
          ...packageRuntime.agentEnv,
          AGENTEVAL_TRIAL_ID: run.id,
        },
        user: "root",
        timeoutMs: packageRuntime.setupTimeoutMs,
      });
      await writeJson(join(runDir, "setup-manifest.json"), {
        setup_status: setup.exitCode === 0 && !setup.timedOut ? "success" : "failed",
        duration_ms: setup.durationMs,
        exit_code: setup.exitCode,
        timed_out: setup.timedOut,
        stdout: setup.stdout,
        stderr: setup.stderr,
        package_digest: task.packageDigest,
      });
      if (setup.exitCode !== 0 || setup.timedOut) {
        throw new Error(
          setup.timedOut
            ? "canonical eval setup timed out"
            : `canonical eval setup exited ${setup.exitCode}`,
        );
      }
    }
    if (envSpec && (envSpec.setupScript || envSpec.commitBaseline !== false)) {
      try {
        const provision = await provisionEnvInContainer(handle, envSpec, workspaceDir);
        workspaceCommit = provision.baselineCommit ?? workspaceCommit;
        await writeJson(join(runDir, "provision.json"), provision);
      } catch (err) {
        const result =
          err instanceof ProvisionError
            ? err.result
            : { error: err instanceof Error ? err.message : String(err) };
        await writeJson(join(runDir, "provision.json"), result);
        throw err;
      }
    }

    await record.append({
      v: 1,
      runId: run.id,
      seq: 0,
      ts: new Date().toISOString(),
      type: "run.start",
      agent: input.adapter.id,
      model: queue.model,
      provider: queue.provider,
      workspace: {
        source: task.workspace.source === "git" ? "git" : "empty",
        ...(task.workspace.source === "git" ? { repo: task.workspace.repo } : {}),
        ...(workspaceCommit ? { commit: workspaceCommit } : {}),
      },
      params: overrides?.params ?? {},
    });
    nextSeq = 1;

    const command = input.adapter.command(ctx);
    if (command.argv.length === 0) throw new Error(`adapter ${input.adapter.id} returned empty argv`);
    const session = await handle.startExec({
      argv: command.argv,
      cwd: command.cwd ?? "/workspace",
      env: { ...packageRuntime.agentEnv, ...command.env },
      timeoutMs: command.timeoutMs ?? input.timeoutMs,
    });
    input.setExec(session);
    agentStarted = true;

    const stdoutChannel = new AsyncChannel<Buffer>();
    const stderrChannel = new AsyncChannel<Buffer>();
    const stdoutPump = pumpStream(session.stdout(), join(runDir, RAW_STDOUT), stdoutChannel);
    const stderrPump = pumpStream(session.stderr(), join(runDir, RAW_STDERR), stderrChannel);
    const waitPromise = session.wait();

    try {
      for await (const event of input.adapter.parse(
        {
          stdout: stdoutChannel,
          stderr: stderrChannel,
          exitCode: waitPromise.then((result) => result.exitCode),
          durationMs: waitPromise.then((result) => result.durationMs),
        },
        ctx,
      )) {
        if (event.type === "run.start") continue;
        if (event.type === "run.end") {
          adapterStatus = event.status;
          continue;
        }
        if (event.type === "error" && event.fatal) sawFatalError = true;
        await record.append(event);
      }
    } catch (err) {
      await session.stop().catch(() => undefined);
      throw err;
    } finally {
      await Promise.allSettled([stdoutPump, stderrPump]);
    }

    const execResult = await waitPromise;
    input.setExec(null);
    status = deriveRunStatus({
      adapterStatus,
      exitCode: execResult.exitCode,
      sawFatalError,
      timedOut: execResult.timedOut,
      aborted: input.isStopRequested(),
    });
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    status = input.isStopRequested() ? "aborted" : "failed";
    await record.append({
      v: 1,
      runId: run.id,
      seq: -1,
      ts: new Date().toISOString(),
      type: "error",
      message: runError,
      phase: agentStarted ? "agent" : "prepare",
      fatal: true,
    }).catch(() => undefined);
  } finally {
    input.setExec(null);
  }

  try {
    const diff = await captureDiffByCategory(task.agentCategory, workspaceDir, {
      outPath:
        task.agentCategory === "coding" || task.agentCategory === "general"
          ? join(runDir, "diff.patch")
          : runDir,
      manifestPath: join(runDir, "outputs-manifest.json"),
    });
    if (diff.kind === "git") diffPath = diff.patchPath;
    else if (diff.kind === "outputs") diffPath = diff.manifestPath;
  } catch (err) {
    await writeJson(join(runDir, "diff-error.json"), {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Capture agent-authored evidence before the hidden verifier can touch the
  // workspace. The agent process is already stopped at this point.
  const evidence = await copyRetainedEvidence(
    workspaceDir,
    runDir,
    input.adapter.evidence(ctx),
  );
  await writeJson(join(runDir, "evidence-extraction.json"), evidence);
  await record.append({
    v: 1,
    runId: run.id,
    seq: -1,
    ts: new Date().toISOString(),
    type: "run.end",
    status,
    durationMs: Date.now() - startedAt,
    ...(diffPath ? { diffPath } : {}),
  }).catch(() => undefined);
  await recordTail;

  let verifierError: string | null = null;
  try {
    const verifier = await runCanonicalPackageVerifier({
      runtime: input.runtime,
      task,
      runId: run.id,
      workspaceDir,
      runDir,
    });
    queries.storeCheckResults(run.id, verifier.checks);
    await writeJson(join(runDir, "verifier.json"), verifier);
  } catch (err) {
    verifierError = err instanceof Error ? err.message : String(err);
    queries.storeCheckResults(run.id, [{
      checkId: "package-verifier",
      kind: "test_suite",
      status: "error",
      detail: verifierError,
    }]);
    await writeJson(join(runDir, "verifier-error.json"), {
      error: verifierError,
    });
  }

  let packageCleanup = {
    ran: false,
    exitCode: null as number | null,
    timedOut: false,
    stdout: "",
    stderr: "",
    durationMs: 0,
    error: null as string | null,
  };
  if (packageRuntime.cleanupPath) {
    try {
      await restoreEvalLifecycleScript({
        packagePath: task.packagePath,
        workspaceDir,
        containerPath: packageRuntime.cleanupPath,
      });
      const result = await handle.exec({
        argv: ["/bin/bash", packageRuntime.cleanupPath],
        cwd: "/workspace",
        env: {
          ...packageRuntime.agentEnv,
          AGENTEVAL_TRIAL_ID: run.id,
        },
        user: "root",
        timeoutMs: packageRuntime.cleanupTimeoutMs,
      });
      packageCleanup = {
        ran: true,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        error:
          result.exitCode === 0 && !result.timedOut
            ? null
            : result.timedOut
              ? "canonical eval cleanup timed out"
              : `canonical eval cleanup exited ${result.exitCode}`,
      };
    } catch (err) {
      packageCleanup = {
        ...packageCleanup,
        ran: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  await writeJson(join(runDir, "package-cleanup.json"), packageCleanup);

  const cleanup = envSpec
    ? await cleanupEnvInContainer(handle, envSpec)
    : { ran: false, exitCode: null, log: "", durationMs: 0, error: null };
  await writeJson(join(runDir, "cleanup.json"), cleanup);

  let verification = {
    ran: false,
    exitCode: null as number | null,
    log: "",
    durationMs: 0,
    error: null as string | null,
  };
  try {
    if (envSpec) verification = await verifyCleanupInContainer(handle, envSpec);
  } catch (err) {
    verification = {
      ran: true,
      exitCode: null,
      log: "",
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  await writeJson(join(runDir, "cleanup-verification.json"), verification);

  const reset = await resetContainerWorkspace(handle);
  await writeJson(join(runDir, "workspace-reset.json"), reset);

  const finalizedRun = queries.finalizeRun(run.id, {
    status,
    durationMs: Date.now() - startedAt,
    eventsPath,
    ...(diffPath ? { diffPath } : {}),
    error: runError,
    controlState: status === "aborted" ? "aborted" : "done",
  });

  const finalizationErrors: string[] = [];
  try {
    await writeJson(join(runDir, "run.json"), {
      ...finalizedRun,
      evalVersion: task.version,
      workspaceCommit: workspaceCommit ?? finalizedRun.workspaceCommit,
    });
    const diffText = diffPath
      ? await readFile(diffPath, "utf8").catch(() => undefined)
      : undefined;
    const metrics = deriveRunMetrics(recordedEvents, {
      ...(diffText !== undefined ? { diffText } : {}),
      totalCost: finalizedRun.totalCost,
    });
    await writeJson(join(runDir, "run-metrics.json"), metrics);
    queries.upsertEvalMetrics({
      runId: run.id,
      projectId: queue.projectId,
      schemaVersion: metrics.schemaVersion,
      execution: metrics as unknown as Record<string, unknown>,
    });
    const integrity = await analyzeEvidenceIntegrity({
      runId: run.id,
      retainedDir: join(runDir, "retained"),
      metrics,
    });
    await writeJson(join(runDir, "evidence-integrity.json"), integrity);
  } catch (err) {
    finalizationErrors.push(err instanceof Error ? err.message : String(err));
    await writeJson(join(runDir, "finalization-error.json"), {
      errors: finalizationErrors,
    }).catch(() => undefined);
  }

  let archiveError: string | null = null;
  try {
    await sealEvalArchive(queries, runDir, {
      runId: run.id,
      projectId: queue.projectId,
      queueId: queue.id,
      batchId: run.batchId,
    });
  } catch (err) {
    archiveError = err instanceof Error ? err.message : String(err);
  }

  input.setRecorder(null);
  return {
    tainted:
      packageCleanup.error !== null ||
      cleanup.error !== null ||
      verification.error !== null ||
      verifierError !== null ||
      evidence.missingRequired.length > 0 ||
      evidence.errors.length > 0 ||
      !reset.ok ||
      finalizationErrors.length > 0 ||
      archiveError !== null,
  };
}

async function verifyAdapterConnection(input: {
  dataDir: string;
  queue: EvalQueue;
  batchId: string;
  adapter: Adapter;
  handle: ContainerHandle;
  workspaceDir: string;
  task: Task;
  overrides: ReturnType<typeof resolveAdapterOverrides>;
}): Promise<{
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  modelMessages: number;
  error: string | null;
}> {
  const dir = join(
    input.dataDir,
    "projects",
    input.queue.projectId,
    "queues",
    input.queue.id,
    "batches",
    input.batchId,
    "connection-check",
  );
  await mkdir(dir, { recursive: true });
  const runId = `connection-${input.batchId}`;
  const ctx = makeRunContext(
    runId,
    input.queue,
    input.task,
    input.workspaceDir,
    input.overrides,
  );
  const probe = input.adapter.connectionCheck(ctx);
  const session = await input.handle.startExec({
    argv: probe.command.argv,
    env: probe.command.env,
    cwd: probe.cwd ?? "/workspace",
    timeoutMs: probe.timeoutMs ?? 60_000,
  });
  const stdoutChannel = new AsyncChannel<Buffer>();
  const stderrChannel = new AsyncChannel<Buffer>();
  const stdoutPump = pumpStream(session.stdout(), join(dir, RAW_STDOUT), stdoutChannel);
  const stderrPump = pumpStream(session.stderr(), join(dir, RAW_STDERR), stderrChannel);
  const waitPromise = session.wait();
  let seq = 0;
  let modelMessages = 0;
  let fatal = false;
  let parseError: string | null = null;
  try {
    for await (const event of input.adapter.parse(
      {
        stdout: stdoutChannel,
        stderr: stderrChannel,
        exitCode: waitPromise.then((result) => result.exitCode),
        durationMs: waitPromise.then((result) => result.durationMs),
      },
      ctx,
    )) {
      if (event.type === "message" && event.text.trim().length > 0) modelMessages += 1;
      if (event.type === "error" && event.fatal) fatal = true;
      await appendEvent(join(dir, EVENTS), { ...event, runId, seq: seq++ });
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
    await session.stop().catch(() => undefined);
  }
  const result = await waitPromise;
  await Promise.allSettled([stdoutPump, stderrPump]);
  const error =
    parseError ??
    (result.timedOut
      ? "connection check timed out"
      : result.exitCode !== 0
        ? `connection check exited ${result.exitCode}`
        : fatal
          ? "agent emitted a fatal error during connection check"
          : modelMessages === 0
            ? "agent produced no model message"
            : null);
  const summary = {
    ok: error === null,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    modelMessages,
    error,
  };
  await writeJson(join(dir, "connection.json"), {
    adapterId: input.adapter.id,
    provider: input.queue.provider,
    model: input.queue.model,
    runtimeContainerId: input.handle.id,
    command: probe.command.argv,
    ...summary,
  });
  return summary;
}

function makeRunContext(
  runId: string,
  queue: EvalQueue,
  task: Task,
  workspaceDir: string,
  overrides: ReturnType<typeof resolveAdapterOverrides>,
): RunContext {
  return {
    runId,
    project: { id: queue.projectId },
    task: { prompt: task.prompt, workspace: task.workspace },
    // Queue provider/model are explicit, durable pins. Adapter override blobs may
    // refine image/env/params/network/ports but must not silently change them.
    model: queue.model,
    provider: queue.provider,
    params: overrides?.params ?? {},
    workspaceDir,
    apiKeys: collectApiKeys(),
    ...(overrides ? { overrides } : {}),
  };
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
    const value = process.env[name];
    if (value) keys[name] = value;
  }
  if (!keys.ANTHROPIC_API_KEY && keys.ANTHROPIC_AUTH_TOKEN) {
    keys.ANTHROPIC_API_KEY = keys.ANTHROPIC_AUTH_TOKEN;
  }
  return keys;
}

function mergeOverrides(
  queue: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const merged = { ...(queue ?? {}), ...(item ?? {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}

function taskSnapshot(task: Task): Record<string, unknown> {
  return JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function clearDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    await rm(join(dir, name), { recursive: true, force: true });
  }
}

async function copyRetainedEvidence(
  workspaceDir: string,
  runDir: string,
  spec: ReturnType<Adapter["evidence"]>,
): Promise<{ copied: string[]; missingRequired: string[]; errors: string[] }> {
  const root = resolve(workspaceDir);
  const retainedRoot = join(runDir, "retained");
  const copied: string[] = [];
  const missingRequired: string[] = [];
  const errors: string[] = [];
  const required = new Set(spec.requiredPaths ?? []);
  const paths = new Set([
    "outputs",
    "artifacts",
    "screenshots",
    ...spec.paths,
    ...required,
  ]);

  for (const relativePath of paths) {
    const source = resolve(root, relativePath);
    if (source !== root && !source.startsWith(`${root}${sep}`)) {
      errors.push(`adapter evidence path escapes workspace: ${relativePath}`);
      continue;
    }
    try {
      // A required child path (e.g. ".reaper/runs") may already have been
      // copied as part of a parent path (".reaper"). force:true + no
      // errorOnExist so overlapping entries copy idempotently.
      await cp(source, join(retainedRoot, "agent", relativePath), {
        recursive: true,
        force: true,
      });
      copied.push(relativePath);
    } catch {
      if (required.has(relativePath)) missingRequired.push(relativePath);
    }
  }
  return { copied, missingRequired, errors };
}

async function clearWorkspaceInContainer(
  handle: ContainerHandle,
): Promise<{ ok: boolean; error: string | null }> {
  const result = await handle.exec({
    argv: ["sh", "-c", "find /workspace -mindepth 1 -delete"],
    cwd: "/workspace",
    user: "root",
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  }).catch((err) => ({
    exitCode: 1,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
    outputTruncated: false,
  }));
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    error: result.timedOut
      ? "workspace reset timed out"
      : result.exitCode !== 0
        ? result.stderr || `workspace reset exited ${result.exitCode}`
        : null,
  };
}

async function resetContainerWorkspace(
  handle: ContainerHandle,
): Promise<{ ok: boolean; processExitCode: number; error: string | null }> {
  // Stop every process except PID 1 and this reset shell. A queue container has
  // no other harness process inside it, so anything else belongs to the eval.
  const processes = await handle.exec({
    argv: [
      "sh",
      "-c",
      "self=$$; for p in /proc/[0-9]*; do pid=${p##*/}; [ \"$pid\" = 1 ] || [ \"$pid\" = \"$self\" ] || kill -TERM \"$pid\" 2>/dev/null || true; done; sleep 0.2; for p in /proc/[0-9]*; do pid=${p##*/}; [ \"$pid\" = 1 ] || [ \"$pid\" = \"$self\" ] || kill -KILL \"$pid\" 2>/dev/null || true; done; find /workspace -mindepth 1 -delete",
    ],
    cwd: "/workspace",
    user: "root",
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  }).catch((err) => ({
    exitCode: 1,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
    outputTruncated: false,
  }));

  return {
    ok: processes.exitCode === 0 && !processes.timedOut,
    processExitCode: processes.exitCode,
    error: processes.timedOut
      ? "residual process cleanup timed out"
      : processes.exitCode !== 0
        ? processes.stderr || `residual process cleanup exited ${processes.exitCode}`
        : null,
  };
}

async function pumpStream(
  source: AsyncIterable<Buffer>,
  path: string,
  channel: AsyncChannel<Buffer>,
): Promise<void> {
  const file = await open(path, "a");
  try {
    for await (const chunk of source) {
      const data = Buffer.from(chunk);
      await file.write(data);
      channel.push(data);
    }
    channel.end();
  } catch (err) {
    channel.fail(err);
    throw err;
  } finally {
    await file.close();
  }
}

class AsyncChannel<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private ended = false;
  private error: unknown;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

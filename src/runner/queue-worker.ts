/** Sequential eval execution inside one persistent queue-owned container. */

import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Adapter, RunContext } from "../adapters/types.js";
import { getAdapter } from "../adapters/index.js";
import { createDeclarativeAdapter } from "../adapters/declarative.js";
import type {
  DbQueries,
  EvalQueue,
  EvalQueueItem,
  GenerationSnapshot,
  QueueContainer,
  Run,
  Task,
} from "../db/queries.js";
import {
  AGENT_TASK_SUBDIR,
  AGENT_TASK_WORKSPACE,
  evalEnvironmentDigest,
  loadEvalPackageRuntimeConfig,
  prepareEvalPackageWorkspace,
  restoreEvalLifecycleScript,
  synthesizeSuiteLifecycleScripts,
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
import { buildEvalContext, organizeArchiveLayout, restructureSuiteArchive, sealEvalArchive } from "./eval-archive.js";
import { storeEvalArchive } from "./archive-store.js";
import { classifyRunFailure } from "./run-failure.js";
import { analyzeEvidenceIntegrity } from "./evidence-integrity.js";
import { deriveRunMetrics, RUN_METRICS_SCHEMA_VERSION } from "./metrics.js";
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
import { deriveRunStatus } from "./status.js";
import { commitWorkspaceBaseline } from "./workspace.js";
import {
  ensureAdapterImageForCommit,
  type AdapterBuildService,
} from "./adapter-build.js";

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
    stopped: boolean;
  }) => void | Promise<void>;
  /**
   * Immutable commit override for THIS generation only. When set, the generation
   * builds/runs this exact commit instead of the queue's default
   * `queue.agentCommit`, WITHOUT mutating `queue.agentCommit`. Used by the queue
   * watcher to launch a generation pinned to a specific webhook/commit.
   */
  agentCommitOverride?: string;
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
  /** True once the worker finished its claim loop (generation closed or stopped). */
  finished: boolean;
  /** Marks the current run for operator abort; worker seals partial evidence and continues. */
  abortRequested: boolean;
  /** Immutable container signature of this live generation (validates mid-run additions). */
  signature: GenerationContainerSignature;
  done: Promise<void>;
  startExec(spec: ContainerExecSpec): Promise<ContainerExecHandle>;
  exec(spec: ContainerExecSpec): Promise<ContainerExecResult>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Abort the current claimed eval (partial seal), then continue to the next claim when safe. */
  abortCurrentRun(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

export type LiveQueueContainersMap = Map<string, LiveQueueContainer>;

/** Create the process-local registry used by queue routes and introspection. */
export function createLiveQueueContainersMap(): LiveQueueContainersMap {
  return new Map();
}

interface ClaimedRun {
  run: Run;
  item: EvalQueueItem | null;
  task: Task;
  packageRuntime: EvalPackageRuntimeConfig;
  overrides: Record<string, unknown> | null;
}

interface EventRecorder {
  append(event: CanonicalEvent): Promise<void>;
  operator(spec: ContainerExecSpec, result: ContainerExecResult): Promise<void>;
}

/**
 * The immutable execution signature of a live queue generation container. New
 * queue items added while the generation runs are validated against this before
 * being accepted; incompatible items are rejected so they never join a container
 * that cannot run them.
 */
export interface GenerationContainerSignature {
  image: string;
  network: string;
  networkAllowlist: string[] | null;
  cpus: number | null;
  memoryMiB: number | null;
  ports: string;
  /** Non-empty only for legacy (non-suite) canonical evals: their env digest must match. */
  environmentDigest: string | null;
}

/** Spawn one persistent container and atomically claim + drain its eval queue. */
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
  // A crashed previous process can leave a permanent active container row with
  // no live handle. Recover only clearly stale rows here; createServer also
  // recovers every abandoned active generation at boot.
  if (!existing) {
    queries.recoverStaleQueueContainers({ olderThanMs: 5 * 60_000 });
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
  // The generation needs at least one enabled, non-deleted item to derive its
  // container signature and image. Later additions may be accepted while running.
  const seedItems = queries.listEvalQueueItems(queueId).filter((item) => item.enabled);
  if (seedItems.length === 0) throw new Error(`queue ${queueId} has no enabled evals`);

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
  if (!sharedAdapter && !projectAdapter && !queue.builtinAdapterId) {
    throw new Error(
      `queue ${queue.id} has no agent adapter selected: create a project adapter, reference a shared adapter, or explicitly set builtin_adapter_id (no implicit fallback)`,
    );
  }
  if (projectAdapter && !projectAdapter.enabled) {
    throw new Error(`project agent adapter ${projectAdapter.id} is disabled`);
  }
  if (queue.builtinAdapterId) {
    try {
      getAdapter(queue.builtinAdapterId);
    } catch {
      throw new Error(
        `queue ${queue.id} builtin_adapter_id ${queue.builtinAdapterId} is not a registered built-in adapter`,
      );
    }
  }
  const adapterDef = sharedAdapter ?? projectAdapter;
  const queueAdapter = adapterDef
    ? createDeclarativeAdapter(adapterDef)
    : getAdapter(queue.builtinAdapterId!);
  const runtime = opts.runtime ?? resolveRuntime();

  // ---- Queue-pinned commit build (fail-closed before any immutable generation) ----
  // A source adapter queue must resolve to a reproducible commit BEFORE the
  // immutable batch/container/runs are created. We build the exact selected
  // SHA (or reuse a ready adapter_build whose image still exists) and snapshot
  // buildId/image/imageId/commit/version. Built-in adapters may omit it.
  let build: { buildId: string; image: string; imageId: string; commit: string; version: string } | null = null;
  if (adapterDef) {
    if (adapterDef.installType === "source-build") {
      // A generation-scoped override pins THIS generation to an exact commit
      // without mutating the queue's default agent_commit.
      const resolvedCommit = opts.agentCommitOverride ?? queue.agentCommit;
      if (!resolvedCommit) {
        throw new Error(
          `queue ${queue.id} uses a source-built adapter ${adapterDef.id} but has no agent_commit; resolve a reproducible commit before start`,
        );
      }
      const buildService: AdapterBuildService = {
        queries,
        dataDir,
        runtime,
      };
      const buildRow = await ensureAdapterImageForCommit(buildService, adapterDef, resolvedCommit);
      if (buildRow.status !== "ready" || !buildRow.imageId) {
        throw new Error(
          `adapter ${adapterDef.id} could not produce a ready image for commit ${resolvedCommit}`,
        );
      }
      build = {
        buildId: buildRow.id,
        image: buildRow.image!,
        imageId: buildRow.imageId,
        commit: buildRow.commitSha,
        version: buildRow.agentVersion ?? resolvedCommit.slice(0, 12),
      };
    } else {
      // npm adapters have no source repo to pin; require the adapter be ready.
      if (adapterDef.containerfile && adapterDef.buildStatus !== "ready") {
        throw new Error(
          `agent adapter ${adapterDef.id} image is not ready; build it through the adapter API first`,
        );
      }
    }
  }

  // Load the seed task + package runtime to derive the container image + signature.
  const seedItem = seedItems[0]!;
  const seedTask = queries.getTask(seedItem.taskId);
  if (!seedTask || seedTask.projectId !== queue.projectId || seedTask.archived) {
    throw new Error(`queue item ${seedItem.id} references unavailable eval ${seedItem.taskId}`);
  }
  if (!seedTask.packagePath || !seedTask.packageDigest || !seedTask.packageManifest) {
    throw new Error(`queue item ${seedItem.id} references a non-canonical eval package`);
  }
  const seedPackageRuntime = await loadEvalPackageRuntimeConfig({
    packagePath: seedTask.packagePath,
    packageDigest: seedTask.packageDigest,
    manifest: seedTask.packageManifest,
  });

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

  const seedOverrides = mergeOverrides(queue.adapterOverrides, seedItem.overrides);
  const seedCtx = makeRunContext(
    `queue-image-${queue.id}`,
    queue,
    seedTask,
    workspaceDir,
    resolveAdapterOverrides(project, seedOverrides),
  );
  // For a source-built adapter the built image is the commit-addressed tag
  // (build.image), which must be the `FROM`/`COPY --from` source for the eval
  // image. npm/built-in adapters use the rendered template image.
  const adapterImage = build ? build.image : queueAdapter.image(seedCtx);
  const builtEvalImage = await buildEvalAgentImage({
    runtime,
    task: seedTask,
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
  const seedResolved = resolveAdapterOverrides(project, seedOverrides);
  const configuredNetwork = resolveNetworkMode(seedResolved?.network ?? queue.networkPolicy);
  if (configuredNetwork !== seedPackageRuntime.network) {
    throw new Error(
      `queue ${queue.id} network policy ${configuredNetwork} does not match eval package policy ${seedPackageRuntime.network}`,
    );
  }
  const containerNetwork = seedPackageRuntime.network;
  const containerNetworkAllowlist = seedPackageRuntime.networkAllowlist;
  const containerPorts = queue.ports.length > 0 ? queue.ports : (seedResolved?.ports ?? []);
  const generationSignature: GenerationContainerSignature = {
    image,
    network: containerNetwork,
    networkAllowlist: containerNetworkAllowlist,
    cpus: seedPackageRuntime.cpus ?? null,
    memoryMiB: seedPackageRuntime.memoryMiB ?? null,
    ports: JSON.stringify(containerPorts),
    environmentDigest: seedPackageRuntime.suite ? null : evalEnvironmentDigest(seedTask.packageManifest),
  };

  // Validate every existing enabled item resolves to this same container signature
  // (a live generation cannot host heterogeneous eval environments).
  for (const item of seedItems) {
    const task = queries.getTask(item.taskId)!;
    const raw = mergeOverrides(queue.adapterOverrides, item.overrides);
    const resolved = resolveAdapterOverrides(project, raw);
    const itemAdapterImage = queueAdapter.image(
      makeRunContext(`queue-image-${queue.id}-${item.id}`, queue, task, workspaceDir, resolved),
    );
    if (itemAdapterImage !== adapterImage) {
      throw new Error(
        `queue ${queue.id} resolves multiple adapter images (${adapterImage}, ${itemAdapterImage}); one persistent queue requires one image`,
      );
    }
    const itemPackageRuntime = await loadEvalPackageRuntimeConfig({
      packagePath: task.packagePath!,
      packageDigest: task.packageDigest!,
      manifest: task.packageManifest!,
    });
    if (!itemPackageRuntime.suite) {
      const itemDigest = evalEnvironmentDigest(task.packageManifest!);
      if (itemDigest !== generationSignature.environmentDigest) {
        throw new Error(
          `queue ${queue.id} contains multiple agent environment digests; split them into separate queues`,
        );
      }
    }
    const itemNetwork = resolveNetworkMode(resolved?.network ?? queue.networkPolicy);
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
      itemPackageRuntime.cpus !== seedPackageRuntime.cpus ||
      itemPackageRuntime.memoryMiB !== seedPackageRuntime.memoryMiB
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

  // Build the generation snapshot once; every claimed run captures it immutably.
  // For source adapters the commit/image/id/version/build snapshot comes from the
  // resolved + built commit; built-in/npm adapters keep queue.agentCommit (null)
  // and the rendered image.
  const generationSnapshot: GenerationSnapshot = {
    batchId: "",
    queueId: queue.id,
    queueRevision: queue.revision,
    queueContainerId: "",
    agentCommit: build ? build.commit : queue.agentCommit,
    agentImage: image,
    agentImageId: builtEvalImage.imageId,
    agentVersion: build ? build.version : null,
    buildId: build ? build.buildId : null,
    model: queue.model,
    provider: queue.provider,
    adapterOverrides: queue.adapterOverrides,
    networkPolicy: containerNetwork,
  };

  // Create the generation record atomically (batch + active container + queue
  // status). Concurrent starts lose the unique-active race here instead of
  // leaving an orphan accepting batch.
  let batch;
  let containerRow;
  try {
    const generation = queries.beginQueueGeneration({
      batch: {
        taskId: null,
        projectId: queue.projectId,
        agentId: queue.agentId,
        model: queue.model,
        provider: queue.provider,
        params: seedResolved?.params ?? {},
        repeats: 0,
        trigger: "eval-queue",
        triggerRef: queue.id,
        agentImage: image,
        agentImageId: builtEvalImage.imageId,
        agentCommit: build ? build.commit : (queue.agentCommit ?? undefined),
        agentVersion: build ? build.version : undefined,
        buildId: build ? build.buildId : undefined,
        queueId: queue.id,
        queueRevision: queue.revision,
      },
      container: {
        queueId: queue.id,
        projectId: queue.projectId,
        image,
        imageId: builtEvalImage.imageId,
        agentCommit: build ? build.commit : (queue.agentCommit ?? null),
        agentVersion: build ? build.version : null,
        buildId: build ? build.buildId : null,
        state: "starting",
        workspaceDir,
      },
    });
    batch = generation.batch;
    containerRow = generation.container;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    if (code === "ALREADY_ACTIVE") throw err;
    throw err;
  }
  generationSnapshot.batchId = batch.id;
  generationSnapshot.queueContainerId = containerRow.id;

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
      limits: { cpus: seedPackageRuntime.cpus, pids: 512 },
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
    queries.updateEvalQueue(queue.id, { status: "failed", activeBatchId: null });
    // Any runs already claimed (race with start failure) become failed.
    for (const run of queries.listRunsByBatch(batch.id)) {
      queries.finalizeRun(run.id, {
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
  let abortRequested = false;
  let abortWaiters: Array<() => void> = [];
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
    abortRequested: false,
    signature: generationSignature,
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
        state: live.currentRunId ? "running" : "running",
      });
      queries.updateEvalQueue(queue.id, {
        status: live.currentRunId ? "running" : "running",
      });
    },
    async abortCurrentRun() {
      if (live.finished) return;
      // Signal the worker to stop the in-flight exec session and treat the
      // current run as aborted (preserve partial events + seal partial archive).
      abortRequested = true;
      live.abortRequested = true;
      if (currentExec) await currentExec.stop(2_000).catch(() => undefined);
      // Resume waiting workers (the claim loop polls abortRequested anyway).
      for (const w of abortWaiters.splice(0)) w();
    },
    async stop(graceMs = 10_000) {
      if (live.finished) return;
      live.stopRequested = true;
      live.acceptingExec = false;
      abortRequested = true;
      live.abortRequested = true;
      if (currentExec) await currentExec.stop(Math.min(graceMs, 2_000)).catch(() => undefined);
      queries.updateQueueContainer(containerRow.id, { state: "stopping" });
      await handle.stop(graceMs).catch(() => undefined);
      await handle.remove().catch(() => undefined);
      live.finished = true;
      queries.updateQueueContainer(containerRow.id, {
        state: "stopped",
        stoppedAt: new Date().toISOString(),
      });
      queries.updateEvalQueue(queue.id, { status: "stopped", activeBatchId: null });
      liveQueues.delete(queue.id);
    },
  };
  liveQueues.set(queue.id, live);

  const runIds: string[] = [];

  live.done = (async () => {
    let tainted = false;
    let stopped = false;
    try {
      const connection = await verifyAdapterConnection({
        dataDir,
        queue,
        batchId: batch.id,
        adapter: queueAdapter,
        handle,
        workspaceDir,
        task: seedTask,
        overrides: resolveAdapterOverrides(project, seedOverrides),
      });
      const connectionReset = await clearWorkspaceInContainer(handle);
      if (!connectionReset.ok) {
        connection.error = connection.error ?? connectionReset.error;
        connection.ok = false;
      }
      if (!connection.ok || (queueAdapter.configure !== undefined && live.stopRequested)) {
        if (!connection.ok) {
          const message = `agent/provider connection check failed: ${connection.error ?? "no real model response"}`;
          queries.updateQueueContainer(containerRow.id, { state: "running", error: message });
          queries.updateEvalQueue(queue.id, { status: "failed" });
          for (const run of queries.listRunsByBatch(batch.id)) {
            queries.finalizeRun(run.id, {
              status: "failed",
              error: message,
              controlState: "done",
            });
          }
          return;
        }
      }

      if (queueAdapter.configure) {
        const configureCtx: RunContext = makeRunContext(
          `configure-${batch.id}`,
          queue,
          seedTask,
          workspaceDir,
          resolveAdapterOverrides(project, seedOverrides),
        );
        const configureProbe = queueAdapter.configure(configureCtx);
        if (configureProbe && !live.stopRequested) {
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
            for (const run of queries.listRunsByBatch(batch.id)) {
              queries.finalizeRun(run.id, { status: "failed", error: message, controlState: "done" });
            }
            return;
          }
        }
      }

      // ---- Dynamic claim loop ----
      // Each iteration atomically claims one repeat of one enabled item, or
      // atomically closes the generation (empty) and exits the loop. Pause and
      // abort states are honored between claims and reflected into the live run.
      for (;;) {
        if (live.stopRequested) break;
        while (live.paused && !live.stopRequested) {
          await sleep(100);
        }
        if (live.stopRequested) break;

        let claim;
        try {
          claim = queries.claimQueueWork({
            batchId: batch.id,
            queueId: queue.id,
            projectId: queue.projectId,
            queueContainerId: containerRow.id,
            snapshot: generationSnapshot,
            agentId: queue.agentId,
          });
        } catch (err) {
          if (
            err &&
            typeof err === "object" &&
            (err as { code?: string }).code === "GENERATION_CLOSED"
          ) {
            break;
          }
          throw err;
        }
        if (!claim.claimed) break; // atomically closed as empty

        // A claimed run must always reach a terminal disposition (metrics +
        // archive, or an explicit failure). Guard the whole per-claim body so a
        // transient package-load/exec error fails exactly this run and the drain
        // continues, rather than aborting the entire generation with an orphaned
        // "queued"/"running" run.
        const claimedRun = claim.run;
        try {
          const task = queries.getTask(claimedRun.taskId);
          if (!task || task.archived) {
            queries.finalizeRun(claimedRun.id, {
              status: "failed",
              error: `claimed eval ${claimedRun.taskId} is unavailable`,
              controlState: "done",
            });
            continue;
          }
          const packageRuntime = await loadEvalPackageRuntimeConfig({
            packagePath: task.packagePath!,
            packageDigest: task.packageDigest!,
            manifest: task.packageManifest!,
          });
          const itemSnapshot = claimedRun.itemSnapshot as Record<string, unknown> | null;
          const rawOverrides = mergeOverrides(
            queue.adapterOverrides,
            (itemSnapshot as { overrides?: Record<string, unknown> | null } | null)?.overrides ?? null,
          );
          const entry: ClaimedRun = {
            run: claimedRun,
            item: claimedRun.itemSnapshot as unknown as EvalQueueItem | null,
            task,
            packageRuntime,
            overrides: rawOverrides,
          };

          live.currentRunId = claimedRun.id;
          live.currentQueueItemId = claimedRun.queueItemId;
          abortRequested = false;
          live.abortRequested = false;
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
            timeoutMs: opts.timeoutMs ?? packageRuntime.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
            isStopRequested: () => live.stopRequested,
            isAbortRequested: () => abortRequested,
            setExec: (session) => {
              currentExec = session;
            },
            setRecorder: (recorder) => {
              currentRecorder = recorder;
            },
          });
          runIds.push(claimedRun.id);
          tainted = outcome.tainted || tainted;
          currentExec = null;
          currentRecorder = null;
          live.currentRunId = null;
          live.currentQueueItemId = null;

              // If a queue stop was requested mid-run, finalize the generation now.
          if (live.stopRequested) {
            stopped = true;
            break;
          }
        } catch (err) {
          const message = `queue worker failed claimed eval: ${
            err instanceof Error ? err.message : String(err)
          }`;
          // Record the failure so the run is never left queued/running with no
          // metrics/archive. Best-effort: finalizeRun itself could throw; the
          // outer generation catch still marks the container failed then.
          try {
            queries.finalizeRun(claimedRun.id, {
              status: "failed",
              error: message,
              controlState: "done",
            });
          } catch (finalizeErr) {
            // Best-effort terminal write; the outer generation catch marks the
            // container/queue failed so the orphan is at least surfaced there.
          }
          // The claimed run is terminal and must carry exactly one root
          // run-metrics.json regardless of where executeEval failed (an
          // un-archived, metrics-less failed run breaks the run-metrics
          // guarantee). Write a minimal platform-owned terminal metrics file
          // only if executeEval did not already write one.
          const claimedRunDir = join(
            dataDir,
            "projects",
            claimedRun.projectId,
            "evals",
            claimedRun.id,
          );
          try {
            const metricsPath = join(claimedRunDir, "run-metrics.json");
            let needsWrite = true;
            try {
              await readFile(metricsPath, "utf8");
              needsWrite = false;
            } catch {
              // absent → write below
            }
            if (needsWrite) {
              const terminalMetrics = deriveRunMetrics([], {
                officialReward: null,
              });
              await writeJson(metricsPath, {
                ...terminalMetrics,
                terminalStatus: "failed",
                measurements: {
                  ...terminalMetrics.measurements,
                  agent_crashes: {
                    value: 1,
                    unit: "count",
                    provenance: "exact",
                    refs: [],
                  },
                  timeouts: {
                    value: 0,
                    unit: "count",
                    provenance: "exact",
                    refs: [],
                  },
                },
              });
              try {
                queries.upsertEvalMetrics({
                  runId: claimedRun.id,
                  projectId: claimedRun.projectId,
                  schemaVersion: RUN_METRICS_SCHEMA_VERSION,
                  execution: {
                    ...terminalMetrics,
                    terminalStatus: "failed",
                  } as unknown as Record<string, unknown>,
                });
              } catch {
                // best-effort metrics row
              }
            }
          } catch {
            // A metrics-write failure must not mask the run failure itself.
          }
          runIds.push(claimedRun.id);
          currentExec = null;
          currentRecorder = null;
          live.currentRunId = null;
          live.currentQueueItemId = null;
          continue;
        }
      }

      live.currentRunId = null;
      live.currentQueueItemId = null;
      // Release this generation's live slot BEFORE any onQueueDrained hook runs.
      // The watcher FIFO auto-launch calls startQueueContainer for the next pending
      // commit, which must see this queue as free (not ALREADY_ACTIVE) and must not
      // be clobbered by this generation's own map-delete teardown. We finalize the
      // container handle here too so generationhandover is not blocked.
      const releaseSlot = () => {
        if (live.finished) return;
        live.finished = true;
        handle.remove().catch(() => undefined);
        if (liveQueues.get(queue.id) === live) liveQueues.delete(queue.id);
      };
      if (live.stopRequested) {
        stopped = true;
        releaseSlot();
        queries.updateQueueContainer(containerRow.id, { state: "stopped" });
        queries.updateEvalQueue(queue.id, { status: "stopped", activeBatchId: null });
        if (opts.onQueueDrained) {
          await opts.onQueueDrained({
            queueId: queue.id,
            projectId: queue.projectId,
            batchId: batch.id,
            runIds,
            tainted,
            stopped,
          });
        }
        return;
      }
      releaseSlot();
      queries.updateQueueContainer(containerRow.id, {
        state: tainted ? "tainted" : "completed",
        ...(tainted
          ? {
              error:
                "queue workspace hygiene failed (package-cleanup, cleanup, cleanup-verification, or workspace reset); shared container is unsafe for further claims",
            }
          : {}),
        stoppedAt: new Date().toISOString(),
      });
      queries.updateEvalQueue(queue.id, {
        status: tainted ? "tainted" : "completed",
        activeBatchId: null,
      });
      if (opts.onQueueDrained) {
        await opts.onQueueDrained({
          queueId: queue.id,
          projectId: queue.projectId,
          batchId: batch.id,
          runIds,
          tainted,
          stopped,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queries.updateQueueContainer(containerRow.id, { state: "failed", error: message });
      queries.updateEvalQueue(queue.id, { status: "failed" });
    } finally {
      currentExec = null;
      currentRecorder = null;
    }
  })();

  // Generation closure must stop + remove the persistent container and clear the
  // queue's active generation. The worker loop releases the live slot before the
  // onQueueDrained hook and before this finally; only delete from the live map if
  // this generation is still the one registered (a watcher FIFO auto-launch may
  // have already started a replacement generation for the same queue).
  void live.done.finally(() => {
    if (!live.finished) {
      live.finished = true;
      handle.remove().catch(() => undefined);
      if (liveQueues.get(queue.id) === live) liveQueues.delete(queue.id);
    }
  });

  return live;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Validate an item (newly added while a generation runs) against the live
 * generation's immutable container signature. Returns the reason when the item is
 * incompatible, or null when it can run in the current container. Mirrors the
 * startup homogeneity checks so a mid-run addition either joins the running
 * container (matching signature) or is rejected with 409, never silently accepted
 * and later un-runnable.
 */
export async function validateItemAgainstGenerationSignature(input: {
  queries: DbQueries;
  queue: EvalQueue;
  task: Task;
  overrides: Record<string, unknown> | null;
  signature: GenerationContainerSignature;
}): Promise<string | null> {
  const { queries, queue, task, overrides, signature } = input;
  if (!task.packagePath || !task.packageDigest || !task.packageManifest) {
    return `eval ${task.id} is not a canonical eval package`;
  }
  const project = queries.getProject(queue.projectId);
  if (!project) return "project not found";
  const runtimeConfig = await loadEvalPackageRuntimeConfig({
    packagePath: task.packagePath,
    packageDigest: task.packageDigest,
    manifest: task.packageManifest,
  });
  if (!runtimeConfig.suite && signature.environmentDigest !== null) {
    if (evalEnvironmentDigest(task.packageManifest) !== signature.environmentDigest) {
      return "eval environment digest does not match the active generation container";
    }
  }
  const resolved = resolveAdapterOverrides(project, mergeOverrides(queue.adapterOverrides, overrides));
  const itemNetwork = resolveNetworkMode(resolved?.network ?? queue.networkPolicy);
  if (itemNetwork !== signature.network || runtimeConfig.network !== signature.network) {
    return "network policy does not match the active generation container";
  }
  if (JSON.stringify(runtimeConfig.networkAllowlist) !== JSON.stringify(signature.networkAllowlist ?? [])) {
    return "network allowlist does not match the active generation container";
  }
  if (
    (runtimeConfig.cpus ?? null) !== signature.cpus ||
    (runtimeConfig.memoryMiB ?? null) !== signature.memoryMiB
  ) {
    return "CPU/RAM limits do not match the active generation container";
  }
  const itemPorts = queue.ports.length > 0 ? queue.ports : (resolved?.ports ?? []);
  if (JSON.stringify(itemPorts) !== signature.ports) {
    return "port set does not match the active generation container";
  }
  return null;
}

async function executeEval(input: {
  dataDir: string;
  queries: DbQueries;
  runtime: ContainerRuntime;
  queue: EvalQueue;
  containerRow: QueueContainer;
  handle: ContainerHandle;
  adapter: Adapter;
  entry: ClaimedRun;
  workspaceDir: string;
  timeoutMs: number;
  isStopRequested: () => boolean;
  /** True when the operator aborted the current eval; seals partial evidence. */
  isAbortRequested: () => boolean;
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

  // Persist eventsPath BEFORE the agent launches so SSE/NDJSON clients can tail
  // the run's canonical events during execution (not only after finalize).
  queries.setRunEventsPath(run.id, eventsPath);

  if (!task.packagePath || !task.packageDigest || !task.packageManifest) {
    throw new Error(`eval ${task.id} is not a validated canonical eval package`);
  }
  const packageRuntime = entry.packageRuntime;
  await prepareEvalPackageWorkspace({
    packagePath: task.packagePath,
    packageDigest: task.packageDigest,
    manifest: task.packageManifest,
    workspaceDir,
    suite: packageRuntime.suite ?? false,
  });
  // The git baseline is committed at the graded root: workspaceDir for legacy,
  // workspaceDir/task (the suite's seed_repo home) for suite tasks, so diff
  // capture reports only the agent's changes to the task files.
  const gitBaselineRoot = packageRuntime.suite ? join(workspaceDir, AGENT_TASK_SUBDIR) : workspaceDir;
  // Host-side git on the rootful-podman bind mount hits git's 'dubious
  // ownership' safe.directory check; trust the graded workspace.
  const gitSafeDirEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };
  // For suite, /workspace/task is empty until setup.sh seeds it at eval time,
  // so the baseline is committed after setup (see the suite branch below).
  let workspaceCommit: string | undefined = packageRuntime.suite ? undefined : await commitWorkspaceBaseline(gitBaselineRoot);

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
  // Snapshot the adapter's evidence manifest onto the run so a judge years
  // later binds traces/logs to the adapter version that produced them. The
  // role-typed evalContext is what the judge reads to find each evidence class
  // (trace/transcript/result/tool_calls/model_calls/tmp) without path folklore.
  const evidenceSpec = input.adapter.evidence(ctx);
  await writeJson(join(runDir, "adapter-evidence.json"), evidenceSpec);
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
    evalContext: buildEvalContext(evidenceSpec.manifest),
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
    if (packageRuntime.suite) {
      // Suite: synthesize the lifecycle wrappers (apt-install the language
      // toolchain + run the author's setup.sh) into the workspace, then run
      // setup as root. setup.sh seeds /workspace/task, so the baseline is
      // committed only after a successful setup.
      await synthesizeSuiteLifecycleScripts({
        packagePath: task.packagePath!,
        workspaceDir,
        language: packageRuntime.language ?? null,
      });
    }
    if (packageRuntime.setupPath) {
      const setup = await handle.exec({
        argv: ["/bin/bash", packageRuntime.setupPath, ...(packageRuntime.suite ? [AGENT_TASK_WORKSPACE] : [])],
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
            ? "eval setup timed out"
            : `eval setup exited ${setup.exitCode}`,
        );
      }
      // Suite task dir was empty until setup seeded it; baseline now.
      if (packageRuntime.suite) {
        workspaceCommit = await commitWorkspaceBaseline(gitBaselineRoot, gitSafeDirEnv);
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
      aborted: input.isStopRequested() || input.isAbortRequested(),
    });
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
    status =
      input.isStopRequested() || input.isAbortRequested() ? "aborted" : "failed";
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
    // Suite tasks work inside the graded workspaceDir/task subdirectory; diff
    // capture runs there so patch paths are repo-relative. Legacy tasks diff
    // the workspace root.
    const diffRoot = entry.packageRuntime.suite
      ? join(workspaceDir, AGENT_TASK_SUBDIR)
      : workspaceDir;
    const diff = await captureDiffByCategory(task.agentCategory, diffRoot, {
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
    evidenceSpec,
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
      if (packageRuntime.suite) {
        // Re-synthesize the trusted lifecycle wrapper (overwriting any
        // tampered in-container copy) before running cleanup.
        await synthesizeSuiteLifecycleScripts({
          packagePath: task.packagePath!,
          workspaceDir,
          language: packageRuntime.language ?? null,
        });
      } else {
        await restoreEvalLifecycleScript({
          packagePath: task.packagePath,
          workspaceDir,
          containerPath: packageRuntime.cleanupPath,
        });
      }
      const result = await handle.exec({
        argv: ["/bin/bash", packageRuntime.cleanupPath, ...(packageRuntime.suite ? [AGENT_TASK_WORKSPACE] : [])],
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
              ? "eval cleanup timed out"
              : `eval cleanup exited ${result.exitCode}`,
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

  // Document WHY a failed run failed — especially provider/model exhaustion
  // (quota/credits, rate limit, context length) — by scanning the recorded error
  // and the raw agent output, rather than leaving a generic "failed".
  const classification = status === "failed"
    ? await classifyRunFailure({ runDir, error: runError }).catch(() => null)
    : null;
  const failureReason = classification
    ? `${runError ? `${runError} — ` : ""}${classification.reason}`
    : runError;
  await writeJson(join(runDir, "failure-classification.json"), {
    status,
    error: runError,
    reason: failureReason,
    category: classification?.category ?? null,
  });

  const finalizedRun = queries.finalizeRun(run.id, {
    status,
    durationMs: Date.now() - startedAt,
    eventsPath,
    ...(diffPath ? { diffPath } : {}),
    error: failureReason,
    controlState: status === "aborted" ? "aborted" : "done",
  });

  const finalizationErrors: string[] = [];
  // Verifier is ground truth for whether the eval actually passed. Read its
  // official reward (persisted as verifier.json) so false_success is classified
  // authoritatively (the agent claimed success the verifier did not confirm)
  // instead of fragile shell-command heuristics. Hoisted to also feed the central
  // archive manifest's reward.
  let officialReward: number | null = null;
  try {
    await writeJson(join(runDir, "run.json"), {
      ...finalizedRun,
      evalVersion: task.version,
      workspaceCommit: workspaceCommit ?? finalizedRun.workspaceCommit,
      evalContext: buildEvalContext(evidenceSpec.manifest),
    });
    const diffText = diffPath
      ? await readFile(diffPath, "utf8").catch(() => undefined)
      : undefined;
    try {
      const verifierRecord = JSON.parse(
        await readFile(join(runDir, "verifier.json"), "utf8"),
      ) as { officialReward?: unknown };
      if (typeof verifierRecord.officialReward === "number") officialReward = verifierRecord.officialReward;
    } catch {
      // verifier may be absent (error path); fall back to heuristics
    }
    const metrics = deriveRunMetrics(recordedEvents, {
      ...(diffText !== undefined ? { diffText } : {}),
      totalCost: finalizedRun.totalCost,
      officialReward,
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
    if (packageRuntime.suite) {
      // Reorganize retained evidence into a high-signal layout with traces at
      // the top and platform logs plus deeper evidence in subfolders, so
      // archive consumers meet important files first walking top-down. This also
      // applies the shared target folder layout via organizeArchiveLayout.
      await restructureSuiteArchive(runDir);
    } else {
      // Legacy (non-suite) archives still get the shared target folder layout
      // (verifier_res/session/diffs/raw_std/eval_lifecycle_logs + remove
      // events.jsonl) before sealing.
      await organizeArchiveLayout(runDir);
    }
    await sealEvalArchive(queries, runDir, {
      runId: run.id,
      projectId: queue.projectId,
      queueId: queue.id,
      batchId: run.batchId,
    });
    // Central store: copy the sealed tree to archives/<runId> and upsert the
    // catalog row in archives/index.json. Best-effort; never fails the run.
    try {
      const rowRun = queries.getRun(run.id);
      const rowTask = queries.getTask(task.id);
      const theProject = queries.getProject(queue.projectId);
      const rowContainer = containerRow.runtimeContainerId
        ? queries.getQueueContainer(containerRow.id)
        : null;
      await storeEvalArchive({
        dataDir: input.dataDir,
        sealedArchiveDir: runDir,
        entry: {
          projectId: queue.projectId,
          projectName: theProject?.name ?? null,
          queueId: queue.id,
          queueName: queue.name ?? null,
          batchId: run.batchId,
          runId: run.id,
          taskId: task.id,
          taskName: rowTask?.name ?? null,
          agentId: rowRun?.agentId ?? null,
          agentCommit: rowRun?.agentCommit ?? null,
          agentImage: rowRun?.agentImage ?? null,
          agentImageId: rowContainer?.imageId ?? null,
          agentVersion: rowContainer?.agentVersion ?? rowRun?.agentCommit?.slice(0, 12) ?? null,
          buildId: rowContainer?.buildId ?? null,
          queueRevision: queue.revision,
          model: queue.model,
          provider: queue.provider,
          status: status,
          reward: officialReward ?? null,
          sealedAt: queries.getEvalArchive(run.id)?.sealedAt ?? null,
        },
      });

      // Themis judge ingestion: when a judge queue is linked to this eval queue,
      // hand the freshly sealed archive to it. autoJudge ON → stream immediately;
      // OFF → buffer for a later batch flush. Best-effort; never fails the run.
      try {
        const manifest = queries.getEvalArchive(run.id);
        const baseManifestSha256 = manifest?.manifestSha256 ?? "";
        const themisDb = await import("../judge/ingest/store.js");
        // The ingestion store needs a SQLite handle; open the project-scoped
        // themis sqlite file lazily so a judge-less eval never pays for it.
        const { default: Database } = await import("better-sqlite3");
        const { join } = await import("node:path");
        const db = new Database(join(input.dataDir, "themis.sqlite"));
        try {
          const { migrate } = await import("../db/sqlite/migrate.js");
          migrate(db);
          themisDb.onArchiveSealed(db, {
            runId: run.id,
            projectId: queue.projectId,
            evalQueueId: queue.id,
            baseManifestSha256,
          });
        } finally {
          db.close();
        }
      } catch {
        // judge ingestion is best-effort and must never taint an eval run
      }
    } catch (storeErr) {
      // best-effort: not fatal
    }
  } catch (err) {
    archiveError = err instanceof Error ? err.message : String(err);
  }

  input.setRecorder(null);
  // Queue-level "tainted" means the SHARED container workspace is unsafe for
  // the next eval (cleanup/reset/package-cleanup failed). It must NOT fire for
  // per-run scoring/evidence gaps — a missing agent log or a failing verifier
  // is a failed eval, not a poisoned queue. E2E saw reward=0 + missing
  // task/.reaper/logs mark the whole generation tainted with the misleading
  // error "queue workspace cleanup/reset failed" even when reset.ok was true.
  return {
    tainted: computeQueueWorkspaceTaint({
      packageCleanupError: packageCleanup.error,
      cleanupError: cleanup.error,
      verificationError: verification.error,
      resetOk: reset.ok,
    }),
  };
}

/**
 * Whether an eval's post-run hygiene failed in a way that endangers later
 * claims on the same persistent queue container.
 */
export function computeQueueWorkspaceTaint(input: {
  packageCleanupError: string | null;
  cleanupError: string | null;
  verificationError: string | null;
  resetOk: boolean;
}): boolean {
  return (
    input.packageCleanupError !== null ||
    input.cleanupError !== null ||
    input.verificationError !== null ||
    !input.resetOk
  );
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
    // The connection-check probe (and configure, setup, cleanup) run as root: the
    // host-created /workspace bind mount is root-owned, so a non-root probe
    // (the image's USER 10001) cannot `mkdir /workspace/task`. Reaper drops to
    // its own workspace user internally; running the probe container-side as
    // root just grants the probe write access to its workspace scratch dir.
    user: "root",
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
    "OPENAI_BASE_URL",
    "OPENAI_CODEX_ACCESS_TOKEN",
    "MINIMAX_API_KEY",
    "NEURALWATT_API_KEY",
    "NURALWATT_API_KEY",
    "NURALWATT_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "DEEPSEEK_API_KEY",
  ]) {
    const value = process.env[name];
    if (value) keys[name] = value;
  }
  // Disabling TLS verification inside the agent container enables MITM of model
  // traffic. It is only carried in when the operator explicitly opts in for a
  // self-signed proxy; it is never forwarded by default.
  if (process.env.AGENTEVAL_ALLOW_INSECURE_TLS === "1" && process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    keys.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  if (!keys.ANTHROPIC_API_KEY && keys.ANTHROPIC_AUTH_TOKEN) {
    keys.ANTHROPIC_API_KEY = keys.ANTHROPIC_AUTH_TOKEN;
  }
  // The reaper CLI registers NeuroWatt under the provider id `nuralwatt`
  // (one U) and reads its key from NURALWATT_API_KEY. Authors/operators
  // commonly export NEURALWATT_API_KEY (two U's); mirror it under the spelling
  // the agent expects so the connection check and real runs find the key.
  if (!keys.NURALWATT_API_KEY && keys.NEURALWATT_API_KEY) {
    keys.NURALWATT_API_KEY = keys.NEURALWATT_API_KEY;
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
    // Reject symlinks: an agent can plant `ln -s /etc/passwd /workspace/outputs`
    // and, if the link were copied into the retained tree and sealed, the archive
    // API could later follow it back to the host. Symlinks are forbidden in
    // retained evidence; a required symlink is a missing-required error.
    const sourceStat = await lstat(source).catch(() => null);
    if (sourceStat?.isSymbolicLink()) {
      errors.push(`adapter evidence path is a symlink and was not retained: ${relativePath}`);
      if (required.has(relativePath)) missingRequired.push(relativePath);
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

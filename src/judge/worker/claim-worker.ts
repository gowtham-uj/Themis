/**
 * WP-5/13 judge claim worker: claimNext → Phase-1 → publish view → CAS pointer.
 */

import Database from "better-sqlite3";
import { access, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  JUDGE_JOB_STATE,
  JUDGE_NODE,
  JUDGE_PUBLICATION_STATE,
  type JudgeJobRepository,
  type LeaseClaimOptions,
  type NewJudgeResultVersion,
  type ThemisDb,
} from "../../db/contracts.js";
import type { StoredModelConfig } from "../../config/model-config.js";
import { migrate } from "../../db/sqlite/migrate.js";
import { advanceCurrentPointer } from "../../db/sqlite/pointers.js";
import { upsertResultVersion } from "../../db/sqlite/results.js";
import { SqliteJudgeJobRepository } from "../../db/sqlite/store.js";
import { GatewayError, ModelGateway, ProviderThrottledError } from "../gateway/client.js";
import { loadGatewayConfig } from "../gateway/config.js";
import { loadCheckpoint } from "../graph/checkpoint.js";
import { runPhase1 } from "../graph/graph.js";
import { pauseJudgeQueue } from "../ingest/pause.js";
import { piConnectionFor, type PiConnection } from "../pi/runtime.js";
import { publishJudgeArchiveView } from "../results/publish-view.js";

export interface ClaimWorkerOptions {
  themisDbPath: string;
  archivesRoot: string;
  gateway?: ModelGateway;
  /** Max wall-clock for the PI Node 4 courtroom. */
  node4TimeoutMs?: number;
  /** Stable per-case working-store root (checkpoints + PI sessions). */
  workRoot?: string;
  /** Production PostgreSQL handle. When set, ALL durable work-control and
   *  publication writes go through it (no SQLite dual-write). */
  themis?: ThemisDb;
  /** Per-project stage overrides, layered over the global Phase-1 config. */
  projectModelConfig?: StoredModelConfig | null;
}

/** One tick: claim a job for the queue and run Phase-1 end-to-end. */
export class JudgeClaimWorker {
  private readonly db: Database.Database;
  private readonly jobs: JudgeJobRepository;
  private readonly themis: ThemisDb | null;
  private readonly gateway: ModelGateway;

  constructor(private readonly opts: ClaimWorkerOptions) {
    this.db = new Database(opts.themisDbPath);
    migrate(this.db);
    this.themis = opts.themis ?? null;
    this.jobs = this.themis !== null ? this.themis.judgeJobs : new SqliteJudgeJobRepository(this.db);
    const project = opts.projectModelConfig ?? null;
    this.gateway = opts.gateway ?? ModelGateway.fromEnv(process.env, undefined, "phase1", project);
    // When a gateway is injected (tests, custom backends), there may be no env;
    // otherwise load from the environment the gateway itself would use.
    this.gatewayConfig = opts.gateway
      ? {
          baseUrl: "",
          apiKey: "",
          model: "",
          reasoningEffort: "low",
          maxTokensFloor: 2048,
          timeoutMs: 300_000,
        }
      : loadGatewayConfig(process.env, "phase1", project);
  }

  /** Resolved gateway config (baseUrl/apiKey/model/effort) for the PI court. */
  private readonly gatewayConfig: import("../gateway/config.js").GatewayConfig;

  /**
   * PI courtroom connection for this worker.
   *
   * Resolved through the same helper every other PI call site uses, so the
   * courtroom cannot land on a different endpoint, model, or wire format than
   * the nodes that fed it. Falls back to the gateway config only when the
   * stage will not resolve, which is the injected-gateway test path.
   */
  private piConnection(): PiConnection {
    try {
      return piConnectionFor("phase1", process.env, this.opts.projectModelConfig ?? null);
    } catch {
      return {
        baseUrl: this.gatewayConfig.baseUrl,
        apiKey: this.gatewayConfig.apiKey,
        model: this.gatewayConfig.model,
        reasoningEffort: this.gatewayConfig.reasoningEffort,
      };
    }
  }

  close(): void {
    // The ThemisDb owns its pool and closes it via its own lifecycle; the
    // SQLite handle here is closed only when the worker opened it as primary.
    if (this.themis === null) this.db.close();
  }

  /** Claim and process at most one job. Returns null if none available. */
  async tick(input: {
    judgeQueueId: string;
    claim: LeaseClaimOptions;
  }): Promise<{
    jobId: string;
    runId: string;
    resultVersionId: string;
    /** The eval's own archive, resealed with judge/ layered in. */
    archiveDir: string;
  } | null> {
    const claimed = await this.jobs.claimNext(input.judgeQueueId, input.claim);
    if (!claimed) return null;

    const runId = claimed.job.runId;
    // New runs have one canonical per-project sealed tree (no duplicate
    // data/archives/<runId> copy). Keep the flat path as migration compatibility
    // for historical archives, otherwise resolve the project-owned tree.
    const flatArchiveDir = join(this.opts.archivesRoot, runId);
    const canonicalArchiveDir = join(
      dirname(this.opts.archivesRoot),
      "projects",
      claimed.job.projectId,
      "evals",
      runId,
    );
    const archiveDir = await access(flatArchiveDir)
      .then(() => flatArchiveDir)
      .catch(() => canonicalArchiveDir);
    // Stable per-case paths: a paused/reclaimed job re-enters the SAME working
    // store and PI session, so --continue can replay it. `/tmp` mkdtemp paths
    // lost the resume source when another worker claimed the case.
    const dataRoot = dirname(this.opts.themisDbPath);
    const workDir = join(this.opts.workRoot ?? join(dataRoot, "judge_work"), claimed.job.id);
    await mkdir(workDir, { recursive: true });

    // Keep the lease alive while model/subagent work runs. No DB transaction is
    // held across calls; each heartbeat is a fenced single update. Without this,
    // a valid 20-30 minute courtroom could expire and be reclaimed mid-run.
    const heartbeatEveryMs = Math.max(1_000, Math.floor(input.claim.leaseMs / 3));
    let heartbeatBusy = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      const leaseExpiresAt = new Date(Date.now() + input.claim.leaseMs).toISOString();
      void this.jobs
        .heartbeat(
          claimed.job.id,
          {
            caseId: claimed.job.id,
            activeAttemptId: claimed.attempt.id,
            activeState: JUDGE_JOB_STATE.leased,
            fencingToken: claimed.fencingToken,
          },
          leaseExpiresAt,
        )
        .finally(() => {
          heartbeatBusy = false;
        });
    }, heartbeatEveryMs);
    heartbeatTimer.unref();

    let state;
    try {
      // Recoverable sealing: if a previous worker already completed Node 4 and
      // wrote evalJudge.yaml, do NOT spend another model token. Reuse the
      // checkpoint + immutable court files and continue directly at publish.
      const finalReport = join(workDir, "node4", "judge", "evalJudge.yaml");
      const node4Checkpoint = await loadCheckpoint(workDir, "node4");
      const canRecoverPublish =
        node4Checkpoint !== null &&
        (await access(finalReport).then(() => true).catch(() => false));

      if (canRecoverPublish) {
        state = {
          ...node4Checkpoint,
          paths: { ...node4Checkpoint.paths, evalJudgePath: finalReport },
        };
      } else {
        // The real PI courtroom (Node 4 = themis-orchestrator +
        // kratos/logos/minos subagents), not the legacy role-labeled loop.
        state = await runPhase1({
        caseId: claimed.job.id,
        runId,
        archiveDir,
        workDir,
        gateway: this.gateway,
        attemptId: claimed.attempt.id,
          pi: {
            ...this.piConnection(),
            timeoutMs: this.opts.node4TimeoutMs ?? 900_000,
          },
        });
      }
    } catch (err) {
      clearInterval(heartbeatTimer);
      if (err instanceof ProviderThrottledError) {
        // Provider 429/quota: PAUSE the queue WITHOUT consuming a retry. The
        // claim already incremented attempt_count, so release it without charge
        // first, then pause — resume returns the job to `queued` at its
        // committed checkpoint.
        await this.jobs.releaseClaimNoRetryCharge(
          claimed.job.id,
          claimed.attempt.id,
          {
            caseId: claimed.job.id,
            activeAttemptId: claimed.attempt.id,
            activeState: JUDGE_JOB_STATE.leased,
            fencingToken: claimed.fencingToken,
          },
        );
        const pauseKind = err.throttleKind === "quota" ? "provider_quota" : "provider_rate_limit";
        if (this.themis !== null) {
          const queue = await this.themis.judgeQueues.get(input.judgeQueueId);
          if (queue !== null) {
            await this.themis.judgeQueues.update(
              input.judgeQueueId,
              { revision: queue.revision, status: queue.status },
              { status: "paused", pauseKind, pauseReason: err.message },
            );
          }
        } else {
          pauseJudgeQueue(this.db, input.judgeQueueId, {
            kind: pauseKind,
            reason: err.message,
          });
        }
        return null;
      }
      // Transient provider/network/5xx failures: bounded backoff + automatic
      // retry from the same persistent work/checkpoint/session. Do NOT crash the
      // worker process. Unlike quota pauses, a real transient attempt does count.
      if (
        err instanceof GatewayError &&
        (
          err.code === "transport" ||
          err.code === "schema" ||
          (err.code === "http" && (err.status ?? 0) >= 500)
        )
      ) {
        const backoffMs = Math.min(60_000, 2_000 * 2 ** Math.max(0, claimed.job.attemptCount));
        await this.jobs.updateFenced(
          claimed.job.id,
          {
            caseId: claimed.job.id,
            activeAttemptId: claimed.attempt.id,
            activeState: JUDGE_JOB_STATE.leased,
            fencingToken: claimed.fencingToken,
          },
          {
            state: JUDGE_JOB_STATE.waiting_retry,
            availableAt: new Date(Date.now() + backoffMs).toISOString(),
            terminalErrorKind: err.code === "schema" ? "schema" : "transient",
            terminalErrorDetail: err.message,
            lease: null,
          },
        );
        return null;
      }

      // Other failures are real attempts: leave them waiting_retry for explicit
      // policy/operator handling, but surface the error to the supervising loop.
      await this.jobs.updateFenced(
        claimed.job.id,
        {
          caseId: claimed.job.id,
          activeAttemptId: claimed.attempt.id,
          activeState: JUDGE_JOB_STATE.leased,
          fencingToken: claimed.fencingToken,
        },
        { state: JUDGE_JOB_STATE.waiting_retry, lease: null },
      );
      throw err;
    }

    try {
      const published = await publishJudgeArchiveView({
        runId,
        trackId: claimed.job.publicationPolicy.trackId,
        baseArchiveDir: archiveDir,
        // The mediated tools write under THEMIS_JUDGE_DIR = workDir/node4.
        judgeDir: join(workDir, "node4", "judge"),
        // PI orchestrator + subagent session logs -> phase1/judge_traces/
        traceDir: join(workDir, "node4"),
        // node0..node3 deterministic artifacts + checkpoints -> phase1/
        workDir,
      });

      let stored: { id: string; trackId: string };
      if (this.themis !== null) {
        // Production publication (design §8/§9): one transaction writes the
        // verified result version and advances the current pointer with a
        // compare-and-swap predicate on base hash + expected current pointer.
        const reportPath = join(archiveDir, "judge", "evalJudge.yaml");
        let reportByteLength = 0;
        try {
          reportByteLength = (await stat(reportPath)).size;
        } catch {
          /* size 0 when the report is absent — publish will be gated below */
        }
        const newVersion: NewJudgeResultVersion = {
          runId,
          caseId: claimed.job.id,
          judgeQueueId: claimed.job.judgeQueueId,
          trackId: claimed.job.publicationPolicy.trackId,
          projectId: claimed.job.projectId,
          pipelineVersion: "phase1",
          templateVersion: "4",
          schemaVersion: 1,
          configSnapshotId: claimed.job.configSnapshotId,
          configSha256: claimed.job.configSnapshotSha256,
          rejudgeTriggerId:
            claimed.job.sourceTriggerKind === "rejudge" ? claimed.job.sourceTriggerId : null,
          baseArchiveGenerationId: claimed.job.baseArchiveGenerationId,
          archiveGenerationId: published.result.id,
          reportBlobKey: reportPath,
          reportSha256: published.result.reportSha256,
          reportByteLength,
          officialReward: null,
        };
        // createStaging, verification, publish, and the pointer CAS are ONE
        // transaction (design §8): a version can never be sequenced while its
        // projection is still staging, and the pointer moves only if the base
        // hash and expected-current predicate still hold.
        stored = await this.themis.transaction(async (tx) => {
          const staged = await tx.judgeResultVersions.createStaging(newVersion);
          await tx.judgeResultVersions.transitionPublication(
            staged.id,
            JUDGE_PUBLICATION_STATE.preparing,
            JUDGE_PUBLICATION_STATE.verified,
          );
          await tx.judgeResultVersions.publish(staged.id, { publicationState: "verified" });
          if (claimed.job.publicationPolicy.makeCurrent) {
            await tx.judgeCurrentPointers.advance(
              runId,
              staged.trackId,
              {
                expectedCurrent: {
                  resultVersionId: claimed.job.publicationPolicy.expectedCurrentResultVersionId,
                  archiveViewGenerationId: null,
                },
                fencing: {
                  caseId: claimed.job.id,
                  activeAttemptId: claimed.attempt.id,
                  activeState: JUDGE_JOB_STATE.leased,
                  fencingToken: claimed.fencingToken,
                },
                baseManifestSha256: claimed.job.baseManifestSha256,
              },
              {
                runId,
                trackId: staged.trackId,
                resultVersionId: staged.id,
                archiveViewGenerationId: staged.archiveGenerationId,
                updatedAt: new Date().toISOString(),
              },
            );
          }
          return { id: staged.id, trackId: staged.trackId };
        });
      } else {
        const sqliteStored = upsertResultVersion(this.db, published.result);
        advanceCurrentPointer(this.db, {
          runId,
          trackId: sqliteStored.trackId,
          resultVersionId: sqliteStored.id,
          archiveViewPath: sqliteStored.archiveViewPath ?? archiveDir,
          baseManifestSha256: claimed.job.baseManifestSha256,
          expectedResultVersionId:
            claimed.job.publicationPolicy.expectedCurrentResultVersionId,
        });
        stored = { id: sqliteStored.id, trackId: sqliteStored.trackId };
      }

      // Fenced terminalization: claim leaves the job `leased`; move to completed.
      await this.jobs.updateFenced(
        claimed.job.id,
        {
          caseId: claimed.job.id,
          activeAttemptId: claimed.attempt.id,
          activeState: JUDGE_JOB_STATE.leased,
          fencingToken: claimed.fencingToken,
        },
        {
          state: JUDGE_JOB_STATE.completed,
          currentNode: JUDGE_NODE.node4,
          currentRound: Math.min(10, Math.max(1, state.round)) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
          lease: null,
        },
      );

      return {
        jobId: claimed.job.id,
        runId,
        resultVersionId: stored.id,
        archiveDir,
      };
    } catch (err) {
      // Publication failures are recoverable sealing failures. Keep the full
      // court/session work and retry the same job; the recovery path above will
      // skip all model calls once evalJudge.yaml + node4 checkpoint exist.
      await this.jobs.updateFenced(
        claimed.job.id,
        {
          caseId: claimed.job.id,
          activeAttemptId: claimed.attempt.id,
          activeState: JUDGE_JOB_STATE.leased,
          fencingToken: claimed.fencingToken,
        },
        {
          state: JUDGE_JOB_STATE.waiting_retry,
          availableAt: new Date(Date.now() + 2_000).toISOString(),
          terminalErrorKind: "transient",
          terminalErrorDetail: err instanceof Error ? err.message : String(err),
          lease: null,
        },
      );
      throw err;
    } finally {
      clearInterval(heartbeatTimer);
    }
  }
}

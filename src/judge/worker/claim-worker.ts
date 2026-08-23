/**
 * WP-5/13 judge claim worker: claimNext → Phase-1 → publish view → CAS pointer.
 */

import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JUDGE_JOB_STATE,
  JUDGE_NODE,
  type LeaseClaimOptions,
} from "../../db/contracts.js";
import { migrate } from "../../db/sqlite/migrate.js";
import { advanceCurrentPointer } from "../../db/sqlite/pointers.js";
import { upsertResultVersion } from "../../db/sqlite/results.js";
import { SqliteJudgeJobRepository } from "../../db/sqlite/store.js";
import { ModelGateway } from "../gateway/client.js";
import { runPhase1LangGraph } from "../graph/langgraph-phase1.js";
import { publishJudgeArchiveView } from "../results/publish-view.js";

export interface ClaimWorkerOptions {
  themisDbPath: string;
  archivesRoot: string;
  gateway?: ModelGateway;
}

/** One tick: claim a job for the queue and run Phase-1 end-to-end. */
export class JudgeClaimWorker {
  private readonly db: Database.Database;
  private readonly jobs: SqliteJudgeJobRepository;
  private readonly gateway: ModelGateway;

  constructor(private readonly opts: ClaimWorkerOptions) {
    this.db = new Database(opts.themisDbPath);
    migrate(this.db);
    this.jobs = new SqliteJudgeJobRepository(this.db);
    this.gateway = opts.gateway ?? ModelGateway.fromEnv();
  }

  close(): void {
    this.db.close();
  }

  /** Claim and process at most one job. Returns null if none available. */
  async tick(input: {
    judgeQueueId: string;
    claim: LeaseClaimOptions;
  }): Promise<{
    jobId: string;
    runId: string;
    resultVersionId: string;
    viewDir: string;
  } | null> {
    const claimed = await this.jobs.claimNext(input.judgeQueueId, input.claim);
    if (!claimed) return null;

    const runId = claimed.job.runId;
    const archiveDir = join(this.opts.archivesRoot, runId);
    const workDir = await mkdtemp(join(tmpdir(), "ae-claim-work-"));
    const viewDir = await mkdtemp(join(tmpdir(), "ae-claim-view-"));

    const state = await runPhase1LangGraph({
      caseId: claimed.job.id,
      runId,
      archiveDir,
      workDir,
      gateway: this.gateway,
      attemptId: claimed.attempt.id,
      maxRounds: 3,
    });

    const published = await publishJudgeArchiveView({
      runId,
      trackId: claimed.job.publicationPolicy.trackId,
      baseArchiveDir: archiveDir,
      judgeDir: join(workDir, "judge"),
      viewDir,
    });

    const stored = upsertResultVersion(this.db, published.result);
    advanceCurrentPointer(this.db, {
      runId,
      trackId: stored.trackId,
      resultVersionId: stored.id,
      archiveViewPath: stored.archiveViewPath ?? viewDir,
      baseManifestSha256: claimed.job.baseManifestSha256,
      expectedResultVersionId:
        claimed.job.publicationPolicy.expectedCurrentResultVersionId,
    });

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
      viewDir,
    };
  }
}

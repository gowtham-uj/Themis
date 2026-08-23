/**
 * Drizzle SQLite schema — Themis async store (narrow slice).
 *
 * Only the tables the two repositories in this slice implement need:
 * `judge_jobs`, `judge_attempts`, and enough of `judge_provider_operations`
 * for `requeueExpiredLeases` to flip a lost attempt's in-flight operations
 * to `unknown`. Queues, generations, config snapshots, result versions,
 * current pointers, outbox, and idempotency keys belong to other slices.
 */

import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/** {owner, token, expiresAt} — null column means no lease held. */
type LeaseJson = {
  owner: string;
  token: number;
  expiresAt: string;
};

/** Judge publication policy snapshot (design §8). */
type PublicationPolicyJson = {
  makeCurrent: boolean;
  trackId: string;
  expectedCurrentResultVersionId: string | null;
  expectedCurrentArchiveViewGenerationId: string | null;
};

export const judgeJobs = sqliteTable(
  "judge_jobs",
  {
    id: text("id").primaryKey(),
    judgeQueueId: text("judge_queue_id").notNull(),
    judgeQueueGenerationId: text("judge_queue_generation_id").notNull(),
    sourceTriggerId: text("source_trigger_id").notNull(),
    /** JUDGE_JOB_TRIGGER_KIND value. */
    sourceTriggerKind: text("source_trigger_kind").notNull(),
    configSnapshotId: text("config_snapshot_id").notNull(),
    configSnapshotSha256: text("config_snapshot_sha256").notNull(),
    runId: text("run_id").notNull(),
    projectId: text("project_id").notNull(),
    batchId: text("batch_id"),
    taskId: text("task_id"),
    agentId: text("agent_id"),
    baseArchiveGenerationId: text("base_archive_generation_id").notNull(),
    baseManifestSha256: text("base_manifest_sha256").notNull(),
    /** JSON-encoded JudgePublicationPolicy. */
    publicationPolicyJson: text("publication_policy_json")
      .$type<PublicationPolicyJson>()
      .notNull(),
    /** JUDGE_JOB_STATE value. */
    state: text("state").$type<string>().notNull(),
    priority: integer("priority").notNull().default(0),
    availableAt: text("available_at").notNull(), // UTC ISO
    attemptCount: integer("attempt_count").notNull().default(0),
    activeAttemptId: text("active_attempt_id"),
    activeAttemptNumber: integer("active_attempt_number"),
    fencingToken: integer("fencing_token").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseToken: integer("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    currentNode: text("current_node"),
    currentRound: integer("current_round"),
    pauseKind: text("pause_kind"),
    pauseReason: text("pause_reason"),
    terminalErrorKind: text("terminal_error_kind"),
    terminalErrorDetail: text("terminal_error_detail"),
    createdAt: text("created_at").notNull(), // UTC ISO
    updatedAt: text("updated_at").notNull(), // UTC ISO
  },
  (t) => [
    // Idempotent trigger identity per kind (design §3).
    unique("uq_judge_jobs_trigger").on(
      t.judgeQueueId,
      t.sourceTriggerKind,
      t.sourceTriggerId,
    ),
    // Ready-job claim order; the production partial index over eligible states
    // is emulated here as a plain composite index (SQLite partial indexes via
    // drizzle are added below where the contract names one explicitly).
    index("idx_judge_jobs_ready").on(t.availableAt, t.priority, t.createdAt, t.id),
    index("idx_judge_jobs_lease_expiry").on(t.leaseExpiresAt),
    index("idx_judge_jobs_run").on(t.runId, t.createdAt, t.id),
    index("idx_judge_jobs_queue").on(t.judgeQueueId, t.createdAt, t.id),
    index("idx_judge_jobs_project").on(t.projectId, t.createdAt, t.id),
    // No UNIQUE (id, fencing_token) here. `id` is the primary key, so that pair
    // is unique by construction and the constraint enforces nothing — it reads
    // as fencing protection while providing none. The plan's real fencing
    // uniqueness is `(job_id, fencing_token)` on judge_attempts, below, where
    // job_id is NOT unique and the constraint therefore has teeth.
  ],
);

export const judgeAttempts = sqliteTable(
  "judge_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => judgeJobs.id),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    fencingToken: integer("fencing_token").notNull(),
    workingStorePrefix: text("working_store_prefix").notNull(),
    stagingPrefix: text("staging_prefix").notNull(),
    /** JUDGE_ATTEMPT_STATE value. */
    state: text("state").$type<string>().notNull(),
    errorClassification: text("error_classification"),
    /** JSON-encoded JudgeUsageSummary or null. */
    aggregateModelUsageJson: text("aggregate_model_usage_json"),
    aggregateWebUsageJson: text("aggregate_web_usage_json"),
    evidenceBytes: integer("evidence_bytes").notNull().default(0),
    estimatedCost: real("estimated_cost").notNull().default(0),
    /** JSON-encoded JudgeCheckpoint or null. */
    checkpointReachedJson: text("checkpoint_reached_json"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (t) => [
    unique("uq_judge_attempts_job_number").on(t.jobId, t.attemptNumber),
    unique("uq_judge_attempts_job_token").on(t.jobId, t.fencingToken),
    index("idx_judge_attempts_job").on(t.jobId),
  ],
);

export const judgeProviderOperations = sqliteTable(
  "judge_provider_operations",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    node: text("node").notNull(),
    metricOrRole: text("metric_or_role").notNull(),
    round: integer("round"),
    roundExecutionId: text("round_execution_id"),
    assignmentId: text("assignment_id"),
    operationKind: text("operation_kind").notNull(),
    canonicalRequestDigest: text("canonical_request_digest").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    canonicalUrl: text("canonical_url"),
    providerIdempotencyKey: text("provider_idempotency_key"),
    providerRequestId: text("provider_request_id"),
    /** JUDGE_PROVIDER_OPERATION_STATE value. */
    state: text("state").$type<string>().notNull(),
    authoritative: integer("authoritative", { mode: "boolean" })
      .notNull()
      .default(false),
    responseBlobKey: text("response_blob_key"),
    responseBlobHash: text("response_blob_hash"),
    usageJson: text("usage_json"),
    cost: real("cost"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    errorClassification: text("error_classification"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_jpo_attempt_state").on(t.attemptId, t.state),
    index("idx_jpo_attempt_created").on(t.attemptId, t.createdAt, t.id),
  ],
);

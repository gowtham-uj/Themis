/**
 * Themis async persistence contracts — WP-1.
 *
 * Async repository contracts and shared row types for the NEW Themis tables only.
 * This file is the frozen contract that `src/db/sqlite/` and `src/db/postgres/`
 * implement against (WP-1 build), and that WP-5/6/7 compose on top of.
 *
 * Sequencing (implementation plan §1.1, settled decision 1): the legacy
 * synchronous `QueryStore` (`src/db/queries.ts`) is NOT converted here. It keeps
 * serving the runner/API on the same database; these repositories share no code
 * path with it. Converting the legacy store is WP-16, out of scope.
 *
 * Hard rules encoded below, all from design sections 1–3 and "Scale and
 * correctness requirements":
 *  - Every repository method returns a Promise. Nothing here is synchronous.
 *  - A transaction is explicit: a transaction-scoped store is passed into a
 *    callback. A transaction must NEVER be held open across a model call or an
 *    object-store write (scale requirement 4) — enforced in `transaction`'s doc
 *    and repeated on every method that REQUIRES a transaction scope.
 *  - Every list API is bounded keyset pagination over a stable indexed order.
 *    There is deliberately NO offset type anywhere in this contract, and no
 *    unbounded `.all()` on high-cardinality tables (scale requirement 5).
 *  - Ordering columns that gate keyset cursors (`completed_at`, `result_sequence`,
 *    `created_at`) are written from the database clock in the publishing/creating
 *    transaction, never from a worker clock (design §10).
 *
 * The state enums in this file are the exact member sets the design names;
 * `tests/themis-db-contract.test.ts` pins them so they cannot drift.
 */

// ---------------------------------------------------------------------------
// Scalar primitives
// ---------------------------------------------------------------------------

/** Canonical UTC timestamp (ISO-8601, timestamptz). Where an ordering column is
 *  involved it MUST come from the database clock, never a worker clock. */
export type DbTimestamp = string;

/** Monotonically increasing fencing token. A worker receives one at claim and
 *  must include it in every later mutable predicate; a stale worker's writes are
 *  fenced out by a token mismatch. */
export type FencingToken = number;

/** Attempt ordinal within a job, 1-based. */
export type AttemptNumber = number;

/** Hard round ceiling (design: round 1 always runs, hard ceiling is 10). */
export const MAX_JUDGE_ROUNDS = 10;

/** Round ordinal, 1..10. */
export type JudgeRound = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** The five graph nodes (design: Nodes 0 through 4). */
export const JUDGE_NODE = {
  node0: "node0",
  node1: "node1",
  node2: "node2",
  node3: "node3",
  node4: "node4",
} as const;
export type JudgeNode = (typeof JUDGE_NODE)[keyof typeof JUDGE_NODE];

/** Judge agent roles (design: orchestrator directs, kratos/logos establish facts,
 *  minos rules, clerk assembles the bounded pack). */
export const JUDGE_ROLE = {
  orchestrator: "orchestrator",
  kratos: "kratos",
  logos: "logos",
  minos: "minos",
  clerk: "clerk",
} as const;
export type JudgeRole = (typeof JUDGE_ROLE)[keyof typeof JUDGE_ROLE];

/** A claim/lease held by one worker. Null means no lease is held. */
export interface Lease {
  readonly owner: string;
  readonly token: FencingToken;
  readonly expiresAt: DbTimestamp;
}

// ---------------------------------------------------------------------------
// State enums — exact member sets as named by the design
// ---------------------------------------------------------------------------

/** `judge_jobs.state` — design §3: queued, leased, running, waiting_retry,
 *  paused, sealing, completed, publication_conflict, input_invalid, failed,
 *  dead_letter, cancelled. */
export const JUDGE_JOB_STATE = {
  queued: "queued",
  leased: "leased",
  running: "running",
  waiting_retry: "waiting_retry",
  paused: "paused",
  sealing: "sealing",
  completed: "completed",
  publication_conflict: "publication_conflict",
  input_invalid: "input_invalid",
  failed: "failed",
  dead_letter: "dead_letter",
  cancelled: "cancelled",
} as const;
export type JudgeJobState = (typeof JUDGE_JOB_STATE)[keyof typeof JUDGE_JOB_STATE];

/** `judge_provider_operations.state` — design §3: not_started, in_flight,
 *  succeeded, failed, unknown. `unknown` after a crash is surfaced to retry
 *  policy, never silently retried as if it never happened. */
export const JUDGE_PROVIDER_OPERATION_STATE = {
  not_started: "not_started",
  in_flight: "in_flight",
  succeeded: "succeeded",
  failed: "failed",
  unknown: "unknown",
} as const;
export type JudgeProviderOperationState =
  (typeof JUDGE_PROVIDER_OPERATION_STATE)[keyof typeof JUDGE_PROVIDER_OPERATION_STATE];

/** `judge_result_versions.publication_state` — design "Publication states are
 *  explicit: preparing, uploaded, verified, committed, published, and invalid"
 *  (§ Production architecture), merged with the result-version lifecycle state
 *  `superseded` (§3: versions "may be published, superseded, or invalid") into
 *  one "publication/supersession state" column (design §8). */
export const JUDGE_PUBLICATION_STATE = {
  preparing: "preparing",
  uploaded: "uploaded",
  verified: "verified",
  committed: "committed",
  published: "published",
  superseded: "superseded",
  invalid: "invalid",
} as const;
export type JudgePublicationState =
  (typeof JUDGE_PUBLICATION_STATE)[keyof typeof JUDGE_PUBLICATION_STATE];

/** `judge_queue_generations.state` — design §3: accepting/closed. */
export const JUDGE_QUEUE_GENERATION_STATE = {
  accepting: "accepting",
  closed: "closed",
} as const;
export type JudgeQueueGenerationState =
  (typeof JUDGE_QUEUE_GENERATION_STATE)[keyof typeof JUDGE_QUEUE_GENERATION_STATE];

/** `judge_queues.status` — design §3 transition "Queue running -> paused stops
 *  claims ...; paused -> running requeues unfinished work". The design names no
 *  queue-level closed status; closure is expressed by closing the accepting
 *  judge_queue_generations row. */
export const JUDGE_QUEUE_STATUS = {
  running: "running",
  paused: "paused",
} as const;
export type JudgeQueueStatus = (typeof JUDGE_QUEUE_STATUS)[keyof typeof JUDGE_QUEUE_STATUS];

/** `judge_queues.pause_kind` and `judge_jobs.pause_kind` — design §3 Claims:
 *  manual, provider_quota, provider_rate_limit, budget, operator_safety. */
export const JUDGE_PAUSE_KIND = {
  manual: "manual",
  provider_quota: "provider_quota",
  provider_rate_limit: "provider_rate_limit",
  budget: "budget",
  operator_safety: "operator_safety",
} as const;
export type JudgePauseKind = (typeof JUDGE_PAUSE_KIND)[keyof typeof JUDGE_PAUSE_KIND];

/** `judge_attempts.state` — not literally enumerated in the design; derived from
 *  the attempt lifecycle it names: an attempt runs after claim, succeeds or fails
 *  terminally, or is `lost` when the lease expires (worker loss / OOM / kill,
 *  classification `worker_loss`). */
export const JUDGE_ATTEMPT_STATE = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  lost: "lost",
} as const;
export type JudgeAttemptState = (typeof JUDGE_ATTEMPT_STATE)[keyof typeof JUDGE_ATTEMPT_STATE];

/** `judge_attempts.error_classification` / `judge_provider_operations.error_classification`
 *  — design: "Error classification maps quota, transient, input, schema, and
 *  permanent failures correctly" (§ Verification), plus `worker_loss` (claims
 *  section) and `rate_limit` (retry classes, distinct from quota). */
export const JUDGE_ERROR_CLASSIFICATION = {
  rate_limit: "rate_limit",
  quota: "quota",
  transient: "transient",
  input: "input",
  schema: "schema",
  permanent: "permanent",
  worker_loss: "worker_loss",
} as const;
export type JudgeErrorClassification =
  (typeof JUDGE_ERROR_CLASSIFICATION)[keyof typeof JUDGE_ERROR_CLASSIFICATION];

/** `judge_queue_generations.source_trigger` — design §3: linked archive events
 *  atomically target the current accepting generation; standalone bulk submission
 *  explicitly creates or names one. */
export const JUDGE_GENERATION_TRIGGER_KIND = {
  linked_archive: "linked_archive",
  standalone_bulk: "standalone_bulk",
} as const;
export type JudgeGenerationTriggerKind =
  (typeof JUDGE_GENERATION_TRIGGER_KIND)[keyof typeof JUDGE_GENERATION_TRIGGER_KIND];

/** `judge_jobs.source_trigger_kind` — design §3: linked auto-judge keys on
 *  (judge_queue_id, archive_sealed_outbox_event_id); standalone bulk keys on
 *  (judge_queue_id, submitted_item_id); rejudging is an explicit new trigger. */
export const JUDGE_JOB_TRIGGER_KIND = {
  archive_sealed: "archive_sealed",
  standalone_item: "standalone_item",
  rejudge: "rejudge",
} as const;
export type JudgeJobTriggerKind =
  (typeof JUDGE_JOB_TRIGGER_KIND)[keyof typeof JUDGE_JOB_TRIGGER_KIND];

/** `judge_provider_operations.operation_kind` — design §3: "one durable row per
 *  model call or web fetch". */
export const JUDGE_PROVIDER_OPERATION_KIND = {
  model: "model",
  web_fetch: "web_fetch",
} as const;
export type JudgeProviderOperationKind =
  (typeof JUDGE_PROVIDER_OPERATION_KIND)[keyof typeof JUDGE_PROVIDER_OPERATION_KIND];

/** `idempotency_keys.state` — not literally enumerated in the design; derived
 *  from the lifecycle it describes: a request is in_progress until a response is
 *  stored, after which replays return the original response (within a bounded
 *  grace period past expiry). */
export const IDEMPOTENCY_KEY_STATE = {
  in_progress: "in_progress",
  completed: "completed",
} as const;
export type IdempotencyKeyState =
  (typeof IDEMPOTENCY_KEY_STATE)[keyof typeof IDEMPOTENCY_KEY_STATE];

/** Freeze every runtime enum so a stray mutation cannot corrupt the shared
 *  contract values (asserted by the WP-1 contract test). */
for (const enumObject of [
  JUDGE_NODE,
  JUDGE_ROLE,
  JUDGE_JOB_STATE,
  JUDGE_PROVIDER_OPERATION_STATE,
  JUDGE_PUBLICATION_STATE,
  JUDGE_QUEUE_GENERATION_STATE,
  JUDGE_QUEUE_STATUS,
  JUDGE_PAUSE_KIND,
  JUDGE_ATTEMPT_STATE,
  JUDGE_ERROR_CLASSIFICATION,
  JUDGE_GENERATION_TRIGGER_KIND,
  JUDGE_JOB_TRIGGER_KIND,
  JUDGE_PROVIDER_OPERATION_KIND,
  IDEMPOTENCY_KEY_STATE,
] as const) {
  Object.freeze(enumObject);
}

// ---------------------------------------------------------------------------
// Keyset pagination — the ONLY pagination model. No offset type exists.
// ---------------------------------------------------------------------------

/** A single value in a cursor's stable ordering tuple. */
export type CursorValue = string | number | boolean | null;

/** Internal cursor shape. Backends decode the opaque string with CursorCodec and
 *  resume the indexed order AFTER the recorded `orderValues`. The cursor is
 *  opaque to callers — the API passes `nextCursor` back uninterpreted. */
export interface KeysetCursor {
  /** Values of the ordering columns from the last row of the previous page, in
   *  indexed order. Never empty. */
  readonly orderValues: readonly CursorValue[];
  /** Direction of the stable order. */
  readonly direction: "asc" | "desc";
  /** Wire-format version; decoders fail closed on a different version. */
  readonly version: number;
}

/** Request for one keyset page. `cursor` is an opaque `nextCursor` from a prior
 *  page, or null for the first page. `limit` must be positive and bounded; a
 *  backend rejects excessive limits. There is no offset parameter. */
export interface KeysetPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

/** One page of results. `nextCursor` is null when `hasMore` is false. */
export interface KeysetPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Raised when a cursor string is malformed, tampered, or of an unknown version.
 *  Decoders must fail closed rather than guess. */
export class CursorDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorDecodeError";
  }
}

/** Current wire-format version carried inside every encoded cursor. */
export const CURSOR_VERSION = 1;

function isCursorScalar(value: unknown): value is CursorValue {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Deterministic, versioned, opaque cursor wire codec. Pure wire-format helpers —
 *  deliberately synchronous; no I/O and no blocking. Both backends and the API
 *  must share this one wire format so a cursor produced by either backend decodes
 *  on the other. */
export const opaqueCursorCodec: CursorCodec = {
  encode(cursor: KeysetCursor): string {
    if (cursor.version !== CURSOR_VERSION) {
      throw new Error(`cannot encode cursor with unknown version ${cursor.version}`);
    }
    if (cursor.orderValues.length === 0) {
      throw new Error("keyset cursor requires at least one order value");
    }
    if (cursor.direction !== "asc" && cursor.direction !== "desc") {
      throw new Error(`invalid cursor direction ${cursor.direction}`);
    }
    if (!cursor.orderValues.every(isCursorScalar)) {
      throw new Error("cursor order values must be finite scalars (string|number|boolean|null)");
    }
    const json = JSON.stringify({
      orderValues: cursor.orderValues,
      direction: cursor.direction,
      version: cursor.version,
    });
    return Buffer.from(json, "utf8").toString("base64url");
  },
  decode(cursor: string): KeysetCursor {
    let json: string;
    try {
      json = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      throw new CursorDecodeError("cursor is not base64url");
    }
    if (json === "") {
      throw new CursorDecodeError("cursor is empty");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new CursorDecodeError("cursor payload is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CursorDecodeError("cursor payload is not an object");
    }
    const record = parsed as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "orderValues" && key !== "direction" && key !== "version") {
        throw new CursorDecodeError(`cursor has unknown key ${key}`);
      }
    }
    if (record["version"] !== CURSOR_VERSION) {
      throw new CursorDecodeError(
        `cursor version ${String(record["version"])} is not supported (expected ${CURSOR_VERSION})`,
      );
    }
    if (record["direction"] !== "asc" && record["direction"] !== "desc") {
      throw new CursorDecodeError(`cursor has invalid direction ${String(record["direction"])}`);
    }
    if (!Array.isArray(record["orderValues"]) || record["orderValues"].length === 0) {
      throw new CursorDecodeError("cursor orderValues must be a non-empty array");
    }
    if (!record["orderValues"].every(isCursorScalar)) {
      throw new CursorDecodeError("cursor orderValues contain a non-scalar value");
    }
    return {
      orderValues: record["orderValues"] as CursorValue[],
      direction: record["direction"] as "asc" | "desc",
      version: CURSOR_VERSION,
    };
  },
};

/** Contract for a cursor wire codec. The concrete codec is `opaqueCursorCodec`. */
export interface CursorCodec {
  /** Serialize a cursor to its opaque string form. Deterministic for equal
   *  cursors, so re-encoding a decoded cursor is byte-stable. */
  encode(cursor: KeysetCursor): string;
  /** Parse an opaque cursor string. Throws CursorDecodeError on any malformed,
   *  wrong-version, or tampered input; never guesses. */
  decode(cursor: string): KeysetCursor;
}

// ---------------------------------------------------------------------------
// Shared configuration types (queue row + frozen config snapshot)
// ---------------------------------------------------------------------------

/** Judge agent roles that call a provider, with provider/model binding. */
export interface JudgeModelBinding {
  readonly provider: string;
  readonly model: string;
  readonly thinkingEnabled: boolean;
  readonly maxTokens: number;
}

/** Model settings for a judge queue / snapshot. Per-role overrides are first-class
 *  (design §5 settled decision 2): routing a role elsewhere is a distinct provider
 *  operation by construction. */
export interface JudgeModelSettings {
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly perRole: Readonly<Partial<Record<JudgeRole, JudgeModelBinding>>>;
  /** Floor on max_tokens for every judge call so a reasoning model cannot starve
   *  content budget (WP-6 reasoning budget). */
  readonly reasoningBudgetFloorTokens: number;
  readonly timeoutMs: number;
}

/** Retry policy (exponential backoff with jitter). Quota/rate-limit pauses never
 *  consume retries; that invariant is enforced by WP-5, not stored here. */
export interface JudgeRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly jitterRatio: number;
}

/** Per-case budget limits (design §11): input/output/reasoning tokens, model and
 *  web call counts, evidence bytes, wall time, estimated cost. */
export interface JudgeBudgetLimits {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxReasoningTokens: number;
  readonly maxModelCalls: number;
  readonly maxWebCalls: number;
  readonly maxEvidenceBytes: number;
  readonly maxWallMs: number;
  readonly maxEstimatedCost: number;
}

/** Node 3 clerk settings — the pack must refuse rather than silently truncate. */
export interface JudgeClerkSettings {
  readonly maxPackBytes: number;
  readonly maxPackTokens: number;
  /** Invalid clerk output gets one local repair; a second failure writes
   *  covered_partial (design §4 Node 3). */
  readonly repairAttempts: number;
  readonly coveredPartialAllowed: boolean;
}

/** Node 4 courtroom settings. */
export interface JudgeNode4Settings {
  /** Maximum sub-agent cap K. */
  readonly subAgentCap: number;
  /** Hard round ceiling, at most MAX_JUDGE_ROUNDS. */
  readonly maxRounds: number;
}

/** The eval-side dimensions snapshotted onto a judge job (design §7 provenance). */
export interface JudgeEvalProvenance {
  readonly projectId: string;
  readonly batchId: string | null;
  readonly taskId: string | null;
  readonly evalVersion: string;
  readonly agentId: string | null;
  readonly agentCommit: string | null;
  readonly agentVersion: string | null;
  readonly agentImage: string | null;
  readonly officialRewardProvenance: string;
}

// ---------------------------------------------------------------------------
// Row types — one interface per new Themis table
// ---------------------------------------------------------------------------

/** `judge_queues` row. */
export interface JudgeQueueRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: JudgeQueueStatus;
  /** Queue revision; every update bumps it and CASes on it. */
  readonly revision: number;
  /** Partial unique index on non-null linked_eval_queue_id: one judge queue per
   *  eval queue; standalone judge queues leave this null. */
  readonly linkedEvalQueueId: string | null;
  readonly autoJudge: boolean;
  /** First-class judgement track key (design §8): defaults to the linked eval
   *  queue id for the auto-judge track, else the queue's own track. */
  readonly trackKey: string;
  readonly parallelism: number;
  readonly priority: number;
  readonly retryPolicy: JudgeRetryPolicy;
  readonly modelSettings: JudgeModelSettings;
  readonly node0ChunkSize: number;
  readonly node2MetricSelection: readonly string[];
  readonly clerkSettings: JudgeClerkSettings;
  readonly node4Settings: JudgeNode4Settings;
  readonly budgetLimits: JudgeBudgetLimits;
  readonly createdAt: DbTimestamp;
  readonly updatedAt: DbTimestamp;
}

/** `judge_queue_generations` row. */
export interface JudgeQueueGenerationRow {
  readonly id: string;
  readonly judgeQueueId: string;
  readonly queueRevision: number;
  readonly configSnapshotId: string;
  /** Ordinal, unique per judge queue; assigned by the backend as max+1. */
  readonly ordinal: number;
  readonly state: JudgeQueueGenerationState;
  readonly sourceTrigger: JudgeGenerationTriggerKind;
  readonly createdAt: DbTimestamp;
  readonly closedAt: DbTimestamp | null;
}

/** `judge_config_snapshots` row. Created atomically with its job, before the job
 *  becomes claimable. Prompt bodies are encrypted and retained only while the job
 *  can run or be retried; hashes and runtime IDs survive. */
export interface JudgeConfigSnapshotRow {
  readonly id: string;
  readonly judgeQueueId: string;
  readonly projectId: string;
  /** Owning job; the snapshot and the job are created in one transaction. */
  readonly jobId: string;
  readonly queueRevision: number;
  /** Overall hash of the resolved configuration. */
  readonly configSha256: string;
  /** Encrypted effective prompt bodies (base64/hex ciphertext — never plaintext,
   *  never a credential). Deleted only on transition to a terminal state; never
   *  by a fixed TTL. */
  readonly promptBodiesEncrypted: string;
  /** SHA-256 of every prompt by role — retained after the bodies are deleted. */
  readonly promptSha256ByRole: Readonly<Record<JudgeRole, string>>;
  readonly modelSettings: JudgeModelSettings;
  readonly retryPolicy: JudgeRetryPolicy;
  readonly budgetLimits: JudgeBudgetLimits;
  readonly subAgentCap: number;
  readonly maxRounds: number;
  readonly toolRegistryVersion: string;
  readonly templateSchemaVersion: string;
  readonly graphVersion: string;
  readonly extractorVersion: string;
  readonly runtimeVersions: Readonly<Record<string, string>>;
  readonly inputArchiveGenerationId: string;
  readonly inputManifestSha256: string;
  readonly provenance: JudgeEvalProvenance;
  readonly createdAt: DbTimestamp;
}

/** `judge_jobs` row. */
export interface JudgeJobRow {
  readonly id: string;
  readonly judgeQueueId: string;
  readonly judgeQueueGenerationId: string;
  /** Immutable trigger id: archive-sealed outbox event id, submitted item id, or
   *  an explicit rejudge trigger. Unique with judge_queue_id per kind. */
  readonly sourceTriggerId: string;
  readonly sourceTriggerKind: JudgeJobTriggerKind;
  readonly configSnapshotId: string;
  readonly configSnapshotSha256: string;
  readonly runId: string;
  readonly projectId: string;
  readonly batchId: string | null;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly baseArchiveGenerationId: string;
  readonly baseManifestSha256: string;
  /** Snapshot of the publication policy at creation (design §8). */
  readonly publicationPolicy: JudgePublicationPolicy;
  readonly state: JudgeJobState;
  readonly priority: number;
  /** Earliest time the job may be claimed. */
  readonly availableAt: DbTimestamp;
  readonly attemptCount: number;
  readonly activeAttemptId: string | null;
  readonly activeAttemptNumber: AttemptNumber | null;
  readonly fencingToken: FencingToken;
  readonly lease: Lease | null;
  readonly heartbeatAt: DbTimestamp | null;
  readonly currentNode: JudgeNode | null;
  readonly currentRound: JudgeRound | null;
  readonly pauseKind: JudgePauseKind | null;
  readonly pauseReason: string | null;
  readonly terminalErrorKind: JudgeErrorClassification | null;
  readonly terminalErrorDetail: string | null;
  readonly createdAt: DbTimestamp;
  readonly updatedAt: DbTimestamp;
}

/** `judge_attempts` row. */
export interface JudgeAttemptRow {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNumber: AttemptNumber;
  readonly workerId: string;
  readonly fencingToken: FencingToken;
  /** Attempt-scoped working-store and object prefix; retries never share these. */
  readonly workingStorePrefix: string;
  readonly stagingPrefix: string;
  readonly state: JudgeAttemptState;
  readonly errorClassification: JudgeErrorClassification | null;
  readonly aggregateModelUsage: JudgeUsageSummary;
  readonly aggregateWebUsage: JudgeUsageSummary;
  readonly evidenceBytes: number;
  readonly estimatedCost: number;
  readonly checkpointReached: JudgeCheckpoint | null;
  readonly startedAt: DbTimestamp | null;
  readonly endedAt: DbTimestamp | null;
}

/** `judge_provider_operations` row — one durable row per model call or web fetch. */
export interface JudgeProviderOperationRow {
  readonly id: string;
  /** Judge job id. */
  readonly caseId: string;
  readonly attemptId: string;
  readonly node: JudgeNode;
  /** Metric id (Node 2) or agent role (Nodes 3/4). */
  readonly metricOrRole: string;
  readonly round: JudgeRound | null;
  readonly roundExecutionId: string | null;
  readonly assignmentId: string | null;
  readonly operationKind: JudgeProviderOperationKind;
  /** Canonical request digest; part of the logical operation key. */
  readonly canonicalRequestDigest: string;
  readonly provider: string;
  /** Null for web fetches. */
  readonly model: string | null;
  /** Canonical URL for web fetches, else null. */
  readonly canonicalUrl: string | null;
  /** Provider idempotency key where supported. */
  readonly providerIdempotencyKey: string | null;
  readonly providerRequestId: string | null;
  readonly state: JudgeProviderOperationState;
  /** Exactly one operation per logical unit is authoritative before an overlay
   *  merge consumes it; a second succeeded op for the same logical unit can never
   *  silently become authoritative (enforced by a partial unique constraint). */
  readonly authoritative: boolean;
  readonly responseBlobKey: string | null;
  readonly responseBlobHash: string | null;
  readonly usage: JudgeUsageSummary | null;
  readonly cost: number | null;
  readonly startedAt: DbTimestamp | null;
  readonly endedAt: DbTimestamp | null;
  readonly errorClassification: JudgeErrorClassification | null;
  readonly createdAt: DbTimestamp;
}

/** `judge_result_versions` row — WP-1 pins identity, provenance, and publication.
 *  Verdict/narrative/confidence projection columns (design §8) are WP-11's
 *  typed-projection contract and are intentionally not enumerated here. */
export interface JudgeResultVersionRow {
  readonly id: string;
  readonly runId: string;
  readonly caseId: string;
  readonly judgeQueueId: string;
  readonly trackId: string;
  readonly projectId: string;
  readonly pipelineVersion: string;
  readonly templateVersion: string;
  readonly schemaVersion: number;
  readonly configSnapshotId: string;
  readonly configSha256: string;
  /** Explicit rejudge trigger id, or null for the first judgement of a case. */
  readonly rejudgeTriggerId: string | null;
  readonly baseArchiveGenerationId: string;
  /** This result's judge archive-view generation (WP-12). */
  readonly archiveGenerationId: string;
  readonly reportBlobKey: string;
  readonly reportSha256: string;
  readonly reportByteLength: number;
  readonly publicationState: JudgePublicationState;
  /** Assigned in the same transaction that flips the version to published, from
   *  a per-project monotonic sequence written by the database clock. */
  readonly resultSequence: number | null;
  /** Reconciled against the verifier; byte-exact, never assigned by a judge. */
  readonly officialReward: number | null;
  readonly completedAt: DbTimestamp | null;
  readonly createdAt: DbTimestamp;
}

/** `judge_current_pointers` row. The design (§8) unifies the current-result and
 *  current-archive-view pointers into one atomic row unique on (run_id, track_id),
 *  advanced only by compare-and-swap. */
export interface JudgeCurrentPointerRow {
  readonly runId: string;
  readonly trackId: string;
  readonly resultVersionId: string;
  readonly archiveViewGenerationId: string;
  readonly updatedAt: DbTimestamp;
}

/** `outbox_events` row. Delivery state is derived (pending / leased / delivered)
 *  from `lease*` and `deliveredAt`; the design stores no separate state enum. */
export interface OutboxEventRow {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Unique outbox event identity per aggregate: (aggregate_type, event_type,
   *  aggregate_version). */
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly payloadVersion: number;
  readonly payloadBody: string;
  readonly availableAt: DbTimestamp;
  readonly leaseOwner: string | null;
  readonly leaseToken: number | null;
  readonly leaseExpiresAt: DbTimestamp | null;
  readonly attempts: number;
  readonly deliveredAt: DbTimestamp | null;
  readonly lastError: string | null;
  readonly createdAt: DbTimestamp;
}

/** `idempotency_keys` row. */
export interface IdempotencyKeyRow {
  /** Caller-supplied key, unique within (projectId, route, callerIdentity). */
  readonly key: string;
  readonly projectId: string;
  readonly route: string;
  readonly callerIdentity: string;
  readonly requestDigest: string;
  readonly state: IdempotencyKeyState;
  readonly responseStatus: number | null;
  readonly responseBodyRef: string | null;
  readonly expiresAt: DbTimestamp;
  readonly completedAt: DbTimestamp | null;
  readonly createdAt: DbTimestamp;
}

// ---------------------------------------------------------------------------
// Supporting row-adjacent types
// ---------------------------------------------------------------------------

/** Token/call usage for an attempt or a single provider operation. Reasoning
 *  tokens are billed but invisible in content, so they are tracked separately. */
export interface JudgeUsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly modelCalls: number;
  readonly webCalls: number;
}

/** Last committed checkpoint of an attempt (resume-from, never process-local). */
export interface JudgeCheckpoint {
  readonly node: JudgeNode;
  readonly round: JudgeRound;
  readonly committedAt: DbTimestamp;
}

/** Fencing predicate every mutable judge write must carry: job id, active attempt,
 *  active state, and fencing token. A stale worker fails the predicate. */
export interface JudgeFencing {
  readonly caseId: string;
  readonly activeAttemptId: string;
  readonly activeState: JudgeJobState;
  readonly fencingToken: FencingToken;
}

/** Publication policy snapshotted onto a judge job at creation (design §8). */
export interface JudgePublicationPolicy {
  readonly makeCurrent: boolean;
  readonly trackId: string;
  readonly expectedCurrentResultVersionId: string | null;
  readonly expectedCurrentArchiveViewGenerationId: string | null;
}

/** The logical identity of a provider operation (design §3). Provider/model are
 *  part of the key, so a policy-allowed provider fallback is a distinct op. */
export interface JudgeProviderOperationLogicalKey {
  readonly attemptId: string;
  readonly node: JudgeNode;
  readonly metricOrRole: string;
  readonly round: JudgeRound | null;
  readonly roundExecutionId: string | null;
  readonly assignmentId: string | null;
  readonly canonicalRequestDigest: string;
  readonly provider: string;
  readonly model: string | null;
}

/** Success outcome recorded for a provider operation. */
export interface JudgeProviderSuccess {
  readonly providerRequestId: string;
  readonly responseBlobKey: string;
  readonly responseBlobHash: string;
  readonly usage: JudgeUsageSummary;
  readonly cost: number;
  readonly endedAt: DbTimestamp;
}

/** Failure outcome recorded for a provider operation. */
export interface JudgeProviderFailure {
  readonly classification: JudgeErrorClassification;
  readonly detail: string;
  readonly endedAt: DbTimestamp;
}

/** Lease-claim parameters shared by judge-job and outbox claiming. */
export interface LeaseClaimOptions {
  readonly now: DbTimestamp;
  readonly leaseMs: number;
  readonly workerId: string;
}

/** Lease-requeue parameters for the sweeper paths. */
export interface RequeueOptions {
  readonly now: DbTimestamp;
  /** Leases older than this are considered expired. */
  readonly maxLeaseAgeMs: number;
  /** Bounded batch size; never an unbounded scan. */
  readonly limit: number;
}

/** Result of a successful judge-job claim: the job, its new attempt, and the
 *  fencing token the worker must echo on every later write. */
export interface JudgeClaimResult {
  readonly job: JudgeJobRow;
  readonly attempt: JudgeAttemptRow;
  readonly fencingToken: FencingToken;
}

/** Fenced patch applied to a judge job by `updateFenced`. */
export interface JudgeJobPatch {
  readonly state?: JudgeJobState;
  readonly currentNode?: JudgeNode | null;
  readonly currentRound?: JudgeRound | null;
  readonly pauseKind?: JudgePauseKind | null;
  readonly pauseReason?: string | null;
  readonly terminalErrorKind?: JudgeErrorClassification | null;
  readonly terminalErrorDetail?: string | null;
  readonly lease?: Lease | null;
  readonly heartbeatAt?: DbTimestamp | null;
  readonly availableAt?: DbTimestamp;
  readonly activeAttemptId?: string | null;
  readonly activeAttemptNumber?: AttemptNumber | null;
  readonly attemptCount?: number;
  readonly fencingToken?: FencingToken;
}

/** Fenced patch applied to a judge queue row by `update`; bumps revision. */
export interface JudgeQueuePatch {
  readonly status?: JudgeQueueStatus;
  readonly pauseKind?: JudgePauseKind | null;
  readonly pauseReason?: string | null;
  readonly name?: string;
  readonly linkedEvalQueueId?: string | null;
  readonly autoJudge?: boolean;
  readonly parallelism?: number;
  readonly priority?: number;
  readonly retryPolicy?: JudgeRetryPolicy;
  readonly modelSettings?: JudgeModelSettings;
  readonly node0ChunkSize?: number;
  readonly node2MetricSelection?: readonly string[];
  readonly clerkSettings?: JudgeClerkSettings;
  readonly node4Settings?: JudgeNode4Settings;
  readonly budgetLimits?: JudgeBudgetLimits;
}

/** Compare-and-swap predicate for the current pointer. */
export interface JudgeCurrentPointerCas {
  /** Expected current pointer (null fields = expected no current). */
  readonly expectedCurrent: {
    readonly resultVersionId: string | null;
    readonly archiveViewGenerationId: string | null;
  };
  /** Job/attempt fencing so a stale worker can never move the pointer. */
  readonly fencing: JudgeFencing;
  readonly baseManifestSha256: string;
}

/** Scoped idempotency-key reference used by repository methods. */
export interface IdempotencyKeyRef {
  readonly projectId: string;
  readonly key: string;
}

// ---------------------------------------------------------------------------
// New-row input types (server-assigned fields omitted)
// ---------------------------------------------------------------------------

/** Input for `judgeQueues.create`. Status is caller-chosen; revision starts at 1. */
export type NewJudgeQueue = Omit<
  JudgeQueueRow,
  "id" | "createdAt" | "updatedAt" | "revision"
>;

/** Input for `judgeQueueGenerations.createNext`; ordinal, state, and timestamps
 *  are assigned by the backend. */
export type NewJudgeQueueGeneration = Omit<
  JudgeQueueGenerationRow,
  "id" | "state" | "ordinal" | "createdAt" | "closedAt"
>;

/** Input for `judgeConfigSnapshots.create`. */
export type NewJudgeConfigSnapshot = Omit<JudgeConfigSnapshotRow, "id" | "createdAt">;

/** Input for `judgeJobs.upsertByTrigger`. Initial state is queued; lease, attempt,
 *  fencing, and timestamps are assigned by the backend. */
export type NewJudgeJob = Omit<
  JudgeJobRow,
  | "id"
  | "state"
  | "attemptCount"
  | "activeAttemptId"
  | "activeAttemptNumber"
  | "fencingToken"
  | "lease"
  | "heartbeatAt"
  | "currentNode"
  | "currentRound"
  | "pauseKind"
  | "pauseReason"
  | "terminalErrorKind"
  | "terminalErrorDetail"
  | "createdAt"
  | "updatedAt"
>;

/** Input for `judgeAttempts.create`; state starts running and counters start zero. */
export type NewJudgeAttempt = Omit<
  JudgeAttemptRow,
  | "id"
  | "state"
  | "startedAt"
  | "endedAt"
  | "errorClassification"
  | "checkpointReached"
  | "aggregateModelUsage"
  | "aggregateWebUsage"
  | "evidenceBytes"
  | "estimatedCost"
>;

/** Input for `judgeProviderOperations.create`; state starts not_started and
 *  response/outcome fields are null. */
export type NewJudgeProviderOperation = Omit<
  JudgeProviderOperationRow,
  | "id"
  | "state"
  | "authoritative"
  | "providerRequestId"
  | "responseBlobKey"
  | "responseBlobHash"
  | "usage"
  | "cost"
  | "startedAt"
  | "endedAt"
  | "errorClassification"
>;

/** Input for `outboxEvents.enqueue`; lease, attempts, and timestamps assigned. */
export type NewOutboxEvent = Omit<
  OutboxEventRow,
  "id" | "leaseOwner" | "leaseToken" | "leaseExpiresAt" | "attempts" | "deliveredAt" | "lastError" | "createdAt"
>;

/** Input for `idempotencyKeys.createIfAbsent`; state starts in_progress. */
export type NewIdempotencyKey = Omit<
  IdempotencyKeyRow,
  "state" | "responseStatus" | "responseBodyRef" | "completedAt" | "createdAt"
>;

/** Input for `judgeResultVersions.createStaging`; publication starts preparing. */
export type NewJudgeResultVersion = Omit<
  JudgeResultVersionRow,
  "id" | "publicationState" | "resultSequence" | "completedAt" | "createdAt"
>;

// ---------------------------------------------------------------------------
// Repository contracts — every method returns a Promise
// ---------------------------------------------------------------------------

/** `judge_queues` repository. */
export interface JudgeQueueRepository {
  /** Create a judge queue. Initial revision is 1. */
  create(input: NewJudgeQueue): Promise<JudgeQueueRow>;
  /** Fetch one judge queue by id. */
  get(id: string): Promise<JudgeQueueRow | null>;
  /** Fetch the single judge queue linked to an eval queue (partial unique index
   *  on non-null linked_eval_queue_id), or null. */
  getByLinkedEvalQueue(evalQueueId: string): Promise<JudgeQueueRow | null>;
  /** Keyset list by project, ordered by (created_at, id). */
  listByProjectCursor(projectId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeQueueRow>>;
  /** Fenced update: CAS on (revision, status); returns null on conflict. Bumps
   *  the revision. The queue state machine (running↔paused) is WP-5 policy; this
   *  primitive only makes the transition atomic. */
  update(id: string, expected: { revision: number; status: JudgeQueueStatus }, patch: JudgeQueuePatch): Promise<JudgeQueueRow | null>;
}

/** `judge_queue_generations` repository. */
export interface JudgeQueueGenerationRepository {
  /** Fetch one generation by id. */
  get(id: string): Promise<JudgeQueueGenerationRow | null>;
  /** Fetch the current accepting generation of a judge queue (partial unique
   *  accepting index), or null. REQUIRES a transaction scope when the caller will
   *  atomically claim an event for it (design §3). */
  getCurrentAccepting(judgeQueueId: string): Promise<JudgeQueueGenerationRow | null>;
  /** Atomically create the next accepting generation (ordinal = max+1) and, in
   *  the same transaction, route the triggering event/item to it. REQUIRES a
   *  transaction scope. Never infers closure from a stale queue row or a scan. */
  createNext(input: NewJudgeQueueGeneration): Promise<JudgeQueueGenerationRow>;
  /** Close an accepting generation (CAS accepting → closed); returns null on
   *  conflict. REQUIRES a transaction scope when combined with late-event routing. */
  close(id: string): Promise<JudgeQueueGenerationRow | null>;
  /** Keyset list of a queue's generations, ordered by (ordinal, id). */
  listByQueueCursor(judgeQueueId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeQueueGenerationRow>>;
}

/** `judge_config_snapshots` repository. */
export interface JudgeConfigSnapshotRepository {
  /** Create a config snapshot atomically with its job, before the job becomes
   *  claimable. REQUIRES a transaction scope. */
  create(input: NewJudgeConfigSnapshot): Promise<JudgeConfigSnapshotRow>;
  /** Fetch one snapshot by id. */
  get(id: string): Promise<JudgeConfigSnapshotRow | null>;
  /** Fetch the snapshot owned by a job. */
  getByJob(jobId: string): Promise<JudgeConfigSnapshotRow | null>;
  /** Delete the encrypted prompt bodies only — hashes and runtime IDs remain.
   *  Event-driven: allowed only on a transition to a terminal state
   *  (completed/cancelled/dead_letter after its operator retry window), never by
   *  a fixed TTL, and never while the job is paused/waiting_retry/leased/running. */
  deleteEncryptedPromptBodies(id: string): Promise<void>;
  /** Delete the whole snapshot after the retry/dead-letter retention window. */
  delete(id: string): Promise<void>;
}

/** `judge_jobs` repository — the work-control heart. */
export interface JudgeJobRepository {
  /** Idempotent upsert keyed on the immutable trigger identity
   *  (judge_queue_id, source_trigger_id) for the archive_sealed / standalone_item
   *  kinds, so replaying one trigger can never create a second job. Returns
   *  whether a new job was created. REQUIRES a transaction scope: the outbox
   *  relay's job upsert and the event's delivered_time update must be one
   *  transaction (design §3). */
  upsertByTrigger(input: NewJudgeJob): Promise<{ job: JudgeJobRow; created: boolean }>;
  /** Fetch one job by id. */
  get(id: string): Promise<JudgeJobRow | null>;
  /** Keyset list of jobs judging a run, ordered by (created_at, id). */
  getByRunCursor(runId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>>;
  /** Keyset list by judge queue, ordered by (created_at, id). */
  listByQueueCursor(judgeQueueId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>>;
  /** Keyset list by project, ordered by (created_at, id). */
  listByProjectCursor(projectId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeJobRow>>;
  /** Claim the next eligible job of a queue with one short transaction
   *  (SELECT ... FOR UPDATE SKIP LOCKED over the partial ready-job index
   *  (available_at, priority DESC, created_at, id)), bump the fencing token, set
   *  the lease deadline, and create the attempt. Returns null when nothing is
   *  eligible. REQUIRES a transaction scope and the transaction MUST be committed
   *  before any model call or object-store write begins. */
  claimNext(judgeQueueId: string, opts: LeaseClaimOptions): Promise<JudgeClaimResult | null>;
  /** Extend a lease only when the worker, fencing token, and active state still
   *  match. Returns false (fenced out) otherwise. Never requires a transaction. */
  heartbeat(id: string, expected: JudgeFencing, leaseExpiresAt: DbTimestamp): Promise<boolean>;
  /** Fenced update: every mutable job write (checkpoints, pause/resume, retry
   *  accounting, completion, terminal error) goes through this CAS; a stale
   *  worker gets null. REQUIRES a transaction scope where the write must be
   *  atomic with other rows (round commits, projections, publication). */
  updateFenced(id: string, expected: JudgeFencing, patch: JudgeJobPatch): Promise<JudgeJobRow | null>;
  /** Sweep expired leases in bounded batches: move expired jobs to
   *  waiting_retry, mark the lost attempt lost, and flip every in_flight
   *  provider operation of the lost attempt to unknown (classification
   *  worker_loss). REQUIRES a transaction scope. Returns the number requeued. */
  requeueExpiredLeases(opts: RequeueOptions): Promise<number>;
  /**
   * Release a lease WITHOUT charging a retry attempt. Used for provider
   * quota/rate-limit pauses: the claim already incremented attempt_count, but a
   * throttle is not a failed try — it must not count against the retry budget.
   * Decrements attempt_count and drops the attempt row atomically.
   */
  releaseClaimNoRetryCharge(id: string, attemptId: string, expected: JudgeFencing): Promise<boolean>;
}

/** `judge_attempts` repository. */
export interface JudgeAttemptRepository {
  /** Create an attempt (normally inside claimNext's transaction). REQUIRES a
   *  transaction scope. */
  create(input: NewJudgeAttempt): Promise<JudgeAttemptRow>;
  /** Fetch one attempt by id. */
  get(id: string): Promise<JudgeAttemptRow | null>;
  /** All attempts of a job — bounded by the retry budget, so a plain list is
   *  fine (not high-cardinality). */
  getByJob(jobId: string): Promise<readonly JudgeAttemptRow[]>;
  /** CAS attempt state transition (running → succeeded|failed|lost); returns
   *  null on conflict. */
  transition(
    id: string,
    expected: JudgeAttemptState,
    next: JudgeAttemptState,
    opts?: { errorClassification?: JudgeErrorClassification | null; endedAt?: DbTimestamp | null; checkpoint?: JudgeCheckpoint | null },
  ): Promise<JudgeAttemptRow | null>;
}

/** `judge_provider_operations` repository — one durable row per model/web call. */
export interface JudgeProviderOperationRepository {
  /** Create the row BEFORE the request is issued, in state not_started. */
  create(input: NewJudgeProviderOperation): Promise<JudgeProviderOperationRow>;
  /** Fetch one operation by its durable id. */
  get(id: string): Promise<JudgeProviderOperationRow | null>;
  /** Fetch the operation of an attempt with a given logical key, so recovery can
   *  reuse a succeeded response or resolve an unknown outcome by policy. */
  getByLogicalKey(attemptId: string, key: JudgeProviderOperationLogicalKey): Promise<JudgeProviderOperationRow | null>;
  /** CAS not_started → in_flight; records startedAt. */
  begin(id: string, expected: { attemptId: string; fencingToken: FencingToken }): Promise<JudgeProviderOperationRow | null>;
  /** CAS in_flight → succeeded; records the response blob, usage, and cost. */
  succeed(id: string, expected: { attemptId: string; fencingToken: FencingToken }, result: JudgeProviderSuccess): Promise<JudgeProviderOperationRow | null>;
  /** CAS in_flight → failed with a classification. */
  fail(id: string, expected: { attemptId: string; fencingToken: FencingToken }, failure: JudgeProviderFailure): Promise<JudgeProviderOperationRow | null>;
  /** CAS in_flight → unknown (classification worker_loss) for a lost attempt's
   *  outstanding operation, so retry policy sees an explicit nonterminal outcome. */
  markUnknown(id: string, expected: { attemptId: string }): Promise<JudgeProviderOperationRow | null>;
  /** Flip every in_flight operation of a lost attempt to unknown. REQUIRES a
   *  transaction scope (runs inside the re-queue transaction). Returns the count
   *  flipped. */
  markInFlightUnknownByAttempt(attemptId: string): Promise<number>;
  /** Mark one succeeded operation authoritative for its logical unit. The
   *  backend enforces that a second succeeded op for the same logical unit cannot
   *  silently become authoritative (partial unique constraint). */
  setAuthoritative(id: string, expected: { attemptId: string; fencingToken: FencingToken }): Promise<JudgeProviderOperationRow | null>;
  /** Keyset list of an attempt's operations, ordered by (created_at, id). */
  listByAttemptCursor(attemptId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeProviderOperationRow>>;
}

/** `judge_result_versions` repository. */
export interface JudgeResultVersionRepository {
  /** Insert a result version in state preparing, together with its child
   *  projection rows. REQUIRES a transaction scope; rows must stay staging until
   *  the archive view publishes (design §8). */
  createStaging(input: NewJudgeResultVersion): Promise<JudgeResultVersionRow>;
  /** Fetch one immutable result version by id. */
  get(id: string): Promise<JudgeResultVersionRow | null>;
  /** Keyset list of a run's versions, ordered by (completed_at, id). */
  listByRunCursor(runId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>>;
  /** Keyset list by project, ordered by (completed_at, id). */
  listByProjectCursor(projectId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>>;
  /** Keyset list by judge queue, ordered by (completed_at, id). */
  listByQueueCursor(judgeQueueId: string, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>>;
  /** Generic CAS on publication_state (preparing → uploaded → verified →
   *  committed, and verified → invalid, published → superseded). */
  transitionPublication(id: string, expected: JudgePublicationState, next: JudgePublicationState): Promise<JudgeResultVersionRow | null>;
  /** Publish: CAS verified → published and assign result_sequence from the
   *  per-project monotonic sequence in the same transaction (the pointer CAS is a
   *  separate advance on judgeCurrentPointers, in the same transaction). REQUIRES
   *  a transaction scope. */
  publish(id: string, expected: { publicationState: "verified" }): Promise<JudgeResultVersionRow | null>;
  /** Move a version to invalid on a consistency failure; removes it from
   *  current-result reads and raises an operational alert. Never mutates bytes. */
  markInvalid(id: string, reason: string): Promise<JudgeResultVersionRow | null>;
  /** Mark a previously published version superseded when a newer version becomes
   *  current. The version stays immutable and addressable. */
  markSuperseded(id: string): Promise<JudgeResultVersionRow | null>;
  /** High-water-mark export page: published versions with
   *  result_sequence <= asOfSequence, ordered by (result_sequence, id). REQUIRES a
   *  transaction scope so a concurrent publish cannot be skipped or duplicated
   *  relative to the mark (design §10). */
  listForExport(projectId: string, asOfSequence: number, req: KeysetPageRequest): Promise<KeysetPage<JudgeResultVersionRow>>;
}

/** `judge_current_pointers` repository — one atomic current pointer per
 *  (run_id, track_id). */
export interface JudgeCurrentPointerRepository {
  /** Fetch the current pointer of a run/track, or null. */
  get(runId: string, trackId: string): Promise<JudgeCurrentPointerRow | null>;
  /** Compare-and-swap advance of the current pointer. The predicate includes the
   *  expected current result/view, the base hash, and the job's fencing; a stale
   *  worker or a moved pointer gets null. REQUIRES a transaction scope. A
   *  standalone/rejudge judgement moves only its own track's pointer. */
  advance(runId: string, trackId: string, expected: JudgeCurrentPointerCas, next: JudgeCurrentPointerRow): Promise<JudgeCurrentPointerRow | null>;
  /** All pointers of a run (one per track — low cardinality). */
  listByRun(runId: string): Promise<readonly JudgeCurrentPointerRow[]>;
}

/** `outbox_events` repository — at-least-once relay. */
export interface OutboxEventRepository {
  /** Enqueue an event. REQUIRES a transaction scope: `archive.sealed` is inserted
   *  in the same transaction that publishes the base archive generation (design
   *  §3). */
  enqueue(input: NewOutboxEvent): Promise<OutboxEventRow>;
  /** Claim the next due undelivered event with a lease (FOR UPDATE SKIP LOCKED
   *  over the partial undelivered index (available_at, created_at, event_id)).
   *  REQUIRES a transaction scope. */
  claimNext(opts: LeaseClaimOptions): Promise<OutboxEventRow | null>;
  /** Mark an event delivered. REQUIRES a transaction scope: this update must be
   *  atomic with the judge-job upsert, so a crash before commits redelivers and
   *  dedupes, and delivery is never marked without its job being durable. */
  markDelivered(id: string, expected: { leaseToken: number; leaseOwner: string }): Promise<boolean>;
  /** Release a lease after a failed delivery (attempts++, lastError), so the
   *  event is redelivered later. */
  releaseLease(id: string, expected: { leaseToken: number }, error: string): Promise<OutboxEventRow | null>;
  /** Requeue undelivered events with expired leases, in bounded batches. REQUIRES
   *  a transaction scope. */
  requeueExpiredLeases(opts: RequeueOptions): Promise<number>;
  /** Keyset list of pending (undelivered) events due at or before `now`, ordered
   *  by (available_at, created_at, id). */
  listPendingCursor(now: DbTimestamp, req: KeysetPageRequest): Promise<KeysetPage<OutboxEventRow>>;
}

/** `idempotency_keys` repository — durable replacement for the legacy in-memory
 *  idempotency map. */
export interface IdempotencyKeyRepository {
  /** Atomically insert a key in state in_progress if absent; returns whether it
   *  was created. A replay that finds the key must return the stored response. */
  createIfAbsent(input: NewIdempotencyKey): Promise<{ key: IdempotencyKeyRow; created: boolean }>;
  /** Fetch one key by its scoped reference. */
  get(ref: IdempotencyKeyRef): Promise<IdempotencyKeyRow | null>;
  /** Return the original stored response if the key is completed, within a
   *  bounded grace period past expiry, so a slow replay cannot create a second
   *  resource. */
  getReplay(ref: IdempotencyKeyRef, gracePeriodMs: number, now: DbTimestamp): Promise<IdempotencyKeyRow | null>;
  /** CAS in_progress → completed with the stored response status/body reference. */
  complete(ref: IdempotencyKeyRef, expected: { state: "in_progress" }, result: { responseStatus: number; responseBodyRef: string | null; completedAt: DbTimestamp }): Promise<IdempotencyKeyRow | null>;
  /** Delete keys past their expiry and grace period, in bounded batches. */
  deleteExpired(now: DbTimestamp): Promise<number>;
}

// ---------------------------------------------------------------------------
// Database handle and explicit transaction scope
// ---------------------------------------------------------------------------

/** Repository accessor surface shared by the database handle and the
 *  transaction-scoped store. */
export interface ThemisRepos {
  readonly judgeQueues: JudgeQueueRepository;
  readonly judgeQueueGenerations: JudgeQueueGenerationRepository;
  readonly judgeConfigSnapshots: JudgeConfigSnapshotRepository;
  readonly judgeJobs: JudgeJobRepository;
  readonly judgeAttempts: JudgeAttemptRepository;
  readonly judgeProviderOperations: JudgeProviderOperationRepository;
  readonly judgeResultVersions: JudgeResultVersionRepository;
  readonly judgeCurrentPointers: JudgeCurrentPointerRepository;
  readonly outboxEvents: OutboxEventRepository;
  readonly idempotencyKeys: IdempotencyKeyRepository;
}

/** The async Themis database handle. */
export interface ThemisDb extends ThemisRepos {
  /**
   * Run `fn` inside ONE transaction. A transaction-scoped store (`tx`) is passed
   * into the callback; every repository call through `tx` is bound to that
   * transaction and commits atomically when `fn` resolves, rolls back when it
   * rejects.
   *
   * HARD RULES (design scale requirement 4):
   *  - NEVER hold the transaction open across a model call, a large object read,
   *    or an object-store blob write. Do all external work OUTSIDE `fn`; inside
   *    `fn` only read/verify database state and write small rows.
   *  - Do not call `transaction` inside `fn` (no nesting).
   *  - Keep `fn` short; a claim/lease transaction must commit before any model or
   *    object-store work begins.
   */
  transaction<T>(fn: (tx: ThemisTx) => Promise<T>): Promise<T>;

  /** Close the connection pool. Backends fail closed on production startup if
   *  the database is unreachable; this is the explicit shutdown path. */
  close(): Promise<void>;
}

/** A transaction-scoped store: the same repository surface as ThemisDb, bound to
 *  one transaction. Methods marked "REQUIRES a transaction scope" are the ones
 *  whose callers must receive `tx`. */
export type ThemisTx = ThemisRepos;

// ---------------------------------------------------------------------------
// Runtime contract manifest — the method surface as a runtime value
// ---------------------------------------------------------------------------

/**
 * The contract surface as a runtime value, so tests can pin the exact method set
 * and so a backend or conformance suite can check it is fully implemented. Each
 * method is `async` because the corresponding repository interface method is
 * compiled to return Promise (the compile-time tie below fails otherwise).
 */
export const THEMIS_CONTRACT = {
  version: 1,
  repos: {
    judgeQueues: {
      async: true,
      methods: ["create", "get", "getByLinkedEvalQueue", "listByProjectCursor", "update"],
    },
    judgeQueueGenerations: {
      async: true,
      methods: ["get", "getCurrentAccepting", "createNext", "close", "listByQueueCursor"],
    },
    judgeConfigSnapshots: {
      async: true,
      methods: ["create", "get", "getByJob", "deleteEncryptedPromptBodies", "delete"],
    },
    judgeJobs: {
      async: true,
      methods: [
        "upsertByTrigger",
        "get",
        "getByRunCursor",
        "listByQueueCursor",
        "listByProjectCursor",
        "claimNext",
        "heartbeat",
        "updateFenced",
        "requeueExpiredLeases",
        "releaseClaimNoRetryCharge",
      ],
    },
    judgeAttempts: {
      async: true,
      methods: ["create", "get", "getByJob", "transition"],
    },
    judgeProviderOperations: {
      async: true,
      methods: [
        "create",
        "get",
        "getByLogicalKey",
        "begin",
        "succeed",
        "fail",
        "markUnknown",
        "markInFlightUnknownByAttempt",
        "setAuthoritative",
        "listByAttemptCursor",
      ],
    },
    judgeResultVersions: {
      async: true,
      methods: [
        "createStaging",
        "get",
        "listByRunCursor",
        "listByProjectCursor",
        "listByQueueCursor",
        "transitionPublication",
        "publish",
        "markInvalid",
        "markSuperseded",
        "listForExport",
      ],
    },
    judgeCurrentPointers: {
      async: true,
      methods: ["get", "advance", "listByRun"],
    },
    outboxEvents: {
      async: true,
      methods: ["enqueue", "claimNext", "markDelivered", "releaseLease", "requeueExpiredLeases", "listPendingCursor"],
    },
    idempotencyKeys: {
      async: true,
      methods: ["createIfAbsent", "get", "getReplay", "complete", "deleteExpired"],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Compile-time self-checks — enforced by `npx tsc -p tsconfig.json --noEmit`
// ---------------------------------------------------------------------------

type AnyFunction = (...args: never[]) => unknown;
type Expect<T extends true> = T;
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Method names of an interface (non-function members are ignored). */
type MethodNames<T> = {
  [K in keyof T]: T[K] extends AnyFunction ? K : never;
}[keyof T];

/** true iff every method of T returns a Promise<...> (non-method members pass). */
type IsPromiseReturn<T> = {
  [K in keyof T]: T[K] extends AnyFunction
    ? ReturnType<T[K]> extends Promise<unknown>
      ? true
      : false
    : true;
}[keyof T] extends true
  ? true
  : false;

/** No contract method may return a non-Promise. Combined as a UNION of the
 *  per-repo checks: a failing member contributes `false`, so the union becomes
 *  `boolean` and `Expect<boolean>` fails — an intersection would instead collapse
 *  a failure to `never`, which `Expect` accepts vacuously. */
type _AllRepositoriesReturnPromises = Expect<
  | IsPromiseReturn<JudgeQueueRepository>
  | IsPromiseReturn<JudgeQueueGenerationRepository>
  | IsPromiseReturn<JudgeConfigSnapshotRepository>
  | IsPromiseReturn<JudgeJobRepository>
  | IsPromiseReturn<JudgeAttemptRepository>
  | IsPromiseReturn<JudgeProviderOperationRepository>
  | IsPromiseReturn<JudgeResultVersionRepository>
  | IsPromiseReturn<JudgeCurrentPointerRepository>
  | IsPromiseReturn<OutboxEventRepository>
  | IsPromiseReturn<IdempotencyKeyRepository>
  | IsPromiseReturn<ThemisDb>
  | IsPromiseReturn<ThemisTx>
>;

/** No cursor/page type may expose an `offset` key. Each member is a concrete
 *  conditional (no deferred generics), so a type gaining an `offset` key fails
 *  deterministically. There is no offset pagination type in this contract. */
type _NoOffsetAnywhere = Expect<
  | ("offset" extends keyof KeysetPageRequest ? false : true)
  | ("offset" extends keyof KeysetPage<unknown> ? false : true)
  | ("offset" extends keyof KeysetCursor ? false : true)
  | ("offset" extends keyof CursorCodec ? false : true)
>;

/** The runtime manifest must name exactly the interface methods, so the two
 *  cannot drift. */
type _JudgeQueuesSurface = Expect<IsEqual<MethodNames<JudgeQueueRepository>, (typeof THEMIS_CONTRACT.repos.judgeQueues.methods)[number]>>;
type _JudgeQueueGenerationsSurface = Expect<IsEqual<MethodNames<JudgeQueueGenerationRepository>, (typeof THEMIS_CONTRACT.repos.judgeQueueGenerations.methods)[number]>>;
type _JudgeConfigSnapshotsSurface = Expect<IsEqual<MethodNames<JudgeConfigSnapshotRepository>, (typeof THEMIS_CONTRACT.repos.judgeConfigSnapshots.methods)[number]>>;
type _JudgeJobsSurface = Expect<IsEqual<MethodNames<JudgeJobRepository>, (typeof THEMIS_CONTRACT.repos.judgeJobs.methods)[number]>>;
type _JudgeAttemptsSurface = Expect<IsEqual<MethodNames<JudgeAttemptRepository>, (typeof THEMIS_CONTRACT.repos.judgeAttempts.methods)[number]>>;
type _JudgeProviderOperationsSurface = Expect<IsEqual<MethodNames<JudgeProviderOperationRepository>, (typeof THEMIS_CONTRACT.repos.judgeProviderOperations.methods)[number]>>;
type _JudgeResultVersionsSurface = Expect<IsEqual<MethodNames<JudgeResultVersionRepository>, (typeof THEMIS_CONTRACT.repos.judgeResultVersions.methods)[number]>>;
type _JudgeCurrentPointersSurface = Expect<IsEqual<MethodNames<JudgeCurrentPointerRepository>, (typeof THEMIS_CONTRACT.repos.judgeCurrentPointers.methods)[number]>>;
type _OutboxEventsSurface = Expect<IsEqual<MethodNames<OutboxEventRepository>, (typeof THEMIS_CONTRACT.repos.outboxEvents.methods)[number]>>;
type _IdempotencyKeysSurface = Expect<IsEqual<MethodNames<IdempotencyKeyRepository>, (typeof THEMIS_CONTRACT.repos.idempotencyKeys.methods)[number]>>;

/** The repository accessor keys must match the manifest repo keys exactly. */
type _ThemisReposSurface = Expect<IsEqual<keyof ThemisRepos, keyof typeof THEMIS_CONTRACT.repos>>;

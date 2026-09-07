/**
 * Unified project-pipeline and black-box Phase-2 persistence contracts.
 *
 * Kept separate from the Phase-1 judge repository surface so campaign metadata
 * cannot become a second authority for eval/judge result bytes. Phase-2 rows
 * reference immutable Phase-1 result versions and archive views by id/hash.
 */

export type Phase2Timestamp = string;
export interface Phase2PageRequest { cursor: string | null; limit: number }
export interface Phase2Page<T> { items: readonly T[]; nextCursor: string | null; hasMore: boolean }

export type PipelineQueueStatus = "running" | "paused" | "cancelled";
export type PipelineGenerationState =
  | "draft" | "ready" | "eval_running" | "phase1_running" | "phase2_ready"
  | "phase2_running" | "finalizing" | "completed" | "waiting_retry" | "paused"
  | "failed" | "cancelled";
export type PipelineItemState =
  | "eval_pending" | "eval_running" | "archive_sealed" | "phase1_pending"
  | "phase1_running" | "phase1_published" | "phase2_attached"
  | "final_view_published" | "failed" | "cancelled";

export interface PipelineQueueRow {
  id: string; projectId: string; evalQueueId: string; name: string; status: PipelineQueueStatus;
  revision: number; autoEval: boolean; autoPhase1: boolean; autoPhase2: boolean;
  createdAt: Phase2Timestamp; updatedAt: Phase2Timestamp;
}
export interface PipelineGenerationRow {
  id: string; queueId: string; ordinal: number;
  /** Operator-chosen run name. Null falls back to "Run <ordinal>" in the UI. */
  name: string | null;
  state: PipelineGenerationState;
  fencingToken: number; configJson: string; createdAt: Phase2Timestamp;
  updatedAt: Phase2Timestamp; completedAt: Phase2Timestamp | null;
}
export interface PipelineItemRow {
  id: string; generationId: string; ordinal: number; evalId: string;
  state: PipelineItemState; runId: string | null; baseArchiveId: string | null;
  phase1ResultVersionId: string | null; phase1ArchiveViewId: string | null;
  finalArchiveViewId: string | null; errorKind: string | null;
  errorDetail: string | null; retryCount: number; createdAt: Phase2Timestamp; updatedAt: Phase2Timestamp;
}
export interface PipelineEventRow {
  id: string; generationId: string; itemId: string | null; operationId: string;
  eventType: string; payloadJson: string; createdAt: Phase2Timestamp;
}

export type Phase2CampaignState =
  | "draft" | "frozen" | "analyzing" | "reviewing" | "published"
  | "waiting_retry" | "failed" | "cancelled";
export type Phase2RecordKind =
  | "observation" | "pattern" | "hypothesis" | "research_source"
  | "recommendation" | "experiment_plan" | "external_result" | "decision"
  | "signature_definition" | "signature_alias";

export interface Phase2CampaignRow {
  id: string; projectId: string; pipelineGenerationId: string;
  state: Phase2CampaignState; fencingToken: number; sutFingerprint: string;
  ontologyVersion: string; membershipSha256: string; configJson: string;
  developerPackSha256: string | null; createdAt: Phase2Timestamp;
  updatedAt: Phase2Timestamp; publishedAt: Phase2Timestamp | null;
}
export interface Phase2CampaignMemberRow {
  campaignId: string; pipelineItemId: string; runId: string;
  phase1ResultVersionId: string; phase1ArchiveViewId: string;
  validForAgentLearning: boolean; ordinal: number;
}
export interface Phase2RecordRow {
  id: string; campaignId: string; kind: Phase2RecordKind;
  signature: string | null; owner: string | null; status: string | null;
  sourceOperationId: string; payloadJson: string; createdAt: Phase2Timestamp;
}
export interface Phase2PublicationRow {
  id: string; campaignId: string; runId: string; phase1ArchiveViewId: string;
  finalArchiveViewId: string; manifestSha256: string; state: "preparing" | "verified" | "published" | "invalid";
  createdAt: Phase2Timestamp; publishedAt: Phase2Timestamp | null;
}

export interface CreatePipelineQueueInput {
  projectId: string; evalQueueId: string; name: string; autoEval?: boolean; autoPhase1?: boolean; autoPhase2?: boolean;
}
export interface PipelineQueuePatch {
  status?: PipelineQueueStatus; name?: string; autoEval?: boolean; autoPhase1?: boolean; autoPhase2?: boolean;
}
export interface CreatePipelineGenerationInput { queueId: string; configJson: string; name?: string | null }
export interface AddPipelineItemInput { generationId: string; evalId: string; ordinal: number }
export interface PipelineItemPatch {
  state?: PipelineItemState; runId?: string | null; baseArchiveId?: string | null;
  phase1ResultVersionId?: string | null; phase1ArchiveViewId?: string | null;
  finalArchiveViewId?: string | null; errorKind?: string | null; errorDetail?: string | null; retryCount?: number;
}
export interface CreatePhase2CampaignInput {
  projectId: string; pipelineGenerationId: string; sutFingerprint: string;
  ontologyVersion: string; membershipSha256: string; configJson: string;
}
export interface AddPhase2MemberInput extends Phase2CampaignMemberRow {}
export interface CreatePhase2RecordInput {
  campaignId: string; kind: Phase2RecordKind; signature?: string | null;
  owner?: string | null; status?: string | null; sourceOperationId: string; payloadJson: string;
}

export interface PipelineRepository {
  createQueue(input: CreatePipelineQueueInput): Promise<PipelineQueueRow>;
  getQueue(id: string): Promise<PipelineQueueRow | null>;
  getQueueByProject(projectId: string): Promise<PipelineQueueRow | null>;
  updateQueue(id: string, expectedRevision: number, patch: PipelineQueuePatch): Promise<PipelineQueueRow | null>;
  createGeneration(input: CreatePipelineGenerationInput): Promise<PipelineGenerationRow>;
  getGeneration(id: string): Promise<PipelineGenerationRow | null>;
  getCurrentGeneration(queueId: string): Promise<PipelineGenerationRow | null>;
  /** Every run of one pipeline queue, newest first. */
  listGenerations(queueId: string, req: Phase2PageRequest): Promise<Phase2Page<PipelineGenerationRow>>;
  renameGeneration(id: string, name: string | null): Promise<PipelineGenerationRow | null>;
  transitionGeneration(id: string, expectedState: PipelineGenerationState, expectedToken: number, next: PipelineGenerationState): Promise<PipelineGenerationRow | null>;
  addItem(input: AddPipelineItemInput): Promise<PipelineItemRow>;
  getItem(id: string): Promise<PipelineItemRow | null>;
  listItems(generationId: string, req: Phase2PageRequest): Promise<Phase2Page<PipelineItemRow>>;
  updateItem(id: string, expectedState: PipelineItemState, patch: PipelineItemPatch): Promise<PipelineItemRow | null>;
  appendEvent(input: Omit<PipelineEventRow, "id" | "createdAt">): Promise<{event: PipelineEventRow; created: boolean}>;
  listEvents(generationId: string, req: Phase2PageRequest): Promise<Phase2Page<PipelineEventRow>>;
}

export interface Phase2Repository {
  createCampaign(input: CreatePhase2CampaignInput): Promise<Phase2CampaignRow>;
  getCampaign(id: string): Promise<Phase2CampaignRow | null>;
  getCampaignByGeneration(generationId: string): Promise<Phase2CampaignRow | null>;
  transitionCampaign(id: string, expectedState: Phase2CampaignState, expectedToken: number, next: Phase2CampaignState): Promise<Phase2CampaignRow | null>;
  /** Record the digest of the developer pack this campaign produced. The column
   *  existed from the first migration but nothing ever wrote it, so every
   *  published campaign read back with a null pack digest and a client could not
   *  tell a real pack from a missing one. */
  setCampaignDeveloperPackSha256(id: string, sha256: string): Promise<Phase2CampaignRow | null>;
  addMember(input: AddPhase2MemberInput): Promise<Phase2CampaignMemberRow>;
  listMembers(campaignId: string, req: Phase2PageRequest): Promise<Phase2Page<Phase2CampaignMemberRow>>;
  upsertRecord(input: CreatePhase2RecordInput): Promise<{record: Phase2RecordRow; created: boolean}>;
  listRecords(campaignId: string, kind: Phase2RecordKind | null, req: Phase2PageRequest): Promise<Phase2Page<Phase2RecordRow>>;
  createPublication(input: Omit<Phase2PublicationRow, "id" | "state" | "createdAt" | "publishedAt">): Promise<Phase2PublicationRow>;
  transitionPublication(id: string, expected: Phase2PublicationRow["state"], next: Phase2PublicationRow["state"]): Promise<Phase2PublicationRow | null>;
  listPublications(campaignId: string, req: Phase2PageRequest): Promise<Phase2Page<Phase2PublicationRow>>;
}

export interface Phase2Db {
  pipeline: PipelineRepository;
  phase2: Phase2Repository;
  transaction<T>(fn: (tx: Pick<Phase2Db, "pipeline" | "phase2">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

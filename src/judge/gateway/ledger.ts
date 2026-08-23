/**
 * Provider-operation ledger — row created BEFORE the HTTP call.
 * States: not_started → in_flight → succeeded | failed | unknown.
 */

export type ProviderOpState =
  | "not_started"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ProviderOperationRecord {
  id: string;
  attemptId: string;
  node: string;
  metricOrRole: string;
  round: number | null;
  roundExecutionId: string | null;
  assignmentId: string | null;
  canonicalRequestDigest: string;
  provider: string;
  model: string;
  state: ProviderOpState;
  authoritative: boolean;
  usage: Record<string, unknown> | null;
  error: string | null;
  /** Debug-only; never copy into reports. */
  reasoningContent: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CreateProviderOperationInput {
  attemptId: string;
  node: string;
  metricOrRole: string;
  round?: number | null;
  roundExecutionId?: string | null;
  assignmentId?: string | null;
  canonicalRequestDigest: string;
  provider: string;
  model: string;
}

export interface ProviderOperationLedger {
  create(input: CreateProviderOperationInput): Promise<ProviderOperationRecord>;
  transition(
    id: string,
    from: ProviderOpState,
    to: ProviderOpState,
    patch?: Partial<
      Pick<ProviderOperationRecord, "usage" | "error" | "reasoningContent" | "authoritative">
    >,
  ): Promise<ProviderOperationRecord | null>;
  get(id: string): Promise<ProviderOperationRecord | null>;
}

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `jpo_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** In-memory ledger for tests and single-process workers. */
export class MemoryProviderOperationLedger implements ProviderOperationLedger {
  private readonly rows = new Map<string, ProviderOperationRecord>();

  async create(input: CreateProviderOperationInput): Promise<ProviderOperationRecord> {
    const row: ProviderOperationRecord = {
      id: newId(),
      attemptId: input.attemptId,
      node: input.node,
      metricOrRole: input.metricOrRole,
      round: input.round ?? null,
      roundExecutionId: input.roundExecutionId ?? null,
      assignmentId: input.assignmentId ?? null,
      canonicalRequestDigest: input.canonicalRequestDigest,
      provider: input.provider,
      model: input.model,
      state: "not_started",
      authoritative: false,
      usage: null,
      error: null,
      reasoningContent: null,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async transition(
    id: string,
    from: ProviderOpState,
    to: ProviderOpState,
    patch?: Partial<
      Pick<ProviderOperationRecord, "usage" | "error" | "reasoningContent" | "authoritative">
    >,
  ): Promise<ProviderOperationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.state !== from) return null;
    row.state = to;
    if (to === "in_flight") row.startedAt = now();
    if (to === "succeeded" || to === "failed" || to === "unknown") row.endedAt = now();
    if (patch?.usage !== undefined) row.usage = patch.usage;
    if (patch?.error !== undefined) row.error = patch.error;
    if (patch?.reasoningContent !== undefined) row.reasoningContent = patch.reasoningContent;
    if (patch?.authoritative !== undefined) row.authoritative = patch.authoritative;
    this.rows.set(id, row);
    return { ...row };
  }

  async get(id: string): Promise<ProviderOperationRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
}

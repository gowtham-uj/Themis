/**
 * WP-7 document ledger (minimal): staging docs with same-id/same-hash no-op
 * and same-id/different-hash conflict.
 */

import { createHash } from "node:crypto";

export type DocumentState = "staging" | "committed";

export interface JudgeDocument {
  id: string;
  caseId: string;
  node: string;
  round: number;
  agentId: string;
  sequence: number;
  state: DocumentState;
  contentSha256: string;
  bytes: number;
  body: string;
  createdAt: string;
}

export class DocumentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentConflictError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** In-memory document ledger for staging/commit. */
export class MemoryDocumentLedger {
  private readonly docs = new Map<string, JudgeDocument>();

  /** Stage a document. Same id+hash → no-op; same id different hash → conflict. */
  stage(input: {
    id: string;
    caseId: string;
    node: string;
    round: number;
    agentId: string;
    sequence: number;
    body: string;
  }): { doc: JudgeDocument; created: boolean } {
    const contentSha256 = sha256(input.body);
    const existing = this.docs.get(input.id);
    if (existing) {
      if (existing.contentSha256 === contentSha256) {
        return { doc: existing, created: false };
      }
      throw new DocumentConflictError(
        `document ${input.id} already staged with different hash`,
      );
    }
    const doc: JudgeDocument = {
      id: input.id,
      caseId: input.caseId,
      node: input.node,
      round: input.round,
      agentId: input.agentId,
      sequence: input.sequence,
      state: "staging",
      contentSha256,
      bytes: Buffer.byteLength(input.body, "utf8"),
      body: input.body,
      createdAt: new Date().toISOString(),
    };
    this.docs.set(doc.id, doc);
    return { doc, created: true };
  }

  /** Mark staged docs committed for a round. */
  commit(ids: string[]): void {
    for (const id of ids) {
      const doc = this.docs.get(id);
      if (!doc) throw new Error(`missing document ${id}`);
      if (doc.state !== "staging") continue;
      doc.state = "committed";
    }
  }

  get(id: string): JudgeDocument | null {
    return this.docs.get(id) ?? null;
  }

  listByCase(caseId: string): JudgeDocument[] {
    return [...this.docs.values()]
      .filter((d) => d.caseId === caseId)
      .sort((a, b) => a.sequence - b.sequence);
  }
}

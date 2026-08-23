/**
 * Append-only petition / grant audit log with idempotency keys (plan §6).
 */

export type PetitionDecision = "granted" | "denied" | "pending";

export interface PetitionEvent {
  id: string;
  idempotencyKey: string;
  caseId: string;
  fromAgentId: string;
  kind: "evidence" | "dispatch";
  target: string;
  suspicion: string;
  decision: PetitionDecision;
  reason: string;
  createdAt: string;
}

/** Durable-enough in-process petition log (persist via documents in later wiring). */
export class PetitionLog {
  private readonly byId = new Map<string, PetitionEvent>();
  private readonly byKey = new Map<string, string>();

  /** Append a petition. Same idempotency key returns the original event. */
  petition(input: {
    caseId: string;
    fromAgentId: string;
    kind: "evidence" | "dispatch";
    target: string;
    suspicion: string;
    idempotencyKey: string;
  }): { event: PetitionEvent; created: boolean } {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) {
      return { event: this.byId.get(existingId)!, created: false };
    }
    const event: PetitionEvent = {
      id: `pet_${crypto.randomUUID().replace(/-/g, "")}`,
      idempotencyKey: input.idempotencyKey,
      caseId: input.caseId,
      fromAgentId: input.fromAgentId,
      kind: input.kind,
      target: input.target,
      suspicion: input.suspicion,
      decision: "pending",
      reason: "",
      createdAt: new Date().toISOString(),
    };
    this.byId.set(event.id, event);
    this.byKey.set(input.idempotencyKey, event.id);
    return { event, created: true };
  }

  /** Grant or deny a pending petition (idempotent on final decision). */
  decide(
    petitionId: string,
    decision: "granted" | "denied",
    reason: string,
  ): PetitionEvent {
    const event = this.byId.get(petitionId);
    if (!event) throw new Error(`unknown petition ${petitionId}`);
    if (event.decision !== "pending") return event;
    event.decision = decision;
    event.reason = reason;
    return event;
  }

  list(caseId: string): PetitionEvent[] {
    return [...this.byId.values()]
      .filter((e) => e.caseId === caseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/**
 * Immutable scratchpad chunks with completion-gated cross-reads (plan §6).
 */

import { createHash } from "node:crypto";

export class ScratchpadAccessError extends Error {
  constructor(
    message: string,
    readonly code: "denied_in_progress" | "not_found",
  ) {
    super(message);
    this.name = "ScratchpadAccessError";
  }
}

export interface ScratchpadChunk {
  sequence: number;
  sha256: string;
  body: string;
  writtenAt: string;
}

export interface ScratchpadOwnerState {
  ownerId: string;
  inProgress: boolean;
  chunks: ScratchpadChunk[];
}

/** In-memory scratchpad store for a single case. */
export class ScratchpadStore {
  private readonly owners = new Map<string, ScratchpadOwnerState>();

  /** Ensure an owner row exists. */
  open(ownerId: string): void {
    if (!this.owners.has(ownerId)) {
      this.owners.set(ownerId, { ownerId, inProgress: true, chunks: [] });
    }
  }

  /** Append an immutable chunk; returns new sequence. */
  append(ownerId: string, body: string): ScratchpadChunk {
    this.open(ownerId);
    const owner = this.owners.get(ownerId)!;
    if (!owner.inProgress) {
      throw new ScratchpadAccessError("scratchpad is closed", "denied_in_progress");
    }
    const chunk: ScratchpadChunk = {
      sequence: owner.chunks.length + 1,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      body,
      writtenAt: new Date().toISOString(),
    };
    owner.chunks.push(chunk);
    return chunk;
  }

  /** Mark owner finished so peers may read. */
  complete(ownerId: string): void {
    this.open(ownerId);
    this.owners.get(ownerId)!.inProgress = false;
  }

  /**
   * Read another owner's pad. In-progress owners are DENIED with an explicit
   * error — never an empty successful read.
   */
  read(ownerId: string, readerId: string): ScratchpadChunk[] {
    const owner = this.owners.get(ownerId);
    if (!owner) throw new ScratchpadAccessError(`no scratchpad for ${ownerId}`, "not_found");
    if (owner.inProgress && readerId !== ownerId) {
      throw new ScratchpadAccessError(
        `scratchpad ${ownerId} is still in progress`,
        "denied_in_progress",
      );
    }
    return [...owner.chunks];
  }
}

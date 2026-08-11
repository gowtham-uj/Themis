/** Evidence-linked verification-after-mutation gate for judge context. */

import type { Ref } from "./verdict.js";
import type { RunMetrics } from "../runner/metrics.js";

export interface VerificationGateResult {
  status: "verified" | "unverified" | "unknown";
  refs: Ref[];
  note: string;
}

/** Convert canonical run metrics into a conservative tri-state judge signal. */
export function verificationAfterMutationGate(
  runId: string,
  metrics: RunMetrics,
): VerificationGateResult {
  if (metrics.lastMutationSeq === null) {
    return {
      status: "unknown",
      refs: [],
      note: "No recognized mutation event was present; verification-after-mutation is not applicable or cannot be established.",
    };
  }
  if (metrics.verificationAfterLastMutation === true && metrics.lastVerificationSeq !== null) {
    return {
      status: "verified",
      refs: [
        { kind: "trace", runId, seqs: [metrics.lastMutationSeq, metrics.lastVerificationSeq] },
      ],
      note: "A recognized verification action occurred after the final recognized mutation.",
    };
  }
  if (metrics.ambiguousActionCount > 0) {
    return {
      status: "unknown",
      refs: [{ kind: "trace", runId, seqs: [metrics.lastMutationSeq, metrics.lastMutationSeq] }],
      note: "No recognized verification followed the final mutation, but ambiguous actions prevent a definitive unverified classification.",
    };
  }
  return {
    status: "unverified",
    refs: [{ kind: "trace", runId, seqs: [metrics.lastMutationSeq, metrics.lastMutationSeq] }],
    note: "No recognized verification action occurred after the final recognized mutation.",
  };
}

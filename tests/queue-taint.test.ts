/**
 * Queue-level taint is about shared-container hygiene only.
 * Per-run verifier failures / missing agent evidence must not poison the queue.
 */
import { describe, expect, it } from "vitest";

import { computeQueueWorkspaceTaint } from "../src/runner/queue-worker.ts";

describe("computeQueueWorkspaceTaint", () => {
  it("is clean when reset/cleanup succeeded even if the eval failed scoring", () => {
    // The E2E false positive: missing task/.reaper/logs + reward 0 used to
    // OR into generation taint. Those signals are intentionally absent here.
    expect(
      computeQueueWorkspaceTaint({
        packageCleanupError: null,
        cleanupError: null,
        verificationError: null,
        resetOk: true,
      }),
    ).toBe(false);
  });

  it("taints when workspace reset fails", () => {
    expect(
      computeQueueWorkspaceTaint({
        packageCleanupError: null,
        cleanupError: null,
        verificationError: null,
        resetOk: false,
      }),
    ).toBe(true);
  });

  it("taints when package-cleanup or author cleanup errors", () => {
    expect(
      computeQueueWorkspaceTaint({
        packageCleanupError: "cleanup script exploded",
        cleanupError: null,
        verificationError: null,
        resetOk: true,
      }),
    ).toBe(true);
    expect(
      computeQueueWorkspaceTaint({
        packageCleanupError: null,
        cleanupError: "author cleanup non-zero",
        verificationError: null,
        resetOk: true,
      }),
    ).toBe(true);
    expect(
      computeQueueWorkspaceTaint({
        packageCleanupError: null,
        cleanupError: null,
        verificationError: "verify failed",
        resetOk: true,
      }),
    ).toBe(true);
  });
});

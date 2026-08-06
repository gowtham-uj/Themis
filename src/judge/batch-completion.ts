/**
 * Batch completion — deciding when a release's evals are all done.
 *
 * The release flow is: a tagged commit fires the watcher, which queues one run
 * per eval task. Each run is judged as it finishes (fast feedback). When the
 * LAST run of the batch reaches a terminal state, the whole set is handed to a
 * release-level judge that can see across tasks — recurring defects, capability
 * gaps, regression against the previous release.
 *
 * The hard part is "exactly once". Several runs can finalize concurrently, and
 * each one asks "was I the last?" — without a claim, two of them can both see a
 * complete batch and both trigger the release judge. {@link BatchClaimStore}
 * makes the answer single-winner.
 */

import type { DbQueries, Run } from "../db/queries.js";

/** Terminal run statuses — a batch is done when every run is one of these. */
const TERMINAL = new Set(["completed", "failed", "aborted", "timeout"]);

/** Snapshot of a batch's progress. */
export interface BatchProgress {
  batchId: string;
  total: number;
  terminal: number;
  completed: number;
  failed: number;
  /** True when every run has reached a terminal state. */
  done: boolean;
  runs: Run[];
}

/** Compute a batch's progress from its runs. */
export function batchProgress(runs: readonly Run[], batchId: string): BatchProgress {
  let terminal = 0;
  let completed = 0;
  let failed = 0;
  for (const r of runs) {
    if (!TERMINAL.has(r.status)) continue;
    terminal++;
    if (r.status === "completed") completed++;
    else failed++;
  }
  return {
    batchId,
    total: runs.length,
    terminal,
    completed,
    failed,
    // An empty batch is not "done" — it never started.
    done: runs.length > 0 && terminal === runs.length,
    runs: [...runs],
  };
}

/**
 * Single-winner claim over batch ids.
 *
 * In-process only, which matches the current single-process runner. A
 * multi-process deployment needs this backed by a DB row (an
 * `INSERT ... ON CONFLICT DO NOTHING` on a `batch_judgements` table gives the
 * same single-winner property across processes) — the interface is kept narrow
 * so that swap does not touch callers.
 */
export interface BatchClaimStore {
  /** Returns true for the FIRST caller for this batch, false for the rest. */
  claim(batchId: string): boolean;
  /** Release a claim so it can be re-taken (used when the rollup failed). */
  release(batchId: string): void;
}

/** Default in-memory claim store. */
export function createBatchClaimStore(): BatchClaimStore {
  const claimed = new Set<string>();
  return {
    claim(batchId: string): boolean {
      if (!batchId || claimed.has(batchId)) return false;
      claimed.add(batchId);
      return true;
    },
    release(batchId: string): void {
      claimed.delete(batchId);
    },
  };
}

/**
 * Decide whether this run's finalization completes its batch, claiming the
 * right to run the release rollup if so.
 *
 * Returns the progress when this caller won the claim, or null when the batch
 * is not finished or another caller already claimed it.
 */
export function claimBatchIfComplete(
  queries: DbQueries,
  batchId: string,
  claims: BatchClaimStore,
): BatchProgress | null {
  if (!batchId) return null;
  const runs = queries.listRuns({ batchId });
  const progress = batchProgress(runs, batchId);
  if (!progress.done) return null;
  if (!claims.claim(batchId)) return null;
  return progress;
}

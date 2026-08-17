/**
 * Shared run-status derivation + terminal classification.
 *
 * `deriveRunStatus` maps exit code / fatal-error / timeout / abort signals to a
 * final run status. `isTerminalStatus` classifies a run status as terminal.
 *
 * These were factored out of the removed local run orchestrator so the queue
 * worker and RunController share one definition (plan/adapters.md "Never trust
 * clean exit alone").
 */

import type { RunStatus } from "../schema/events.js";

/** Terminal run statuses (control actions return 409 past these). */
export const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "aborted",
  "timeout",
]);

export function isTerminalStatus(
  status: string | null | undefined,
): boolean {
  return status != null && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Derive run.end.status from exit code, fatal-error, timeout, and abort signals,
 * optionally letting the adapter's own self-reported terminal status win.
 *
 * Priority (plan/adapters.md "Never trust clean exit alone" + plan/execution.md
 * run-control):
 *  1. Operator abort → "aborted" (takes precedence; the operator cut the run short).
 *  2. Wall-clock timeout → "timeout".
 *  3. A fatal error event → "failed" (crash mid-stream), even at exit 0.
 *  4. A non-zero exit code → "failed".
 *  5. Otherwise honor an adapter-reported terminal status if present; else "completed".
 */
export function deriveRunStatus(input: {
  adapterStatus?: RunStatus;
  exitCode: number;
  sawFatalError: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}): RunStatus {
  if (input.aborted) return "aborted";
  if (input.timedOut) return "timeout";
  if (input.sawFatalError) return "failed";
  if (input.exitCode !== 0) return "failed";
  if (input.adapterStatus) return input.adapterStatus;
  return "completed";
}

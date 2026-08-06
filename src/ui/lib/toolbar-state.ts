/**
 * Pure run-control toolbar state — maps run status/control_state → button props.
 * Spec: plan/ui.md §4 Run control toolbar, plan/execution.md §Run control.
 *
 * Separated from the React component so vitest can cover logic without a DOM.
 */

import type { ControlState, RunStatus } from "./api.js";

/** Terminal control / status values where pause/resume no longer apply. */
export const TERMINAL_CONTROL_STATES: ReadonlySet<string> = new Set([
  "aborted",
  "completed",
  "failed",
  "timeout",
  "done",
]);

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "aborted",
  "timeout",
]);

export const PAUSED_CONTROL_STATES: ReadonlySet<string> = new Set([
  "paused-soft",
  "paused-hard",
]);

export interface ToolbarInput {
  status: RunStatus | string;
  controlState?: ControlState | string | null;
  /** Current network-enabled flag (sandbox egress). Default true. */
  networkEnabled?: boolean;
  /** When true, an in-flight control request disables the whole bar. */
  busy?: boolean;
}

export interface ToolbarButtonProps {
  disabled: boolean;
  label: string;
  title?: string;
}

export interface ToolbarViewModel {
  isTerminal: boolean;
  isPaused: boolean;
  isRunning: boolean;
  isAborting: boolean;
  networkEnabled: boolean;
  pauseSoft: ToolbarButtonProps;
  pauseHard: ToolbarButtonProps;
  resume: ToolbarButtonProps;
  abort: ToolbarButtonProps;
  network: ToolbarButtonProps & { enabled: boolean };
}

/**
 * Derive presentational button props from run lifecycle state.
 * Pure: same input always yields the same view model.
 */
export function getToolbarViewModel(input: ToolbarInput): ToolbarViewModel {
  const control = (input.controlState ?? "").toString();
  const status = (input.status ?? "").toString();
  const busy = Boolean(input.busy);
  const networkEnabled = input.networkEnabled !== false;

  const isTerminal =
    TERMINAL_CONTROL_STATES.has(control) ||
    TERMINAL_RUN_STATUSES.has(status) ||
    control === "aborting";

  const isPaused = PAUSED_CONTROL_STATES.has(control) || status === "paused";
  const isAborting = control === "aborting";
  const isRunning =
    !isTerminal &&
    !isPaused &&
    (control === "running" ||
      control === "resuming" ||
      status === "running" ||
      status === "queued" ||
      status === "resuming" ||
      control === "");

  // Pause: only when actively running (not paused, not terminal)
  const canPause = !busy && !isTerminal && !isPaused && !isAborting;
  // Resume: only when paused
  const canResume = !busy && !isTerminal && isPaused;
  // Abort: any non-terminal
  const canAbort = !busy && !isTerminal && !isAborting;
  // Network: live intervention only on non-terminal runs
  const canNetwork = !busy && !isTerminal && !isAborting;

  return {
    isTerminal,
    isPaused,
    isRunning,
    isAborting,
    networkEnabled,
    pauseSoft: {
      disabled: !canPause,
      label: "Pause (soft)",
      title: canPause
        ? "Stop dequeuing new work; in-flight continues"
        : "Pause unavailable in this state",
    },
    pauseHard: {
      disabled: !canPause,
      label: "Pause (hard)",
      title: canPause
        ? "Freeze the sandbox (cgroup freeze / SIGSTOP)"
        : "Pause unavailable in this state",
    },
    resume: {
      disabled: !canResume,
      label: "Resume",
      title: canResume
        ? "Resume a paused run"
        : "Resume only when paused",
    },
    abort: {
      disabled: !canAbort,
      label: "Abort",
      title: canAbort
        ? "Graceful abort; keeps partial logs"
        : "Abort unavailable (terminal or aborting)",
    },
    network: {
      disabled: !canNetwork,
      label: networkEnabled ? "Network: on" : "Network: off",
      title: canNetwork
        ? "Toggle sandbox egress (live cutoff)"
        : "Network control unavailable",
      enabled: networkEnabled,
    },
  };
}

/** True when the run still produces "results so far" (partial). */
export function showResultsSoFarBanner(input: ToolbarInput): boolean {
  const control = (input.controlState ?? "").toString();
  const status = (input.status ?? "").toString();
  if (TERMINAL_RUN_STATUSES.has(status) && status === "aborted") return true;
  if (control === "aborted") return true;
  if (PAUSED_CONTROL_STATES.has(control) || status === "paused") return true;
  if (status === "running" || control === "running" || control === "resuming") {
    return true;
  }
  if (control === "aborting") return true;
  return false;
}

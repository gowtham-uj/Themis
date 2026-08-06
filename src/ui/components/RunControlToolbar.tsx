"use client";

/**
 * Interactive run-control toolbar: Pause (soft/hard), Resume, Abort, network toggle.
 * Spec: plan/ui.md §4. Posts through the typed API client.
 */

import { useCallback, useMemo, useState } from "react";
import type { ControlState, PauseMode, RunStatus } from "../lib/api.js";
import {
  abortRun as defaultAbortRun,
  pauseRun as defaultPauseRun,
  resumeRun as defaultResumeRun,
  setNetwork as defaultSetNetwork,
} from "../lib/api.js";
import {
  getToolbarViewModel,
  showResultsSoFarBanner,
} from "../lib/toolbar-state.js";

export interface RunControlApi {
  pauseRun: (runId: string, mode?: PauseMode) => Promise<unknown>;
  resumeRun: (runId: string) => Promise<unknown>;
  abortRun: (runId: string) => Promise<unknown>;
  setNetwork: (runId: string, enabled: boolean) => Promise<unknown>;
}

export interface RunControlToolbarProps {
  runId: string;
  status: RunStatus | string;
  controlState?: ControlState | string | null;
  networkEnabled?: boolean;
  /** Inject API methods (tests). Defaults to lib/api. */
  api?: Partial<RunControlApi>;
  /** Called after a successful control action with the latest known state. */
  onChanged?: (info: {
    action: "pause" | "resume" | "abort" | "network";
    mode?: PauseMode;
    networkEnabled?: boolean;
  }) => void;
  className?: string;
}

const defaultApi: RunControlApi = {
  pauseRun: defaultPauseRun,
  resumeRun: defaultResumeRun,
  abortRun: defaultAbortRun,
  setNetwork: defaultSetNetwork,
};

export function RunControlToolbar(props: RunControlToolbarProps) {
  const {
    runId,
    status,
    controlState = null,
    networkEnabled: networkProp = true,
    api: apiPartial,
    onChanged,
    className = "",
  } = props;

  const api: RunControlApi = { ...defaultApi, ...apiPartial };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkEnabled, setNetworkEnabled] = useState(networkProp);
  const [pauseMode, setPauseMode] = useState<PauseMode>("soft");

  const vm = useMemo(
    () =>
      getToolbarViewModel({
        status,
        controlState,
        networkEnabled,
        busy,
      }),
    [status, controlState, networkEnabled, busy],
  );

  const showBanner = showResultsSoFarBanner({ status, controlState });

  const runAction = useCallback(
    async (
      action: "pause" | "resume" | "abort" | "network",
      fn: () => Promise<unknown>,
      extra?: { mode?: PauseMode; networkEnabled?: boolean },
    ) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        onChanged?.({ action, ...extra });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  return (
    <div
      className={`rounded-lg border border-slate-700 bg-slate-900/80 p-3 ${className}`}
      data-testid="run-control-toolbar"
      data-terminal={vm.isTerminal ? "1" : "0"}
      data-paused={vm.isPaused ? "1" : "0"}
    >
      {showBanner && (
        <div
          className="mb-2 rounded bg-amber-900/40 px-3 py-2 text-sm text-amber-100"
          data-testid="results-so-far"
        >
          Results so far — status: <strong>{status}</strong>
          {controlState ? (
            <>
              {" "}
              · control: <strong>{controlState}</strong>
            </>
          ) : null}
          {vm.isTerminal ? null : " (partial; still live)"}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-300">
          Pause mode
          <select
            data-testid="pause-mode"
            className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm"
            value={pauseMode}
            disabled={vm.pauseSoft.disabled}
            onChange={(e) => setPauseMode(e.target.value as PauseMode)}
          >
            <option value="soft">soft</option>
            <option value="hard">hard</option>
          </select>
        </label>

        <button
          type="button"
          data-testid="btn-pause"
          className="rounded bg-yellow-700 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          disabled={vm.pauseSoft.disabled}
          title={
            pauseMode === "hard" ? vm.pauseHard.title : vm.pauseSoft.title
          }
          onClick={() =>
            void runAction(
              "pause",
              () => api.pauseRun(runId, pauseMode),
              { mode: pauseMode },
            )
          }
        >
          Pause
        </button>

        <button
          type="button"
          data-testid="btn-resume"
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          disabled={vm.resume.disabled}
          title={vm.resume.title}
          onClick={() =>
            void runAction("resume", () => api.resumeRun(runId))
          }
        >
          Resume
        </button>

        <button
          type="button"
          data-testid="btn-abort"
          className="rounded bg-red-800 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          disabled={vm.abort.disabled}
          title={vm.abort.title}
          onClick={() =>
            void runAction("abort", () => api.abortRun(runId))
          }
        >
          Abort
        </button>

        <button
          type="button"
          data-testid="btn-network"
          className={`rounded px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${
            networkEnabled ? "bg-sky-700" : "bg-slate-600"
          }`}
          disabled={vm.network.disabled}
          title={vm.network.title}
          aria-pressed={!networkEnabled}
          onClick={() => {
            const next = !networkEnabled;
            void runAction(
              "network",
              async () => {
                await api.setNetwork(runId, next);
                setNetworkEnabled(next);
              },
              { networkEnabled: next },
            );
          }}
        >
          {vm.network.label}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-sm text-red-400" data-testid="toolbar-error">
          {error}
        </p>
      )}
    </div>
  );
}

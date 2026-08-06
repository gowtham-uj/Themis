/**
 * Client shell for suite-level release compare.
 * Spec: plan/ui.md §6c Release compare.
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import type { ReleaseCompareApi } from "../../../../../lib/api.js";
import { ApiError, getReleaseCompare } from "../../../../../lib/api.js";

export interface ReleaseCompareViewProps {
  projectId: string;
  initialFrom: string;
  initialTo: string;
  initialData: ReleaseCompareApi | null;
  initialError?: string | null;
}

type SortKey =
  | "taskId"
  | "deltaOverall"
  | "findingsDelta"
  | "presentInBoth";

function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(3);
}

function formatDelta(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3)}`;
}

function formatRate(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function deltaClass(d: number): string {
  if (d > 0) return "text-emerald-300";
  if (d < 0) return "text-red-300";
  return "text-slate-400";
}

function deltaArrow(d: number): string {
  if (d > 0) return "↑";
  if (d < 0) return "↓";
  return "·";
}

/** Per-axis rollup bars. */
function AxisRollup({
  rows,
}: {
  rows: ReleaseCompareApi["perAxisRollup"];
}) {
  if (!rows.length) {
    return <p className="text-sm text-slate-500">No axis data.</p>;
  }
  const maxAbs = Math.max(0.05, ...rows.map((r) => Math.abs(r.delta)));
  return (
    <div className="space-y-2" data-testid="axis-rollup">
      {rows.map((r) => {
        const pct = (Math.abs(r.delta) / maxAbs) * 100;
        const positive = r.delta >= 0;
        return (
          <div
            key={r.axis}
            className="grid grid-cols-[40px_minmax(0,1fr)_90px] items-center gap-2 text-xs"
          >
            <span className="font-mono font-semibold text-slate-300">
              {r.axis}
            </span>
            <div className="relative h-3 overflow-hidden rounded bg-slate-800">
              <div
                className={`absolute top-0 h-full ${
                  positive ? "left-1/2 bg-emerald-500/70" : "right-1/2 bg-red-500/70"
                }`}
                style={{ width: `${pct / 2}%` }}
                title={`from ${r.fromMean.toFixed(3)} → ${r.toMean.toFixed(3)}`}
              />
              <div className="absolute left-1/2 top-0 h-full w-px bg-slate-500" />
            </div>
            <span className={`text-right font-mono ${deltaClass(r.delta)}`}>
              {formatDelta(r.delta)} {deltaArrow(r.delta)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ReleaseCompareView({
  projectId,
  initialFrom,
  initialTo,
  initialData,
  initialError = null,
}: ReleaseCompareViewProps) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [data, setData] = useState<ReleaseCompareApi | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [sortKey, setSortKey] = useState<SortKey>("deltaOverall");
  const [sortAsc, setSortAsc] = useState(true); // default: worst regressors first

  const load = useCallback(
    async (vFrom: string, vTo: string) => {
      const f = vFrom.trim();
      const t = vTo.trim();
      if (!f || !t) {
        setError("Enter both from and to versions (agentCommit or triggerRef).");
        setData(null);
        return;
      }
      if (f === t) {
        setError("from and to must differ.");
        setData(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await getReleaseCompare(projectId, f, t);
        setData(next);
        if (typeof window !== "undefined") {
          const sp = new URLSearchParams({ from: f, to: t });
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}?${sp.toString()}`,
          );
        }
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
        setError(msg);
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  const sortedTasks = useMemo(() => {
    if (!data) return [];
    const rows = [...data.perTaskBreakdown];
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "taskId":
          cmp = a.taskId.localeCompare(b.taskId);
          break;
        case "deltaOverall":
          cmp = a.deltaOverall - b.deltaOverall;
          break;
        case "findingsDelta":
          cmp = a.findingsDelta - b.findingsDelta;
          break;
        case "presentInBoth":
          cmp = Number(a.presentInBoth) - Number(b.presentInBoth);
          break;
        default:
          cmp = 0;
      }
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [data, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      // Default direction: worst first for deltas; asc for taskId.
      setSortAsc(key === "deltaOverall" || key === "findingsDelta");
    }
  }

  function sortIndicator(key: SortKey): string {
    if (sortKey !== key) return "";
    return sortAsc ? " ▲" : " ▼";
  }

  return (
    <div className="space-y-5" data-testid="release-compare-view">
      <div>
        <p className="text-xs text-slate-500">
          <a href={`/projects/${projectId}/tasks`}>Tasks</a>
          {" / compare releases"}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">Release compare</h1>
        <p className="mt-1 text-sm text-slate-400">
          Suite-level progress/regression between two agent versions
          (agentCommit or triggerRef).
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded border border-slate-800 bg-slate-900/40 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load(from, to);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          From version
          <input
            type="text"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-56 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100"
            placeholder="v2.2.0 or commit"
            data-testid="release-from-input"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          To version
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-56 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100"
            placeholder="v2.3.0 or commit"
            data-testid="release-to-input"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          disabled={loading}
        >
          {loading ? "Comparing…" : "Compare releases"}
        </button>
      </form>

      {error && (
        <p
          className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-100"
          data-testid="release-compare-error"
        >
          {error}
        </p>
      )}

      {!data && !loading && !error && (
        <div
          className="rounded border border-dashed border-slate-600 p-8 text-center text-slate-400"
          data-testid="release-compare-empty"
        >
          Pick from/to versions (agent commit or trigger ref) to compare the
          suite.
        </div>
      )}

      {data && (
        <>
          {/* Suite cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div
              className="rounded border border-slate-700 bg-slate-900/60 p-4"
              data-testid="suite-delta-card"
            >
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Suite Δ overall
              </div>
              <div
                className={`mt-1 font-mono text-3xl font-semibold ${deltaClass(data.suiteDelta.deltaOverall)}`}
              >
                {formatDelta(data.suiteDelta.deltaOverall)}{" "}
                <span className="text-lg" aria-hidden="true">
                  {deltaArrow(data.suiteDelta.deltaOverall)}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                ± {formatScore(data.suiteDelta.spread)} spread
              </div>
              <div className="mt-2 text-xs text-slate-400">
                {data.fromVersion || data.from} → {data.toVersion || data.to}
              </div>
              <div className="text-xs text-slate-500">
                tasks: {data.fromTasks} → {data.toTasks}
              </div>
            </div>

            <div className="rounded border border-slate-700 bg-slate-900/60 p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Task outcomes
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                <li className="flex justify-between">
                  <span className="text-emerald-300">↑ Improved</span>
                  <span className="font-mono">{data.suiteDelta.nImproved}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-red-300">↓ Regressed</span>
                  <span className="font-mono">{data.suiteDelta.nRegressed}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-slate-400">· Flat</span>
                  <span className="font-mono">{data.suiteDelta.nFlat}</span>
                </li>
              </ul>
              <p className="mt-2 text-[11px] text-slate-500">
                Counts only tasks present in both releases.
              </p>
            </div>

            <div className="rounded border border-slate-700 bg-slate-900/60 p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Task coverage
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                <li className="flex justify-between">
                  <span className="text-indigo-300">+ New tasks</span>
                  <span className="font-mono">{data.suiteDelta.nNewTasks}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-amber-300">− Removed tasks</span>
                  <span className="font-mono">
                    {data.suiteDelta.nRemovedTasks}
                  </span>
                </li>
              </ul>
              <p className="mt-2 text-[11px] text-slate-500">
                Flagged — not scored in suite Δ.
              </p>
            </div>

            <div className="rounded border border-slate-700 bg-slate-900/60 p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Legend
              </div>
              <ul className="mt-2 space-y-1 text-xs text-slate-400">
                <li>
                  <span className="text-emerald-300">↑ / green</span> = improved
                  (B better)
                </li>
                <li>
                  <span className="text-red-300">↓ / red</span> = regressed (B
                  worse)
                </li>
                <li>
                  <span className="text-slate-400">· / slate</span> = flat
                </li>
                <li>Deltas are always B − A (to − from).</li>
              </ul>
            </div>
          </div>

          {/* Per-axis */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">
              Per-axis rollup (A–H)
            </h2>
            <AxisRollup rows={data.perAxisRollup} />
          </section>

          {/* Finding category deltas */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">
              Finding-category deltas
            </h2>
            {!data.findingCategoryDeltas.length ? (
              <p className="text-sm text-slate-500">No findings across both releases.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="px-2 py-2 font-medium">Category</th>
                      <th className="px-2 py-2 font-medium">Introduced</th>
                      <th className="px-2 py-2 font-medium">Resolved</th>
                      <th className="px-2 py-2 font-medium">Persisted</th>
                      <th className="px-2 py-2 font-medium">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.findingCategoryDeltas.map((row) => (
                      <tr
                        key={row.category}
                        className="border-b border-slate-800"
                      >
                        <td className="px-2 py-1.5 font-mono text-xs text-slate-300">
                          {row.category}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-red-300">
                          +{row.introduced}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-emerald-300">
                          −{row.resolved}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-400">
                          {row.persisted}
                        </td>
                        <td
                          className={`px-2 py-1.5 font-mono ${
                            row.deltaNet > 0
                              ? "text-red-300"
                              : row.deltaNet < 0
                                ? "text-emerald-300"
                                : "text-slate-400"
                          }`}
                        >
                          {row.deltaNet > 0 ? "+" : ""}
                          {row.deltaNet}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Diagnostic rate deltas */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">
              Diagnostic rate deltas
            </h2>
            {!data.diagnosticRateDeltas.length ? (
              <p className="text-sm text-slate-500">No diagnostics recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="px-2 py-2 font-medium">Key</th>
                      <th className="px-2 py-2 font-medium">From rate</th>
                      <th className="px-2 py-2 font-medium">To rate</th>
                      <th className="px-2 py-2 font-medium">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.diagnosticRateDeltas.map((row) => (
                      <tr key={row.key} className="border-b border-slate-800">
                        <td className="px-2 py-1.5 font-mono text-xs text-slate-300">
                          {row.key}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs">
                          {formatRate(row.fromRate)}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs">
                          {formatRate(row.toRate)}
                        </td>
                        <td
                          className={`px-2 py-1.5 font-mono text-xs ${deltaClass(row.delta)}`}
                        >
                          {formatDelta(row.delta)} {deltaArrow(row.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Per-task breakdown */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">
              Per-task breakdown
            </h2>
            <p className="mb-2 text-xs text-slate-500">
              Default sort: worst-regressing tasks first (Δ overall ascending).
              Click a row to open the task trend.
            </p>
            {!sortedTasks.length ? (
              <p className="text-sm text-slate-500">No tasks in either release.</p>
            ) : (
              <div className="overflow-x-auto">
                <table
                  className="w-full border-collapse text-left text-sm"
                  data-testid="per-task-table"
                >
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="px-2 py-2 font-medium">
                        <button
                          type="button"
                          className="hover:text-slate-200"
                          onClick={() => toggleSort("taskId")}
                        >
                          Task{sortIndicator("taskId")}
                        </button>
                      </th>
                      <th className="px-2 py-2 font-medium">
                        <button
                          type="button"
                          className="hover:text-slate-200"
                          onClick={() => toggleSort("deltaOverall")}
                        >
                          Δ overall{sortIndicator("deltaOverall")}
                        </button>
                      </th>
                      <th className="px-2 py-2 font-medium">Per-axis</th>
                      <th className="px-2 py-2 font-medium">
                        <button
                          type="button"
                          className="hover:text-slate-200"
                          onClick={() => toggleSort("findingsDelta")}
                        >
                          Findings Δ{sortIndicator("findingsDelta")}
                        </button>
                      </th>
                      <th className="px-2 py-2 font-medium">
                        <button
                          type="button"
                          className="hover:text-slate-200"
                          onClick={() => toggleSort("presentInBoth")}
                        >
                          In both{sortIndicator("presentInBoth")}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTasks.map((row) => (
                      <tr
                        key={row.taskId}
                        className="cursor-pointer border-b border-slate-800 hover:bg-slate-900/60"
                        onClick={() => {
                          window.location.href = `/projects/${projectId}/trend/${encodeURIComponent(row.taskId)}`;
                        }}
                        data-testid={`task-row-${row.taskId}`}
                      >
                        <td className="px-2 py-1.5 font-mono text-xs">
                          <a
                            href={`/projects/${projectId}/trend/${encodeURIComponent(row.taskId)}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {row.taskId}
                          </a>
                        </td>
                        <td
                          className={`px-2 py-1.5 font-mono text-xs ${deltaClass(row.deltaOverall)}`}
                        >
                          {formatDelta(row.deltaOverall)}{" "}
                          {deltaArrow(row.deltaOverall)}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[11px] text-slate-400">
                          {row.perAxis
                            .map(
                              (a) =>
                                `${a.axis}:${formatDelta(a.delta)}`,
                            )
                            .join(" ")}
                        </td>
                        <td
                          className={`px-2 py-1.5 font-mono text-xs ${
                            row.findingsDelta > 0
                              ? "text-red-300"
                              : row.findingsDelta < 0
                                ? "text-emerald-300"
                                : "text-slate-400"
                          }`}
                        >
                          {row.findingsDelta > 0 ? "+" : ""}
                          {row.findingsDelta}
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {row.presentInBoth ? (
                            <span className="text-slate-300">yes</span>
                          ) : (
                            <span className="text-amber-300">no</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

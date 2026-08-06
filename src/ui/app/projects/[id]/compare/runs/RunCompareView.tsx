/**
 * Client shell for two-run side-by-side compare.
 * Spec: plan/ui.md §6 Two-run side-by-side.
 */

"use client";

import { useCallback, useState } from "react";
import type {
  FindingInstanceApi,
  RunCompareApi,
} from "../../../../../lib/api.js";
import {
  ApiError,
  getRunCompare,
  isLikelyRegression,
} from "../../../../../lib/api.js";
import { RefChips } from "../../../../../components/RefChips.js";

export interface RunCompareViewProps {
  projectId: string;
  initialA: string;
  initialB: string;
  initialData: RunCompareApi | null;
  initialError?: string | null;
}

function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(3);
}

function formatDelta(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(3)}`;
}

function shortId(id: string, n = 10): string {
  if (!id) return "—";
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

function verdictClass(v: string | null | undefined): string {
  switch (v) {
    case "pass":
      return "bg-emerald-900/40 text-emerald-200 border-emerald-700/60";
    case "fail":
      return "bg-red-900/40 text-red-200 border-red-700/60";
    case "partial":
      return "bg-amber-900/40 text-amber-200 border-amber-700/60";
    default:
      return "bg-slate-800 text-slate-300 border-slate-600";
  }
}

function deltaClass(d: number): string {
  if (d > 0) return "text-emerald-300";
  if (d < 0) return "text-red-300";
  return "text-slate-400";
}

function FindingSection({
  projectId,
  title,
  badge,
  badgeClass,
  items,
  runA,
  runB,
}: {
  projectId: string;
  title: string;
  badge: string;
  badgeClass: string;
  items: FindingInstanceApi[];
  runA: string;
  runB: string;
}) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/40 p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
        {title}
        <span
          className={`rounded border px-1.5 py-0.5 font-mono text-xs ${badgeClass}`}
        >
          {badge}
        </span>
      </h3>
      {!items.length ? (
        <p className="text-xs text-slate-500">None.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((f) => (
            <li
              key={f.fingerprint}
              className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-slate-700 px-1 font-mono text-[10px] text-slate-400">
                  {f.category}
                </span>
                <span className="rounded border border-slate-700 px-1 text-[10px] text-slate-500">
                  {f.severity}
                </span>
                <span className="text-slate-200">{f.claim}</span>
              </div>
              <div className="mt-1">
                <RefChips
                  projectId={projectId}
                  runId={f.runId || runB}
                  altRunId={runA !== runB ? runA : undefined}
                  refs={f.refs}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Horizontal bar chart of per-criterion deltas (B − A). */
function CriterionDeltaChart({
  rows,
}: {
  rows: RunCompareApi["perCriterion"];
}) {
  if (!rows.length) {
    return (
      <p className="text-sm text-slate-500">No criterion scores on either side.</p>
    );
  }
  const maxAbs = Math.max(0.05, ...rows.map((r) => Math.abs(r.delta)));
  return (
    <div className="space-y-2" data-testid="criterion-delta-chart">
      {rows.map((r) => {
        const pct = (Math.abs(r.delta) / maxAbs) * 100;
        const positive = r.delta >= 0;
        return (
          <div key={r.criterion} className="grid grid-cols-[minmax(0,1fr)_120px_80px] items-center gap-2 text-xs">
            <div className="min-w-0 truncate font-mono text-slate-300" title={r.criterion}>
              <span className="mr-1 rounded border border-slate-700 px-1 text-[10px] text-slate-500">
                {r.axis}
              </span>
              {r.criterion}
            </div>
            <div className="relative h-3 overflow-hidden rounded bg-slate-800">
              <div
                className={`absolute top-0 h-full ${
                  positive ? "left-1/2 bg-emerald-500/70" : "right-1/2 bg-red-500/70"
                }`}
                style={{ width: `${pct / 2}%` }}
                title={`A=${r.aScore.toFixed(2)} B=${r.bScore.toFixed(2)}`}
              />
              <div className="absolute left-1/2 top-0 h-full w-px bg-slate-500" />
            </div>
            <div className={`text-right font-mono ${deltaClass(r.delta)}`}>
              {formatDelta(r.delta)}
              <span className="ml-1 text-[10px] text-slate-500">
                {r.delta > 0 ? "↑" : r.delta < 0 ? "↓" : "·"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RunCompareView({
  projectId,
  initialA,
  initialB,
  initialData,
  initialError = null,
}: RunCompareViewProps) {
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const [data, setData] = useState<RunCompareApi | null>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const load = useCallback(
    async (runA: string, runB: string) => {
      const aa = runA.trim();
      const bb = runB.trim();
      if (!aa || !bb) {
        setError("Enter both run ids (A and B).");
        setData(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await getRunCompare(projectId, aa, bb);
        setData(next);
        // Sync URL without full navigation.
        if (typeof window !== "undefined") {
          const sp = new URLSearchParams({ a: aa, b: bb });
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

  const delta = data?.deltaOverall ?? null;
  // Without batch spread, treat any non-zero |delta| as "notable"; use 0 noise band.
  const likely =
    delta !== null ? isLikelyRegression(delta, 0) && delta < 0 : false;

  return (
    <div className="space-y-5" data-testid="run-compare-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">
            <a href={`/projects/${projectId}/tasks`}>Tasks</a>
            {" / compare runs"}
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Two-run compare</h1>
          <p className="mt-1 text-sm text-slate-400">
            Side-by-side scores, findings-set diff, and diagnostics (B − A).
          </p>
        </div>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded border border-slate-800 bg-slate-900/40 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load(a, b);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Run A (baseline)
          <input
            type="text"
            value={a}
            onChange={(e) => setA(e.target.value)}
            className="w-56 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100"
            placeholder="run id"
            data-testid="run-a-input"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Run B (candidate)
          <input
            type="text"
            value={b}
            onChange={(e) => setB(e.target.value)}
            className="w-56 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100"
            placeholder="run id"
            data-testid="run-b-input"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          disabled={loading}
        >
          {loading ? "Comparing…" : "Compare"}
        </button>
      </form>

      {error && (
        <p
          className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-100"
          data-testid="run-compare-error"
        >
          {error}
        </p>
      )}

      {!data && !loading && !error && (
        <div className="rounded border border-dashed border-slate-600 p-8 text-center text-slate-400">
          Enter two run ids and click Compare.
        </div>
      )}

      {data && (
        <>
          {/* Provenance header */}
          <div className="grid gap-3 md:grid-cols-2">
            {(["a", "b"] as const).map((side) => {
              const p = data[side];
              return (
                <div
                  key={side}
                  className="rounded border border-slate-800 bg-slate-900/50 p-3"
                  data-testid={`run-provenance-${side}`}
                >
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {side === "a" ? "A — baseline" : "B — candidate"}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <a
                      href={`/projects/${projectId}/runs/${encodeURIComponent(p.runId)}`}
                      className="font-mono"
                    >
                      {shortId(p.runId, 14)}
                    </a>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-xs ${verdictClass(p.verdict)}`}
                    >
                      {p.verdict ?? "—"}
                    </span>
                    <span className="font-mono text-slate-200">
                      {formatScore(p.overallScore)}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-slate-500">
                    {p.agentCommit ? (
                      <div>
                        agentCommit:{" "}
                        <span className="font-mono text-slate-400">
                          {shortId(p.agentCommit, 16)}
                        </span>
                      </div>
                    ) : null}
                    {p.triggerRef ? (
                      <div>
                        triggerRef:{" "}
                        <span className="font-mono text-slate-400">
                          {p.triggerRef}
                        </span>
                      </div>
                    ) : null}
                    <div>
                      judgement:{" "}
                      <span className="font-mono">{shortId(p.judgementId, 12)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Big delta number */}
          <div
            className="rounded border border-slate-700 bg-slate-900/60 p-5 text-center"
            data-testid="delta-overall"
          >
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Δ overall (B − A)
            </div>
            <div
              className={`mt-1 font-mono text-4xl font-semibold ${
                delta === null
                  ? "text-slate-500"
                  : delta < 0
                    ? "text-red-300"
                    : delta > 0
                      ? "text-emerald-300"
                      : "text-slate-300"
              }`}
            >
              {formatDelta(delta)}
              {delta !== null && (
                <span className="ml-2 text-lg" aria-hidden="true">
                  {delta < 0 ? "↓" : delta > 0 ? "↑" : "·"}
                </span>
              )}
            </div>
            {likely && (
              <p className="mt-2 text-sm text-red-200">
                Likely regression: overall score dropped (B worse than A).
              </p>
            )}
            {delta !== null && delta > 0 && (
              <p className="mt-2 text-sm text-emerald-200">
                Progress: overall score improved (B better than A).
              </p>
            )}
            {delta === null && (
              <p className="mt-2 text-sm text-slate-500">
                Overall score unavailable on one or both sides.
              </p>
            )}
          </div>

          {/* Per-criterion */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">
              Per-criterion delta
            </h2>
            <CriterionDeltaChart rows={data.perCriterion} />
          </section>

          {/* Findings set diff */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-200">
              Findings-set diff
            </h2>
            <div className="grid gap-3 lg:grid-cols-3">
              <FindingSection
                projectId={projectId}
                title="Introduced"
                badge={`+${data.findingSetDiff.introduced.length}`}
                badgeClass="border-red-800/50 bg-red-950/40 text-red-200"
                items={data.findingSetDiff.introduced}
                runA={data.a.runId}
                runB={data.b.runId}
              />
              <FindingSection
                projectId={projectId}
                title="Resolved"
                badge={`−${data.findingSetDiff.resolved.length}`}
                badgeClass="border-emerald-800/50 bg-emerald-950/40 text-emerald-200"
                items={data.findingSetDiff.resolved}
                runA={data.a.runId}
                runB={data.b.runId}
              />
              <FindingSection
                projectId={projectId}
                title="Persisted"
                badge={`${data.findingSetDiff.persisted.length}`}
                badgeClass="border-slate-600 bg-slate-800 text-slate-300"
                items={data.findingSetDiff.persisted}
                runA={data.a.runId}
                runB={data.b.runId}
              />
            </div>
          </section>

          {/* Diagnostics */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">
              Diagnostic deltas
            </h2>
            {!data.diagnosticDeltas.length ? (
              <p className="text-sm text-slate-500">No diagnostics on either side.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400">
                      <th className="px-2 py-2 font-medium">Key</th>
                      <th className="px-2 py-2 font-medium">A</th>
                      <th className="px-2 py-2 font-medium">B</th>
                      <th className="px-2 py-2 font-medium">Changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.diagnosticDeltas.map((d) => {
                      const changed = d.a !== d.b;
                      return (
                        <tr
                          key={d.key}
                          className="border-b border-slate-800"
                        >
                          <td className="px-2 py-1.5 font-mono text-xs text-slate-300">
                            {d.key}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-xs">
                            {d.a ? "true ✓" : "false ·"}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-xs">
                            {d.b ? "true ✓" : "false ·"}
                          </td>
                          <td className="px-2 py-1.5 text-xs">
                            {changed ? (
                              <span className="text-amber-300">changed</span>
                            ) : (
                              <span className="text-slate-600">same</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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

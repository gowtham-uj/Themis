/**
 * Client shell for per-task score trend: timeline of overallScore with
 * finding-delta chips and optional batch mean±spread bands.
 * Spec: plan/ui.md §6 Score trend.
 */

"use client";

import { useCallback, useMemo, useState } from "react";
import type { FindingInstanceApi, TrendPointApi } from "../../../../../lib/api.js";
import { getTaskTrend } from "../../../../../lib/api.js";
import { RefChips } from "../../../../../components/RefChips.js";

export interface TrendViewProps {
  projectId: string;
  taskId: string;
  initialPoints: TrendPointApi[];
}

function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(3);
}

function formatTs(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string, n = 8): string {
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

function FindingList({
  projectId,
  title,
  sign,
  items,
}: {
  projectId: string;
  title: string;
  sign: "+" | "-";
  items: FindingInstanceApi[];
}) {
  if (!items.length) return null;
  const signClass =
    sign === "+"
      ? "text-red-300 border-red-800/50 bg-red-950/30"
      : "text-emerald-300 border-emerald-800/50 bg-emerald-950/30";
  return (
    <div className="mt-2">
      <div className="mb-1 text-xs font-medium text-slate-400">
        {title}{" "}
        <span className={`rounded border px-1.5 py-0.5 font-mono ${signClass}`}>
          {sign}
          {items.length}
        </span>
      </div>
      <ul className="space-y-1.5">
        {items.map((f) => (
          <li
            key={f.fingerprint}
            className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-slate-700 px-1 font-mono text-[10px] text-slate-400">
                {f.category}
              </span>
              <span className="text-slate-200">{f.claim}</span>
            </div>
            <div className="mt-1">
              <RefChips
                projectId={projectId}
                runId={f.runId}
                refs={f.refs}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Score trend chart (SVG) with optional error band from batchStats.
 * Accessible: axis labels + numeric list below; never hue alone for deltas.
 */
function TrendChart({ points }: { points: TrendPointApi[] }) {
  const width = 640;
  const height = 180;
  const padL = 40;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const scored = points.filter(
    (p) => p.overallScore !== null && p.overallScore !== undefined,
  );
  if (scored.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">
        No numeric scores to chart yet.
      </div>
    );
  }

  const xs = points.map((_, i) =>
    points.length === 1
      ? padL + innerW / 2
      : padL + (i / (points.length - 1)) * innerW,
  );

  const yOf = (v: number) => padT + (1 - Math.min(1, Math.max(0, v))) * innerH;

  // Mean line through points (nulls skipped in polyline).
  const polyPts = points
    .map((p, i) =>
      p.overallScore === null || p.overallScore === undefined
        ? null
        : `${xs[i]},${yOf(p.overallScore)}`,
    )
    .filter((s): s is string => s !== null)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full max-w-3xl text-slate-100"
      role="img"
      aria-label="Overall score trend across runs"
    >
      {/* axes */}
      <line
        x1={padL}
        y1={padT}
        x2={padL}
        y2={padT + innerH}
        stroke="currentColor"
        strokeOpacity={0.25}
      />
      <line
        x1={padL}
        y1={padT + innerH}
        x2={padL + innerW}
        y2={padT + innerH}
        stroke="currentColor"
        strokeOpacity={0.25}
      />
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line
            x1={padL}
            y1={yOf(t)}
            x2={padL + innerW}
            y2={yOf(t)}
            stroke="currentColor"
            strokeOpacity={0.08}
          />
          <text
            x={padL - 6}
            y={yOf(t) + 3}
            textAnchor="end"
            className="fill-slate-500"
            fontSize={10}
          >
            {t.toFixed(1)}
          </text>
        </g>
      ))}

      {/* error bands for batched points */}
      {points.map((p, i) => {
        if (!p.batchStats || p.batchStats.n < 2) return null;
        const mean = p.batchStats.mean;
        const spread = p.batchStats.spread;
        const y1 = yOf(Math.min(1, mean + spread));
        const y2 = yOf(Math.max(0, mean - spread));
        const x = xs[i] ?? padL;
        return (
          <rect
            key={`band-${i}`}
            x={x - 8}
            y={y1}
            width={16}
            height={Math.max(2, y2 - y1)}
            fill="#6366f1"
            fillOpacity={0.18}
            stroke="#818cf8"
            strokeOpacity={0.4}
            strokeWidth={1}
          >
            <title>
              {`mean ${mean.toFixed(3)} ± ${spread.toFixed(3)} (n=${p.batchStats.n})`}
            </title>
          </rect>
        );
      })}

      {polyPts ? (
        <polyline
          fill="none"
          stroke="#a5b4fc"
          strokeWidth={2}
          points={polyPts}
        />
      ) : null}

      {points.map((p, i) => {
        if (p.overallScore === null || p.overallScore === undefined) return null;
        const x = xs[i] ?? padL;
        const y = yOf(p.overallScore);
        return (
          <g key={p.runId + p.judgementId}>
            <circle cx={x} cy={y} r={4.5} fill="#c7d2fe" stroke="#312e81" strokeWidth={1.5}>
              <title>
                {`#${p.order} score=${formatScore(p.overallScore)} run=${p.runId}`}
              </title>
            </circle>
            <text
              x={x}
              y={padT + innerH + 14}
              textAnchor="middle"
              className="fill-slate-500"
              fontSize={9}
            >
              {p.order}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function TrendView({
  projectId,
  taskId,
  initialPoints,
}: TrendViewProps) {
  const [points, setPoints] = useState<TrendPointApi[]>(initialPoints);
  const [selected, setSelected] = useState<number | null>(
    initialPoints.length ? initialPoints.length - 1 : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getTaskTrend(projectId, taskId);
      setPoints(next);
      setSelected(next.length ? next.length - 1 : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId]);

  const selectedPoint =
    selected !== null && selected >= 0 && selected < points.length
      ? points[selected]
      : null;

  const empty = points.length === 0;

  const summary = useMemo(() => {
    const scores = points
      .map((p) => p.overallScore)
      .filter((s): s is number => s !== null && s !== undefined);
    if (!scores.length) return null;
    const last = scores[scores.length - 1]!;
    const first = scores[0]!;
    return { n: scores.length, first, last, delta: last - first };
  }, [points]);

  return (
    <div className="space-y-4" data-testid="trend-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">
            <a href={`/projects/${projectId}/tasks`}>Tasks</a>
            {" / "}
            <span className="font-mono text-slate-400">{taskId}</span>
            {" / trend"}
          </p>
          <h1 className="mt-1 text-2xl font-semibold">Score trend</h1>
          <p className="mt-1 text-sm text-slate-400">
            Per-task overall score across judged runs, annotated with finding-set
            deltas (introduced / resolved).
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`/projects/${projectId}/tasks`}
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300"
          >
            Back to tasks
          </a>
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-1.5 text-sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-100">
          {error}
        </p>
      )}

      {empty ? (
        <div
          className="rounded border border-dashed border-slate-600 p-10 text-center text-slate-400"
          data-testid="trend-empty"
        >
          No judged runs yet for this task.
        </div>
      ) : (
        <>
          {summary && (
            <div className="flex flex-wrap gap-4 text-sm text-slate-300">
              <span>
                Points: <strong className="text-slate-100">{summary.n}</strong>
              </span>
              <span>
                First → last:{" "}
                <strong className="font-mono text-slate-100">
                  {formatScore(summary.first)} → {formatScore(summary.last)}
                </strong>
              </span>
              <span
                className={
                  summary.delta < 0
                    ? "text-red-300"
                    : summary.delta > 0
                      ? "text-emerald-300"
                      : "text-slate-400"
                }
              >
                Δ {summary.delta >= 0 ? "+" : ""}
                {formatScore(summary.delta)}
                {summary.delta < 0 ? " (↓ worse)" : summary.delta > 0 ? " (↑ better)" : " (flat)"}
              </span>
            </div>
          )}

          <div className="rounded border border-slate-800 bg-slate-900/40 p-3">
            <TrendChart points={points} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400">
                  <th className="px-2 py-2 font-medium">#</th>
                  <th className="px-2 py-2 font-medium">Score</th>
                  <th className="px-2 py-2 font-medium">Verdict</th>
                  <th className="px-2 py-2 font-medium">Findings Δ</th>
                  <th className="px-2 py-2 font-medium">Run</th>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Batch</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => {
                  const intro = p.findingDeltas?.introduced?.length ?? 0;
                  const resolved = p.findingDeltas?.resolved?.length ?? 0;
                  const active = selected === i;
                  return (
                    <tr
                      key={`${p.runId}-${p.judgementId}`}
                      data-testid={`trend-row-${p.order}`}
                      className={`cursor-pointer border-b border-slate-800 ${
                        active ? "bg-indigo-950/40" : "hover:bg-slate-900/60"
                      }`}
                      onClick={() => setSelected(i)}
                    >
                      <td className="px-2 py-2 font-mono text-slate-400">
                        {p.order}
                      </td>
                      <td className="px-2 py-2 font-mono">
                        {formatScore(p.overallScore)}
                        {p.batchStats && p.batchStats.n > 1 ? (
                          <span
                            className="ml-1 text-[11px] text-slate-500"
                            title={`batch mean±spread n=${p.batchStats.n}`}
                          >
                            (μ{formatScore(p.batchStats.mean)}±
                            {formatScore(p.batchStats.spread)})
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-xs ${verdictClass(p.verdict)}`}
                        >
                          {p.verdict ?? "—"}
                        </span>
                      </td>
                      <td className="px-2 py-2 font-mono text-xs">
                        {intro > 0 && (
                          <span className="mr-2 text-red-300" title="introduced">
                            +{intro}
                          </span>
                        )}
                        {resolved > 0 && (
                          <span className="text-emerald-300" title="resolved">
                            −{resolved}
                          </span>
                        )}
                        {intro === 0 && resolved === 0 && (
                          <span className="text-slate-600">0</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <a
                          href={`/projects/${projectId}/runs/${encodeURIComponent(p.runId)}`}
                          className="font-mono text-xs"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {shortId(p.runId)}
                        </a>
                      </td>
                      <td className="px-2 py-2 text-xs text-slate-400">
                        {formatTs(p.createdAt)}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-slate-500">
                        {p.batchId ? shortId(p.batchId) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedPoint && (
            <div
              className="rounded border border-slate-700 bg-slate-900/50 p-4"
              data-testid="trend-point-detail"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-200">
                  Point #{selectedPoint.order} — score{" "}
                  <span className="font-mono">
                    {formatScore(selectedPoint.overallScore)}
                  </span>
                </h2>
                <div className="flex gap-3 text-xs text-slate-400">
                  <a
                    href={`/projects/${projectId}/runs/${encodeURIComponent(selectedPoint.runId)}`}
                  >
                    Run {shortId(selectedPoint.runId, 12)}
                  </a>
                  <span className="font-mono">
                    judgement {shortId(selectedPoint.judgementId, 12)}
                  </span>
                </div>
              </div>
              <FindingList
                projectId={projectId}
                title="Introduced findings"
                sign="+"
                items={selectedPoint.findingDeltas?.introduced ?? []}
              />
              <FindingList
                projectId={projectId}
                title="Resolved findings"
                sign="-"
                items={selectedPoint.findingDeltas?.resolved ?? []}
              />
              {(selectedPoint.findingDeltas?.introduced?.length ?? 0) === 0 &&
                (selectedPoint.findingDeltas?.resolved?.length ?? 0) === 0 && (
                  <p className="mt-2 text-xs text-slate-500">
                    No finding-set change vs previous point.
                  </p>
                )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

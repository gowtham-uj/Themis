"use client";

/**
 * Trace timeline — renders canonical events grouped by turn.
 * Spec: plan/ui.md §4 Trace timeline; plan/event-schema.md.
 */

import { useMemo, useState } from "react";

/** Minimal event shape the timeline needs (compatible with CanonicalEvent). */
export interface TimelineEvent {
  type: string;
  seq: number;
  ts?: string;
  turn?: number;
  text?: string;
  name?: string;
  args?: unknown;
  id?: string;
  output?: unknown;
  isError?: boolean;
  status?: string;
  durationMs?: number;
  argv?: string[] | string;
  host?: string;
  port?: number;
  blocked?: boolean | string;
  [key: string]: unknown;
}

export interface TraceTimelineProps {
  events: TimelineEvent[];
  /** Highlighted / selected seq (deep-link). */
  selectedSeq?: number | null;
  onSelectSeq?: (seq: number) => void;
  className?: string;
}

interface TurnGroup {
  turn: number | "meta";
  events: TimelineEvent[];
}

function groupByTurn(events: TimelineEvent[]): TurnGroup[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const groups = new Map<number | "meta", TimelineEvent[]>();
  for (const ev of sorted) {
    const key =
      ev.turn === undefined ||
      ev.type === "run.start" ||
      ev.type === "run.end" ||
      ev.type === "exec" ||
      ev.type === "net"
        ? ev.turn !== undefined
          ? ev.turn
          : "meta"
        : ev.turn;
    const list = groups.get(key) ?? [];
    list.push(ev);
    groups.set(key, list);
  }
  // Preserve encounter order of keys
  const keys: Array<number | "meta"> = [];
  const seen = new Set<number | "meta">();
  for (const ev of sorted) {
    const key =
      ev.turn === undefined ||
      ev.type === "run.start" ||
      ev.type === "run.end"
        ? ev.turn !== undefined
          ? ev.turn
          : "meta"
        : ev.turn;
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  // Also include any remaining keys
  for (const k of groups.keys()) {
    if (!seen.has(k)) keys.push(k);
  }
  return keys.map((turn) => ({ turn, events: groups.get(turn) ?? [] }));
}

function typeStyle(type: string): string {
  switch (type) {
    case "thinking":
      return "border-slate-600 bg-slate-900/40 text-slate-400";
    case "message":
      return "border-indigo-800 bg-indigo-950/40 text-indigo-100";
    case "tool.call":
      return "border-cyan-800 bg-cyan-950/30 text-cyan-100";
    case "tool.result":
      return "border-teal-900 bg-teal-950/20 text-teal-100";
    case "exec":
      return "border-orange-900 bg-orange-950/30 text-orange-100";
    case "net":
      return "border-rose-900 bg-rose-950/30 text-rose-100";
    case "run.start":
    case "run.end":
      return "border-slate-500 bg-slate-800 text-slate-200";
    default:
      return "border-slate-700 bg-slate-900 text-slate-300";
  }
}

function summarize(ev: TimelineEvent): string {
  switch (ev.type) {
    case "thinking":
    case "message":
      return (ev.text ?? "").slice(0, 240) || "(empty)";
    case "tool.call":
      return `${ev.name ?? "tool"}(${summarizeArgs(ev.args)})`;
    case "tool.result":
      return ev.isError
        ? `error: ${String(ev.output ?? "").slice(0, 160)}`
        : String(ev.output ?? "").slice(0, 160) || "ok";
    case "exec": {
      const argv = Array.isArray(ev.argv)
        ? ev.argv.join(" ")
        : String(ev.argv ?? "");
      return argv.slice(0, 200);
    }
    case "net":
      return `${ev.host ?? "?"}${ev.port != null ? `:${ev.port}` : ""}${
        ev.blocked ? " [blocked]" : ""
      }`;
    case "run.start":
      return `start · ${String(ev.agent ?? "")} / ${String(ev.model ?? "")}`;
    case "run.end":
      return `end · ${ev.status ?? ""} · ${ev.durationMs ?? "?"}ms`;
    default:
      return ev.type;
  }
}

function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(args);
  }
}

export function TraceTimeline({
  events,
  selectedSeq = null,
  onSelectSeq,
  className = "",
}: TraceTimelineProps) {
  const groups = useMemo(() => groupByTurn(events), [events]);
  const [collapsedThinking, setCollapsedThinking] = useState(true);

  if (!events.length) {
    return (
      <div
        className={`rounded border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500 ${className}`}
        data-testid="trace-empty"
      >
        No events yet.
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`} data-testid="trace-timeline">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">
          Trace ({events.length} events)
        </h3>
        <label className="flex items-center gap-1 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={collapsedThinking}
            onChange={(e) => setCollapsedThinking(e.target.checked)}
          />
          Collapse thinking
        </label>
      </div>

      {groups.map((g) => (
        <section
          key={String(g.turn)}
          data-testid={`turn-${g.turn}`}
          className="space-y-1"
        >
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {g.turn === "meta" ? "Run / sandbox" : `Turn ${g.turn}`}
          </h4>
          {g.events.map((ev) => {
            if (ev.type === "thinking" && collapsedThinking) {
              return (
                <button
                  key={ev.seq}
                  type="button"
                  data-testid={`event-${ev.seq}`}
                  data-seq={ev.seq}
                  className={`block w-full rounded border px-2 py-1 text-left text-xs opacity-70 ${typeStyle(
                    ev.type,
                  )} ${selectedSeq === ev.seq ? "ring-2 ring-amber-400" : ""}`}
                  onClick={() => onSelectSeq?.(ev.seq)}
                >
                  <span className="mr-2 font-mono text-slate-500">
                    #{ev.seq}
                  </span>
                  thinking · {(ev.text ?? "").length} chars
                </button>
              );
            }
            return (
              <button
                key={ev.seq}
                type="button"
                data-testid={`event-${ev.seq}`}
                data-seq={ev.seq}
                data-type={ev.type}
                className={`block w-full rounded border px-2 py-1.5 text-left text-xs ${typeStyle(
                  ev.type,
                )} ${selectedSeq === ev.seq ? "ring-2 ring-amber-400" : ""}`}
                onClick={() => onSelectSeq?.(ev.seq)}
              >
                <div className="mb-0.5 flex gap-2 font-mono text-[10px] text-slate-500">
                  <span>#{ev.seq}</span>
                  <span>{ev.type}</span>
                  {ev.ts ? <span>{ev.ts}</span> : null}
                </div>
                <div className="whitespace-pre-wrap break-words">
                  {summarize(ev)}
                </div>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

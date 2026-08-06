/**
 * Pure helpers + presentational status chip for an eval-queue row.
 * The interactive list lives in QueueClient; this module exports the
 * wire-contract helpers the contract tests pin.
 */

"use client";

import type { QueueEntry } from "../lib/api.js";

/** True when the entry is still "live" and the queue page should poll. */
export function isQueueEntryActive(status: string | null | undefined): boolean {
  const s = String(status ?? "").toLowerCase();
  return s === "queued" || s === "promoted" || s === "running";
}

/** Status chip Tailwind classes (colorblind-safe: text label + accent border). */
export function queueStatusColor(status: string | null | undefined): string {
  const s = String(status ?? "queued").toLowerCase();
  switch (s) {
    case "queued":
      return "border-slate-500 bg-slate-800 text-slate-200";
    case "promoted":
      return "border-amber-600 bg-amber-950/50 text-amber-100";
    case "running":
      return "border-emerald-600 bg-emerald-950/40 text-emerald-100";
    case "removed":
      return "border-slate-700 bg-slate-900 text-slate-400";
    case "failed":
      return "border-red-700 bg-red-950/40 text-red-200";
    default:
      return "border-slate-600 bg-slate-800 text-slate-300";
  }
}

/** Human label for a queue status (pinned by contract tests). */
export function queueStatusLabel(status: string | null | undefined): string {
  const s = String(status ?? "queued").toLowerCase();
  if (
    s === "queued" ||
    s === "promoted" ||
    s === "running" ||
    s === "removed" ||
    s === "failed"
  ) {
    return s;
  }
  return s || "queued";
}

/**
 * Format the target column: task id, or tags joined, or a task-set placeholder.
 * Pins the row-ordering label contract for queue lists.
 */
export function formatQueueTarget(
  entry: Pick<QueueEntry, "taskId" | "taskTags" | "targetKind" | "triggerRef"> &
    Record<string, unknown>,
): string {
  if (entry.taskId) return `task:${entry.taskId}`;
  const tags = entry.taskTags;
  if (Array.isArray(tags) && tags.length > 0) {
    return `tags:${tags.join(",")}`;
  }
  const kind = String(entry.targetKind ?? "task_set");
  if (entry.triggerRef) return `${kind}@${entry.triggerRef}`;
  return kind;
}

/**
 * Ordering label shown next to a row: "P{priority} · pos {position}".
 * Server sorts priority DESC then position ASC; the UI mirrors that label.
 */
export function formatQueueOrderLabel(
  entry: Pick<QueueEntry, "priority" | "position">,
): string {
  const p = typeof entry.priority === "number" ? entry.priority : 0;
  const pos = typeof entry.position === "number" ? entry.position : 0;
  return `P${p} · pos ${pos}`;
}

export interface QueueRowProps {
  entry: QueueEntry;
  projectId: string;
  onPromote?: (id: string) => void;
  onRemove?: (id: string) => void;
  onMoveUp?: (id: string) => void;
  onMoveDown?: (id: string) => void;
  busy?: boolean;
}

/** Presentational queue row (optional; QueueClient may inline similar markup). */
export function QueueRow({
  entry,
  projectId,
  onPromote,
  onRemove,
  onMoveUp,
  onMoveDown,
  busy = false,
}: QueueRowProps) {
  const active = isQueueEntryActive(entry.status);
  const runIds = entry.runIds ?? [];

  return (
    <tr
      className="border-b border-slate-800 text-sm"
      data-testid={`queue-row-${entry.id}`}
      data-status={entry.status}
    >
      <td className="px-2 py-2 font-mono text-xs text-slate-300">
        {formatQueueTarget(entry)}
      </td>
      <td className="px-2 py-2">{entry.agentId}</td>
      <td className="px-2 py-2 text-slate-400">{entry.model ?? "—"}</td>
      <td className="px-2 py-2 font-mono text-xs">{entry.triggerRef ?? "—"}</td>
      <td className="px-2 py-2">{entry.repeats ?? 1}</td>
      <td className="px-2 py-2 text-xs text-slate-400">
        {formatQueueOrderLabel(entry)}
      </td>
      <td className="px-2 py-2">
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs ${queueStatusColor(entry.status)}`}
          data-testid="queue-status-chip"
        >
          {queueStatusLabel(entry.status)}
        </span>
      </td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap gap-1">
          {active && onMoveUp && (
            <button
              type="button"
              className="rounded bg-slate-800 px-2 py-0.5 text-xs"
              disabled={busy}
              onClick={() => onMoveUp(entry.id)}
              title="Move up (higher priority / earlier)"
              data-testid="queue-move-up"
            >
              ↑
            </button>
          )}
          {active && onMoveDown && (
            <button
              type="button"
              className="rounded bg-slate-800 px-2 py-0.5 text-xs"
              disabled={busy}
              onClick={() => onMoveDown(entry.id)}
              title="Move down"
              data-testid="queue-move-down"
            >
              ↓
            </button>
          )}
          {entry.status === "queued" && onPromote && (
            <button
              type="button"
              className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white"
              disabled={busy}
              onClick={() => onPromote(entry.id)}
              data-testid="queue-promote"
            >
              Promote
            </button>
          )}
          {entry.status === "queued" && onRemove && (
            <button
              type="button"
              className="rounded bg-slate-700 px-2 py-0.5 text-xs"
              disabled={busy}
              onClick={() => onRemove(entry.id)}
              data-testid="queue-remove"
            >
              Remove
            </button>
          )}
          {runIds.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {runIds.slice(0, 3).map((rid) => (
                <a
                  key={rid}
                  className="text-xs text-indigo-300 underline"
                  href={`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(rid)}`}
                >
                  run
                </a>
              ))}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

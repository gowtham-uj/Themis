/**
 * Client shell for the eval queue: list + add + reorder + promote + drain.
 * Polls lightly while any entry is queued/promoted/running (mirrors RunDetailClient).
 */

"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { CreateQueueEntryBody, QueueEntry } from "../../../../lib/api.js";
import {
  createQueueEntry,
  drainQueue,
  getQueue,
  promoteQueue,
  removeQueueEntry,
  reorderQueueEntry,
} from "../../../../lib/api.js";
import {
  formatQueueOrderLabel,
  formatQueueTarget,
  isQueueEntryActive,
  QueueRow,
  queueStatusColor,
  queueStatusLabel,
} from "../../../../components/QueueRow.js";

export interface QueueClientProps {
  projectId: string;
  initialQueue: QueueEntry[];
}

/** Re-export pure helpers so contract tests can import from this module too. */
export {
  formatQueueOrderLabel,
  formatQueueTarget,
  isQueueEntryActive,
  queueStatusColor,
  queueStatusLabel,
};

/** True when the queue page should keep polling. */
export function shouldPollQueue(entries: QueueEntry[]): boolean {
  return entries.some((e) => isQueueEntryActive(e.status));
}

export function QueueClient({ projectId, initialQueue }: QueueClientProps) {
  const [queue, setQueue] = useState<QueueEntry[]>(initialQueue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [promoteInfo, setPromoteInfo] = useState<string | null>(null);

  // Add form
  const [ref, setRef] = useState("");
  const [taskId, setTaskId] = useState("");
  const [taskTags, setTaskTags] = useState("");
  const [agent, setAgent] = useState("pi");
  const [model, setModel] = useState("claude-sonnet-4-20250514");
  const [repeats, setRepeats] = useState(1);
  const [priority, setPriority] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const rows = await getQueue(projectId);
      setQueue(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  // Light poll while any entry is active (4s, mirrors RunDetailClient).
  const poll = shouldPollQueue(queue);
  useEffect(() => {
    if (!poll) return;
    const timer = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [poll, refresh]);

  const ordered = useMemo(() => {
    // Server already sorts priority DESC, position ASC; keep stable display order.
    return [...queue].sort((a, b) => {
      const dp = (b.priority ?? 0) - (a.priority ?? 0);
      if (dp !== 0) return dp;
      return (a.position ?? 0) - (b.position ?? 0);
    });
  }, [queue]);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: CreateQueueEntryBody = {
        agent,
        model,
        repeats,
        priority,
      };
      if (ref.trim()) body.ref = ref.trim();
      if (taskId.trim()) body.taskId = taskId.trim();
      if (taskTags.trim()) {
        body.taskTags = taskTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      const entry = await createQueueEntry(projectId, body);
      setMessage(`Queued ${entry.id}`);
      setShowAdd(false);
      setTaskId("");
      setTaskTags("");
      setRef("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPromote(entryId: string) {
    setBusy(true);
    setError(null);
    setPromoteInfo(null);
    try {
      const result = await promoteQueue(projectId, entryId);
      const runs = result.runIds?.join(", ") || "(none)";
      setPromoteInfo(
        `Promoted → batch=${result.batchId ?? "—"} runs=[${runs}]`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(entryId: string) {
    if (!confirm("Remove this queue entry before it starts?")) return;
    setBusy(true);
    setError(null);
    try {
      await removeQueueEntry(projectId, entryId);
      await refresh();
      setMessage("Entry removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onMove(entryId: string, direction: "up" | "down") {
    const idx = ordered.findIndex((e) => e.id === entryId);
    if (idx < 0) return;
    const neighbor =
      direction === "up" ? ordered[idx - 1] : ordered[idx + 1];
    if (!neighbor) return;
    setBusy(true);
    setError(null);
    try {
      // Midpoint via before/after relative to the neighbor.
      const body =
        direction === "up"
          ? { before: neighbor.id }
          : { after: neighbor.id };
      await reorderQueueEntry(projectId, entryId, body);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDrain() {
    if (!confirm("Drain all queued entries? Running runs are not touched.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await drainQueue(projectId);
      setMessage(`Drained ${result.removed} entr${result.removed === 1 ? "y" : "ies"}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Eval queue</h1>
          <p className="mt-1 text-sm text-slate-400">
            Pending evals awaiting a runner slot. Promote to start; remove cancels
            before execution.
            {poll && (
              <span className="ml-2 text-emerald-400" data-testid="queue-polling">
                · polling
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-1.5 text-sm"
            disabled={busy}
            onClick={() => void onDrain()}
            data-testid="queue-drain"
          >
            Drain
          </button>
          <button
            type="button"
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
            onClick={() => setShowAdd((v) => !v)}
            data-testid="queue-add-toggle"
          >
            {showAdd ? "Cancel" : "Add to queue"}
          </button>
        </div>
      </div>

      {promoteInfo && (
        <p
          className="rounded border border-emerald-800 bg-emerald-950/30 p-2 text-xs text-emerald-100"
          data-testid="queue-promote-result"
        >
          {promoteInfo}
        </p>
      )}
      {message && (
        <p className="text-sm text-slate-400" data-testid="queue-message">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-400" data-testid="queue-error">
          {error}
        </p>
      )}

      {showAdd && (
        <form
          onSubmit={(e) => void onAdd(e)}
          className="max-w-2xl space-y-3 rounded border border-slate-700 bg-slate-900/40 p-4"
          data-testid="queue-add-form"
        >
          <h2 className="text-lg font-medium">Add to queue</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Ref (optional)
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="v2.3.0"
              />
            </label>
            <label className="block text-sm">
              Task id (optional)
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            Task tags (comma-separated, for task-set)
            <input
              className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
              value={taskTags}
              onChange={(e) => setTaskTags(e.target.value)}
              placeholder="smoke,regression"
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block text-sm">
              Agent
              <input
                required
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Model
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              Priority
              <input
                type="number"
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
              />
            </label>
          </div>
          <label className="block text-sm">
            Repeats
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
              value={repeats}
              onChange={(e) => setRepeats(Number(e.target.value) || 1)}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !agent.trim()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="queue-add-submit"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </form>
      )}

      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="min-w-full text-left text-sm" data-testid="queue-table">
          <thead className="bg-slate-900/80 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-2 py-2">Target</th>
              <th className="px-2 py-2">Agent</th>
              <th className="px-2 py-2">Model</th>
              <th className="px-2 py-2">Ref</th>
              <th className="px-2 py-2">Repeats</th>
              <th className="px-2 py-2">Order</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  Queue is empty.
                </td>
              </tr>
            )}
            {ordered.map((entry) => (
              <QueueRow
                key={entry.id}
                entry={entry}
                projectId={projectId}
                busy={busy}
                onPromote={(id) => void onPromote(id)}
                onRemove={(id) => void onRemove(id)}
                onMoveUp={(id) => void onMove(id, "up")}
                onMoveDown={(id) => void onMove(id, "down")}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import type { Task } from "../../../../../lib/api.js";
import { startRun } from "../../../../../lib/api.js";

export interface NewRunFormProps {
  projectId: string;
  tasks: Task[];
  defaultTaskId?: string;
}

export function NewRunForm({
  projectId,
  tasks,
  defaultTaskId,
}: NewRunFormProps) {
  const [taskId, setTaskId] = useState(defaultTaskId ?? tasks[0]?.id ?? "");
  const [agent, setAgent] = useState("pi");
  const [model, setModel] = useState("claude-sonnet-4-20250514");
  const [provider, setProvider] = useState("anthropic");
  const [repeats, setRepeats] = useState(1);
  const [timeoutMs, setTimeoutMs] = useState(600_000);
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!taskId) {
      setError("Select a task");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { timeoutMs };
      if (reasoningEffort) params.reasoningEffort = reasoningEffort;
      const res = await startRun(projectId, {
        taskId,
        agent,
        model,
        provider,
        repeats,
        params,
      });
      const runId =
        res.id ??
        res.runIds?.[0] ??
        res.runs?.[0]?.id;
      if (runId) {
        window.location.href = `/projects/${projectId}/runs/${encodeURIComponent(runId)}`;
      } else if (res.batchId) {
        // Fall back to project tasks with a message
        window.location.href = `/projects/${projectId}/tasks?started=${encodeURIComponent(res.batchId)}`;
      } else {
        setError("Start returned 202 but no run id — check API response shape.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="max-w-xl space-y-4 rounded border border-slate-700 bg-slate-900/40 p-4"
      data-testid="new-run-form"
    >
      <h1 className="text-2xl font-semibold">Start run</h1>

      <label className="block text-sm">
        Task
        <select
          required
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
        >
          <option value="" disabled>
            Select…
          </option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        Agent
        <select
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="pi">pi</option>
          <option value="reapercode">reapercode</option>
        </select>
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
        Provider
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
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
        <label className="block text-sm">
          Timeout (ms)
          <input
            type="number"
            min={1000}
            className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value) || 0)}
          />
        </label>
      </div>

      <label className="block text-sm">
        Reasoning effort (optional)
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
          value={reasoningEffort}
          onChange={(e) => setReasoningEffort(e.target.value)}
          placeholder="e.g. high"
        />
      </label>

      {error && (
        <p className="text-sm text-red-400" data-testid="new-run-error">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !tasks.length}
        className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        data-testid="start-now"
      >
        {busy ? "Starting…" : "Start now"}
      </button>
    </form>
  );
}

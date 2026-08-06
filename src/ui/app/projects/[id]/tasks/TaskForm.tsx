"use client";

import { useState, type FormEvent } from "react";
import type { AgentCategory, CreateTaskBody, Rubric, Task } from "../../../../lib/api.js";
import { createTask, updateTask } from "../../../../lib/api.js";
import { RubricBuilder, rubricToJsonPayload } from "../../../../components/RubricBuilder.js";

const CATEGORIES: AgentCategory[] = [
  "coding",
  "research",
  "general",
  "browser",
  "data",
  "conversational",
];

const DEFAULT_RUBRIC: Rubric = {
  version: 1,
  profile: "general",
  criteria: [
    {
      id: "A1",
      axis: "A",
      label: "Correctness",
      weight: 1,
      appliesTo: "both",
      anchors: {
        full: "Fully meets the requirement and is verifiable.",
        partial: "Partially meets the requirement.",
        none: "Does not meet the requirement or is harmful.",
      },
    },
  ],
};

export interface TaskFormProps {
  projectId: string;
  initial?: Task | null;
  onDone?: (task: Task) => void;
  onCancel?: () => void;
}

export function TaskForm({ projectId, initial, onDone, onCancel }: TaskFormProps) {
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentCategory, setAgentCategory] = useState<string>(
    initial?.agentCategory ?? "coding",
  );
  const [workspaceSource, setWorkspaceSource] = useState<"empty" | "git">(
    initial?.workspace?.source === "git" ? "git" : "empty",
  );
  const [repo, setRepo] = useState(
    initial?.workspace?.source === "git" ? initial.workspace.repo : "",
  );
  const [ref, setRef] = useState(
    initial?.workspace?.source === "git" ? (initial.workspace.ref ?? "") : "",
  );
  const [rubric, setRubric] = useState<Rubric>(
    initial?.rubric ?? DEFAULT_RUBRIC,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const workspace =
      workspaceSource === "git"
        ? { source: "git" as const, repo, ...(ref ? { ref } : {}) }
        : { source: "empty" as const };
    const { rubric: r, rubric_json } = rubricToJsonPayload({
      ...rubric,
      profile: rubric.profile || "general",
      version: rubric.version || 1,
    });
    const body = {
      name,
      prompt,
      workspace,
      agentCategory,
      profile: r.profile,
      rubric: r,
      rubric_json,
    } satisfies CreateTaskBody;
    try {
      const task = editing && initial
        ? await updateTask(projectId, initial.id, {
            name: body.name,
            prompt: body.prompt,
            workspace: body.workspace,
            agentCategory: body.agentCategory,
            profile: body.profile,
            rubric: r,
            rubric_json: r,
          })
        : await createTask(projectId, body);
      onDone?.(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="space-y-4 rounded border border-slate-700 bg-slate-900/40 p-4"
      data-testid="task-form"
    >
      <h2 className="text-lg font-medium">
        {editing ? "Edit task" : "Create task"}
      </h2>

      <label className="block text-sm">
        Name
        <input
          required
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="block text-sm">
        Prompt
        <textarea
          required
          rows={5}
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2 font-mono text-sm"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>

      <label className="block text-sm">
        Agent category
        <select
          className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
          value={agentCategory}
          onChange={(e) => setAgentCategory(e.target.value)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">Workspace</legend>
        <div className="flex gap-3">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={workspaceSource === "empty"}
              onChange={() => setWorkspaceSource("empty")}
            />
            empty folder
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={workspaceSource === "git"}
              onChange={() => setWorkspaceSource("git")}
            />
            git repo
          </label>
        </div>
        {workspaceSource === "git" && (
          <div className="grid gap-2 md:grid-cols-2">
            <input
              required
              placeholder="owner/repo or url"
              className="rounded border border-slate-600 bg-slate-800 px-3 py-2"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
            <input
              placeholder="ref (optional)"
              className="rounded border border-slate-600 bg-slate-800 px-3 py-2"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </div>
        )}
      </fieldset>

      <RubricBuilder value={rubric} onChange={setRubric} />

      {error && (
        <p className="text-sm text-red-400" data-testid="task-form-error">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : editing ? "Save" : "Create"}
        </button>
        {onCancel && (
          <button
            type="button"
            className="rounded bg-slate-700 px-4 py-2 text-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

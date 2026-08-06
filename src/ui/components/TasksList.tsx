/**
 * Presentational tasks list — renders a sample/API task payload.
 * Spec: plan/ui.md §1 Tasks.
 */

import type { Task } from "../lib/api.js";

export interface TasksListProps {
  tasks: Task[];
  projectId?: string;
  /** Optional row actions (client pages wire these). */
  onEdit?: (task: Task) => void;
  onDelete?: (task: Task) => void;
  onRun?: (task: Task) => void;
  emptyMessage?: string;
  className?: string;
}

function workspaceLabel(task: Task): string {
  const w = task.workspace;
  if (!w) return "—";
  if (w.source === "git") {
    return w.ref ? `${w.repo}@${w.ref}` : w.repo;
  }
  return "empty";
}

export function TasksList(props: TasksListProps) {
  const {
    tasks,
    onEdit,
    onDelete,
    onRun,
    emptyMessage = "No tasks yet. Create one to get started.",
    className = "",
  } = props;

  if (!tasks.length) {
    return (
      <div
        className={`rounded border border-dashed border-slate-600 p-8 text-center text-slate-400 ${className}`}
        data-testid="tasks-list-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`overflow-x-auto ${className}`} data-testid="tasks-list">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700 text-slate-400">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 font-medium">Workspace</th>
            <th className="px-3 py-2 font-medium">Profile</th>
            <th className="px-3 py-2 font-medium">Criteria</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              data-testid={`task-row-${task.id}`}
              className="border-b border-slate-800 hover:bg-slate-900/60"
            >
              <td className="px-3 py-2 font-medium text-slate-100">
                {task.name}
                {task.archived ? (
                  <span className="ml-2 text-xs text-slate-500">(archived)</span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-slate-300">{task.agentCategory}</td>
              <td className="px-3 py-2 font-mono text-xs text-slate-400">
                {workspaceLabel(task)}
              </td>
              <td className="px-3 py-2 text-slate-300">
                {task.profile ?? task.rubric?.profile ?? "—"}
              </td>
              <td className="px-3 py-2 text-slate-300">
                {task.rubric?.criteria?.length ?? 0}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {onRun && (
                    <button
                      type="button"
                      data-testid={`task-run-${task.id}`}
                      className="rounded bg-indigo-700 px-2 py-1 text-xs text-white"
                      onClick={() => onRun(task)}
                    >
                      Run
                    </button>
                  )}
                  {onEdit && (
                    <button
                      type="button"
                      data-testid={`task-edit-${task.id}`}
                      className="rounded bg-slate-700 px-2 py-1 text-xs text-white"
                      onClick={() => onEdit(task)}
                    >
                      Edit
                    </button>
                  )}
                  {onDelete && !task.archived && (
                    <button
                      type="button"
                      data-testid={`task-delete-${task.id}`}
                      className="rounded bg-red-900/80 px-2 py-1 text-xs text-white"
                      onClick={() => onDelete(task)}
                    >
                      Archive
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

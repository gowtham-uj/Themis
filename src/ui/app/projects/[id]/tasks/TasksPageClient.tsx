"use client";

import { useCallback, useState } from "react";
import type { Task } from "../../../../lib/api.js";
import { deleteTask, listTasks, syncTasks } from "../../../../lib/api.js";
import { TasksList } from "../../../../components/TasksList.js";
import { TaskForm } from "./TaskForm.js";

export interface TasksPageClientProps {
  projectId: string;
  initialTasks: Task[];
}

export function TasksPageClient({
  projectId,
  initialTasks,
}: TasksPageClientProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [mode, setMode] = useState<"list" | "create" | "edit">("list");
  const [editing, setEditing] = useState<Task | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await listTasks(projectId);
    setTasks(next);
  }, [projectId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-1.5 text-sm"
            onClick={() => {
              void (async () => {
                try {
                  await syncTasks(projectId);
                  await refresh();
                  setMessage("Synced tasks from project source.");
                } catch (e) {
                  setMessage(
                    e instanceof Error ? e.message : "Sync failed",
                  );
                }
              })();
            }}
          >
            Sync now
          </button>
          <button
            type="button"
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
            onClick={() => {
              setEditing(null);
              setMode("create");
            }}
          >
            New task
          </button>
        </div>
      </div>

      {message && (
        <p className="text-sm text-slate-400" data-testid="tasks-message">
          {message}
        </p>
      )}

      {(mode === "create" || mode === "edit") && (
        <TaskForm
          projectId={projectId}
          initial={editing}
          onCancel={() => {
            setMode("list");
            setEditing(null);
          }}
          onDone={() => {
            setMode("list");
            setEditing(null);
            void refresh();
          }}
        />
      )}

      <TasksList
        tasks={tasks}
        projectId={projectId}
        onEdit={(t) => {
          setEditing(t);
          setMode("edit");
        }}
        onDelete={(t) => {
          void (async () => {
            if (!confirm(`Archive task “${t.name}”?`)) return;
            await deleteTask(projectId, t.id);
            await refresh();
          })();
        }}
        onRun={(t) => {
          window.location.href = `/projects/${projectId}/runs/new?taskId=${encodeURIComponent(t.id)}`;
        }}
      />
    </div>
  );
}

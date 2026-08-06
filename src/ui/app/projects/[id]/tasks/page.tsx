import { listTasks } from "../../../../lib/api.js";
import { TasksPageClient } from "./TasksPageClient.js";

export const dynamic = "force-dynamic";

export default async function TasksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let tasks: Awaited<ReturnType<typeof listTasks>> = [];
  let error: string | null = null;
  try {
    tasks = await listTasks(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          API unavailable ({error}). Showing empty list — create still posts to
          the API.
        </p>
      )}
      <TasksPageClient projectId={id} initialTasks={tasks} />
    </div>
  );
}

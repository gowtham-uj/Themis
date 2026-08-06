import { listTasks } from "../../../../../lib/api.js";
import { NewRunForm } from "./NewRunForm.js";

export const dynamic = "force-dynamic";

export default async function NewRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ taskId?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  let tasks: Awaited<ReturnType<typeof listTasks>> = [];
  try {
    tasks = await listTasks(id);
  } catch {
    tasks = [];
  }

  return (
    <NewRunForm
      projectId={id}
      tasks={tasks}
      defaultTaskId={sp.taskId}
    />
  );
}

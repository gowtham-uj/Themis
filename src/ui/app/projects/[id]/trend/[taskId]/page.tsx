/**
 * Per-task score trend — server-prefetches getTaskTrend.
 * Spec: plan/ui.md §6 Score trend.
 */

import { getTaskTrend, type TrendPointApi } from "../../../../../lib/api.js";
import { TrendView } from "./TrendView.js";

export const dynamic = "force-dynamic";

export default async function TaskTrendPage({
  params,
}: {
  params: Promise<{ id: string; taskId: string }>;
}) {
  const { id, taskId } = await params;
  let points: TrendPointApi[] = [];
  let error: string | null = null;
  try {
    points = await getTaskTrend(id, taskId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          API unavailable ({error}). Trend may be empty until the API is up.
        </p>
      )}
      <TrendView projectId={id} taskId={taskId} initialPoints={points} />
    </div>
  );
}

/**
 * Eval queue page — server-prefetches ordered list; client polls + mutates.
 * Spec: plan/ui.md §2b Eval queue; API: plan/api.md §Eval queue.
 */

import { getQueue, type QueueEntry } from "../../../../lib/api.js";
import { QueueClient } from "./QueueClient.js";

export const dynamic = "force-dynamic";

export default async function QueuePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let queue: QueueEntry[] = [];
  let error: string | null = null;
  try {
    queue = await getQueue(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          API unavailable ({error}). Showing empty list — add still posts to the
          API.
        </p>
      )}
      <QueueClient projectId={id} initialQueue={queue} />
    </div>
  );
}

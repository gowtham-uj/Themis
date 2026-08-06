/**
 * Project watchers tab — server-prefetches rules; client handles CRUD + fire.
 * Spec: plan/ui.md + plan/watcher.md; API: plan/api.md §/watchers.
 */

import { getWatcherRules, type WatcherRule } from "../../../../lib/api.js";
import { WatchersClient } from "./WatchersClient.js";

export const dynamic = "force-dynamic";

export default async function WatchersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let watchers: WatcherRule[] = [];
  let error: string | null = null;
  try {
    watchers = await getWatcherRules(id);
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
      <WatchersClient projectId={id} initialWatchers={watchers} />
    </div>
  );
}

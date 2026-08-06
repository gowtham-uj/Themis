import {
  getRun,
  getRunDiff,
  getRunEventsStream,
} from "../../../../../lib/api.js";
import type { TimelineEvent } from "../../../../../components/TraceTimeline.js";
import { RunDetailClient } from "./RunDetailClient.js";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;

  let run: Awaited<ReturnType<typeof getRun>> | null = null;
  let events: TimelineEvent[] = [];
  let diff = "";

  try {
    run = await getRun(runId);
  } catch {
    run = null;
  }

  try {
    // Initial disk replay via stream (ndjson); client then tails via EventSource.
    for await (const frame of getRunEventsStream(runId, 0, {
      stream: "ndjson",
    })) {
      if (frame.data && typeof frame.data === "object") {
        events.push(frame.data as TimelineEvent);
      }
      if (events.length > 5000) break;
    }
  } catch {
    events = [];
  }

  try {
    diff = await getRunDiff(runId);
  } catch {
    diff = "";
  }

  return (
    <RunDetailClient
      projectId={id}
      runId={runId}
      initialRun={run}
      initialEvents={events}
      initialDiff={diff}
    />
  );
}

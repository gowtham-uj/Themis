"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "../../../../../lib/api.js";
import {
  getRun,
  getRunDiff,
  getRunEventsSSE,
  runEventsUrl,
} from "../../../../../lib/api.js";
import { DiffViewer } from "../../../../../components/DiffViewer.js";
import { RunControlToolbar } from "../../../../../components/RunControlToolbar.js";
import {
  TraceTimeline,
  type TimelineEvent,
} from "../../../../../components/TraceTimeline.js";

export interface RunDetailClientProps {
  projectId: string;
  runId: string;
  initialRun: Run | null;
  initialEvents?: TimelineEvent[];
  initialDiff?: string;
}

function eventSeq(ev: unknown): number | null {
  if (ev && typeof ev === "object" && "seq" in ev) {
    const n = Number((ev as { seq: unknown }).seq);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function RunDetailClient({
  projectId,
  runId,
  initialRun,
  initialEvents = [],
  initialDiff = "",
}: RunDetailClientProps) {
  const [run, setRun] = useState<Run | null>(initialRun);
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  const [diff, setDiff] = useState(initialDiff);
  const [tab, setTab] = useState<"trace" | "diff">("trace");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const lastSeqRef = useRef(
    initialEvents.reduce((m, e) => Math.max(m, e.seq ?? 0), 0),
  );

  const mergeEvent = useCallback((raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const ev = raw as TimelineEvent;
    if (typeof ev.seq !== "number" || !ev.type) return;
    setEvents((prev) => {
      if (prev.some((p) => p.seq === ev.seq)) {
        // replace delta-same-seq message/thinking by appending text if needed
        return prev.map((p) => (p.seq === ev.seq ? { ...p, ...ev } : p));
      }
      const next = [...prev, ev].sort((a, b) => a.seq - b.seq);
      return next;
    });
    if (ev.seq > lastSeqRef.current) lastSeqRef.current = ev.seq;
  }, []);

  // SSE live tail
  useEffect(() => {
    const status = run?.status ?? "";
    const terminal = ["completed", "failed", "aborted", "timeout"].includes(
      status,
    );
    if (terminal) {
      setLive(false);
      return;
    }

    let es: EventSource | null = null;
    let closed = false;

    try {
      es = getRunEventsSSE(runId, lastSeqRef.current || undefined);
      setLive(true);
      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as unknown;
          mergeEvent(data);
        } catch {
          // ignore non-json
        }
      };
      es.addEventListener("event", (msg) => {
        try {
          const data = JSON.parse((msg as MessageEvent).data) as unknown;
          mergeEvent(data);
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        // browser will reconnect; update since via close/reopen if needed
      };
    } catch {
      setLive(false);
    }

    return () => {
      closed = true;
      es?.close();
      void closed;
    };
  }, [runId, run?.status, mergeEvent]);

  // Poll run metadata lightly
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const status = run?.status ?? "";
    const terminal = ["completed", "failed", "aborted", "timeout"].includes(
      status,
    );
    if (terminal) return;
    timer = setInterval(() => {
      void getRun(runId)
        .then((r) => setRun(r))
        .catch(() => undefined);
    }, 4000);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [runId, run?.status]);

  // Refresh diff occasionally while running
  useEffect(() => {
    let cancelled = false;
    void getRunDiff(runId)
      .then((t) => {
        if (!cancelled) setDiff(t);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId, run?.status, events.length]);

  const refreshRun = useCallback(async () => {
    try {
      const r = await getRun(runId);
      setRun(r);
    } catch {
      /* ignore */
    }
  }, [runId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Run {runId.slice(0, 8)}…</h1>
          <p className="text-sm text-slate-400">
            project{" "}
            <a href={`/projects/${projectId}/tasks`}>{projectId}</a>
            {run?.taskId ? (
              <>
                {" "}
                · task <span className="font-mono">{run.taskId}</span>
              </>
            ) : null}
          </p>
          <p className="mt-1 text-sm">
            status: <strong data-testid="run-status">{run?.status ?? "unknown"}</strong>
            {run?.controlState ? (
              <>
                {" "}
                · control:{" "}
                <strong data-testid="run-control-state">
                  {run.controlState}
                </strong>
              </>
            ) : null}
            {live ? (
              <span className="ml-2 rounded bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-200">
                live
              </span>
            ) : null}
          </p>
          <p className="text-xs text-slate-500">
            SSE: {runEventsUrl(runId, { since: lastSeqRef.current || undefined })}
          </p>
        </div>
      </div>

      {run && (
        <RunControlToolbar
          runId={runId}
          status={run.status}
          controlState={run.controlState}
          onChanged={() => {
            void refreshRun();
          }}
        />
      )}

      <div className="flex gap-2 border-b border-slate-800 pb-2 text-sm">
        <button
          type="button"
          className={tab === "trace" ? "font-semibold text-white" : "text-slate-400"}
          onClick={() => setTab("trace")}
        >
          Trace
        </button>
        <button
          type="button"
          className={tab === "diff" ? "font-semibold text-white" : "text-slate-400"}
          onClick={() => setTab("diff")}
        >
          Diff
        </button>
      </div>

      {tab === "trace" ? (
        <TraceTimeline
          events={events}
          selectedSeq={selectedSeq}
          onSelectSeq={setSelectedSeq}
        />
      ) : (
        <DiffViewer patch={diff} />
      )}
    </div>
  );
}

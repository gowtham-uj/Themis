"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "../../../../../lib/api.js";
import {
  ApiError,
  getRun,
  getRunDiff,
  getRunEventsSSE,
  getRunReport,
  runEventsUrl,
  runReportUrl,
} from "../../../../../lib/api.js";
import { ArtifactsPanel } from "../../../../../components/ArtifactsPanel.js";
import { DiffViewer } from "../../../../../components/DiffViewer.js";
import { RunControlToolbar } from "../../../../../components/RunControlToolbar.js";
import {
  TraceTimeline,
  type TimelineEvent,
} from "../../../../../components/TraceTimeline.js";

/** Tabs on the run detail page; also the values `?tab=` accepts. */
type RunTab = "trace" | "diff" | "report" | "artifacts";

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
  // Honor deep-links from ref chips (+ issues/compare views): allow the initial
  // tab + a trace seq-selection to be driven by the URL so a finding's
  // #diff:file:hunk / #trace:start:end / #tool:... link jumps straight to the
  // evidence, not the default Trace tab.
  function tabFromQuery(): RunTab {
    if (typeof window === "undefined") return "trace";
    const q = new URLSearchParams(window.location.search).get("tab");
    return q === "diff" || q === "report" || q === "artifacts" ? q : "trace";
  }
  const [run, setRun] = useState<Run | null>(initialRun);
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  const [diff, setDiff] = useState(initialDiff);
  const [tab, setTab] = useState<RunTab>(tabFromQuery);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);

  // On mount, act on the deep-link hash (#trace:start:end selects that seq range
  // in the Trace tab; #diff:… / #tool:… only need the tab, set above).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    if (hash.startsWith("trace:")) {
      const [, a, b] = hash.split(":");
      const start = Number(a);
      if (Number.isFinite(start)) setSelectedSeq(start);
      setTab("trace");
    } else if (hash.startsWith("diff:")) {
      setTab("diff");
    } else if (hash.startsWith("tool:")) {
      const id = hash.slice("tool:".length);
      // Best-effort: select the event whose tool call matches the id.
      setEvents((prev) => {
        const match = prev.find((e) => {
          if (e.type !== "tool.call") return false;
          const tcId = (e as unknown as { toolCallId?: unknown }).toolCallId;
          return typeof tcId === "string" && tcId === id;
        });
        if (match && typeof match.seq === "number") {
          setSelectedSeq(match.seq);
        }
        return prev;
      });
      setTab("trace");
    } else if (hash.startsWith("artifact:")) {
      setSelectedArtifact(hash.slice("artifact:".length));
      setTab("artifacts");
    }
  }, []);
  const [live, setLive] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
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

  // Lazy-fetch the self-contained verdict report when the Report tab is opened.
  useEffect(() => {
    if (tab !== "report") return;
    let cancelled = false;
    setReportLoading(true);
    setReportError(null);
    setReportHtml(null);
    void getRunReport(runId)
      .then((html) => {
        if (!cancelled) {
          setReportHtml(html);
          setReportLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReportLoading(false);
        if (err instanceof ApiError && err.status === 404) {
          setReportError("No report yet. Run a judgement first.");
        } else {
          const msg =
            err instanceof Error ? err.message : "Failed to load report.";
          setReportError(msg);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab, runId]);

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
        <button
          type="button"
          className={
            tab === "artifacts" ? "font-semibold text-white" : "text-slate-400"
          }
          onClick={() => setTab("artifacts")}
        >
          Artifacts
        </button>
        <button
          type="button"
          className={tab === "report" ? "font-semibold text-white" : "text-slate-400"}
          onClick={() => setTab("report")}
        >
          Report
        </button>
      </div>

      {tab === "trace" ? (
        <TraceTimeline
          events={events}
          selectedSeq={selectedSeq}
          onSelectSeq={setSelectedSeq}
        />
      ) : tab === "diff" ? (
        <DiffViewer patch={diff} />
      ) : tab === "artifacts" ? (
        <ArtifactsPanel runId={runId} selectedPath={selectedArtifact} />
      ) : (
        <div className="space-y-3" data-testid="report-panel">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-slate-300">Verdict report</h2>
            <a
              href={runReportUrl(runId, { download: true })}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800"
            >
              Download report
            </a>
          </div>
          {reportLoading ? (
            <p className="text-sm text-slate-400">Loading report…</p>
          ) : reportError ? (
            <p className="text-sm text-amber-200/90" data-testid="report-error">
              {reportError}
            </p>
          ) : reportHtml ? (
            // sandbox allow-scripts is intentional: report.html is first-party
            // (our XSS-safe validated renderer) and needs scripts for the theme toggle.
            // Do NOT add allow-top-navigation.
            <iframe
              sandbox="allow-scripts allow-same-origin"
              srcDoc={reportHtml}
              title="Verdict report"
              style={{ width: "100%", height: "80vh" }}
              className="rounded border border-slate-800 bg-white"
            />
          ) : (
            <p className="text-sm text-slate-400">No report yet. Run a judgement first.</p>
          )}
        </div>
      )}
    </div>
  );
}

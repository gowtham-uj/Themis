/**
 * Presentational issues log table — durable finding fingerprints backlog.
 * Spec: plan/ui.md §6b Issues / Findings log.
 *
 * Colorblind-safe severity cues (icon + label + color, never hue alone):
 * blocker=red ●, major=amber ▲, minor=blue ■, nit=slate ·
 */

"use client";

import type {
  IssueBatchRecurrence,
  IssueDetail,
  IssueListItem,
  IssueOccurrence,
  IssueRef,
} from "../lib/api.js";

export interface IssuesTableProps {
  issues: IssueListItem[];
  projectId: string;
  /** Expanded fingerprint detail (fetched by the page client). */
  expandedFingerprint?: string | null;
  expandedDetail?: IssueDetail | null;
  expandedLoading?: boolean;
  expandedError?: string | null;
  onToggleExpand?: (fingerprint: string) => void;
  emptyMessage?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Severity / status presentation helpers
// ---------------------------------------------------------------------------

function severityIcon(sev: string | null | undefined): string {
  switch (sev) {
    case "blocker":
      return "●";
    case "major":
      return "▲";
    case "minor":
      return "■";
    case "nit":
      return "·";
    default:
      return "○";
  }
}

function severityClass(sev: string | null | undefined): string {
  switch (sev) {
    case "blocker":
      return "text-red-400";
    case "major":
      return "text-amber-400";
    case "minor":
      return "text-blue-400";
    case "nit":
      return "text-slate-400";
    default:
      return "text-slate-500";
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "open":
      return "bg-amber-900/40 text-amber-200 border-amber-700/60";
    case "resolved":
      return "bg-emerald-900/40 text-emerald-200 border-emerald-700/60";
    case "regressed":
      return "bg-red-900/40 text-red-200 border-red-700/60";
    case "wontfix":
      return "bg-slate-800 text-slate-300 border-slate-600";
    default:
      return "bg-slate-800 text-slate-300 border-slate-600";
  }
}

function kindClass(kind: string): string {
  switch (kind) {
    case "defect":
      return "bg-red-950/50 text-red-200 border-red-800/50";
    case "positive":
      return "bg-emerald-950/50 text-emerald-200 border-emerald-800/50";
    case "meta":
      return "bg-violet-950/50 text-violet-200 border-violet-800/50";
    default:
      return "bg-slate-800 text-slate-300 border-slate-600";
  }
}

function truncate(s: string, n = 96): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Absolute short form; relative would need a live clock.
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return "—";
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

/** Access ref fields without fighting the discriminated union. */
function refField(ref: IssueRef, key: string): unknown {
  return (ref as Record<string, unknown>)[key];
}

function refHref(ref: IssueRef): string {
  const kind = String(ref.kind ?? "ref");
  if (kind === "diff") {
    const file = String(refField(ref, "file") ?? "");
    const hunk = Number(refField(ref, "hunk") ?? 0);
    return `#diff:${file}:${hunk}`;
  }
  if (kind === "trace") {
    const runId = String(refField(ref, "runId") ?? "");
    const seqs =
      (refField(ref, "seqs") as [number, number] | undefined) ?? [0, 0];
    return `#trace:${runId}:${seqs[0]}:${seqs[1]}`;
  }
  if (kind === "tool") {
    return `#tool:${String(refField(ref, "toolCallId") ?? "")}`;
  }
  if (kind === "artifact") {
    return `#artifact:${String(refField(ref, "path") ?? "")}`;
  }
  return `#ref:${kind}`;
}

function refLabel(ref: IssueRef): string {
  const kind = String(ref.kind ?? "ref");
  if (kind === "diff") {
    const file = String(refField(ref, "file") ?? "?");
    const hunk = refField(ref, "hunk") ?? "?";
    const lines = refField(ref, "lines") as [number, number] | undefined;
    if (lines) return `${file} hunk ${hunk} L${lines[0]}–${lines[1]}`;
    return `${file} hunk ${hunk}`;
  }
  if (kind === "trace") {
    const seqs =
      (refField(ref, "seqs") as [number, number] | undefined) ?? [0, 0];
    return `trace seq ${seqs[0]}–${seqs[1]}`;
  }
  if (kind === "tool") {
    return `tool call ${String(refField(ref, "toolCallId") ?? "")}`;
  }
  if (kind === "artifact") {
    return `artifact ${String(refField(ref, "path") ?? "?")}`;
  }
  return kind;
}

function batchBadge(row: IssueBatchRecurrence): {
  label: string;
  className: string;
} {
  const { k, n } = row;
  const label = `${k}/${n}`;
  // Real (stable) when k === n and n > 1; flaky when 0 < k < n.
  if (n > 0 && k === n) {
    return {
      label,
      className: "bg-red-900/50 text-red-100 border-red-700/60",
    };
  }
  if (k > 0 && k < n) {
    return {
      label,
      className: "bg-amber-900/40 text-amber-100 border-amber-700/50",
    };
  }
  return {
    label,
    className: "bg-slate-800 text-slate-300 border-slate-600",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IssuesTable(props: IssuesTableProps) {
  const {
    issues,
    projectId,
    expandedFingerprint = null,
    expandedDetail = null,
    expandedLoading = false,
    expandedError = null,
    onToggleExpand,
    emptyMessage = "No findings yet. Run + judge some tasks to populate the issues log.",
    className = "",
  } = props;

  if (!issues.length) {
    return (
      <div
        className={`rounded border border-dashed border-slate-600 p-8 text-center text-slate-400 ${className}`}
        data-testid="issues-list-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={`overflow-x-auto ${className}`} data-testid="issues-list">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700 text-slate-400">
            <th className="px-3 py-2 font-medium">Category</th>
            <th className="px-3 py-2 font-medium">Severity</th>
            <th className="px-3 py-2 font-medium">Claim</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">×</th>
            <th className="px-3 py-2 font-medium">Recurrence</th>
            <th className="px-3 py-2 font-medium">First seen</th>
            <th className="px-3 py-2 font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => {
            const expanded = expandedFingerprint === issue.fingerprint;
            const rec = issue.recurrence;
            return (
              <IssueRow
                key={issue.fingerprint}
                issue={issue}
                projectId={projectId}
                expanded={expanded}
                detail={expanded ? expandedDetail : null}
                loading={expanded ? expandedLoading : false}
                error={expanded ? expandedError : null}
                recurrenceLabel={
                  rec
                    ? `${shortId(rec.firstSeenRunId)} → ${shortId(rec.lastSeenRunId)}${
                        rec.count != null ? ` (${rec.count}×)` : ""
                      }`
                    : shortId(issue.firstSeenJudgement)
                }
                onToggle={() => onToggleExpand?.(issue.fingerprint)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface IssueRowProps {
  issue: IssueListItem;
  projectId: string;
  expanded: boolean;
  detail: IssueDetail | null;
  loading: boolean;
  error: string | null;
  recurrenceLabel: string;
  onToggle: () => void;
}

function IssueRow({
  issue,
  projectId,
  expanded,
  detail,
  loading,
  error,
  recurrenceLabel,
  onToggle,
}: IssueRowProps) {
  const sev = issue.latestSeverity;
  return (
    <>
      <tr
        data-testid={`issue-row-${issue.fingerprint}`}
        data-fingerprint={issue.fingerprint}
        className="cursor-pointer border-b border-slate-800 hover:bg-slate-900/60"
        onClick={onToggle}
      >
        <td className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex rounded border px-1.5 py-0.5 text-xs ${kindClass(String(issue.kind))}`}
              data-testid="issue-kind"
            >
              {issue.kind}
            </span>
            <span className="font-mono text-xs text-slate-300">
              {issue.category}
            </span>
          </div>
        </td>
        <td className="px-3 py-2">
          {sev ? (
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${severityClass(sev)}`}
              data-testid="issue-severity"
              data-severity={sev}
            >
              <span aria-hidden="true">{severityIcon(sev)}</span>
              <span>{sev}</span>
            </span>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </td>
        <td
          className="max-w-md px-3 py-2 text-slate-100"
          title={issue.claim}
          data-testid="issue-claim"
        >
          {truncate(issue.claim)}
        </td>
        <td className="px-3 py-2">
          <span
            className={`inline-flex rounded border px-1.5 py-0.5 text-xs capitalize ${statusClass(String(issue.status))}`}
            data-testid="issue-status"
          >
            {issue.status}
          </span>
        </td>
        <td
          className="px-3 py-2 font-mono text-xs text-slate-300"
          data-testid="issue-count"
        >
          {issue.occurrenceCount}
        </td>
        <td
          className="px-3 py-2 font-mono text-xs text-slate-400"
          data-testid="issue-recurrence"
          title={recurrenceLabel}
        >
          {recurrenceLabel}
        </td>
        <td className="px-3 py-2 text-xs text-slate-400">
          {formatTs(issue.firstSeenAt)}
        </td>
        <td className="px-3 py-2 text-xs text-slate-400">
          {formatTs(issue.lastSeenAt)}
        </td>
      </tr>
      {expanded && (
        <tr
          data-testid={`issue-detail-${issue.fingerprint}`}
          className="border-b border-slate-800 bg-slate-900/40"
        >
          <td colSpan={8} className="px-4 py-3">
            <IssueDetailPanel
              projectId={projectId}
              fingerprint={issue.fingerprint}
              detail={detail}
              loading={loading}
              error={error}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function IssueDetailPanel({
  projectId,
  fingerprint,
  detail,
  loading,
  error,
}: {
  projectId: string;
  fingerprint: string;
  detail: IssueDetail | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <p className="text-sm text-slate-400" data-testid="issue-detail-loading">
        Loading lifecycle detail…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-sm text-amber-200" data-testid="issue-detail-error">
        {error}
      </p>
    );
  }
  if (!detail) {
    return (
      <p className="text-sm text-slate-500">No detail available.</p>
    );
  }

  const { finding, recurrence, kByBatch } = detail;
  const occurrences = finding.occurrences ?? [];

  return (
    <div className="space-y-3 text-sm" data-testid="issue-detail-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-100">{finding.claim}</p>
          <p className="mt-1 font-mono text-xs text-slate-500">
            fingerprint {fingerprint.slice(0, 16)}…
            {" · "}
            task {shortId(finding.taskId, 12)}
            {" · "}
            project {shortId(projectId, 12)}
          </p>
        </div>
        <div className="text-xs text-slate-400">
          runs {shortId(recurrence.firstSeenRunId)} →{" "}
          {shortId(recurrence.lastSeenRunId)}
          {recurrence.count != null ? ` · ${recurrence.count}×` : null}
        </div>
      </div>

      {kByBatch.length > 0 && (
        <div data-testid="issue-k-by-batch">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
            Recurrence by batch (k/N)
          </p>
          <div className="flex flex-wrap gap-1.5">
            {kByBatch.map((row) => {
              const badge = batchBadge(row);
              const real = row.n > 1 && row.k === row.n;
              const flaky = row.k > 0 && row.k < row.n;
              return (
                <span
                  key={row.batchId}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-xs ${badge.className}`}
                  title={`batch ${row.batchId}: ${row.k}/${row.n}${real ? " (real)" : flaky ? " (flaky)" : ""}`}
                  data-testid={`batch-kn-${row.batchId}`}
                >
                  {badge.label}
                  {real ? (
                    <span className="text-[10px] uppercase opacity-80">
                      real
                    </span>
                  ) : null}
                  {flaky ? (
                    <span className="text-[10px] uppercase opacity-80">
                      flaky
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Occurrences ({occurrences.length})
        </p>
        {occurrences.length === 0 ? (
          <p className="text-xs text-slate-500">No occurrences recorded.</p>
        ) : (
          <ul className="space-y-2">
            {occurrences.map((occ) => (
              <OccurrenceCard key={occ.id} occ={occ} projectId={projectId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function OccurrenceCard({
  occ,
  projectId,
}: {
  occ: IssueOccurrence;
  projectId: string;
}) {
  const refs = occ.refs ?? [];
  return (
    <li
      className="rounded border border-slate-700/80 bg-slate-950/40 p-2"
      data-testid={`occurrence-${occ.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`font-medium ${severityClass(String(occ.severity))}`}>
          <span aria-hidden="true">{severityIcon(String(occ.severity))}</span>{" "}
          {occ.severity}
        </span>
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300">
          {occ.status}
        </span>
        <a
          href={`/projects/${projectId}/runs/${encodeURIComponent(occ.runId)}`}
          className="font-mono text-indigo-300"
          onClick={(e) => e.stopPropagation()}
        >
          run {shortId(occ.runId, 10)}
        </a>
        <span className="text-slate-500">{formatTs(occ.createdAt)}</span>
      </div>
      {occ.claim ? (
        <p className="mt-1 text-slate-200">{occ.claim}</p>
      ) : null}
      {occ.fix?.direction ? (
        <p className="mt-1 text-xs text-slate-400">
          Fix: {occ.fix.direction}
          {occ.fix.repro?.command ? (
            <code className="ml-1 rounded bg-slate-800 px-1 font-mono text-[11px]">
              {occ.fix.repro.command}
            </code>
          ) : null}
        </p>
      ) : null}
      {refs.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1" data-testid="ref-chips">
          {refs.map((ref, i) => (
            <li key={`${ref.kind}-${i}`}>
              <a
                className="inline-flex rounded border border-slate-600 bg-slate-800/80 px-1.5 py-0.5 font-mono text-[11px] text-indigo-200 hover:bg-slate-700"
                href={refHref(ref)}
                data-ref-kind={String(ref.kind)}
                onClick={(e) => e.stopPropagation()}
              >
                {refLabel(ref)}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

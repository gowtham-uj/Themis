/**
 * Client shell for the project issues log: filter controls + expandable table.
 * Filters are query-param driven (?status=open&severity=blocker&category=…).
 * Spec: plan/ui.md §6b.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IssueDetail,
  IssueListItem,
  ListIssuesOptions,
} from "../../../../lib/api.js";
import { getIssue, listIssues } from "../../../../lib/api.js";
import { IssuesTable } from "../../../../components/IssuesTable.js";

export interface IssuesPageClientProps {
  projectId: string;
  initialIssues: IssueListItem[];
  /** Initial filter values from the server URL search params. */
  initialFilters?: ListIssuesOptions;
}

const STATUS_OPTIONS = ["", "open", "resolved", "regressed", "wontfix"] as const;
const SEVERITY_OPTIONS = ["", "blocker", "major", "minor", "nit"] as const;
const KIND_OPTIONS = ["", "defect", "positive", "meta"] as const;

/**
 * Sort so recurrent findings surface first (occurrenceCount desc, then
 * lastSeenAt desc). Noise does not masquerade as the backlog.
 */
export function sortIssuesForBacklog(issues: IssueListItem[]): IssueListItem[] {
  return [...issues].sort((a, b) => {
    const dc = (b.occurrenceCount ?? 0) - (a.occurrenceCount ?? 0);
    if (dc !== 0) return dc;
    const ta = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0;
    const tb = b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0;
    return tb - ta;
  });
}

function readFiltersFromLocation(): ListIssuesOptions {
  if (typeof window === "undefined") return {};
  const sp = new URLSearchParams(window.location.search);
  const out: ListIssuesOptions = {};
  const status = sp.get("status");
  const category = sp.get("category");
  const task = sp.get("task");
  const kind = sp.get("kind");
  const severity = sp.get("severity");
  if (status) out.status = status;
  if (category) out.category = category;
  if (task) out.task = task;
  if (kind) out.kind = kind;
  if (severity) out.severity = severity;
  return out;
}

function writeFiltersToLocation(filters: ListIssuesOptions): void {
  if (typeof window === "undefined") return;
  const sp = new URLSearchParams();
  if (filters.status) sp.set("status", String(filters.status));
  if (filters.category) sp.set("category", filters.category);
  if (filters.task) sp.set("task", filters.task);
  if (filters.kind) sp.set("kind", String(filters.kind));
  if (filters.severity) sp.set("severity", String(filters.severity));
  const qs = sp.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  window.history.replaceState(null, "", next);
}

export function IssuesPageClient({
  projectId,
  initialIssues,
  initialFilters = {},
}: IssuesPageClientProps) {
  const [filters, setFilters] = useState<ListIssuesOptions>(() => ({
    ...initialFilters,
    ...(typeof window !== "undefined" ? readFiltersFromLocation() : {}),
  }));
  const [issues, setIssues] = useState<IssueListItem[]>(() =>
    sortIssuesForBacklog(initialIssues),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Skip the first filter-effect run so the server-prefetched list is not
  // immediately re-fetched on mount.
  const skipFirstFilterEffect = useRef(true);

  const [expandedFingerprint, setExpandedFingerprint] = useState<string | null>(
    null,
  );
  const [expandedDetail, setExpandedDetail] = useState<IssueDetail | null>(
    null,
  );
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const refresh = useCallback(
    async (next: ListIssuesOptions) => {
      setLoading(true);
      setError(null);
      try {
        const rows = await listIssues(projectId, next);
        setIssues(sortIssuesForBacklog(rows));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  // Apply filter changes: sync URL + re-fetch (after first mount).
  useEffect(() => {
    writeFiltersToLocation(filters);
    if (skipFirstFilterEffect.current) {
      skipFirstFilterEffect.current = false;
      return;
    }
    void refresh(filters);
    // Intentionally depend on discrete filter fields, not the filters object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.status,
    filters.category,
    filters.task,
    filters.kind,
    filters.severity,
    projectId,
    refresh,
  ]);

  const onToggleExpand = useCallback(
    (fingerprint: string) => {
      if (expandedFingerprint === fingerprint) {
        setExpandedFingerprint(null);
        setExpandedDetail(null);
        setExpandedError(null);
        return;
      }
      setExpandedFingerprint(fingerprint);
      setExpandedDetail(null);
      setExpandedError(null);
      setExpandedLoading(true);
      void getIssue(projectId, fingerprint)
        .then((d) => {
          setExpandedDetail(d);
        })
        .catch((e) => {
          setExpandedError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setExpandedLoading(false));
    },
    [expandedFingerprint, projectId],
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const i of issues) {
      if (i.category) set.add(i.category);
    }
    // Keep previously selected category visible even if not in current page.
    if (filters.category) set.add(filters.category);
    return Array.from(set).sort();
  }, [issues, filters.category]);

  const setFilter = <K extends keyof ListIssuesOptions>(
    key: K,
    value: ListIssuesOptions[K] | "",
  ) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (!value) {
        delete next[key];
      } else {
        next[key] = value as ListIssuesOptions[K];
      }
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Issues</h1>
          <p className="mt-1 text-sm text-slate-400">
            Durable findings log — fingerprints, severity, recurrence (k/N).
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-slate-700 px-3 py-1.5 text-sm"
          data-testid="issues-refresh"
          disabled={loading}
          onClick={() => void refresh(filters)}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div
        className="flex flex-wrap items-end gap-3 rounded border border-slate-800 bg-slate-900/40 p-3"
        data-testid="issues-filters"
      >
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Status
          <select
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            value={filters.status ?? ""}
            data-testid="filter-status"
            onChange={(e) => setFilter("status", e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s || "all"} value={s}>
                {s ? s : "all"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Severity
          <select
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            value={filters.severity ?? ""}
            data-testid="filter-severity"
            onChange={(e) => setFilter("severity", e.target.value)}
          >
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s || "all"} value={s}>
                {s ? s : "all"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Kind
          <select
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            value={filters.kind ?? ""}
            data-testid="filter-kind"
            onChange={(e) => setFilter("kind", e.target.value)}
          >
            {KIND_OPTIONS.map((s) => (
              <option key={s || "all"} value={s}>
                {s ? s : "all"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Category
          <select
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            value={filters.category ?? ""}
            data-testid="filter-category"
            onChange={(e) => setFilter("category", e.target.value)}
          >
            <option value="">all</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-[10rem] flex-col gap-1 text-xs text-slate-400">
          Task id
          <input
            type="text"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-sm text-slate-100"
            placeholder="optional"
            value={filters.task ?? ""}
            data-testid="filter-task"
            onChange={(e) => setFilter("task", e.target.value.trim())}
          />
        </label>
      </div>

      {error && (
        <p
          className="rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100"
          data-testid="issues-error"
        >
          {error}
        </p>
      )}

      <IssuesTable
        projectId={projectId}
        issues={issues}
        expandedFingerprint={expandedFingerprint}
        expandedDetail={expandedDetail}
        expandedLoading={expandedLoading}
        expandedError={expandedError}
        onToggleExpand={onToggleExpand}
      />
    </div>
  );
}

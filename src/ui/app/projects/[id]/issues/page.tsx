/**
 * Project issues log — durable finding fingerprints backlog.
 * Server-prefetches the list; client handles filters + expand detail.
 * Spec: plan/ui.md §6b Issues / Findings log.
 */

import { listIssues, type IssueListItem, type ListIssuesOptions } from "../../../../lib/api.js";
import { IssuesPageClient } from "./IssuesPageClient.js";

export const dynamic = "force-dynamic";

export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};

  const filters: ListIssuesOptions = {};
  const status = first(sp.status);
  const category = first(sp.category);
  const task = first(sp.task);
  const kind = first(sp.kind);
  const severity = first(sp.severity);
  if (status) filters.status = status;
  if (category) filters.category = category;
  if (task) filters.task = task;
  if (kind) filters.kind = kind;
  if (severity) filters.severity = severity;

  let issues: IssueListItem[] = [];
  let error: string | null = null;
  try {
    issues = await listIssues(id, filters);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-100">
          API unavailable ({error}). Showing empty list — filters still post to
          the API.
        </p>
      )}
      <IssuesPageClient
        projectId={id}
        initialIssues={issues}
        initialFilters={filters}
      />
    </div>
  );
}

function first(
  v: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Deep-link chips for finding evidence refs (diff / trace / tool).
 * Links into the run detail page tabs. Colorblind-safe: icon + label, not hue alone.
 */

"use client";

import type { IssueRef } from "../lib/api.js";

function refField(ref: Record<string, unknown>, key: string): unknown {
  return ref[key];
}

/** Build a project-scoped run deep-link for a structured ref. */
export function refHref(
  projectId: string,
  runId: string,
  ref: object,
): string {
  const r = ref as Record<string, unknown>;
  const kind = String(r.kind ?? "ref");
  const base = `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
  if (kind === "diff") {
    const file = String(refField(r, "file") ?? "");
    const hunk = Number(refField(r, "hunk") ?? 0);
    return `${base}?tab=diff#diff:${encodeURIComponent(file)}:${hunk}`;
  }
  if (kind === "trace") {
    const seqs =
      (refField(r, "seqs") as [number, number] | undefined) ?? [0, 0];
    return `${base}?tab=trace#trace:${seqs[0]}:${seqs[1]}`;
  }
  if (kind === "tool") {
    const toolCallId = String(refField(r, "toolCallId") ?? "");
    return `${base}?tab=trace#tool:${encodeURIComponent(toolCallId)}`;
  }
  return base;
}

/** Short human label for a ref chip. */
export function refLabel(ref: object): string {
  const r = ref as Record<string, unknown>;
  const kind = String(r.kind ?? "ref");
  if (kind === "diff") {
    const file = String(refField(r, "file") ?? "?");
    const hunk = refField(r, "hunk") ?? "?";
    const lines = refField(r, "lines") as [number, number] | undefined;
    const short =
      file.length > 28 ? `…${file.slice(-27)}` : file;
    if (lines) return `diff ${short} h${hunk} L${lines[0]}–${lines[1]}`;
    return `diff ${short} h${hunk}`;
  }
  if (kind === "trace") {
    const seqs =
      (refField(r, "seqs") as [number, number] | undefined) ?? [0, 0];
    return `trace seq ${seqs[0]}–${seqs[1]}`;
  }
  if (kind === "tool") {
    const id = String(refField(r, "toolCallId") ?? "");
    return `tool ${id.length > 10 ? `${id.slice(0, 8)}…` : id}`;
  }
  return kind;
}

function kindIcon(kind: string): string {
  if (kind === "diff") return "△";
  if (kind === "trace") return "◎";
  if (kind === "tool") return "⚙";
  return "○";
}

export interface RefChipsProps {
  projectId: string;
  /** Fallback run id when the ref itself has no runId (diff/tool). */
  runId: string;
  refs: object[] | IssueRef[] | undefined | null;
  /** Optional second run — chips also link into that run (for side-by-side). */
  altRunId?: string;
  className?: string;
}

/**
 * Render ref chips that deep-link into run detail (diff/trace tabs).
 */
export function RefChips({
  projectId,
  runId,
  refs,
  altRunId,
  className = "",
}: RefChipsProps) {
  if (!refs || refs.length === 0) return null;
  return (
    <span className={`inline-flex flex-wrap gap-1 ${className}`}>
      {refs.map((ref, i) => {
        const r = ref as Record<string, unknown>;
        const kind = String(r.kind ?? "ref");
        // Prefer the ref's own runId for trace refs when present.
        const ownRun =
          kind === "trace" && typeof r.runId === "string" && r.runId
            ? r.runId
            : runId;
        const href = refHref(projectId, ownRun, ref);
        const label = refLabel(ref);
        return (
          <span key={i} className="inline-flex items-center gap-0.5">
            <a
              href={href}
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 font-mono text-[11px] text-indigo-200 hover:border-indigo-600"
              title={label}
            >
              <span aria-hidden="true">{kindIcon(kind)}</span>
              <span>{label}</span>
            </a>
            {altRunId && altRunId !== ownRun ? (
              <a
                href={refHref(projectId, altRunId, ref)}
                className="rounded border border-slate-700 px-1 py-0.5 text-[10px] text-slate-400 hover:border-indigo-600 hover:text-indigo-200"
                title={`Open in run ${altRunId}`}
              >
                B
              </a>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

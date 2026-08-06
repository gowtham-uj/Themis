/**
 * Artifacts tab for run detail — the landing spot for `kind:"artifact"` ref
 * chips.
 *
 * Runs with no diff (browser, data, research) locate their findings on the
 * files they produced, so a screenshot has to be viewable one click from the
 * finding that cites it. Images render inline; everything else is a download
 * link. A `#artifact:<path>` hash scrolls to and highlights that entry.
 */

"use client";

import { useEffect, useState } from "react";
import {
  listRunArtifacts,
  runArtifactUrl,
  type RunArtifactSummary,
} from "../lib/api.js";

export interface ArtifactsPanelProps {
  runId: string;
  /** Artifact path from the deep-link hash, highlighted + scrolled to. */
  selectedPath?: string | null;
}

/** Human-readable byte size (1 decimal above KiB). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Stable DOM id so `#artifact:<path>` links resolve to an element. */
export function artifactAnchorId(path: string): string {
  return `artifact:${path}`;
}

export function ArtifactsPanel({ runId, selectedPath }: ArtifactsPanelProps) {
  const [artifacts, setArtifacts] = useState<RunArtifactSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setArtifacts(null);
    void listRunArtifacts(runId)
      .then((list) => {
        if (!cancelled) setArtifacts(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setArtifacts([]);
        setError(err instanceof Error ? err.message : "Failed to load artifacts.");
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Scroll to the deep-linked artifact once the list has rendered.
  useEffect(() => {
    if (!selectedPath || !artifacts || typeof document === "undefined") return;
    const el = document.getElementById(artifactAnchorId(selectedPath));
    el?.scrollIntoView({ block: "center" });
  }, [selectedPath, artifacts]);

  if (artifacts === null) {
    return <p className="text-sm text-slate-400">Loading artifacts…</p>;
  }

  if (error) {
    return (
      <p className="text-sm text-amber-200/90" data-testid="artifacts-error">
        {error}
      </p>
    );
  }

  if (artifacts.length === 0) {
    return (
      <p className="text-sm text-slate-400" data-testid="artifacts-empty">
        No artifacts. A run writes them to <code>workspace/outputs</code> —
        screenshots, exported data, generated reports.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="artifacts-panel">
      <p className="text-xs text-slate-500">
        {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"} from{" "}
        <code>workspace/outputs</code>
      </p>
      {artifacts.map((a) => {
        const selected = selectedPath === a.path;
        return (
          <figure
            key={a.path}
            id={artifactAnchorId(a.path)}
            data-testid="artifact-entry"
            className={`rounded border p-3 ${
              selected
                ? "border-indigo-500 bg-indigo-950/30"
                : "border-slate-800 bg-slate-900/40"
            }`}
          >
            <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm text-slate-200">{a.path}</span>
              <span className="text-xs text-slate-500">
                {formatBytes(a.sizeBytes)} · {a.contentType} ·{" "}
                <span title={a.sha256}>{a.sha256.slice(0, 12)}…</span>
              </span>
            </figcaption>
            {a.isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={runArtifactUrl(runId, a.path)}
                alt={`Artifact ${a.path}`}
                className="max-h-[70vh] w-auto rounded border border-slate-800 bg-white"
              />
            ) : (
              <a
                href={runArtifactUrl(runId, a.path)}
                className="text-sm text-indigo-300 hover:underline"
                download
              >
                Download {a.path}
              </a>
            )}
          </figure>
        );
      })}
    </div>
  );
}

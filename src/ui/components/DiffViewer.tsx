/**
 * Simple text diff viewer — renders unified diff with hunk markers.
 * Spec: plan/ui.md §4 Diff tab.
 */

export interface DiffViewerProps {
  patch: string;
  className?: string;
  emptyMessage?: string;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-slate-400";
  }
  if (line.startsWith("@@")) {
    return "bg-slate-800 text-cyan-300";
  }
  if (line.startsWith("+")) {
    return "bg-emerald-950/50 text-emerald-300";
  }
  if (line.startsWith("-")) {
    return "bg-red-950/50 text-red-300";
  }
  if (line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-slate-500";
  }
  return "text-slate-300";
}

export function DiffViewer({
  patch,
  className = "",
  emptyMessage = "No diff available.",
}: DiffViewerProps) {
  if (!patch || !patch.trim()) {
    return (
      <div
        className={`rounded border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500 ${className}`}
        data-testid="diff-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  const lines = patch.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre
      className={`overflow-x-auto rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-5 ${className}`}
      data-testid="diff-viewer"
    >
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)} data-diff-line={i + 1}>
          {line.length ? line : " "}
        </div>
      ))}
    </pre>
  );
}

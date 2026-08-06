/**
 * Pure string helpers for the verdict HTML report. No DOM, no I/O.
 */

import type { Ref, Severity, VerdictLevel, Priority, CompareDirection } from "../verdict.js";
import { SEVERITY_ORDER } from "../verdict.js";

/** Escape text for safe insertion into HTML text / attribute contexts. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format a 0..1 score as a fixed 2-decimal string (e.g. "0.62"). */
export function fmtScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  const clamped = Math.min(1, Math.max(0, score));
  return clamped.toFixed(2);
}

/** Format confidence 0..1 as a percentage integer string (e.g. "88%"). */
export function fmtPercent(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

/** Human label for a severity value. */
export function severityLabel(s: Severity): string {
  switch (s) {
    case "blocker":
      return "Blocker";
    case "major":
      return "Major";
    case "minor":
      return "Minor";
    case "nit":
      return "Nit";
    default:
      return String(s);
  }
}

/** CSS custom-property token name for a severity (paired with icon + label). */
export function colorForSeverity(s: Severity): string {
  switch (s) {
    case "blocker":
      return "var(--sev-blocker)";
    case "major":
      return "var(--sev-major)";
    case "minor":
      return "var(--sev-minor)";
    case "nit":
      return "var(--sev-nit)";
    default:
      return "var(--text-muted)";
  }
}

/** Icon glyph for severity — color is never the sole signal. */
export function severityIcon(s: Severity): string {
  switch (s) {
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

/** Stable sort key for severity (lower = more severe). Unknowns sort last. */
export function severityRank(s: Severity | string): number {
  const i = (SEVERITY_ORDER as readonly string[]).indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/** Deep-link href for a structured ref chip. */
export function refHref(ref: Ref): string {
  switch (ref.kind) {
    case "diff":
      return `#diff:${ref.file}:${ref.hunk}`;
    case "trace":
      return `#trace:${ref.runId}:${ref.seqs[0]}:${ref.seqs[1]}`;
    case "tool":
      return `#tool:${ref.toolCallId}`;
    case "artifact":
      return `#artifact:${ref.path}`;
    default: {
      // Exhaustiveness guard — unknown kind renders a safe empty anchor.
      const _never: never = ref;
      return `#ref:${JSON.stringify(_never)}`;
    }
  }
}

/** Short human label for a structured ref chip. */
export function refLabel(ref: Ref): string {
  switch (ref.kind) {
    case "diff": {
      const base = `${ref.file} hunk ${ref.hunk}`;
      if (ref.lines) return `${base} L${ref.lines[0]}–${ref.lines[1]}`;
      return base;
    }
    case "trace":
      return `trace seq ${ref.seqs[0]}–${ref.seqs[1]}`;
    case "tool":
      return `tool call ${ref.toolCallId}`;
    case "artifact":
      return `artifact ${ref.path}`;
    default: {
      const _never: never = ref;
      return String(_never);
    }
  }
}

/** Human label for the overall verdict level. */
export function verdictLevelLabel(level: VerdictLevel): string {
  switch (level) {
    case "pass":
      return "Pass";
    case "partial":
      return "Partial";
    case "fail":
      return "Fail";
    default:
      return String(level);
  }
}

/** CSS token for verdict level accent. */
export function colorForVerdictLevel(level: VerdictLevel): string {
  switch (level) {
    case "pass":
      return "var(--status-good)";
    case "partial":
      return "var(--status-warning)";
    case "fail":
      return "var(--status-critical)";
    default:
      return "var(--text-muted)";
  }
}

/** Human label for improvement priority. */
export function priorityLabel(p: Priority): string {
  switch (p) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return String(p);
  }
}

/** Arrow + label for a comparison direction. */
export function comparisonLabel(d: CompareDirection): { arrow: string; label: string; tone: string } {
  switch (d) {
    case "progressed":
      return { arrow: "↑", label: "Progressed", tone: "progressed" };
    case "regressed":
      return { arrow: "↓", label: "Regressed", tone: "regressed" };
    case "flat":
      return { arrow: "→", label: "Flat", tone: "flat" };
    default:
      return { arrow: "·", label: String(d), tone: "flat" };
  }
}

/** Stable slug for use in HTML ids (finding cards, anchors). */
export function slugId(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "id";
}

/** Format an optional duration in ms as a short human string. */
export function fmtDuration(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Pretty-print token counts if present in runMetadata.tokens. */
export function fmtTokens(tokens: unknown): string | null {
  if (tokens == null) return null;
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    return `${tokens.toLocaleString("en-US")} tokens`;
  }
  if (typeof tokens === "object" && !Array.isArray(tokens)) {
    const t = tokens as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof t.input === "number") parts.push(`in ${t.input.toLocaleString("en-US")}`);
    if (typeof t.output === "number") parts.push(`out ${t.output.toLocaleString("en-US")}`);
    if (typeof t.total === "number") parts.push(`total ${t.total.toLocaleString("en-US")}`);
    if (parts.length === 0) {
      // Fall back to JSON if shape is unknown but present.
      try {
        return JSON.stringify(tokens);
      } catch {
        return null;
      }
    }
    return parts.join(" · ");
  }
  return String(tokens);
}

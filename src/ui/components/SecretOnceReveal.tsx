/**
 * Green "secret shown once" panel with copy button.
 * Never persists the secret beyond this component's lifecycle.
 */

"use client";

import { useState } from "react";

export interface SecretOnceRevealProps {
  /** The one-time secret plaintext. */
  secret: string;
  /** Optional HMAC hook URL to display alongside. */
  hookUrl?: string;
  /** Panel title. */
  title?: string;
  /** Called when the user dismisses the panel. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * Build the pure reveal-once descriptor used by contract tests and the chip.
 * Always returns `{ shownOnce: true }` semantics for a non-empty secret.
 */
export function secretOnceRevealMeta(secret: string | null | undefined): {
  shownOnce: true;
  hasSecret: boolean;
  secretLength: number;
} {
  const s = secret ?? "";
  return {
    shownOnce: true,
    hasSecret: s.length > 0,
    secretLength: s.length,
  };
}

/** Secret-once reveal chip: copy + warning. Spec: plan/ui.md + P8 watchers/webhooks. */
export function SecretOnceReveal({
  secret,
  hookUrl,
  title = "Webhook secret (shown once)",
  onDismiss,
  className = "",
}: SecretOnceRevealProps) {
  const [copied, setCopied] = useState(false);
  const meta = secretOnceRevealMeta(secret);

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select via prompt for environments without clipboard API.
      window.prompt("Copy secret:", secret);
    }
  }

  if (!meta.hasSecret) return null;

  return (
    <div
      className={`rounded border border-emerald-700 bg-emerald-950/40 p-4 text-sm text-emerald-50 ${className}`}
      data-testid="secret-once-reveal"
      data-shown-once="true"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-emerald-200">{title}</p>
          <p className="mt-1 text-xs text-amber-200">
            Save this now — it will not be shown again.
          </p>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300"
            onClick={onDismiss}
            data-testid="secret-once-dismiss"
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code
          className="max-w-full break-all rounded bg-slate-950/60 px-2 py-1 font-mono text-xs text-emerald-100"
          data-testid="secret-once-value"
        >
          {secret}
        </code>
        <button
          type="button"
          className="rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white"
          onClick={() => void copy()}
          data-testid="secret-once-copy"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hookUrl && (
        <div className="mt-3">
          <p className="text-xs text-slate-300">HMAC hook URL</p>
          <code
            className="mt-1 block max-w-full break-all rounded bg-slate-950/60 px-2 py-1 font-mono text-xs text-slate-100"
            data-testid="secret-once-hook-url"
          >
            {hookUrl}
          </code>
        </div>
      )}
    </div>
  );
}

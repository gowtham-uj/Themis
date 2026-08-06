/**
 * Client shell for outbound webhook subscriptions + delivery log + test-fire.
 * Secret reveal-once after create (same SecretOnceReveal pattern as watchers).
 */

"use client";

import { useCallback, useState, type FormEvent } from "react";
import type {
  OutboundWebhook,
  WebhookDelivery,
} from "../../../../lib/api.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhooks,
  listWebhookDeliveries,
  testWebhook,
  updateWebhook,
} from "../../../../lib/api.js";
import { SecretOnceReveal } from "../../../../components/SecretOnceReveal.js";

export interface WebhooksClientProps {
  projectId: string;
  initialWebhooks: OutboundWebhook[];
}

/** Supported outbound event types (multi-select). */
export const OUTBOUND_EVENT_TYPES = [
  "run.completed",
  "verdict.completed",
  "release.compared",
] as const;

/**
 * Delivery status chip text — pinned by contract tests.
 * Maps success/failed (+ unknown passthrough) to display labels.
 */
export function deliveryStatusChipText(
  status: string | null | undefined,
): string {
  const s = String(status ?? "").toLowerCase();
  if (s === "success" || s === "ok" || s === "delivered") return "success";
  if (s === "failed" || s === "error" || s === "dead") return "failed";
  return s || "failed";
}

/** Tailwind classes for a delivery status chip. */
export function deliveryStatusColor(status: string | null | undefined): string {
  const label = deliveryStatusChipText(status);
  if (label === "success") {
    return "border-emerald-700 bg-emerald-950/40 text-emerald-100";
  }
  if (label === "failed") {
    return "border-red-700 bg-red-950/40 text-red-200";
  }
  return "border-slate-600 bg-slate-800 text-slate-300";
}

/** Truncate a response body for the deliveries table. */
export function truncateResponseBody(
  body: string | null | undefined,
  max = 120,
): string {
  if (!body) return "—";
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…`;
}

export function WebhooksClient({
  projectId,
  initialWebhooks,
}: WebhooksClientProps) {
  const [webhooks, setWebhooks] = useState<OutboundWebhook[]>(initialWebhooks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>([
    "run.completed",
  ]);
  const [enabled, setEnabled] = useState(true);

  const [expandedSubId, setExpandedSubId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const rows = await getWebhooks(projectId);
    setWebhooks(rows);
  }, [projectId]);

  function toggleEventType(t: string) {
    setEventTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const created = await createWebhook(projectId, {
        url: url.trim(),
        eventTypes,
        enabled,
      });
      if (created.secret) {
        setRevealedSecret(created.secret);
      }
      setShowCreate(false);
      setUrl("");
      setMessage(`Created webhook ${created.id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleEnabled(sub: OutboundWebhook) {
    setBusy(true);
    setError(null);
    try {
      await updateWebhook(projectId, sub.id, { enabled: !sub.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(sub: OutboundWebhook) {
    if (!confirm(`Delete webhook subscription to ${sub.url}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWebhook(projectId, sub.id);
      if (expandedSubId === sub.id) {
        setExpandedSubId(null);
        setDeliveries([]);
      }
      await refresh();
      setMessage("Webhook deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onViewDeliveries(subId: string) {
    if (expandedSubId === subId) {
      setExpandedSubId(null);
      setDeliveries([]);
      return;
    }
    setExpandedSubId(subId);
    setDeliveriesLoading(true);
    setError(null);
    try {
      const rows = await listWebhookDeliveries(projectId, subId);
      setDeliveries(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeliveries([]);
    } finally {
      setDeliveriesLoading(false);
    }
  }

  async function onTest(subId: string) {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await testWebhook(projectId, subId);
      setTestResult(
        `Test delivery: id=${result.deliveryId ?? "—"} status=${result.status ?? "—"}`,
      );
      if (expandedSubId === subId) {
        const rows = await listWebhookDeliveries(projectId, subId);
        setDeliveries(rows);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Outbound webhooks</h1>
          <p className="mt-1 text-sm text-slate-400">
            Notify external apps on run / verdict / release events (HMAC-signed).
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => setShowCreate((v) => !v)}
          data-testid="webhook-new"
        >
          {showCreate ? "Cancel" : "New subscription"}
        </button>
      </div>

      {revealedSecret && (
        <SecretOnceReveal
          secret={revealedSecret}
          title="Webhook signing secret (shown once)"
          onDismiss={() => setRevealedSecret(null)}
        />
      )}

      {testResult && (
        <p
          className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs text-slate-200"
          data-testid="webhook-test-result"
        >
          {testResult}
        </p>
      )}
      {message && (
        <p className="text-sm text-slate-400" data-testid="webhooks-message">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-400" data-testid="webhooks-error">
          {error}
        </p>
      )}

      {showCreate && (
        <form
          onSubmit={(e) => void onCreate(e)}
          className="max-w-2xl space-y-3 rounded border border-slate-700 bg-slate-900/40 p-4"
          data-testid="webhook-create-form"
        >
          <h2 className="text-lg font-medium">Create subscription</h2>
          <label className="block text-sm">
            URL
            <input
              required
              type="url"
              className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hooks/agenteval"
            />
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1">Event types</legend>
            <div className="flex flex-wrap gap-3">
              {OUTBOUND_EVENT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={eventTypes.includes(t)}
                    onChange={() => toggleEventType(t)}
                  />
                  <span className="font-mono text-xs">{t}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <button
            type="submit"
            disabled={busy || !url.trim() || eventTypes.length === 0}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="webhook-create-submit"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      <div className="space-y-3" data-testid="webhooks-list">
        {webhooks.length === 0 && (
          <p className="text-sm text-slate-500">No outbound webhooks yet.</p>
        )}
        {webhooks.map((w) => (
          <div
            key={w.id}
            className="rounded border border-slate-800 bg-slate-900/30 p-3"
            data-testid={`webhook-row-${w.id}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="break-all font-mono text-sm text-slate-100">
                  {w.url}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {w.eventTypes.join(", ") || "(no events)"}
                  {" · "}
                  <span
                    className={
                      w.enabled ? "text-emerald-300" : "text-slate-500"
                    }
                  >
                    {w.enabled ? "enabled" : "disabled"}
                  </span>
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded bg-slate-700 px-2 py-0.5 text-xs"
                  disabled={busy}
                  onClick={() => void onToggleEnabled(w)}
                  data-testid="webhook-toggle"
                >
                  {w.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="rounded bg-slate-700 px-2 py-0.5 text-xs"
                  disabled={busy}
                  onClick={() => void onViewDeliveries(w.id)}
                  data-testid="webhook-view-deliveries"
                >
                  {expandedSubId === w.id ? "Hide deliveries" : "View deliveries"}
                </button>
                <button
                  type="button"
                  className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white"
                  disabled={busy}
                  onClick={() => void onTest(w.id)}
                  data-testid="webhook-test"
                >
                  Send test
                </button>
                <button
                  type="button"
                  className="rounded bg-red-900/60 px-2 py-0.5 text-xs text-red-100"
                  disabled={busy}
                  onClick={() => void onDelete(w)}
                  data-testid="webhook-delete"
                >
                  Delete
                </button>
              </div>
            </div>

            {expandedSubId === w.id && (
              <div className="mt-3 overflow-x-auto" data-testid="webhook-deliveries">
                {deliveriesLoading ? (
                  <p className="text-xs text-slate-400">Loading…</p>
                ) : deliveries.length === 0 ? (
                  <p className="text-xs text-slate-500">No deliveries yet.</p>
                ) : (
                  <table className="min-w-full text-left text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="px-2 py-1">Event</th>
                        <th className="px-2 py-1">Status</th>
                        <th className="px-2 py-1">Attempt</th>
                        <th className="px-2 py-1">HTTP</th>
                        <th className="px-2 py-1">Delivered</th>
                        <th className="px-2 py-1">Body / error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <tr
                          key={d.id}
                          className="border-t border-slate-800"
                          data-testid={`delivery-row-${d.id}`}
                        >
                          <td className="px-2 py-1 font-mono">{d.eventType}</td>
                          <td className="px-2 py-1">
                            <span
                              className={`inline-block rounded border px-1.5 py-0.5 ${deliveryStatusColor(d.status)}`}
                              data-testid="delivery-status-chip"
                            >
                              {deliveryStatusChipText(d.status)}
                            </span>
                          </td>
                          <td className="px-2 py-1">{d.attempt ?? "—"}</td>
                          <td className="px-2 py-1">
                            {d.responseStatus ?? "—"}
                          </td>
                          <td className="px-2 py-1 text-slate-400">
                            {d.deliveredAt
                              ? d.deliveredAt.slice(0, 19)
                              : "—"}
                          </td>
                          <td className="max-w-xs truncate px-2 py-1 text-slate-400">
                            {d.error
                              ? d.error
                              : truncateResponseBody(d.responseBody)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

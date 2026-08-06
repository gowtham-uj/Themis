/**
 * Client shell for watcher rules: list + create + enable/disable + fire + delete.
 * Spec: plan/watcher.md; secret reveal-once after create.
 */

"use client";

import { useCallback, useState, type FormEvent } from "react";
import type {
  CreateWatcherRuleBody,
  WatcherAction,
  WatcherRule,
} from "../../../../lib/api.js";
import {
  createWatcherRule,
  deleteWatcherRule,
  fireWatcher,
  getWatcherRules,
  updateWatcherRule,
} from "../../../../lib/api.js";
import { SecretOnceReveal } from "../../../../components/SecretOnceReveal.js";

export interface WatchersClientProps {
  projectId: string;
  initialWatchers: WatcherRule[];
}

const TRIGGERS = [
  "tag",
  "commit",
  "pr",
  "schedule",
  "manual",
  "webhook",
] as const;

/**
 * Build the HMAC git-host hook URL for a watcher rule.
 * Pins the wire path: POST /api/projects/:id/watcher/hooks/:ruleId
 */
export function watcherHookUrl(projectId: string, ruleId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/watcher/hooks/${encodeURIComponent(ruleId)}`;
}

/** Short action summary for a rule row. */
export function formatWatcherAction(action: WatcherAction | null | undefined): string {
  if (!action) return "—";
  const parts: string[] = [`enqueue ${action.enqueue}`];
  if (action.enqueue === "subset" && action.taskTags?.length) {
    parts.push(`tags:[${action.taskTags.join(",")}]`);
  }
  if (typeof action.repeats === "number") parts.push(`×${action.repeats}`);
  if (action.autoJudge) parts.push("auto-judge");
  return parts.join(" · ");
}

/** Status chip for enabled/disabled. */
export function watcherEnabledLabel(enabled: boolean): string {
  return enabled ? "enabled" : "disabled";
}

export function WatchersClient({
  projectId,
  initialWatchers,
}: WatchersClientProps) {
  const [watchers, setWatchers] = useState<WatcherRule[]>(initialWatchers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    secret: string;
    ruleId: string;
  } | null>(null);
  const [fireResult, setFireResult] = useState<string | null>(null);

  // Create form state
  const [role, setRole] = useState<"agent" | "workspace">("agent");
  const [repo, setRepo] = useState("");
  const [trigger, setTrigger] = useState<string>("tag");
  const [ref, setRef] = useState("");
  const [semverFilter, setSemverFilter] = useState("");
  const [enqueue, setEnqueue] = useState<"all" | "subset">("all");
  const [taskTags, setTaskTags] = useState("");
  const [repeats, setRepeats] = useState(1);
  const [autoJudge, setAutoJudge] = useState(false);
  const [generateSecret, setGenerateSecret] = useState(true);

  const refresh = useCallback(async () => {
    const rows = await getWatcherRules(projectId);
    setWatchers(rows);
  }, [projectId]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const action: WatcherAction = { enqueue };
      if (enqueue === "subset") {
        action.taskTags = taskTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (repeats > 0) action.repeats = repeats;
      if (autoJudge) action.autoJudge = true;

      const body: CreateWatcherRuleBody = {
        role,
        repo: repo.trim(),
        trigger,
        action,
      };
      if (ref.trim()) body.ref = ref.trim();
      if (semverFilter.trim()) body.semverFilter = semverFilter.trim();
      // Server always generates a secret when webhookSecret is omitted or set;
      // checkbox is informational for the user that one will be revealed.
      if (generateSecret) body.webhookSecret = "";

      const created = await createWatcherRule(projectId, body);
      if (created.webhookSecret) {
        setRevealedSecret({
          secret: created.webhookSecret,
          ruleId: created.id,
        });
      }
      setShowCreate(false);
      setRepo("");
      setRef("");
      setSemverFilter("");
      setTaskTags("");
      setMessage(`Created watcher ${created.id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleEnabled(rule: WatcherRule) {
    setBusy(true);
    setError(null);
    try {
      await updateWatcherRule(projectId, rule.id, { enabled: !rule.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(rule: WatcherRule) {
    if (!confirm(`Delete watcher rule for ${rule.repo} (${rule.trigger})?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteWatcherRule(projectId, rule.id);
      await refresh();
      setMessage("Watcher deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFire(rule: WatcherRule) {
    setBusy(true);
    setError(null);
    setFireResult(null);
    try {
      const result = await fireWatcher(projectId, rule.id, {});
      const batches = result.batchIds?.join(", ") || "(none)";
      setFireResult(
        `Fired ${rule.id}: status=${result.status ?? "ok"} batchIds=[${batches}] event=${result.watcherEventId ?? "—"}`,
      );
      await refresh();
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
          <h1 className="text-2xl font-semibold">Watchers</h1>
          <p className="mt-1 text-sm text-slate-400">
            Repo triggers that enqueue eval batches (tag / commit / PR / webhook).
          </p>
        </div>
        <button
          type="button"
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
          data-testid="watcher-new"
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? "Cancel" : "New watcher"}
        </button>
      </div>

      {revealedSecret && (
        <SecretOnceReveal
          secret={revealedSecret.secret}
          hookUrl={watcherHookUrl(projectId, revealedSecret.ruleId)}
          onDismiss={() => setRevealedSecret(null)}
        />
      )}

      {fireResult && (
        <p
          className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs text-slate-200"
          data-testid="watcher-fire-result"
        >
          {fireResult}
        </p>
      )}

      {message && (
        <p className="text-sm text-slate-400" data-testid="watchers-message">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-400" data-testid="watchers-error">
          {error}
        </p>
      )}

      {showCreate && (
        <form
          onSubmit={(e) => void onCreate(e)}
          className="max-w-2xl space-y-3 rounded border border-slate-700 bg-slate-900/40 p-4"
          data-testid="watcher-create-form"
        >
          <h2 className="text-lg font-medium">Create watcher rule</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Role
              <select
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={role}
                onChange={(e) =>
                  setRole(e.target.value === "workspace" ? "workspace" : "agent")
                }
              >
                <option value="agent">agent</option>
                <option value="workspace">workspace</option>
              </select>
            </label>
            <label className="block text-sm">
              Trigger
              <select
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
              >
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            Repo
            <input
              required
              className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Ref (glob, optional)
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="v*"
              />
            </label>
            <label className="block text-sm">
              Semver filter (optional)
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={semverFilter}
                onChange={(e) => setSemverFilter(e.target.value)}
                placeholder=">=2.0.0"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Enqueue
              <select
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={enqueue}
                onChange={(e) =>
                  setEnqueue(e.target.value === "subset" ? "subset" : "all")
                }
              >
                <option value="all">all tasks</option>
                <option value="subset">subset by tags</option>
              </select>
            </label>
            <label className="block text-sm">
              Repeats
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={repeats}
                onChange={(e) => setRepeats(Number(e.target.value) || 1)}
              />
            </label>
          </div>
          {enqueue === "subset" && (
            <label className="block text-sm">
              Task tags (comma-separated)
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
                value={taskTags}
                onChange={(e) => setTaskTags(e.target.value)}
                placeholder="smoke,regression"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoJudge}
              onChange={(e) => setAutoJudge(e.target.checked)}
            />
            Auto-judge on completion
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={generateSecret}
              onChange={(e) => setGenerateSecret(e.target.checked)}
              data-testid="watcher-generate-secret"
            />
            Generate webhook secret (shown once after create)
          </label>
          <button
            type="submit"
            disabled={busy || !repo.trim()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="watcher-create-submit"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="min-w-full text-left text-sm" data-testid="watchers-table">
          <thead className="bg-slate-900/80 text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Repo</th>
              <th className="px-3 py-2">Trigger</th>
              <th className="px-3 py-2">Ref / semver</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {watchers.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                  No watcher rules yet.
                </td>
              </tr>
            )}
            {watchers.map((w) => (
              <tr
                key={w.id}
                className="border-t border-slate-800"
                data-testid={`watcher-row-${w.id}`}
              >
                <td className="px-3 py-2 font-mono text-xs">{w.repo}</td>
                <td className="px-3 py-2">{w.trigger}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">
                  {w.ref ?? "—"}
                  {w.semverFilter ? ` · ${w.semverFilter}` : ""}
                </td>
                <td className="px-3 py-2">{w.role}</td>
                <td className="px-3 py-2 text-xs text-slate-300">
                  {formatWatcherAction(w.action)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block rounded border px-2 py-0.5 text-xs ${
                      w.enabled
                        ? "border-emerald-700 bg-emerald-950/40 text-emerald-100"
                        : "border-slate-600 bg-slate-900 text-slate-400"
                    }`}
                  >
                    {watcherEnabledLabel(w.enabled)}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {w.createdAt ? w.createdAt.slice(0, 10) : "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="rounded bg-slate-700 px-2 py-0.5 text-xs"
                      disabled={busy}
                      onClick={() => void onToggleEnabled(w)}
                      data-testid="watcher-toggle"
                    >
                      {w.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-indigo-600 px-2 py-0.5 text-xs text-white disabled:opacity-50"
                      disabled={busy || !w.enabled}
                      onClick={() => void onFire(w)}
                      data-testid="watcher-fire"
                      title={
                        w.enabled
                          ? "Manual fire now"
                          : "Enable the rule before firing"
                      }
                    >
                      Fire now
                    </button>
                    <button
                      type="button"
                      className="rounded bg-red-900/60 px-2 py-0.5 text-xs text-red-100"
                      disabled={busy}
                      onClick={() => void onDelete(w)}
                      data-testid="watcher-delete"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

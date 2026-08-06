"use client";

import { useState, type FormEvent } from "react";
import {
  createUser,
  deleteUser,
  putSettings,
  type GlobalSettings,
  type PublicUser,
} from "../../lib/api.js";

export interface SettingsClientProps {
  initialSettings: GlobalSettings;
  initialUsers: PublicUser[];
}

/**
 * Client form for global settings + users management.
 * Mirrors the runs/new form pattern: controlled inputs + api client posts.
 */
export function SettingsClient({
  initialSettings,
  initialUsers,
}: SettingsClientProps) {
  const [defaultModels, setDefaultModels] = useState(
    stringifyPretty(initialSettings.defaultModels) ||
      '{\n  "agent": "claude-sonnet-4-20250514",\n  "judge": "claude-sonnet-4-20250514"\n}',
  );
  const [limits, setLimits] = useState(
    stringifyPretty(initialSettings.limits) ||
      '{\n  "concurrency": 1,\n  "timeoutMs": 600000\n}',
  );
  const [judgePromptOverrides, setJudgePromptOverrides] = useState(
    typeof initialSettings.judgePromptOverrides === "string"
      ? initialSettings.judgePromptOverrides
      : stringifyPretty(initialSettings.judgePromptOverrides) || "",
  );
  const [keyNames, setKeyNames] = useState(
    (initialSettings.keys ?? []).join(", "),
  );
  const [users, setUsers] = useState<PublicUser[]>(initialUsers);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);
  const [userBusy, setUserBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userError, setUserError] = useState<string | null>(null);

  async function onSaveSettings(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let models: unknown = null;
      let lim: unknown = null;
      if (defaultModels.trim()) {
        models = JSON.parse(defaultModels);
      }
      if (limits.trim()) {
        lim = JSON.parse(limits);
      }
      const keys = keyNames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await putSettings({
        defaultModels: models,
        limits: lim,
        judgePromptOverrides: judgePromptOverrides || null,
        keys,
      });
      setMessage("Settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreateUser(e: FormEvent) {
    e.preventDefault();
    setUserBusy(true);
    setUserError(null);
    try {
      const created = await createUser({
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
      });
      setUsers((prev) => [...prev, created]);
      setNewUsername("");
      setNewPassword("");
      setNewRole("user");
    } catch (err) {
      setUserError(err instanceof Error ? err.message : String(err));
    } finally {
      setUserBusy(false);
    }
  }

  async function onDeleteUser(id: string) {
    setUserBusy(true);
    setUserError(null);
    try {
      await deleteUser(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err) {
      setUserError(err instanceof Error ? err.message : String(err));
    } finally {
      setUserBusy(false);
    }
  }

  return (
    <div className="space-y-8" data-testid="settings-client">
      <p className="text-sm text-slate-400">
        Admin-only when auth is enabled. Non-admin callers receive 403 from the
        API. Secret key <em>values</em> are never stored or shown here — only
        names (env-side injection).
      </p>

      <form
        onSubmit={(e) => void onSaveSettings(e)}
        className="max-w-2xl space-y-4 rounded border border-slate-700 bg-slate-900/40 p-4"
        data-testid="settings-form"
      >
        <h2 className="text-lg font-medium">Global settings</h2>

        <label className="block text-sm">
          Default models (JSON)
          <textarea
            className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2 font-mono text-xs"
            rows={4}
            value={defaultModels}
            onChange={(e) => setDefaultModels(e.target.value)}
            data-testid="settings-default-models"
          />
        </label>

        <label className="block text-sm">
          Limits (JSON)
          <textarea
            className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2 font-mono text-xs"
            rows={3}
            value={limits}
            onChange={(e) => setLimits(e.target.value)}
            data-testid="settings-limits"
          />
        </label>

        <label className="block text-sm">
          Judge prompt overrides
          <textarea
            className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2 font-mono text-xs"
            rows={6}
            value={judgePromptOverrides}
            onChange={(e) => setJudgePromptOverrides(e.target.value)}
            placeholder="Optional system-prompt override text or JSON"
            data-testid="settings-judge-prompt"
          />
        </label>

        <label className="block text-sm">
          Secret key names (comma-separated; values never shown)
          <input
            className="mt-1 w-full rounded border border-slate-600 bg-slate-800 px-3 py-2"
            value={keyNames}
            onChange={(e) => setKeyNames(e.target.value)}
            placeholder="ANTHROPIC_API_KEY, OPENAI_API_KEY"
            data-testid="settings-key-names"
          />
        </label>

        {error ? (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="text-sm text-emerald-400" role="status">
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </form>

      <section
        className="max-w-2xl space-y-4 rounded border border-slate-700 bg-slate-900/40 p-4"
        data-testid="users-section"
      >
        <h2 className="text-lg font-medium">Users</h2>
        <p className="text-xs text-slate-500">
          First registered user is auto-admin. Password hashes use scrypt;
          plaintext is never stored.
        </p>

        <table className="w-full text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="py-1 pr-2">Username</th>
              <th className="py-1 pr-2">Role</th>
              <th className="py-1">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-2 text-slate-500">
                  No users yet — create the first (auto-admin).
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-t border-slate-800">
                  <td className="py-1 pr-2 font-mono">{u.username}</td>
                  <td className="py-1 pr-2">{u.role}</td>
                  <td className="py-1">
                    <button
                      type="button"
                      disabled={userBusy}
                      onClick={() => void onDeleteUser(u.id)}
                      className="text-xs text-red-400 hover:underline disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <form
          onSubmit={(e) => void onCreateUser(e)}
          className="flex flex-wrap items-end gap-2 border-t border-slate-800 pt-3"
          data-testid="create-user-form"
        >
          <label className="text-xs">
            Username
            <input
              required
              className="mt-1 block rounded border border-slate-600 bg-slate-800 px-2 py-1"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
            />
          </label>
          <label className="text-xs">
            Password
            <input
              required
              type="password"
              className="mt-1 block rounded border border-slate-600 bg-slate-800 px-2 py-1"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </label>
          <label className="text-xs">
            Role
            <select
              className="mt-1 block rounded border border-slate-600 bg-slate-800 px-2 py-1"
              value={newRole}
              onChange={(e) =>
                setNewRole(e.target.value === "admin" ? "admin" : "user")
              }
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={userBusy}
            className="rounded bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600 disabled:opacity-50"
          >
            Create user
          </button>
        </form>
        {userError ? (
          <p className="text-sm text-red-400" role="alert">
            {userError}
          </p>
        ) : null}
      </section>

      <section className="max-w-2xl rounded border border-slate-700 bg-slate-900/40 p-4">
        <h2 className="text-lg font-medium">API tokens</h2>
        <p className="mt-1 text-sm text-slate-400">
          Mint and revoke Bearer tokens via{" "}
          <code className="text-slate-300">POST/GET/DELETE /api/tokens</code>.
          Login also mints a user-bound token. See the public API docs.
        </p>
        <a
          href="/projects"
          className="mt-2 inline-block text-sm text-sky-400 hover:underline"
        >
          Back to projects
        </a>
      </section>
    </div>
  );
}

function stringifyPretty(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

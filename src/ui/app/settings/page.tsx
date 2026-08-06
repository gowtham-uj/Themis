import {
  getSettings,
  listUsers,
  type GlobalSettings,
  type PublicUser,
} from "../../lib/api.js";
import { SettingsClient } from "./SettingsClient.js";

export const dynamic = "force-dynamic";

/**
 * Global Settings page (P9). Server-fetches initial settings + users;
 * client form posts via the api client. Admin-gated client-side with a
 * notice; backend enforces when authEnabled.
 */
export default async function SettingsPage() {
  let settings: GlobalSettings = { keys: [] };
  let users: PublicUser[] = [];
  let error: string | null = null;

  try {
    settings = await getSettings();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    settings = { keys: [] };
  }

  try {
    users = await listUsers();
  } catch {
    // Non-admin / auth-off without seed → empty list is fine.
    users = [];
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {error ? (
        <p className="rounded border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          API unavailable ({error}). Form still posts to the live API when it
          comes up.
        </p>
      ) : null}
      <SettingsClient initialSettings={settings} initialUsers={users} />
    </div>
  );
}

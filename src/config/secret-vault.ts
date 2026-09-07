/**
 * Durable storage for the API key values the console accepts directly.
 *
 * The rest of the platform reads credentials from the process environment by
 * variable name. That works for an operator who exports the key before starting
 * the server, but it loses the key on every restart, so the console also lets
 * someone paste a value. This module is where such a value lives between
 * restarts.
 *
 * Values are encrypted with AES-256-GCM before they reach the settings table.
 * The key comes from AGENTEVAL_SECRET_KEY when set; otherwise it is derived
 * from a random salt generated once and kept in the same table, which protects
 * a leaked database dump but not an attacker who already reads the whole file.
 * Set AGENTEVAL_SECRET_KEY in production.
 *
 * Nothing here ever logs, returns, or serializes a plaintext value. Callers get
 * variable names and a boolean; `loadSecretsIntoEnv` is the one path that moves
 * plaintext, and it moves it into `process.env` only.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import type { DbQueries } from "../db/queries.js";

/** Settings row holding the encrypted values, keyed by env var name. */
const VAULT_KEY = "secrets.vault";
/** Settings row holding the derived-key salt when no operator key is set. */
const SALT_KEY = "secrets.salt";

const ALGO = "aes-256-gcm";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Names the console refuses to write.
 *
 * Every one of these changes how the Node process or its children execute code
 * rather than how they authenticate, so accepting them would turn a credential
 * form into remote code execution.
 */
const FORBIDDEN = new Set([
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "PATH",
  "SHELL",
  "IFS",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "AGENTEVAL_SECRET_KEY",
]);

/** Reject a name that is malformed or would alter process execution. */
export function assertStorableEnvName(name: string): void {
  if (!ENV_NAME.test(name)) {
    throw new Error(`"${name}" is not a valid environment variable name`);
  }
  if (FORBIDDEN.has(name)) {
    throw new Error(`"${name}" changes how processes execute and cannot hold a credential`);
  }
}

type VaultRow = { iv: string; tag: string; data: string; updatedAt: string };
type Vault = Record<string, VaultRow>;

function readVault(queries: DbQueries): Vault {
  const raw = queries.getSetting(VAULT_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Vault) : {};
}

/** Resolve the 32-byte encryption key, generating a stored salt on first use. */
function vaultKey(queries: DbQueries): Buffer {
  const operator = process.env.AGENTEVAL_SECRET_KEY;
  if (operator) return scryptSync(operator, "agenteval.secret.v1", 32);
  let salt = queries.getSetting(SALT_KEY);
  if (typeof salt !== "string" || salt.length < 32) {
    salt = randomBytes(32).toString("hex");
    queries.setSetting(SALT_KEY, salt);
  }
  return scryptSync(salt as string, "agenteval.secret.v1", 32);
}

/** Store one credential value under an environment variable name. */
export function putSecret(queries: DbQueries, name: string, value: string): void {
  assertStorableEnvName(name);
  if (!value) throw new Error("value is empty");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, vaultKey(queries), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const vault = readVault(queries);
  vault[name] = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    updatedAt: new Date().toISOString(),
  };
  queries.setSetting(VAULT_KEY, vault);
  process.env[name] = value;
}

/** Forget one stored credential. Also clears it from this process. */
export function deleteSecret(queries: DbQueries, name: string): boolean {
  const vault = readVault(queries);
  if (!(name in vault)) return false;
  delete vault[name];
  queries.setSetting(VAULT_KEY, vault);
  delete process.env[name];
  return true;
}

/** Names held in the vault, with when each was last written. Never values. */
export function listSecrets(queries: DbQueries): { name: string; updatedAt: string }[] {
  return Object.entries(readVault(queries))
    .map(([name, row]) => ({ name, updatedAt: row.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Decrypt every stored value into `process.env`, so queues, adapters, and judge
 * stages resolve them the same way they resolve an operator-exported variable.
 *
 * An ambient variable of the same name wins: an operator who exported a key
 * before starting the server meant that one. A row that fails to decrypt is
 * skipped and counted, never thrown, so one bad row cannot block startup.
 */
export function loadSecretsIntoEnv(queries: DbQueries): { loaded: number; failed: number } {
  const vault = readVault(queries);
  const names = Object.keys(vault);
  if (names.length === 0) return { loaded: 0, failed: 0 };
  const key = vaultKey(queries);
  let loaded = 0;
  let failed = 0;
  for (const name of names) {
    if (process.env[name]) continue;
    const row = vault[name]!;
    try {
      const decipher = createDecipheriv(ALGO, key, Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      process.env[name] = Buffer.concat([
        decipher.update(Buffer.from(row.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      loaded += 1;
    } catch {
      failed += 1;
    }
  }
  return { loaded, failed };
}

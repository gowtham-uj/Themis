/**
 * Password auth + user management (P9-settings).
 *
 * Password hashing uses node:crypto scrypt (N=16384, r=8, p=1, keylen=64).
 * Format stored in users.password_hash: `<saltHex>:<hashHex>`.
 * Plaintext passwords are NEVER stored or logged.
 *
 * Login mints an API token via the existing P8b createApiToken machinery so
 * the Bearer scheme stays consistent (no separate session cookie layer).
 *
 * First user bootstrap: when the users table is empty, registerUser assigns
 * role=admin so `npm run cli -- user create` can seed an operator.
 *
 * Spec: plan/api.md §Auth + plan/roadmap.md P9 Auth + Settings.
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type {
  CreateUserInput,
  DbQueries,
  User,
  UserRole,
} from "../db/queries.js";

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Hash a plaintext password with scrypt.
 * Returns `saltHex:hashHex` suitable for users.password_hash.
 * NEVER log the plaintext or the return value in production logs.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt `saltHex:hashHex`.
 * Uses timingSafeEqual on the derived hash. Returns false on any malformed
 * stored value or mismatch.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, parsed.salt, parsed.expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  } catch {
    return false;
  }
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

function parsePasswordHash(stored: string): { salt: Buffer; expected: Buffer } | null {
  if (!stored || typeof stored !== "string") return null;
  const idx = stored.indexOf(":");
  if (idx <= 0) return null;
  try {
    const salt = Buffer.from(stored.slice(0, idx), "hex");
    const expected = Buffer.from(stored.slice(idx + 1), "hex");
    if (salt.length === 0 || expected.length === 0) return null;
    return { salt, expected };
  } catch {
    return null;
  }
}

/** Async password verification keeps expensive scrypt work off the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  return new Promise<boolean>((resolve) => {
    scrypt(
      password,
      parsed.salt,
      parsed.expected.length,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derived) => {
        if (err) {
          resolve(false);
          return;
        }
        const actual = Buffer.from(derived);
        resolve(
          actual.length === parsed.expected.length &&
            timingSafeEqual(actual, parsed.expected),
        );
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public user shape (no password hash)
// ---------------------------------------------------------------------------

/** API-safe user view — password hash never included. */
export interface PublicUser {
  id: string;
  username: string;
  role: UserRole | string;
  createdAt: string;
  email?: string | null;
}

/** Strip passwordHash from a User row for API responses. */
export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    email: u.email ?? null,
  };
}

// ---------------------------------------------------------------------------
// User CRUD helpers
// ---------------------------------------------------------------------------

export interface RegisterUserInput {
  username: string;
  password: string;
  /** Force a role. When omitted: first user → admin, else user. */
  role?: UserRole | string;
  email?: string | null;
}

/**
 * Register a user: hash the password with scrypt and insert.
 *
 * Bootstrap rule: if the users table is empty the new user is auto-admin
 * (unless an explicit role is provided). Subsequent users default to "user".
 *
 * Throws on empty username/password or username collision.
 */
export function registerUser(
  queries: DbQueries,
  input: RegisterUserInput,
): User {
  const username = String(input.username ?? "").trim();
  const password = String(input.password ?? "");
  if (!username) {
    throw new Error("username is required");
  }
  if (!password) {
    throw new Error("password is required");
  }
  if (queries.getUserByUsername(username)) {
    throw new Error(`username already taken: ${username}`);
  }
  const passwordHash = hashPassword(password);
  const createInput: CreateUserInput = {
    username,
    passwordHash,
  };
  if (input.role !== undefined) createInput.role = input.role;
  if (input.email !== undefined) createInput.email = input.email;
  return queries.createUser(createInput);
}

/**
 * Verify credentials and mint an API token bound to the user.
 * Returns null when username is unknown or password is wrong.
 * Token plaintext surfaces only in the return value (P8b contract).
 */
const DUMMY_PASSWORD_HASH = `${"00".repeat(SALT_BYTES)}:${"00".repeat(SCRYPT_KEYLEN)}`;

export async function loginUser(
  queries: DbQueries,
  username: string,
  password: string,
  opts: { allowGlobalForAnyUser?: boolean } = {},
): Promise<{ user: User; tokens: { token: string; tokenHash: string; projectId: string | null }[] } | null> {
  const user = queries.getUserByUsername(String(username ?? "").trim());
  // Always run one scrypt, even for an unknown username, so response timing does
  // not become a useful username-enumeration oracle.
  const passwordOk = await verifyPasswordAsync(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordOk) return null;

  // Admins (and auth-off local bootstrap) get one global write token. Non-admins
  // get one project-scoped token per membership; with no memberships they get
  // no token (caller returns 403).
  if (user.role === "admin" || opts.allowGlobalForAnyUser) {
    const created = queries.createApiToken({
      userId: user.id,
      label: `login:${user.username}`,
      readOnly: false,
    });
    return {
      user,
      tokens: [{ token: created.token, tokenHash: created.tokenHash, projectId: null }],
    };
  }

  const projectIds = queries.listUserProjectIds(user.id);
  const tokens = projectIds.map((projectId) => {
    const created = queries.createApiToken({
      userId: user.id,
      projectId,
      label: `login:${user.username}:${projectId}`,
      readOnly: false,
    });
    return { token: created.token, tokenHash: created.tokenHash, projectId };
  });
  return { user, tokens };
}

/**
 * True when the user has the admin role.
 */
export function isAdmin(user: User | PublicUser | null | undefined): boolean {
  return user?.role === "admin";
}

/**
 * Resolve the User for a verified bearer token (via token.userId).
 * Returns null when the token has no user binding or the user is gone.
 */
export function userFromAuth(
  queries: DbQueries,
  auth: { userId: string | null } | null | undefined,
): User | null {
  if (!auth?.userId) return null;
  return queries.getUser(auth.userId);
}

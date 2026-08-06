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

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
  if (!stored || typeof stored !== "string") return false;
  const idx = stored.indexOf(":");
  if (idx <= 0) return false;
  const saltHex = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
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
export function loginUser(
  queries: DbQueries,
  username: string,
  password: string,
): { user: User; token: string; tokenHash: string } | null {
  const user = queries.getUserByUsername(String(username ?? "").trim());
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  const created = queries.createApiToken({
    userId: user.id,
    label: `login:${user.username}`,
    readOnly: false,
  });
  return {
    user,
    token: created.token,
    tokenHash: created.tokenHash,
  };
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

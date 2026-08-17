/**
 * P9-settings hardening tests (plan/api.md §Auth / §Projects export, plan/ui.md §Settings).
 *
 * The build shipped auth-users + settings-routes + export-bundle without tests
 * (verifier flagged the gap; createHash import bug slipped through for exactly
 * this reason). This pins:
 *
 *  1. Password hashing: scrypt round-trip + timing-safe verify; rejects
 *     malformed stored hashes / wrong passwords (no plaintext/md5/sha1).
 *  2. registerUser bootstrap: first user → admin, subsequent → user;
 *     rejects empty username/password + duplicate usernames; explicit role
 *     overrides bootstrap.
 *  3. loginUser mints a token only on correct password; returns null on
 *     unknown user / wrong password.
 *  4. toPublicUser strips passwordHash (never in API responses).
 *  5. isAdmin role gating.
 *  6. Settings: get/set round-trips JSON; key NAMES only (never values).
 *  7. buildExportBundle: NEVER bundle webhook secrets / api token_hash /
 *     plaintext token — secrets stripped even when storage contains them
 *     (defense-in-depth second-pass strip). Includes signed path manifest.
 *
 * Uses the real SqliteQueries (Drizzle) path via openDb so the strip runs
 * against actual persisted rows, not just the memory fallback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type OpenDbResult } from "../src/db/index.ts";
import {
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  toPublicUser,
  isAdmin,
} from "../src/api/auth-users.ts";
import {
  buildExportBundle,
  SETTINGS_KEYS,
} from "../src/api/settings-routes.ts";
import type { User } from "../src/db/queries.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Synchronous temp dir: openDb is sync, so the dir must exist before it runs. */
function open(): { res: OpenDbResult; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-settings-"));
  tempDirs.push(dataDir);
  return { res: openDb(dataDir), dataDir };
}

describe("password hashing (scrypt)", () => {
  it("hashPassword + verifyPassword round-trip a correct password", () => {
    const stored = hashPassword("correct horse battery");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // saltHex:hashHex — no plaintext
    expect(stored).not.toContain("correct horse battery");
    expect(verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("rejects a wrong password (timing-safe compare, returns false)", () => {
    const stored = hashPassword("hunter2");
    expect(verifyPassword("hunter3", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("returns false for malformed stored hashes (never throws)", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "no-colon-here")).toBe(false);
    expect(verifyPassword("x", ":missingSalt")).toBe(false);
    expect(verifyPassword("x", "zzz:not-hex")).toBe(false);
    expect(verifyPassword("x", "deadbeef:cafe")).toBe(false); // hex but wrong length/unknown
  });

  it("produces a unique salt per hash (same password → different stored)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});

describe("registerUser (bootstrap + role gating)", () => {
  it("first user is auto-admin; second defaults to user", async () => {
    const { res } = open();
    const first = registerUser(res.queries, { username: "alice", password: "pw1" });
    expect(first.role).toBe("admin");
    expect(first.passwordHash).toMatch(/:/); // scrypt format
    expect(listUserNames(res)).toEqual(["alice"]);

    const second = registerUser(res.queries, { username: "bob", password: "pw2" });
    expect(second.role).toBe("user");
    expect(isAdmin(second)).toBe(false);
  });

  it("explicit role overrides the bootstrap default", async () => {
    const { res } = open();
    const u = registerUser(res.queries, {
      username: "root",
      password: "pw",
      role: "admin",
    });
    // First user would be admin anyway; force a non-admin first to check override.
    expect(u.role).toBe("admin");
    const u2 = registerUser(res.queries, {
      username: "svc",
      password: "pw",
      role: "admin",
    });
    expect(u2.role).toBe("admin");
  });

  it("rejects empty username / empty password", async () => {
    const { res } = open();
    expect(() => registerUser(res.queries, { username: "", password: "pw" })).toThrow(/username/i);
    expect(() => registerUser(res.queries, { username: "  ", password: "pw" })).toThrow(/username/i);
    expect(() => registerUser(res.queries, { username: "x", password: "" })).toThrow(/password/i);
  });

  it("rejects duplicate usernames", async () => {
    const { res } = open();
    registerUser(res.queries, { username: "dupe", password: "pw" });
    expect(() => registerUser(res.queries, { username: "dupe", password: "pw2" })).toThrow(/already taken/);
  });

  it("password is stored as a scrypt hash, never plaintext/md5/sha1", async () => {
    const { res } = open();
    const u = registerUser(res.queries, { username: "sec", password: "plaintext-secret" });
    // The plaintext MUST NOT appear in the stored hash.
    expect(u.passwordHash).not.toContain("plaintext-secret");
    // md5=32 hex, sha1=40 hex (no colon); scrypt here is saltHex:64-byte-hashHex.
    expect(u.passwordHash.includes(":")).toBe(true);
  });
});

describe("loginUser (token mint path)", () => {
  it("returns user + token on correct credentials; null on wrong/unknown", async () => {
    const { res } = open();
    registerUser(res.queries, { username: "loginuser", password: "good" });
    const ok = loginUser(res.queries, "loginuser", "good");
    expect(ok).not.toBeNull();
    expect(ok!.user.username).toBe("loginuser");
    expect(typeof ok!.token).toBe("string");
    expect(ok!.token.length).toBeGreaterThan(0);
    expect(ok!.tokenHash).toBeTruthy();
    // The plaintext token is NOT the hash.
    expect(ok!.token).not.toBe(ok!.tokenHash);

    expect(loginUser(res.queries, "loginuser", "bad")).toBeNull();
    expect(loginUser(res.queries, "nobody", "good")).toBeNull();
  });
});

describe("toPublicUser (API-safe user view)", () => {
  it("strips passwordHash; keeps id/username/role", async () => {
    const { res } = open();
    const u = registerUser(res.queries, { username: "pub", password: "pw" });
    const pub = toPublicUser(u as User);
    expect(pub.passwordHash).toBeUndefined();
    expect(pub.username).toBe("pub");
    expect(pub.role).toBe("admin");
  });
});

describe("settings (key/value JSON)", () => {
  it("set/get round-trips JSON values + names-only key list (never secret values)", async () => {
    const { res } = open();
    res.queries.setSetting(SETTINGS_KEYS.defaultModels, { coding: "claude-sonnet-5" });
    res.queries.setSetting(SETTINGS_KEYS.limits, { maxRuns: 5 });
    // keyNames stores NAMES only — never the secret value.
    res.queries.setSetting(SETTINGS_KEYS.keyNames, ["ANTHROPIC_AUTH_TOKEN"]);

    const models = res.queries.getSetting(SETTINGS_KEYS.defaultModels);
    expect(models).toEqual({ coding: "claude-sonnet-5" });

    const limits = res.queries.getSetting(SETTINGS_KEYS.limits);
    expect(limits).toEqual({ maxRuns: 5 });

    const names = res.queries.getSetting(SETTINGS_KEYS.keyNames);
    expect(names).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    // Critically: the KEY NAME is stored, never "sk-ant-..." value.
    const all = JSON.stringify(res.queries.getSetting(SETTINGS_KEYS.keyNames));
    expect(all).not.toMatch(/sk-ant-/);
  });
});

describe("buildExportBundle (secret-strip invariant)", () => {
  it("NEVER bundles webhook secrets / api token_hash / plaintext tokens", async () => {
    const { res, dataDir } = open();
    const project = res.queries.createProject({
      name: "ExportProj",
      slug: "export-proj",
    });

    // Seed a watcher rule WITH a webhook secret (stored; must be stripped on export).
    res.queries.createWatcherRule(project.id, {
      role: "source",
      repo: "acme/repo",
      trigger: "push",
      action: { kind: "start_eval", ref: "main" },
      webhookSecret: "super-secret-webhook-value-do-not-leak",
    });

    // Seed an API token (hash stored; plaintext returned once at creation).
    const created = res.queries.createApiToken({
      userId: null,
      label: "ci",
      readOnly: false,
    });
    expect(typeof created.token).toBe("string");

    // Also create a user (password_hash must never leave via export either).
    const user = registerUser(res.queries, { username: "bundled", password: "pw-export-secret" });

    const bundle = buildExportBundle(res.queries, dataDir, project.id);

    // --- Serialized bundle must contain NO secret VALUES. ---
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("super-secret-webhook-value-do-not-leak");
    expect(serialized).not.toContain("pw-export-secret");
    expect(serialized).not.toContain(created.token); // plaintext token
    expect(serialized).not.toContain(created.tokenHash); // token_hash

    // --- Structural: watchers have inbound webhook secret forced to null. ---
    for (const w of bundle.watchers) {
      const ww = w as { webhookSecret?: unknown };
      expect(ww.webhookSecret).toBeNull();
    }

    // --- User password hashes never travel in a project export bundle ---
    // (exportRows returns project-scoped data; users are global, not bundled),
    // so assert the bundle doesn't accidentally include a passwordHash at all.
    expect(serialized).not.toContain("passwordHash");

    // --- Path manifest is present + signed (sha256, deterministic for the path set). ---
    expect(bundle.manifest.algorithm).toBe("sha256");
    expect(bundle.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.manifest.pathCount).toBe(bundle.paths.length);
    const expectedDigest = createHash("sha256")
      .update(JSON.stringify({ projectId: project.id, paths: bundle.paths }), "utf8")
      .digest("hex");
    expect(bundle.manifest.digest).toBe(expectedDigest);

    // Sanity: the seeded user id isn't leaked via the export bundle either.
    expect(serialized).not.toContain(user.id);
  });
});

// Helper: list usernames in creation order (exercises listUsers surface).
function listUserNames(res: OpenDbResult): string[] {
  return res.queries
    .listUsers()
    .map((u) => u.username)
    .filter((n): n is string => Boolean(n));
}

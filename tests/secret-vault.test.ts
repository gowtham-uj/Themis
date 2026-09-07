/**
 * Credential vault: encrypted at rest, decrypted into the process environment.
 *
 * The console accepts a pasted key so an operator does not have to export one
 * before starting the server. This pins the parts that matter:
 *
 *  1. A stored value round-trips through the environment on load.
 *  2. The settings row holds no plaintext.
 *  3. An ambient variable of the same name wins over a stored one.
 *  4. Names that change how processes execute are refused.
 *  5. Delete removes the row and clears the variable.
 *
 * Values here are synthetic strings, never real credentials.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type OpenDbResult } from "../src/db/index.ts";
import {
  assertStorableEnvName,
  deleteSecret,
  listSecrets,
  loadSecretsIntoEnv,
  putSecret,
} from "../src/config/secret-vault.ts";

const SYNTHETIC = "sk-test-0000000000000000000000000000";
const VAR = "AGENTEVAL_TEST_VAULT_KEY";

const tempDirs: string[] = [];
afterEach(() => {
  delete process.env[VAR];
  delete process.env.AGENTEVAL_SECRET_KEY;
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function open(): OpenDbResult {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-vault-"));
  tempDirs.push(dataDir);
  return openDb(dataDir);
}

describe("secret vault", () => {
  it("round-trips a stored value into the environment on load", () => {
    const { queries } = open();
    putSecret(queries, VAR, SYNTHETIC);
    delete process.env[VAR];

    expect(loadSecretsIntoEnv(queries)).toEqual({ loaded: 1, failed: 0 });
    expect(process.env[VAR]).toBe(SYNTHETIC);
  });

  it("stores no plaintext in the settings row", () => {
    const { queries } = open();
    putSecret(queries, VAR, SYNTHETIC);

    const raw = JSON.stringify(queries.getSetting("secrets.vault"));
    expect(raw).not.toContain(SYNTHETIC);
    expect(raw).toContain(VAR);
  });

  it("lists names and write times, never values", () => {
    const { queries } = open();
    putSecret(queries, VAR, SYNTHETIC);

    const listed = listSecrets(queries);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe(VAR);
    expect(JSON.stringify(listed)).not.toContain(SYNTHETIC);
  });

  it("leaves an ambient variable of the same name alone", () => {
    const { queries } = open();
    putSecret(queries, VAR, SYNTHETIC);
    process.env[VAR] = "exported-by-the-operator";

    loadSecretsIntoEnv(queries);
    expect(process.env[VAR]).toBe("exported-by-the-operator");
  });

  it("refuses names that change how processes execute", () => {
    const { queries } = open();
    for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "PATH", "AGENTEVAL_SECRET_KEY"]) {
      expect(() => putSecret(queries, name, SYNTHETIC)).toThrow();
    }
    expect(() => assertStorableEnvName("2BAD")).toThrow();
    expect(() => assertStorableEnvName("has-a-dash")).toThrow();
  });

  it("deletes a stored value and clears the variable", () => {
    const { queries } = open();
    putSecret(queries, VAR, SYNTHETIC);
    expect(process.env[VAR]).toBe(SYNTHETIC);

    expect(deleteSecret(queries, VAR)).toBe(true);
    expect(process.env[VAR]).toBeUndefined();
    expect(listSecrets(queries)).toEqual([]);
    expect(deleteSecret(queries, VAR)).toBe(false);
  });

  it("uses the operator key when AGENTEVAL_SECRET_KEY is set", () => {
    process.env.AGENTEVAL_SECRET_KEY = "operator-managed-key-material";
    const { queries } = open();
    putSecret(queries, VAR, SYNTHETIC);
    delete process.env[VAR];

    expect(loadSecretsIntoEnv(queries).loaded).toBe(1);
    expect(process.env[VAR]).toBe(SYNTHETIC);

    // A different operator key cannot decrypt what the first one wrote.
    delete process.env[VAR];
    process.env.AGENTEVAL_SECRET_KEY = "a-different-key";
    expect(loadSecretsIntoEnv(queries)).toEqual({ loaded: 0, failed: 1 });
    expect(process.env[VAR]).toBeUndefined();
  });
});

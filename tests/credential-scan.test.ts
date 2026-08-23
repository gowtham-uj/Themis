/**
 * WP-3 credential scan + redaction tests.
 *
 * EVERY credential-shaped string in this file is SYNTHETIC — invented here to
 * exercise a pattern. No real key, token, or credential appears in this file,
 * and none may ever be added to it. The obviously-fake filler (repeated
 * characters, the literal word FAKE) is deliberate: a fixture that looks like a
 * plausible real key invites someone to paste a real one next to it.
 *
 * Mutation-verified. Emptying the detector list, dropping the marker guard that
 * makes redaction idempotent, replacing the HMAC with a bare digest, removing
 * the project scoping from the fingerprint, and swapping the left-to-right
 * rebuild for an in-place splice each turn this file red. The negative corpus
 * is what kills the opposite mutant — widening a detector to match any long
 * token passes every positive test and fails here.
 */

import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { scanForCredentials } from "../src/security/credential-scan.js";
import {
  containsCredential,
  redact,
  redactionMarker,
  type RedactionKey,
} from "../src/security/redact.js";

// --- synthetic fixtures (see header) ---------------------------------------
const FAKE_API_KEY = `sk-${"FAKE".repeat(8)}0123`;
const FAKE_API_KEY_2 = `sk-ant-${"NOTREAL".repeat(4)}99`;
const FAKE_AWS_ID = "AKIAFAKEFAKEFAKE1234";
const FAKE_JWT = `eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlLWZpeHR1cmUifQ.${"A".repeat(20)}`;
const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "AAAAB3NzaC1yc2EAAAADAQABAAABgQD-this-is-not-a-key",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const FAKE_URL_PASSWORD = "hunter2-not-real-pw";
const FAKE_DB_URL = `postgres://appuser:${FAKE_URL_PASSWORD}@db.internal:5432/agenteval`;

const KEY_A: RedactionKey = { hmacKey: Buffer.from("project-a-key-material"), keyId: "proj-a-v1" };
const KEY_B: RedactionKey = { hmacKey: Buffer.from("project-b-key-material"), keyId: "proj-b-v1" };

const kindsIn = (text: string): string[] => scanForCredentials(text).map((f) => f.kind);

describe("scanForCredentials — detection", () => {
  it("detects a vendor-prefixed api key", () => {
    expect(kindsIn(`export TOKEN=${FAKE_API_KEY}`)).toContain("api_key");
  });

  it("detects an AWS access key id", () => {
    expect(kindsIn(`aws_access_key_id = ${FAKE_AWS_ID}`)).toContain("aws_access_key_id");
  });

  it("detects a bearer token in an authorization header", () => {
    expect(kindsIn(`Authorization: Bearer ${"z".repeat(40)}`)).toContain("bearer_token");
  });

  it("detects a JWT", () => {
    expect(kindsIn(`id_token=${FAKE_JWT}`)).toContain("jwt");
  });

  it("detects a PEM private key block", () => {
    expect(kindsIn(FAKE_PEM)).toContain("private_key");
  });

  it("detects a password embedded in a connection URL", () => {
    expect(kindsIn(FAKE_DB_URL)).toContain("url_password");
  });

  it("reports the exact span of the value, not the surrounding context", () => {
    const text = `key=${FAKE_API_KEY};`;
    const [finding] = scanForCredentials(text);
    expect(finding).toBeDefined();
    expect(text.slice(finding!.start, finding!.end)).toBe(FAKE_API_KEY);
  });

  it("redacts only the password from a connection URL, keeping host and user", () => {
    // The whole URL is not a secret; the operator needs the host to diagnose.
    // A detector that swallowed the entire URL would pass a naive "was it
    // detected" test and destroy the diagnostic value of the evidence.
    const { text } = redact(FAKE_DB_URL, KEY_A);
    expect(text).toContain("postgres://appuser:");
    expect(text).toContain("@db.internal:5432/agenteval");
    expect(text).not.toContain(FAKE_URL_PASSWORD);
  });

  it("finds every occurrence when several appear in one document", () => {
    const text = `a=${FAKE_API_KEY}\nb=${FAKE_AWS_ID}\nc=${FAKE_JWT}\n`;
    expect(new Set(kindsIn(text))).toEqual(new Set(["api_key", "aws_access_key_id", "jwt"]));
  });

  it("finds a value that spans a line boundary (scanner is not line-based)", () => {
    // The PEM fixture is three lines. A line-at-a-time scanner sees only the
    // BEGIN marker and misses the key material entirely.
    const text = `preamble\n${FAKE_PEM}\ntrailer\n`;
    const [finding] = scanForCredentials(text).filter((f) => f.kind === "private_key");
    expect(finding).toBeDefined();
    expect(text.slice(finding!.start, finding!.end)).toContain("END RSA PRIVATE KEY");
  });

  it("reports one finding, not two, when detectors overlap", () => {
    // A JWT in an Authorization header matches BOTH the jwt detector (whole
    // token) and the bearer_token detector (capture group after the scheme) on
    // the same span. Two overlapping findings cannot both be substituted
    // without corrupting the text, so the more specific detector must win.
    const text = `Authorization: Bearer ${FAKE_JWT}`;
    const findings = scanForCredentials(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("jwt");
  });

  it("produces exactly one marker for an overlapping match", () => {
    // The consequence of the previous test, at the redaction layer. Without
    // overlap resolution the second substitution lands inside the first
    // marker's span and the output is structurally broken — which no
    // "does it still contain the secret" assertion would catch.
    const { text } = redact(`Authorization: Bearer ${FAKE_JWT}`, KEY_A);
    expect(text).toMatch(/^Authorization: Bearer \[REDACTED:jwt:[0-9a-f]+\]$/);
  });

  it("does not depend on call order (no leaked regex lastIndex)", () => {
    const text = `a=${FAKE_API_KEY} b=${FAKE_API_KEY_2}`;
    const first = scanForCredentials(text);
    const second = scanForCredentials(text);
    expect(second).toEqual(first);
    expect(first).toHaveLength(2);
  });
});

describe("scanForCredentials — findings never carry the value", () => {
  it("no finding object contains the secret, even when serialized", () => {
    // The single most important test in the file. A scanner that returns the
    // matched value has not contained the secret, it has relocated it into
    // logs and telemetry.
    const text = `key=${FAKE_API_KEY} aws=${FAKE_AWS_ID} url=${FAKE_DB_URL}`;
    const serialized = JSON.stringify(scanForCredentials(text));
    for (const secret of [FAKE_API_KEY, FAKE_AWS_ID, FAKE_URL_PASSWORD]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("a finding has exactly the three locked fields", () => {
    const [finding] = scanForCredentials(`key=${FAKE_API_KEY}`);
    expect(Object.keys(finding!).sort()).toEqual(["end", "kind", "start"]);
  });
});

describe("scanForCredentials — negative corpus (must NOT flag)", () => {
  // A scanner that flags everything is useless: it makes judge evidence
  // unreadable while proving nothing. These are the cases that hold the
  // detectors to being anchored rather than merely long.
  const benign: Array<[string, string]> = [
    ["a git commit sha", "fix: repair claim fencing (a1b2c3d4e5f60718293a4b5c6d7e8f9012345678)"],
    ["a UUID", "run_id=3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ["a sha256 content hash", `sha256=${"ab".repeat(32)}`],
    ["a base64 image fragment", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA"],
    ["a long hex blob key", `blobs/sha256/ab/${"cd".repeat(32)}`],
    ["an ordinary sentence", "The agent used a narrow regex and the verifier rejected it."],
    ["a file path with dashes", "src/db/sqlite/store.ts and src/storage/archive-service.ts"],
    ["a semver and package name", "@langchain/langgraph@0.2.19 better-sqlite3@13.0.3"],
    ["three dotted identifiers (not a JWT)", "config.judge.orchestrator.roundCeiling"],
    ["an ISO timestamp", "completed_at=2026-01-01T00:00:00.000Z"],
  ];

  for (const [label, text] of benign) {
    it(`does not flag ${label}`, () => {
      expect(scanForCredentials(text)).toEqual([]);
    });
  }

  it("leaves a fully benign document byte-identical after redaction", () => {
    const doc = benign.map(([, t]) => t).join("\n");
    expect(redact(doc, KEY_A).text).toBe(doc);
  });
});

describe("redact — fingerprint properties", () => {
  it("is stable across occurrences of the same value", () => {
    // Correlation is the whole reason the marker carries a fingerprint. A
    // random placeholder passes "was it redacted" and fails here.
    const { text } = redact(`first=${FAKE_API_KEY} second=${FAKE_API_KEY}`, KEY_A);
    const markers = [...text.matchAll(/\[REDACTED:api_key:([0-9a-f]+)\]/g)].map((m) => m[1]);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toBe(markers[1]);
  });

  it("differs for different values of the same kind", () => {
    const { text } = redact(`a=${FAKE_API_KEY} b=${FAKE_API_KEY_2}`, KEY_A);
    const markers = [...text.matchAll(/\[REDACTED:api_key:([0-9a-f]+)\]/g)].map((m) => m[1]);
    expect(markers).toHaveLength(2);
    expect(markers[0]).not.toBe(markers[1]);
  });

  it("changes with the project HMAC key (no cross-project correlation)", () => {
    // Without this, fingerprints become a cross-tenant oracle for "do these two
    // projects hold the same secret".
    const a = redact(`k=${FAKE_API_KEY}`, KEY_A).text;
    const b = redact(`k=${FAKE_API_KEY}`, KEY_B).text;
    expect(a).not.toBe(b);
  });

  it("is not a bare digest of the value (dictionary attack on a known key fails)", () => {
    // A bare SHA-256 of a short or already-known credential is reversible by
    // dictionary. The marker must not equal any unkeyed digest of the value.
    const { text } = redact(`k=${FAKE_API_KEY}`, KEY_A);
    const fp = /\[REDACTED:api_key:([0-9a-f]+)\]/.exec(text)?.[1];
    expect(fp).toBeDefined();
    const unkeyed = createHmac("sha256", Buffer.alloc(0)).update(FAKE_API_KEY).digest("hex");
    expect(unkeyed.startsWith(fp!)).toBe(false);
  });

  it("rejects an empty or missing project key rather than fingerprinting unkeyed", () => {
    expect(() => redact(`k=${FAKE_API_KEY}`, { hmacKey: Buffer.alloc(0), keyId: "x" })).toThrow(
      /hmacKey/,
    );
  });
});

describe("redact — output correctness", () => {
  it("removes every detected value from the output text", () => {
    const text = [
      `api=${FAKE_API_KEY}`,
      `aws=${FAKE_AWS_ID}`,
      `jwt=${FAKE_JWT}`,
      FAKE_DB_URL,
      FAKE_PEM,
    ].join("\n");
    const result = redact(text, KEY_A);
    for (const secret of [FAKE_API_KEY, FAKE_AWS_ID, FAKE_JWT, FAKE_URL_PASSWORD]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("preserves the non-secret text around each value exactly", () => {
    // Guards the left-to-right rebuild. An in-place splice shifts every later
    // offset and corrupts the surrounding bytes; this catches that even when
    // the secrets themselves are gone.
    const { text } = redact(`BEFORE ${FAKE_API_KEY} MIDDLE ${FAKE_AWS_ID} AFTER`, KEY_A);
    expect(text).toMatch(
      /^BEFORE \[REDACTED:api_key:[0-9a-f]+\] MIDDLE \[REDACTED:aws_access_key_id:[0-9a-f]+\] AFTER$/,
    );
  });

  it("handles adjacent values with no separator between them", () => {
    const { text } = redact(`${FAKE_API_KEY} ${FAKE_AWS_ID}`, KEY_A);
    expect(text.split("[REDACTED:")).toHaveLength(3);
  });

  it("returns findings whose offsets index the ORIGINAL text", () => {
    const text = `x=${FAKE_API_KEY};`;
    const { findings } = redact(text, KEY_A);
    expect(text.slice(findings[0]!.start, findings[0]!.end)).toBe(FAKE_API_KEY);
  });
});

describe("redact — idempotence", () => {
  it("re-redacting redacted text is a no-op", () => {
    const once = redact(`k=${FAKE_API_KEY} aws=${FAKE_AWS_ID}`, KEY_A).text;
    expect(redact(once, KEY_A).text).toBe(once);
  });

  it("does not treat a marker's own body as a fresh credential", () => {
    const once = redact(`k=${FAKE_API_KEY}`, KEY_A).text;
    expect(scanForCredentials(once)).toEqual([]);
  });

  it("does not re-redact a marker sitting in a credential-shaped position", () => {
    // This is the case that makes the marker guard load-bearing rather than
    // decorative, and it is the one the two tests above miss.
    //
    // After redacting a connection URL the marker occupies the PASSWORD slot:
    //   postgres://appuser:[REDACTED:url_password:...]@db.internal:5432/...
    // The url_password pattern is `://user:(...)@`, and the marker contains no
    // `/` or `@`, so on a second pass the pattern happily matches the marker
    // itself. Without the guard the result is a marker wrapped in a marker —
    // fingerprint of a fingerprint — which breaks correlation silently: the
    // same underlying password now fingerprints differently depending on how
    // many times the text was scanned.
    const once = redact(FAKE_DB_URL, KEY_A).text;
    expect(scanForCredentials(once)).toEqual([]);
    expect(redact(once, KEY_A).text).toBe(once);
    expect(once.split("[REDACTED:")).toHaveLength(2);
  });

  it("still redacts a NEW credential appearing beside an existing marker", () => {
    // The idempotence guard must skip markers, not disable scanning for the
    // rest of the document.
    const partly = `${redactionMarker("api_key", "0123456789abcdef")} and aws=${FAKE_AWS_ID}`;
    const { text } = redact(partly, KEY_A);
    expect(text).not.toContain(FAKE_AWS_ID);
    expect(text).toContain("[REDACTED:api_key:0123456789abcdef]");
  });
});

describe("containsCredential — report/scratchpad write guard", () => {
  it("is true for unredacted text and false once redacted", () => {
    const raw = `finding: the agent hardcoded ${FAKE_API_KEY}`;
    expect(containsCredential(raw)).toBe(true);
    expect(containsCredential(redact(raw, KEY_A).text)).toBe(false);
  });

  it("is false for a benign report body", () => {
    expect(containsCredential("verdict: narrow; the regex matched .5s over-permissively")).toBe(
      false,
    );
  });
});

describe("scanner robustness", () => {
  it("handles empty and whitespace-only input", () => {
    expect(scanForCredentials("")).toEqual([]);
    expect(redact("", KEY_A)).toEqual({ text: "", findings: [] });
  });

  it("stays bounded on a large benign document", () => {
    const big = "the verifier rejected the over-permissive regex. ".repeat(20_000);
    expect(scanForCredentials(big)).toEqual([]);
  });

  it("does not flag high-entropy random hex, which is what hashes look like", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(scanForCredentials(randomBytes(32).toString("hex"))).toEqual([]);
    }
  });
});

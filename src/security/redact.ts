/**
 * WP-3 deterministic redactor (plan §13).
 *
 * Replaces every detected credential with `[REDACTED:<kind>:<fingerprint>]`,
 * where the fingerprint is a truncated project-scoped HMAC-SHA256 of the raw
 * value. Two properties are load-bearing and pull in opposite directions:
 *
 *   - CORRELATABLE: the same value in two places yields the same fingerprint,
 *     so a judge reading redacted evidence can still see that the key used in
 *     the setup step is the key that leaked in the trace. A random placeholder
 *     would destroy that and make the evidence far less useful.
 *   - NOT CORRELATABLE ACROSS PROJECTS: the HMAC key is project-scoped, so the
 *     same underlying secret fingerprints differently in two projects. Without
 *     this, fingerprints would become a cross-tenant oracle for "do these two
 *     projects hold the same credential", which is exactly the join a plain
 *     hash of the value would hand out for free.
 *
 * HMAC rather than a bare digest for the same reason: a bare SHA-256 of a
 * short, low-entropy, or already-known credential is trivially reversible by
 * dictionary. The secret HMAC key is what makes the fingerprint one-way in
 * practice and not merely in principle.
 *
 * The output is deliberately shorter than the input, so this is a publication
 * transform, not a byte-range transform. Plan §10 forbids applying it after
 * selecting a raw range for exactly that reason: the public derivative is a
 * separate content-addressed blob with its own length and ETag.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { type CredentialKind, type Finding, scanForCredentials } from "./credential-scan.js";

/** Project-scoped redaction key material. `keyId` is recorded alongside the
 *  derivative blob so a later reader knows which key produced a fingerprint;
 *  it is an identifier, never the key itself. */
export interface RedactionKey {
  hmacKey: Buffer;
  keyId: string;
}

export interface RedactionResult {
  text: string;
  findings: Finding[];
}

/**
 * Fingerprint length in hex characters. 16 hex chars = 64 bits, which is far
 * beyond collision range for the number of distinct credentials in one project
 * while keeping the marker short enough to stay readable inside evidence.
 */
const FINGERPRINT_HEX_LENGTH = 16;

/** Deterministic project-scoped fingerprint of one raw value. */
function fingerprint(value: string, key: RedactionKey): string {
  return createHmac("sha256", key.hmacKey)
    .update(value, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_LENGTH);
}

/** The typed marker substituted for one credential. */
export function redactionMarker(kind: CredentialKind, fp: string): string {
  return `[REDACTED:${kind}:${fp}]`;
}

/**
 * Replace every detected credential in `text` with a typed, fingerprinted
 * marker. Idempotent: re-redacting already-redacted text is a no-op, because
 * the scanner refuses to match inside an existing marker.
 */
export function redact(text: string, key: RedactionKey): RedactionResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : "", findings: [] };
  }
  if (!Buffer.isBuffer(key?.hmacKey) || key.hmacKey.length === 0) {
    throw new Error("redact requires a non-empty project-scoped hmacKey");
  }

  const findings = scanForCredentials(text);
  if (findings.length === 0) return { text, findings };

  // Rebuild left-to-right rather than splicing in place: splicing would shift
  // every subsequent finding's offsets, and re-deriving them after each
  // substitution is how off-by-one corruption gets in.
  const ordered = [...findings].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const f of ordered) {
    parts.push(text.slice(cursor, f.start));
    parts.push(redactionMarker(f.kind, fingerprint(text.slice(f.start, f.end), key)));
    cursor = f.end;
  }
  parts.push(text.slice(cursor));

  return { text: parts.join(""), findings: ordered };
}

/**
 * True when `text` still contains a credential. Used by the report/scratchpad
 * write path, which must REJECT rather than silently redact: an agent emitting
 * a raw credential into a report is a bug worth surfacing, and quietly fixing
 * it would hide that the value reached a model context in the first place.
 */
export function containsCredential(text: string): boolean {
  return scanForCredentials(text).length > 0;
}

/**
 * Constant-time comparison of two fingerprints. Fingerprints are not secret,
 * but they are compared on paths that also compare key material, and a single
 * comparison helper avoids one of those call sites reaching for `===`.
 */
export function fingerprintsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

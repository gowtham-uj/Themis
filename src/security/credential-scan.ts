/**
 * WP-3 credential detector (plan §13).
 *
 * The load-bearing property is that a Finding NEVER carries the matched value.
 * A scanner whose result object holds the secret has not contained the secret —
 * it has moved it into whatever consumes findings: structured logs, telemetry,
 * an error payload, a test snapshot. The redactor is the only component that
 * ever sees a matched value, and it converts it to an HMAC fingerprint before
 * returning. So `Finding` is deliberately (kind, start, end) and nothing else,
 * and `tests/credential-scan.test.ts` asserts that the serialized finding does
 * not contain the secret substring.
 *
 * Detection is regex-based and therefore best-effort. That is stated rather than
 * hidden: this scanner is a defence-in-depth layer over KMS, private buckets,
 * and least-privilege IAM, not a proof that no credential escaped. The failure
 * mode it must avoid is the opposite one — flagging everything. A scanner that
 * redacts git SHAs and UUIDs makes evidence unreadable to the judge, so the
 * detectors are anchored and the negative corpus in the tests is what holds
 * them to it.
 */

/** What kind of credential a finding names. Stable: it appears in the redaction
 *  marker and therefore in published bytes. */
export type CredentialKind =
  | "api_key"
  | "aws_access_key_id"
  | "bearer_token"
  | "jwt"
  | "private_key"
  | "url_password";

/**
 * One detected credential, by POSITION AND KIND ONLY.
 *
 * There is intentionally no `value` field, and adding one would defeat the
 * module. `start` is inclusive, `end` exclusive, both in UTF-16 code units so
 * they index `text` directly.
 */
export interface Finding {
  kind: CredentialKind;
  start: number;
  end: number;
}

interface Detector {
  kind: CredentialKind;
  pattern: RegExp;
  /** Which capture group holds the secret itself; 0 means the whole match.
   *  Used so a detector can anchor on surrounding context (`Authorization: `,
   *  `://user:`) without redacting that context. */
  group: number;
}

/**
 * A base64url run long enough to be a real token. Kept as a fragment so the JWT
 * detector composes it three times rather than restating it.
 */
const B64URL = "[A-Za-z0-9_-]";

/**
 * Detectors run in order and earlier findings win an overlap (see `dedupe`).
 * The order therefore encodes specificity: a JWT sitting in an `Authorization`
 * header should report as `jwt`, not as the more generic `bearer_token`, so
 * `jwt` is listed first.
 */
const DETECTORS: readonly Detector[] = [
  // PEM blocks. Matched whole so the entire key material is replaced, not just
  // its header line. [\s\S] rather than . because the body is multi-line by
  // definition and a dot would stop at the first newline.
  {
    kind: "private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    group: 0,
  },
  // JWT: three base64url segments. The middle segment must start with `ey`
  // (i.e. a JSON object opening `{`), which is what separates a real JWT from
  // three unrelated dot-separated identifiers.
  {
    kind: "jwt",
    pattern: new RegExp(`\\bey${B64URL}{8,}\\.ey${B64URL}{8,}\\.${B64URL}{8,}\\b`, "g"),
    group: 0,
  },
  // AWS access key id: fixed prefix + exactly 16 uppercase alphanumerics. The
  // trailing boundary is explicit so a longer run does not match a prefix of
  // itself.
  { kind: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, group: 0 },
  // Vendor-prefixed API keys (sk-…, pk-…, and the sk-ant-/sk-proj- variants).
  // The prefix is what makes this safe to anchor on; an unprefixed 40-char
  // token is indistinguishable from a hash and is deliberately NOT matched.
  {
    kind: "api_key",
    pattern: /\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{16,}\b/g,
    group: 0,
  },
  // Authorization header / bearer value. Anchored on the scheme so the header
  // name survives redaction and the log line stays diagnosable.
  {
    kind: "bearer_token",
    pattern: /\b(?:Bearer|Token)\s+([A-Za-z0-9._~+/=-]{12,})/gi,
    group: 1,
  },
  // Password inside a connection URL. Only the password group is redacted:
  // scheme, user, and host are operationally necessary and are not secrets.
  {
    kind: "url_password",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s/@]+)@/gi,
    group: 1,
  },
];

/** Drop findings that overlap an already-accepted one, keeping the earlier
 *  (more specific) detector's result. Two markers covering overlapping spans
 *  cannot both be substituted without corrupting the text. */
function dedupe(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : b.end - a.end,
  );
  const kept: Finding[] = [];
  let covered = -1;
  for (const f of sorted) {
    if (f.start >= covered) {
      kept.push(f);
      covered = f.end;
    }
  }
  return kept;
}

/** A span already occupied by a `[REDACTED:...]` marker. Re-scanning redacted
 *  text must not treat the marker's own body as a fresh credential, which is
 *  what makes `redact` idempotent. */
const MARKER_RE = /\[REDACTED:[a-z_]+:[0-9a-f]+\]/g;

/**
 * Find credential-shaped values in `text`, reporting position and kind only.
 * Never returns the matched bytes.
 */
export function scanForCredentials(text: string): Finding[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const markers: Array<[number, number]> = [];
  for (const m of text.matchAll(MARKER_RE)) {
    markers.push([m.index, m.index + m[0].length]);
  }
  const insideMarker = (start: number, end: number): boolean =>
    markers.some(([ms, me]) => start >= ms && end <= me);

  const found: Finding[] = [];
  for (const detector of DETECTORS) {
    // Fresh RegExp per call: the module-level literals carry /g and therefore
    // mutable lastIndex, which would make results depend on call order.
    const re = new RegExp(detector.pattern.source, detector.pattern.flags);
    for (const match of text.matchAll(re)) {
      const whole = match[0];
      const captured = detector.group === 0 ? whole : match[detector.group];
      if (captured === undefined) continue;
      const offset = detector.group === 0 ? 0 : whole.lastIndexOf(captured);
      const start = match.index + offset;
      const end = start + captured.length;
      if (insideMarker(start, end)) continue;
      found.push({ kind: detector.kind, start, end });
    }
  }
  return dedupe(found);
}

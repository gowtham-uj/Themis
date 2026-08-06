/**
 * Secret redaction for ingested canonical events.
 *
 * Every event that lands in `events.jsonl` is deep-cloned and scrubbed so
 * API keys, tokens, and long hex/base64 secrets never reach disk or SSE.
 *
 * Spec: plan/execution.md § Secrets, CLAUDE.md quality gate "No secrets in any
 * emitted artifact (redaction pass on ingest)".
 */

import type { CanonicalEvent } from "../schema/events.js";

/** Kind tag embedded in the replacement token `[REDACTED:<kind>]`. */
export type RedactionKind =
  | "api_key"
  | "anthropic_key"
  | "openai_key"
  | "bearer"
  | "env_secret"
  | "hex_secret"
  | "base64_secret"
  | "known_secret"
  | "token"
  | "secret";

/** Replacement written in place of a detected secret. */
export function redactedPlaceholder(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

/**
 * Exact secret strings the caller already knows (e.g. injected API keys).
 * Matched as whole-substring occurrences (case-sensitive).
 */
const knownSecrets = new Set<string>();

/**
 * Register one or more known secret values to scrub wherever they appear.
 * Values shorter than 8 characters are ignored (too collision-prone).
 */
export function registerKnownSecrets(
  ...secrets: Array<string | undefined | null>
): void {
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 8) {
      knownSecrets.add(s);
    }
  }
}

/** Clear the known-secret set (tests). */
export function clearKnownSecrets(): void {
  knownSecrets.clear();
}

/** Snapshot of currently registered known secrets (tests). */
export function listKnownSecrets(): string[] {
  return [...knownSecrets];
}

/**
 * Regex patterns that detect common secret shapes.
 * Order matters: more specific patterns first so the kind tag is accurate.
 *
 * Each entry: [kind, global regex]. The full match is replaced.
 */
export const SECRET_PATTERNS: ReadonlyArray<readonly [RedactionKind, RegExp]> = [
  // Anthropic keys: sk-ant-...
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g],
  // OpenAI / generic sk- keys (but not sk-ant- which already matched)
  ["api_key", /\bsk-(?!ant-)[A-Za-z0-9_\-]{16,}\b/g],
  // Bearer tokens in Authorization headers / free text
  ["bearer", /\bBearer\s+[A-Za-z0-9\-._~+\/]+=*/gi],
  // Env-style KEY=value for *_KEY / *_TOKEN / *_SECRET / API_KEY names
  [
    "env_secret",
    /\b(?:[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)|ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/g,
  ],
  // Long hex secrets (>24 hex chars) — likely keys/hashes of secrets
  ["hex_secret", /\b[0-9a-fA-F]{25,}\b/g],
  // Long base64-ish blobs (>24 chars of base64 alphabet, with optional padding)
  ["base64_secret", /\b[A-Za-z0-9+\/]{25,}={0,2}\b/g],
];

/**
 * Env-var name patterns whose *values* should be redacted when building
 * process env maps for logging / serialization.
 */
const ENV_SECRET_NAME =
  /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIALS?|_AUTH)$|^API_KEY$|^TOKEN$|^SECRET$|ANTHROPIC_API_KEY|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN/i;

/**
 * Scrub secrets from a single string. Never throws.
 * Returns the original string when no secret is found.
 */
export function redactString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;

  let out = input;
  try {
    // 1. Known exact secrets (longest first to avoid partial re-matches).
    if (knownSecrets.size > 0) {
      const sorted = [...knownSecrets].sort((a, b) => b.length - a.length);
      for (const secret of sorted) {
        if (out.includes(secret)) {
          out = out.split(secret).join(redactedPlaceholder("known_secret"));
        }
      }
    }

    // 2. Pattern set.
    for (const [kind, pattern] of SECRET_PATTERNS) {
      // Fresh lastIndex for global regexes.
      pattern.lastIndex = 0;
      if (kind === "env_secret") {
        // Replace only the value portion: NAME=VALUE → NAME=[REDACTED:env_secret]
        out = out.replace(pattern, (full, value: string) => {
          if (typeof value !== "string" || value.length === 0) {
            return redactedPlaceholder(kind);
          }
          return full.replace(value, redactedPlaceholder(kind));
        });
      } else {
        out = out.replace(pattern, redactedPlaceholder(kind));
      }
      pattern.lastIndex = 0;
    }
  } catch {
    // Never throw from redaction — return whatever we have.
  }
  return out;
}

/**
 * Whether `s` still contains a detectable secret (post-redaction check / tests).
 * Returns false for non-strings.
 */
export function looksLikeSecret(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  if (knownSecrets.has(s)) return true;
  for (const secret of knownSecrets) {
    if (s.includes(secret)) return true;
  }
  for (const [, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(s)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

/**
 * Redact an env map: any key matching *_KEY / *_TOKEN / etc. has its value
 * replaced with a redaction placeholder. Returns a new object.
 */
export function redactEnv(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== "object") return out;
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined || v === null) continue;
      const str = String(v);
      if (ENV_SECRET_NAME.test(k)) {
        // Prefer a more specific kind when the name is known.
        let kind: RedactionKind = "env_secret";
        if (/ANTHROPIC/i.test(k)) kind = "anthropic_key";
        else if (/OPENAI/i.test(k)) kind = "openai_key";
        else if (/TOKEN/i.test(k)) kind = "token";
        else if (/KEY/i.test(k)) kind = "api_key";
        out[k] = redactedPlaceholder(kind);
      } else {
        out[k] = redactString(str);
      }
    }
  } catch {
    // pass through empty on catastrophic failure
  }
  return out;
}

/**
 * Deep-clone `value` while scrubbing every string leaf with {@link redactString}.
 * Never throws; unknown / circular shapes pass through as best-effort.
 */
export function redactValue(value: unknown, seen?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value;
  if (typeof value !== "object") {
    // functions, symbols, etc. — drop / pass null-ish
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }

  const tracker = seen ?? new WeakSet<object>();
  if (tracker.has(value as object)) {
    // Cycle — return a shallow marker rather than throwing.
    return "[Circular]";
  }
  tracker.add(value as object);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, tracker));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Also scrub keys that look like secret names when values are strings.
      if (typeof v === "string" && ENV_SECRET_NAME.test(k)) {
        out[k] = redactedPlaceholder("env_secret");
      } else {
        out[k] = redactValue(v, tracker);
      }
    }
    return out;
  } catch {
    return value;
  }
}

/**
 * Deep-clone a CanonicalEvent and scrub secrets from every string-bearing
 * field (message.text, tool.call.args, tool.result.output, error.message,
 * log.message, run.start.params, thinking.text, exec.argv, net.url, …).
 *
 * Never throws. Unknown / malformed shapes pass through best-effort.
 */
export function redactEvent<T extends CanonicalEvent | Record<string, unknown>>(
  event: T,
): T {
  try {
    const cloned = redactValue(event);
    return (cloned ?? event) as T;
  } catch {
    return event;
  }
}

/**
 * Optional indicator: true when `before` and `after` differ (a redaction was
 * applied). Cheap string-compare of JSON forms.
 */
export function redactionApplied(before: unknown, after: unknown): boolean {
  try {
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch {
    return before !== after;
  }
}

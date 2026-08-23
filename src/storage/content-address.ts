/**
 * Content-addressing helpers for the archive store: streaming SHA-256 hashing,
 * sha256 hex validation/normalization, and canonical blob key derivation.
 * Pure functions only — no storage, caching, or upload logic.
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

/** Result of streaming a byte source through SHA-256. */
export interface StreamSha256Result {
  /** Lowercase 64-hex digest of all consumed bytes. */
  sha256: string;
  /** Total number of bytes hashed. */
  bytes: number;
}

/**
 * Hash a `Readable`/async-iterable source of chunks with bounded memory:
 * chunks are fed to `node:crypto` incrementally and never concatenated, so
 * peak memory is one chunk plus the hash state. Consumes the stream exactly
 * once (the stream ends in ended/error state when this returns).
 */
export async function streamSha256(
  source: Readable | AsyncIterable<Uint8Array>,
): Promise<StreamSha256Result> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    bytes += buf.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Matches exactly 64 lowercase hex characters. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Validate a sha256 hex string used across the codebase. Returns the input
 * unchanged when it is exactly 64 lowercase hex characters; `null` otherwise
 * (uppercase, wrong length, non-hex, or non-string input is rejected, never
 * silently normalized into a malformed key).
 */
export function normalizeSha256(input: unknown): string | null {
  if (typeof input !== "string" || !SHA256_HEX_RE.test(input)) return null;
  return input;
}

/**
 * Derive the canonical content-addressed blob key for a sha256:
 * `blobs/sha256/<first-two-hex>/<full-sha256>`. Throws on any input that is
 * not a valid 64-lowercase-hex sha256 rather than producing a malformed key.
 */
export function blobKey(sha256: string): string {
  const normalized = normalizeSha256(sha256);
  if (normalized === null) {
    throw new TypeError(
      `invalid sha256: expected 64 lowercase hex characters, got ${String(sha256)}`,
    );
  }
  return `blobs/sha256/${normalized.slice(0, 2)}/${normalized}`;
}

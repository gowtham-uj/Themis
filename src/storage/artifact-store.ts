/**
 * WP-2 artifact-store contract: a content-addressed object store for archive
 * blobs and immutable manifests. Types and the ArtifactStore interface only —
 * no backend logic lives in this file.
 *
 * LOCKED RULES (design §2 "Canonical content-addressed archive store" and
 * "Scale and correctness requirements"):
 *
 *  1. Blob keys are content-addressed: `blobs/sha256/<first-2-hex>/<full-sha256>`.
 *     Re-uploading identical bytes is idempotent because the key is the hash.
 *  2. Manifests are IMMUTABLE and content-derived. They never live at a fixed
 *     key that a retry can overwrite. The exact key and its sha256 are recorded
 *     in the generation row, so a recovery worker that re-uploads different
 *     bytes lands at a different key and can never clobber a published view.
 *     When a deterministic manifest key must be reused (the base generation),
 *     the upload uses If-None-Match where the provider supports it and treats a
 *     hash mismatch as a hard failure, never an overwrite; any adoption or read
 *     verifies the stored key/hash by fetching first.
 *  3. An S3 ETag is NEVER the sha256. Integrity is verified by the recorded
 *     checksum and byte length, never by ETag.
 *  4. Listing an S3 prefix is NEVER a catalog operation. Catalogs come from
 *     indexed metadata (PostgreSQL), never from scanning object keys.
 *  5. BOUNDED MEMORY is a contract requirement: every byte-bearing operation
 *     streams through fixed-size buffers. No implementation may materialize a
 *     whole object (no full-buffer hashing, no readFile + Buffer.concat of an
 *     entire object). Hashing is computed while streaming; incomplete multipart
 *     uploads are aborted and reaped, never leaked.
 *
 * Implementations live in local-artifact-store.ts (dev/test) and
 * s3-artifact-store.ts (production, `@aws-sdk/client-s3` against MinIO).
 * Nothing here is synchronous; nothing may block on async work.
 */

import type { Readable } from "node:stream";

/**
 * Byte window for a ranged read. `offset` is zero-based; `length` counts bytes
 * and is omitted to mean "through end of object". Ranges are over the stored
 * (public) representation; a range read is bounded by construction.
 */
export interface ByteRange {
  offset: number;
  /** Bytes to read; omitted reads through end of object. */
  length?: number;
}

/** Optional object metadata applied at write time. */
export interface ArtifactMetadata {
  /** Media type served for the stored bytes. */
  contentType?: string;
  /** Optional cache directives. */
  cacheControl?: string;
}

/**
 * Input to `ArtifactStore.put`. The source is streamed exactly once with a
 * bounded buffer; the store computes sha256 and byte length while streaming and
 * never buffers the whole object.
 */
export interface ArtifactPut {
  /** Streaming byte source. Must be consumed, never materialized in memory. */
  source: Readable;
  /**
   * Optional explicit object key.
   *
   * - Absent: the store derives the canonical blob key
   *   `blobs/sha256/<first-2-hex>/<full-sha256>` from the computed hash
   *   (idempotent for identical bytes).
   * - Present: used verbatim (e.g. immutable manifest keys such as
   *   `manifests/<run_id>/generation-1/<sha256>.manifest`). The store MUST
   *   still verify content and MUST NOT overwrite: a key holding identical
   *   bytes is an idempotent no-op (`alreadyExisted: true`); a key holding
   *   different bytes is a hard `immutable_key_conflict` failure, never an
   *   overwrite (If-None-Match where supported; correctness may not depend on
   *   that extension).
   */
  key?: string;
  /** Expected content hash. When present the store MUST verify the streamed
   *  hash matches and fail with `hash_mismatch` otherwise. */
  expectedSha256?: string;
  /** Expected byte length. When present the store MUST verify and fail with
   *  `length_mismatch` on divergence. */
  expectedBytes?: number;
  /**
   * Attempt-scoped staging key for a single-pass upload: bytes stream to the
   * staging key while hashing, are verified, then adopted at the final key and
   * staging is deleted. Staging prefixes are attempt-scoped, never
   * content-addressed, and never serve catalog or read paths. Attempts never
   * share staging keys.
   */
  stagingKey?: string;
  /** Optional object metadata. */
  metadata?: ArtifactMetadata;
}

/** Result of a successful `put`. */
export interface ArtifactPutResult {
  /** Canonical object key actually written. */
  key: string;
  /** sha256 of the stored bytes (computed while streaming, never an ETag). */
  sha256: string;
  /** Byte length of the stored object. */
  bytes: number;
  /** True when the object already existed at `key` with identical bytes. */
  alreadyExisted: boolean;
}

/**
 * Metadata-only probe of one object. Never fetches bytes.
 */
export type ArtifactHead =
  | { key: string; exists: false }
  | {
      key: string;
      exists: true;
      /** Byte length (Content-Length is authoritative). */
      bytes: number;
      /**
       * Stored checksum metadata; `null` when absent (never derived from an S3
       * ETag). Before adopting an existing CAS object, verify it against the
       * recorded checksum and length (design §2).
       */
      sha256: string | null;
      contentType: string | null;
    };

/** A streaming read of one object. */
export interface ArtifactRead {
  key: string;
  /**
   * sha256 of the ENTIRE stored object (the ETag base). `null` when no stored
   * checksum metadata exists; never an S3 ETag.
   */
  sha256: string | null;
  bytes: number;
  contentType: string | null;
  /** Streaming body. Consume with fixed-size buffers; bounded memory. */
  stream: Readable;
}

/** A ranged read: streams exactly the requested window. */
export interface ArtifactRangeRead extends ArtifactRead {
  /** The window actually served (bounded by construction). */
  range: { offset: number; length: number };
}

/**
 * Liveness guard for `deleteIfUnreferenced`. Liveness is decided by the indexed
 * `blob_refs` table (design §9), never by prefix age or a bucket scan.
 */
export interface DeleteGuard {
  /** Identity guard: only delete when the stored sha256 matches, so a delete
   *  can never remove a different object than the caller believes it is
   *  removing. */
  expectedSha256?: string;
  expectedBytes?: number;
  /** Liveness predicate supplied by the caller (DB-backed). The store calls it
   *  once and deletes only when it resolves true, so a concurrent writer that
   *  re-references the blob between the caller's check and the delete is
   *  protected by the single combined check inside the store. */
  isUnreferenced: () => Promise<boolean>;
}

/** Outcome of `deleteIfUnreferenced` — never ambiguous. */
export type ArtifactDeleteOutcome =
  | { deleted: true; key: string }
  | { deleted: false; key: string; reason: "referenced" }
  | { deleted: false; key: string; reason: "not_found" }
  | { deleted: false; key: string; reason: "identity_mismatch" };

/** Typed failure kinds shared by every implementation. */
export type ArtifactStoreErrorKind =
  | "not_found"
  | "hash_mismatch"
  | "length_mismatch"
  | "immutable_key_conflict"
  | "range_out_of_bounds"
  | "io"
  | "staging";

/** Typed error thrown by ArtifactStore implementations. Contract surface only:
 *  a backend supplies its own behavior through these kinds. */
export class ArtifactStoreError extends Error {
  readonly kind: ArtifactStoreErrorKind;
  readonly key: string | undefined;
  constructor(kind: ArtifactStoreErrorKind, message: string, key?: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.kind = kind;
    this.key = key;
  }
}

/**
 * The content-addressed artifact store contract. All operations are async;
 * every byte-bearing operation streams with bounded memory.
 */
export interface ArtifactStore {
  /** Stream `source` once, compute sha256 and byte length, write to the
   *  content-addressed key (or the explicit `key`), verify, and return the key
   *  with the verified hash/length. Idempotent for identical bytes. */
  put(input: ArtifactPut): Promise<ArtifactPutResult>;

  /** Stream the full object at `key`. Throws `not_found` when absent. */
  get(key: string): Promise<ArtifactRead>;

  /** Probe `key` metadata only; never fetches bytes. */
  head(key: string): Promise<ArtifactHead>;

  /** Stream a bounded byte window of `key`. Throws `not_found` when absent and
   *  `range_out_of_bounds` when `offset` is beyond the object; a window that
   *  extends past the end is truncated to the remaining bytes. */
  range(key: string, range: ByteRange): Promise<ArtifactRangeRead>;

  /** Delete `key` only when it still matches the `guard` identity AND
   *  `guard.isUnreferenced()` resolves true. Returns an explicit outcome. */
  deleteIfUnreferenced(key: string, guard: DeleteGuard): Promise<ArtifactDeleteOutcome>;
}

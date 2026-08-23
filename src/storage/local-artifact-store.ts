/**
 * Local filesystem ArtifactStore implementation (dev/test backend for WP-2).
 *
 * Objects live under `rootDir` at their exact contract key
 * (`blobs/sha256/<first-2-hex>/<full-sha256>` or explicit manifest keys);
 * per-object checksum/metadata lives in a parallel `.artifact-meta/` tree so
 * reads never depend on filename conventions. Every byte-bearing operation
 * streams through fixed-size buffers — no whole-object buffering anywhere.
 *
 * Locked rules honored here: ETag concepts do not exist locally (the stored
 * checksum is authoritative), prefix listing is never used as a catalog,
 * identical bytes at an explicit key are an idempotent no-op while different
 * bytes are a hard `immutable_key_conflict`, and adopting an existing CAS
 * object requires the stored length + checksum to match.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  ArtifactDeleteOutcome,
  ArtifactHead,
  ArtifactPut,
  ArtifactPutResult,
  ArtifactRangeRead,
  ArtifactRead,
  ArtifactStore,
  ByteRange,
  DeleteGuard,
} from "./artifact-store.js";
import { ArtifactStoreError } from "./artifact-store.js";
import { blobKey, normalizeSha256, streamSha256 } from "./content-address.js";

/** Sidecar metadata persisted beside every stored object. */
interface StoredObjectMeta {
  sha256: string;
  contentType?: string;
  cacheControl?: string;
}

/** Directory (inside rootDir) holding the sidecar metadata tree. */
const META_DIR = ".artifact-meta";

/** Reject unsafe key shapes and map a contract key to its on-disk path. */
function objectPath(rootDir: string, key: string): string {
  const parts = key.split("/");
  if (key.length === 0 || parts.length === 0) {
    throw new ArtifactStoreError("io", `invalid object key: ${JSON.stringify(key)}`, key);
  }
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === ".." || part.includes("\0")) {
      throw new ArtifactStoreError("io", `invalid object key: ${JSON.stringify(key)}`, key);
    }
  }
  return join(rootDir, ...parts);
}

/** Map a contract key to its sidecar metadata file path. */
function metaPath(rootDir: string, key: string): string {
  return join(rootDir, META_DIR, `${key}.json`);
}

/** Read sidecar metadata; `null` when absent or unreadable. */
async function readMeta(rootDir: string, key: string): Promise<StoredObjectMeta | null> {
  try {
    const raw = await readFile(metaPath(rootDir, key));
    const parsed = JSON.parse(raw.toString()) as StoredObjectMeta;
    if (typeof parsed?.sha256 !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Stat a stored object; `null` when absent. */
async function statObject(rootDir: string, key: string): Promise<{ size: number } | null> {
  try {
    const st = await stat(objectPath(rootDir, key));
    return st.isFile() ? { size: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * Compute the stored sha256 for identity checks: prefer the recorded checksum
 * metadata; otherwise stream the bytes once with bounded memory.
 */
async function storedSha256(rootDir: string, key: string): Promise<string | null> {
  const recorded = (await readMeta(rootDir, key))?.sha256;
  if (recorded !== undefined && normalizeSha256(recorded) !== null) return recorded;
  try {
    return (await streamSha256(createReadStream(objectPath(rootDir, key)))).sha256;
  } catch {
    return null;
  }
}

/**
 * Streaming Transform that feeds every chunk to a running SHA-256 state while
 * passing bytes through untouched — bounded memory, hash computed while
 * streaming, source consumed exactly once.
 */
class HashingTee extends Transform {
  private readonly hash = createHash("sha256");
  private totalBytes = 0;

  /** Digest and byte count, valid once the transform has flushed. */
  digest(): { sha256: string; bytes: number } {
    return { sha256: this.hash.copy().digest("hex"), bytes: this.totalBytes };
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error: Error | null, data?: Buffer) => void,
  ): void {
    this.hash.update(chunk);
    this.totalBytes += chunk.byteLength;
    callback(null, chunk);
  }
}

/**
 * Create a dev/test ArtifactStore backed by the local filesystem under
 * `rootDir`. Implements all five locked operations with bounded-memory
 * streaming; suitable for tests and single-host development.
 */
export function createLocalArtifactStore(rootDir: string): ArtifactStore {
  /**
   * Verify put expectations against the hashed bytes, then adopt-or-conflict
   * at the final key: identical bytes are an idempotent no-op, different bytes
   * are a hard `immutable_key_conflict`, never an overwrite.
   */
  async function finalizePut(
    hashed: { sha256: string; bytes: number },
    input: ArtifactPut,
    stagedPath: string,
  ): Promise<ArtifactPutResult> {
    if (
      input.expectedSha256 !== undefined &&
      normalizeSha256(input.expectedSha256) !== hashed.sha256
    ) {
      await rm(stagedPath, { force: true });
      throw new ArtifactStoreError(
        "hash_mismatch",
        `expected sha256 ${input.expectedSha256}, got ${hashed.sha256}`,
        input.key,
      );
    }
    if (input.expectedBytes !== undefined && input.expectedBytes !== hashed.bytes) {
      await rm(stagedPath, { force: true });
      throw new ArtifactStoreError(
        "length_mismatch",
        `expected ${input.expectedBytes} bytes, got ${hashed.bytes}`,
        input.key,
      );
    }

    const finalKey = input.key ?? blobKey(hashed.sha256);
    const finalPath = objectPath(rootDir, finalKey);
    const existing = await statObject(rootDir, finalKey);

    if (existing !== null) {
      // Adopt only when BOTH stored length and checksum match the streamed
      // bytes (design §2); anything else is a conflict, never an overwrite.
      const storedHash = await storedSha256(rootDir, finalKey);
      if (existing.size !== hashed.bytes || storedHash !== hashed.sha256) {
        await rm(stagedPath, { force: true });
        throw new ArtifactStoreError(
          "immutable_key_conflict",
          `key ${finalKey} already holds different bytes`,
          finalKey,
        );
      }
      await rm(stagedPath, { force: true });
      return { key: finalKey, sha256: hashed.sha256, bytes: hashed.bytes, alreadyExisted: true };
    }

    // Atomic adoption: rename the verified scratch file into place, then
    // record the sidecar checksum/metadata.
    await mkdir(dirname(finalPath), { recursive: true });
    await rename(stagedPath, finalPath);
    const meta: StoredObjectMeta = { sha256: hashed.sha256 };
    if (input.metadata?.contentType !== undefined) meta.contentType = input.metadata.contentType;
    if (input.metadata?.cacheControl !== undefined) meta.cacheControl = input.metadata.cacheControl;
    await mkdir(dirname(metaPath(rootDir, finalKey)), { recursive: true });
    await writeFile(metaPath(rootDir, finalKey), JSON.stringify(meta));
    return { key: finalKey, sha256: hashed.sha256, bytes: hashed.bytes, alreadyExisted: false };
  }

  return {
    /** Single-pass streaming upload: hash while writing to scratch, verify, adopt. */
    async put(input: ArtifactPut): Promise<ArtifactPutResult> {
      // Attempt-scoped staging key when supplied (used verbatim, deleted after
      // adoption); otherwise an internal unique scratch path.
      const stagedPath = input.stagingKey
        ? objectPath(rootDir, input.stagingKey)
        : join(
            rootDir,
            "_incoming",
            `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.incoming`,
          );
      const hasher = new HashingTee();

      try {
        await mkdir(dirname(stagedPath), { recursive: true });
        await pipeline(input.source, hasher, createWriteStream(stagedPath));
      } catch (err) {
        await rm(stagedPath, { force: true });
        if (err instanceof ArtifactStoreError) throw err;
        throw new ArtifactStoreError(
          "io",
          `failed to stream upload: ${err instanceof Error ? err.message : String(err)}`,
          input.key,
        );
      }

      return finalizePut(hasher.digest(), input, stagedPath);
    },

    /** Stream the full stored object; `not_found` when absent. */
    async get(key: string): Promise<ArtifactRead> {
      const info = await statObject(rootDir, key);
      if (info === null) {
        throw new ArtifactStoreError("not_found", `no object at key ${key}`, key);
      }
      const meta = await readMeta(rootDir, key);
      return {
        key,
        sha256: meta?.sha256 ?? null,
        bytes: info.size,
        contentType: meta?.contentType ?? null,
        stream: createReadStream(objectPath(rootDir, key)),
      };
    },

    /** Metadata-only probe; never reads object bytes. */
    async head(key: string): Promise<ArtifactHead> {
      const info = await statObject(rootDir, key);
      if (info === null) return { key, exists: false };
      const meta = await readMeta(rootDir, key);
      return {
        key,
        exists: true,
        bytes: info.size,
        sha256: meta?.sha256 ?? null,
        contentType: meta?.contentType ?? null,
      };
    },

    /** Stream exactly the requested byte window, truncated at end of object. */
    async range(key: string, range: ByteRange): Promise<ArtifactRangeRead> {
      const info = await statObject(rootDir, key);
      if (info === null) {
        throw new ArtifactStoreError("not_found", `no object at key ${key}`, key);
      }
      if (!Number.isInteger(range.offset) || range.offset < 0 || range.offset >= info.size) {
        throw new ArtifactStoreError(
          "range_out_of_bounds",
          `offset ${range.offset} out of bounds for ${info.size}-byte object`,
          key,
        );
      }
      if (
        range.length !== undefined &&
        (!Number.isInteger(range.length) || range.length < 0)
      ) {
        throw new ArtifactStoreError(
          "range_out_of_bounds",
          `invalid range length ${String(range.length)}`,
          key,
        );
      }
      // A window extending past the end truncates to the remaining bytes.
      const servedLength =
        range.length === undefined
          ? info.size - range.offset
          : Math.min(range.length, info.size - range.offset);
      const meta = await readMeta(rootDir, key);

      const stream: Readable =
        servedLength === 0
          ? Readable.from([])
          : createReadStream(objectPath(rootDir, key), {
              start: range.offset,
              // Kernel-bounded window: only the served range is ever read.
              end: range.offset + servedLength - 1,
            });

      return {
        key,
        sha256: meta?.sha256 ?? null,
        bytes: info.size,
        contentType: meta?.contentType ?? null,
        stream,
        range: { offset: range.offset, length: servedLength },
      };
    },

    /** Delete only when identity matches AND the liveness guard passes in-store. */
    async deleteIfUnreferenced(key: string, guard: DeleteGuard): Promise<ArtifactDeleteOutcome> {
      const info = await statObject(rootDir, key);
      if (info === null) return { deleted: false, key, reason: "not_found" };

      // Identity guard: never remove an object other than the caller believes
      // it is removing — verify stored length and checksum before touching it.
      if (guard.expectedBytes !== undefined && guard.expectedBytes !== info.size) {
        return { deleted: false, key, reason: "identity_mismatch" };
      }
      if (guard.expectedSha256 !== undefined) {
        const expected = normalizeSha256(guard.expectedSha256);
        if (expected === null) return { deleted: false, key, reason: "identity_mismatch" };
        const actual = await storedSha256(rootDir, key);
        if (actual !== expected) return { deleted: false, key, reason: "identity_mismatch" };
      }

      // Liveness predicate runs once, inside the store, immediately before the
      // unlink so the combined check protects against concurrent re-references.
      let unreferenced: boolean;
      try {
        unreferenced = await guard.isUnreferenced();
      } catch (err) {
        throw new ArtifactStoreError(
          "io",
          `delete guard failed: ${err instanceof Error ? err.message : String(err)}`,
          key,
        );
      }
      if (!unreferenced) return { deleted: false, key, reason: "referenced" };

      try {
        await unlink(objectPath(rootDir, key));
        await rm(metaPath(rootDir, key), { force: true });
      } catch (err) {
        throw new ArtifactStoreError(
          "io",
          `failed to delete ${key}: ${err instanceof Error ? err.message : String(err)}`,
          key,
        );
      }
      return { deleted: true, key };
    },
  };
}

/**
 * Local ArtifactStore behavioral tests.
 *
 * Mutation targets: immutable_key_conflict on different bytes, range window
 * bounds (not whole-file reads), deleteIfUnreferenced respecting the liveness
 * guard and identity check, hash_mismatch on expectedSha256, idempotent put of
 * identical bytes, and head.exists:false for missing keys.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blobKey } from "../src/storage/content-address.ts";
import { ArtifactStoreError } from "../src/storage/artifact-store.ts";
import { createLocalArtifactStore } from "../src/storage/local-artifact-store.ts";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("createLocalArtifactStore", () => {
  let root: string;
  let store: ReturnType<typeof createLocalArtifactStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ae-local-store-"));
    store = createLocalArtifactStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("put derives the content-addressed blob key and round-trips bytes", async () => {
    const payload = Buffer.from("hello-archive");
    const result = await store.put({ source: Readable.from([payload]) });
    expect(result.sha256).toBe(sha256(payload));
    expect(result.bytes).toBe(payload.length);
    expect(result.key).toBe(blobKey(result.sha256));
    expect(result.alreadyExisted).toBe(false);

    const got = await store.get(result.key);
    expect(await readAll(got.stream)).toEqual(payload);
    expect(got.sha256).toBe(result.sha256);
    expect(got.bytes).toBe(payload.length);
  });

  it("put of identical bytes is idempotent (alreadyExisted: true)", async () => {
    const payload = Buffer.from("same-bytes-twice");
    const first = await store.put({ source: Readable.from([payload]) });
    const second = await store.put({ source: Readable.from([payload]) });
    expect(second).toEqual({ ...first, alreadyExisted: true });
    expect(second.key).toBe(first.key);
  });

  it("put of different bytes at an explicit key is immutable_key_conflict", async () => {
    const key = "manifests/run-1/generation-1/deadbeef.manifest";
    await store.put({ source: Readable.from([Buffer.from("v1")]), key });
    await expect(
      store.put({ source: Readable.from([Buffer.from("v2-different")]), key }),
    ).rejects.toMatchObject({
      name: "ArtifactStoreError",
      kind: "immutable_key_conflict",
      key,
    });
    // Original bytes untouched.
    expect(await readAll((await store.get(key)).stream)).toEqual(Buffer.from("v1"));
  });

  it("put with expectedSha256 mismatch fails with hash_mismatch", async () => {
    await expect(
      store.put({
        source: Readable.from([Buffer.from("payload")]),
        expectedSha256: "ab".repeat(32),
      }),
    ).rejects.toMatchObject({ kind: "hash_mismatch" });
  });

  it("put with expectedBytes mismatch fails with length_mismatch", async () => {
    await expect(
      store.put({ source: Readable.from([Buffer.from("abcd")]), expectedBytes: 99 }),
    ).rejects.toMatchObject({ kind: "length_mismatch" });
  });

  it("head reports exists:false for a missing key and never throws", async () => {
    const head = await store.head("blobs/sha256/ab/" + "ab".repeat(32));
    expect(head).toEqual({ key: head.key, exists: false });
  });

  it("get on a missing key throws not_found", async () => {
    await expect(store.get("blobs/sha256/ab/" + "cd".repeat(32))).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("range returns exactly the requested window, not the whole file", async () => {
    const payload = Buffer.from("0123456789abcdef");
    const { key } = await store.put({ source: Readable.from([payload]) });
    const window = await store.range(key, { offset: 4, length: 6 });
    expect(window.range).toEqual({ offset: 4, length: 6 });
    expect(await readAll(window.stream)).toEqual(Buffer.from("456789"));
  });

  it("range past end truncates; offset past end is range_out_of_bounds", async () => {
    const payload = Buffer.from("short");
    const { key } = await store.put({ source: Readable.from([payload]) });
    const truncated = await store.range(key, { offset: 3, length: 100 });
    expect(truncated.range).toEqual({ offset: 3, length: 2 });
    expect(await readAll(truncated.stream)).toEqual(Buffer.from("rt"));
    await expect(store.range(key, { offset: 99 })).rejects.toMatchObject({
      kind: "range_out_of_bounds",
    });
  });

  it("deleteIfUnreferenced refuses when the guard says referenced", async () => {
    const { key, sha256: hash } = await store.put({
      source: Readable.from([Buffer.from("keep-me")]),
    });
    const outcome = await store.deleteIfUnreferenced(key, {
      expectedSha256: hash,
      isUnreferenced: async () => false,
    });
    expect(outcome).toEqual({ deleted: false, key, reason: "referenced" });
    expect((await store.head(key)).exists).toBe(true);
  });

  it("deleteIfUnreferenced refuses on identity_mismatch", async () => {
    const { key } = await store.put({ source: Readable.from([Buffer.from("id-check")]) });
    const outcome = await store.deleteIfUnreferenced(key, {
      expectedSha256: "ff".repeat(32),
      isUnreferenced: async () => true,
    });
    expect(outcome).toEqual({ deleted: false, key, reason: "identity_mismatch" });
    expect((await store.head(key)).exists).toBe(true);
  });

  it("deleteIfUnreferenced deletes when guard and identity both pass", async () => {
    const { key, sha256: hash, bytes } = await store.put({
      source: Readable.from([Buffer.from("go")]),
    });
    const outcome = await store.deleteIfUnreferenced(key, {
      expectedSha256: hash,
      expectedBytes: bytes,
      isUnreferenced: async () => true,
    });
    expect(outcome).toEqual({ deleted: true, key });
    expect((await store.head(key)).exists).toBe(false);
  });

  it("deleteIfUnreferenced on a missing key returns not_found", async () => {
    const key = "blobs/sha256/00/" + "00".repeat(32);
    expect(
      await store.deleteIfUnreferenced(key, { isUnreferenced: async () => true }),
    ).toEqual({ deleted: false, key, reason: "not_found" });
  });

  it("streams a multi-megabyte put without requiring a single Buffer source", async () => {
    // A chunked Readable whose total size exceeds a typical full-buffer test.
    // The assertion is that put completes and the stored hash matches a
    // independently streamed digest — evidence the store hashed while writing.
    const chunk = randomBytes(64 * 1024);
    const chunks = Array.from({ length: 40 }, () => chunk); // 2.5 MiB
    const expected = createHash("sha256");
    for (const c of chunks) expected.update(c);
    const digest = expected.digest("hex");

    const result = await store.put({ source: Readable.from(chunks) });
    expect(result.sha256).toBe(digest);
    expect(result.bytes).toBe(chunk.length * chunks.length);
    expect(result.key).toBe(blobKey(digest));
  });

  it("rejects path-traversal keys", async () => {
    await expect(
      store.put({ source: Readable.from([Buffer.from("x")]), key: "../escape" }),
    ).rejects.toBeInstanceOf(ArtifactStoreError);
  });

  it("persists contentType metadata through head/get", async () => {
    const { key } = await store.put({
      source: Readable.from([Buffer.from("{}")]),
      metadata: { contentType: "application/json" },
    });
    expect((await store.head(key))).toMatchObject({
      exists: true,
      contentType: "application/json",
    });
    expect((await store.get(key)).contentType).toBe("application/json");
  });
});

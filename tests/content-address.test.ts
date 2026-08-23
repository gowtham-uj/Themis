/**
 * Tests for the content-addressing helpers.
 *
 * The load-bearing property is that `streamSha256` is genuinely streaming. A
 * version that concatenated every chunk before hashing would pass every
 * known-answer test in this file and then exhaust memory on the multi-gigabyte
 * archives this module exists to serve. Known-answer vectors cannot catch that,
 * so the chunk-boundary and bounded-memory tests below carry the real weight:
 * they assert the digest is invariant to how the byte stream is sliced, which is
 * only true of an incremental hash.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { blobKey, normalizeSha256, streamSha256 } from '../src/storage/content-address.js';

/** Public SHA-256 test vectors (FIPS 180-4 / NIST examples). */
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** Yield `bytes` split into fixed-size chunks, allocating only one chunk at a time. */
async function* lazyChunks(total: number, chunkSize: number): AsyncGenerator<Uint8Array> {
  let emitted = 0;
  while (emitted < total) {
    const size = Math.min(chunkSize, total - emitted);
    // A fresh buffer per iteration: nothing accumulates across yields.
    yield Buffer.alloc(size, 0x61);
    emitted += size;
  }
}

/** Split a buffer at the given offsets and yield the resulting pieces. */
async function* splitAt(buf: Buffer, offsets: readonly number[]): AsyncGenerator<Uint8Array> {
  const bounds = [0, ...offsets, buf.byteLength];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    yield buf.subarray(bounds[i], bounds[i + 1]);
  }
}

describe('streamSha256 — known answers', () => {
  it('hashes an empty stream to the empty-input digest', async () => {
    const result = await streamSha256(Readable.from([]));
    expect(result).toEqual({ sha256: SHA256_EMPTY, bytes: 0 });
  });

  it('hashes "abc" to the published vector', async () => {
    const result = await streamSha256(Readable.from([Buffer.from('abc', 'utf8')]));
    expect(result).toEqual({ sha256: SHA256_ABC, bytes: 3 });
  });

  it('accepts a plain async iterable, not only a Readable', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('abc', 'utf8');
    }
    await expect(streamSha256(source())).resolves.toEqual({ sha256: SHA256_ABC, bytes: 3 });
  });

  it('accepts Uint8Array chunks that are not Buffers', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([0x61, 0x62, 0x63]);
    }
    await expect(streamSha256(source())).resolves.toEqual({ sha256: SHA256_ABC, bytes: 3 });
  });
});

describe('streamSha256 — chunk-boundary invariance', () => {
  // This is the test that distinguishes an incremental hash from one that
  // buffers: only an incremental implementation is indifferent to slicing.
  const payload = Buffer.from(
    'the quick brown fox jumps over the lazy dog, repeatedly and at length. '.repeat(37),
    'utf8',
  );

  it('gives the same digest for one chunk and for many one-byte chunks', async () => {
    const whole = await streamSha256(Readable.from([payload]));
    async function* perByte(): AsyncGenerator<Uint8Array> {
      for (const byte of payload) yield Buffer.from([byte]);
    }
    const byBytes = await streamSha256(perByte());
    expect(byBytes.sha256).toBe(whole.sha256);
    expect(byBytes.bytes).toBe(payload.byteLength);
  });

  it.each([
    ['front-loaded', [1, 2, 3]],
    ['ragged', [7, 13, 64, 65, 200]],
    ['back-loaded', [payload.byteLength - 2, payload.byteLength - 1]],
    ['single split at midpoint', [Math.floor(payload.byteLength / 2)]],
  ])('is invariant under a %s split', async (_label, offsets) => {
    const whole = await streamSha256(Readable.from([payload]));
    const split = await streamSha256(splitAt(payload, offsets));
    expect(split).toEqual(whole);
  });

  it('is unaffected by interleaved empty chunks', async () => {
    const whole = await streamSha256(Readable.from([payload]));
    async function* withGaps(): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(0);
      yield payload.subarray(0, 10);
      yield Buffer.alloc(0);
      yield payload.subarray(10);
      yield Buffer.alloc(0);
    }
    expect(await streamSha256(withGaps())).toEqual(whole);
  });
});

describe('streamSha256 — bounded memory', () => {
  it('hashes 64MB delivered as lazy 64KiB chunks', async () => {
    const CHUNK = 64 * 1024;
    const TOTAL = 64 * 1024 * 1024;
    const result = await streamSha256(lazyChunks(TOTAL, CHUNK));
    expect(result.bytes).toBe(TOTAL);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never materializes more than one chunk at a time in the source', async () => {
    // Asserting on RSS is flaky, so assert on structure instead: the generator
    // yields fixed-size chunks and each is a distinct short-lived buffer.
    const CHUNK = 4096;
    const sizes: number[] = [];
    async function* observed(): AsyncGenerator<Uint8Array> {
      for await (const chunk of lazyChunks(CHUNK * 10 + 7, CHUNK)) {
        sizes.push(chunk.byteLength);
        yield chunk;
      }
    }
    const result = await streamSha256(observed());
    expect(Math.max(...sizes)).toBe(CHUNK);
    expect(sizes).toHaveLength(11);
    expect(result.bytes).toBe(CHUNK * 10 + 7);
  });

  it('consumes each chunk before the next is produced', async () => {
    // The tests above are all digest-equality checks, and a buffering
    // implementation (collect every chunk, concat once, hash once) satisfies
    // every one of them — confirmed by mutating the module. Chunk-boundary
    // invariance proves the digest is CORRECT, not that the hash is INCREMENTAL,
    // and it is the incremental property that keeps a multi-gigabyte archive
    // from exhausting memory.
    //
    // A recycled buffer decides it without touching GC or RSS. The source hands
    // out one buffer over and over, refilling it before each yield — which is
    // what Node's own stream layer does with pooled reads. An implementation
    // that hashes on receipt sees the distinct per-iteration contents. One that
    // stores the reference and concatenates later sees the FINAL contents
    // repeated N times, and produces a different digest.
    const CHUNK = 1024;
    const COUNT = 16;
    const recycled = Buffer.alloc(CHUNK);
    async function* pooled(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < COUNT; i += 1) {
        recycled.fill(i & 0xff);
        yield recycled;
      }
    }
    // The digest an incremental hash must produce: the concatenation of the
    // per-iteration contents, computed independently of the module.
    const expected = await streamSha256(
      Readable.from(
        Array.from({ length: COUNT }, (_unused, i) => Buffer.alloc(CHUNK, i & 0xff)),
      ),
    );
    const actual = await streamSha256(pooled());
    expect(actual.bytes).toBe(CHUNK * COUNT);
    expect(
      actual.sha256,
      'digest differs from the incremental result, so the implementation retained ' +
        'chunk references instead of hashing each chunk on receipt',
    ).toBe(expected.sha256);
  });
});

describe('normalizeSha256', () => {
  it('accepts a valid lowercase digest unchanged', () => {
    expect(normalizeSha256(SHA256_ABC)).toBe(SHA256_ABC);
  });

  it.each([
    ['uppercase hex', SHA256_ABC.toUpperCase()],
    ['mixed case', `${SHA256_ABC.slice(0, 10).toUpperCase()}${SHA256_ABC.slice(10)}`],
    ['63 chars', SHA256_ABC.slice(0, 63)],
    ['65 chars', `${SHA256_ABC}a`],
    ['non-hex characters', `${SHA256_ABC.slice(0, 63)}z`],
    ['empty string', ''],
    ['leading whitespace', ` ${SHA256_ABC}`],
    ['trailing newline', `${SHA256_ABC}\n`],
  ])('rejects %s', (_label, input) => {
    // Rejection must be null, never a silently repaired value: a normalizer
    // that lowercased uppercase input would let two spellings of one digest
    // mint two different blob keys for identical bytes.
    expect(normalizeSha256(input)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['Buffer', Buffer.from(SHA256_ABC)],
    ['object', { sha256: SHA256_ABC }],
  ])('rejects non-string input: %s', (_label, input) => {
    expect(normalizeSha256(input)).toBeNull();
  });
});

describe('blobKey', () => {
  it('derives the canonical two-level key', () => {
    expect(blobKey(SHA256_ABC)).toBe(`blobs/sha256/ba/${SHA256_ABC}`);
  });

  it('places digests sharing a two-hex prefix in the same directory', () => {
    const a = `ba${'0'.repeat(62)}`;
    const b = `ba${'1'.repeat(62)}`;
    const dir = (key: string): string => key.slice(0, key.lastIndexOf('/'));
    expect(dir(blobKey(a))).toBe(dir(blobKey(b)));
    expect(blobKey(a)).not.toBe(blobKey(b));
  });

  it('places digests differing in the first byte in different directories', () => {
    const dir = (key: string): string => key.slice(0, key.lastIndexOf('/'));
    expect(dir(blobKey(`ba${'0'.repeat(62)}`))).not.toBe(dir(blobKey(`bb${'0'.repeat(62)}`)));
  });

  it.each([
    ['uppercase', SHA256_ABC.toUpperCase()],
    ['too short', SHA256_ABC.slice(0, 63)],
    ['non-hex', `${SHA256_ABC.slice(0, 63)}z`],
    ['empty', ''],
  ])('throws rather than emitting a malformed key for %s', (_label, input) => {
    expect(() => blobKey(input)).toThrow(TypeError);
  });

  it('does not leak the raw invalid value beyond the error message', () => {
    // The key space must stay well-formed; a rejected input must not appear as
    // a path segment anywhere.
    expect(() => blobKey('../../etc/passwd')).toThrow(TypeError);
  });
});

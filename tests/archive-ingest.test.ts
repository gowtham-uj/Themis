/** Canonical archive ingest streams real files into the local CAS store. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ingestSealedArchive } from "../src/storage/archive-ingest.ts";
import { parseManifest } from "../src/storage/archive-service.ts";
import { createLocalArtifactStore } from "../src/storage/local-artifact-store.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("canonical archive ingest", () => {
  it("streams blobs + immutable manifest and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-ingest-root-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "ae-ingest-store-"));
    await mkdir(join(root, "retained"), { recursive: true });
    const a = Buffer.from("alpha\n");
    const b = Buffer.from("beta\n");
    await writeFile(join(root, "retained", "a.txt"), a);
    await writeFile(join(root, "b.txt"), b);
    const files = [
      { path: "retained/a.txt", kind: "file" as const, bytes: a.length, sha256: sha(a) },
      { path: "b.txt", kind: "file" as const, bytes: b.length, sha256: sha(b) },
    ];
    const store = createLocalArtifactStore(storeRoot);

    const first = await ingestSealedArchive({ store, runId: "run_1", rootDir: root, files });
    expect(first.blobCount).toBe(2);
    expect(first.totalBytes).toBe(a.length + b.length);
    expect(first.manifestKey).toBe(
      `manifests/run_1/generation-1/${first.manifestSha256}.manifest`,
    );

    const read = await store.get(first.manifestKey);
    const chunks: Buffer[] = [];
    for await (const c of read.stream) chunks.push(Buffer.from(c));
    const parsed = parseManifest(Buffer.concat(chunks).toString("utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest.entries).toHaveLength(2);

    // Exact replay is idempotent — same immutable key/hash.
    const second = await ingestSealedArchive({ store, runId: "run_1", rootDir: root, files });
    expect(second.manifestKey).toBe(first.manifestKey);
    expect(second.manifestSha256).toBe(first.manifestSha256);
  });

  it("rejects a file whose bytes do not match the sealed inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-ingest-root-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "ae-ingest-store-"));
    await writeFile(join(root, "x.txt"), "tampered");
    const store = createLocalArtifactStore(storeRoot);
    await expect(
      ingestSealedArchive({
        store,
        runId: "r",
        rootDir: root,
        files: [{ path: "x.txt", kind: "file", bytes: 3, sha256: sha(Buffer.from("old")) }],
      }),
    ).rejects.toThrow(/sha256|bytes|length/i);
  });
});

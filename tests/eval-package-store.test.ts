import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEvalPackageStore, digestPackageManifest, packageManifestKey } from "../src/storage/eval-package-store.ts";
import { createLocalArtifactStore } from "../src/storage/local-artifact-store.ts";
import { blobKey } from "../src/storage/content-address.ts";
import { writeFile } from "node:fs/promises";

describe("eval-package-store", () => {
  let root: string;
  let store: ReturnType<typeof createEvalPackageStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ae-pkg-"));
    store = createEvalPackageStore(createLocalArtifactStore(root));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("put then get round-trips digest and file bytes", async () => {
    const put = await store.put([
      { path: "task.toml", content: 'id = "demo"\n' },
      { path: "seed_repo/main.py", content: "print(1)\n" },
    ]);
    expect(put.packageDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(put.manifestKey).toBe(packageManifestKey(put.packageDigest));
    expect(put.alreadyExisted).toBe(false);

    const got = await store.get(put.packageDigest);
    expect(got.files).toHaveLength(2);
    expect(got.files.find((f) => f.path === "task.toml")?.content.toString()).toBe('id = "demo"\n');
    expect(got.totalBytes).toBe(put.totalBytes);
  });

  it("identical put is idempotent (same digest, alreadyExisted)", async () => {
    const files = [{ path: "a.txt", content: "same" }];
    const first = await store.put(files);
    const second = await store.put(files);
    expect(second.packageDigest).toBe(first.packageDigest);
    expect(second.alreadyExisted).toBe(true);
  });

  it("head reports exists:false for unknown digest", async () => {
    const digest = "ab".repeat(32);
    expect(await store.head(digest)).toEqual({
      exists: false,
      packageDigest: digest,
      manifestKey: packageManifestKey(digest),
    });
  });

  it("get fails closed when a blob was tampered with", async () => {
    const put = await store.put([{ path: "x.txt", content: "original" }]);
    const file = put.files[0]!;
    // Overwrite the CAS blob path with different bytes under the same key by
    // writing directly into the local store root — simulating bit rot / swap.
    const path = join(root, blobKey(file.sha256));
    await writeFile(path, "TAMPERED!!");
    await expect(store.get(put.packageDigest)).rejects.toMatchObject({ kind: "hash_mismatch" });
  });

  it("digestPackageManifest is order-independent", () => {
    const a = [
      { path: "b", bytes: 1, sha256: "aa".repeat(32) },
      { path: "a", bytes: 2, sha256: "bb".repeat(32) },
    ];
    const b = [
      { path: "a", bytes: 2, sha256: "bb".repeat(32) },
      { path: "b", bytes: 1, sha256: "aa".repeat(32) },
    ];
    expect(digestPackageManifest(a)).toBe(digestPackageManifest(b));
  });

  it("rejects duplicate paths", async () => {
    await expect(
      store.put([
        { path: "a.txt", content: "1" },
        { path: "a.txt", content: "2" },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});

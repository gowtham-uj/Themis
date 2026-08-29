/**
 * Canonical local archive ingest — live glue between the sealed eval tree and
 * the existing ArtifactStore / ArchiveManifest contracts (S3 out of scope).
 *
 * Every regular file streams into its content-addressed blob key; the immutable
 * canonical manifest is stored at
 * `manifests/<runId>/generation-1/<sha>.manifest`. Re-ingesting identical bytes
 * is an idempotent no-op; a mismatch is a hard store error.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { EvalArchiveFile } from "../runner/eval-archive.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArchiveManifest, ManifestEntry } from "./archive-manifest.js";
import { serializeManifest, validateManifestSelf } from "./archive-service.js";

export interface CanonicalArchiveIngestResult {
  manifest: ArchiveManifest;
  manifestKey: string;
  manifestSha256: string;
  manifestBytes: number;
  blobCount: number;
  totalBytes: number;
}

/** Convert the runner's sealed inventory into the frozen manifest tuple shape. */
export function buildCanonicalManifest(files: readonly EvalArchiveFile[]): ArchiveManifest {
  const entries: ManifestEntry[] = files.map((f): ManifestEntry => {
    if (f.kind === "symlink") {
      return {
        path: f.path,
        kind: "symlink",
        bytes: 0,
        sha256: null,
        symlinkTarget: f.target ?? "",
      };
    }
    return {
      path: f.path,
      kind: "file",
      bytes: f.bytes,
      sha256: f.sha256,
      symlinkTarget: null,
    };
  });
  const manifest: ArchiveManifest = { schemaVersion: 1, entries };
  const checked = validateManifestSelf(manifest, { rejectAmbiguousHoist: false });
  if (!checked.ok) {
    throw new Error(
      `canonical archive manifest rejected: ${checked.rejections
        .map((r) => `${r.kind}:${r.path}${r.detail ? `:${r.detail}` : ""}`)
        .join(", ")}`,
    );
  }
  return manifest;
}

/** Stream one sealed archive into the local content-addressed ArtifactStore. */
export async function ingestSealedArchive(input: {
  store: ArtifactStore;
  runId: string;
  rootDir: string;
  files: readonly EvalArchiveFile[];
}): Promise<CanonicalArchiveIngestResult> {
  const manifest = buildCanonicalManifest(input.files);
  let blobCount = 0;
  let totalBytes = 0;

  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    let put;
    try {
      put = await input.store.put({
        source: createReadStream(join(input.rootDir, ...entry.path.split("/"))),
        expectedSha256: entry.sha256,
        expectedBytes: entry.bytes,
        metadata: { contentType: "application/octet-stream" },
      });
    } catch (err) {
      throw new Error(
        `canonical ingest failed for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // The store derives the exact CAS key from the computed hash and verifies
    // existing-object checksum+length before adoption.
    if (put.sha256 !== entry.sha256 || put.bytes !== entry.bytes) {
      throw new Error(`canonical blob verification failed: ${entry.path}`);
    }
    blobCount += 1;
    totalBytes += entry.bytes;
  }

  const serialized = serializeManifest(manifest);
  const bytes = Buffer.from(serialized, "utf8");
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestKey = `manifests/${input.runId}/generation-1/${manifestSha256}.manifest`;
  await input.store.put({
    source: Readable.from([bytes]),
    key: manifestKey,
    expectedSha256: manifestSha256,
    expectedBytes: bytes.length,
    metadata: { contentType: "application/vnd.agenteval.archive-manifest+json" },
  });

  return {
    manifest,
    manifestKey,
    manifestSha256,
    manifestBytes: bytes.length,
    blobCount,
    totalBytes,
  };
}

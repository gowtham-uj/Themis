/**
 * Content-addressed eval-package store (plan §2).
 *
 * Package file bytes live as ordinary CAS blobs. A package manifest listing
 * every (path, bytes, sha256) is itself content-addressed under
 * `packages/sha256/<aa>/<digest>.manifest`, so the digest IS the identity —
 * re-putting identical bytes is a no-op, and a mutated file set mints a new
 * digest rather than overwriting. Listing an object-store prefix is never used
 * as a catalog; the only way to find a package is by digest.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { EvalPackageManifestFile } from "../evals/package.js";
import { EVAL_PACKAGE_SCHEMA_VERSION } from "../evals/package.js";
import type { ArtifactStore } from "./artifact-store.js";
import { ArtifactStoreError } from "./artifact-store.js";
import { blobKey, normalizeSha256 } from "./content-address.js";

/** One file submitted for package storage. */
export interface EvalPackageFileInput {
  path: string;
  content: Buffer | string;
}

/** Result of putting a package. */
export interface EvalPackagePutResult {
  packageDigest: string;
  manifestKey: string;
  files: readonly EvalPackageManifestFile[];
  totalBytes: number;
  alreadyExisted: boolean;
}

/** A retrieved package: manifest + per-file bytes. */
export interface EvalPackageRead {
  packageDigest: string;
  manifestKey: string;
  files: ReadonlyArray<EvalPackageManifestFile & { content: Buffer }>;
  totalBytes: number;
}

interface PackageManifestDoc {
  schemaVersion: typeof EVAL_PACKAGE_SCHEMA_VERSION;
  packageDigest: string;
  files: EvalPackageManifestFile[];
  totalBytes: number;
}

/** Canonical manifest object key for a package digest. */
export function packageManifestKey(packageDigest: string): string {
  const normalized = normalizeSha256(packageDigest);
  if (normalized === null) {
    throw new TypeError(`invalid package digest: ${packageDigest}`);
  }
  return `packages/sha256/${normalized.slice(0, 2)}/${normalized}.manifest`;
}

/** Digest of a sorted manifest file list — the package identity. */
export function digestPackageManifest(files: readonly EvalPackageManifestFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = sorted.map((f) => `${f.path}\0${f.bytes}\0${f.sha256}\n`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function toBuffer(content: Buffer | string): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Create an eval-package store backed by any ArtifactStore. Dev/tests pass a
 * local store; production passes S3.
 */
export function createEvalPackageStore(artifacts: ArtifactStore): {
  put(files: readonly EvalPackageFileInput[]): Promise<EvalPackagePutResult>;
  get(packageDigest: string): Promise<EvalPackageRead>;
  head(packageDigest: string): Promise<{ exists: boolean; packageDigest: string; manifestKey: string }>;
} {
  return {
    /** Upload every file as a CAS blob, then store the content-addressed manifest. */
    async put(files: readonly EvalPackageFileInput[]): Promise<EvalPackagePutResult> {
      if (files.length === 0) {
        throw new Error("eval package must contain at least one file");
      }
      const seen = new Set<string>();
      const manifestFiles: EvalPackageManifestFile[] = [];

      for (const file of files) {
        if (seen.has(file.path)) {
          throw new Error(`duplicate package path: ${file.path}`);
        }
        seen.add(file.path);
        const buf = toBuffer(file.content);
        const sha = createHash("sha256").update(buf).digest("hex");
        await artifacts.put({
          source: Readable.from([buf]),
          expectedSha256: sha,
          expectedBytes: buf.length,
        });
        manifestFiles.push({ path: file.path, bytes: buf.length, sha256: sha });
      }

      const packageDigest = digestPackageManifest(manifestFiles);
      const manifestKey = packageManifestKey(packageDigest);
      const totalBytes = manifestFiles.reduce((sum, f) => sum + f.bytes, 0);
      const doc: PackageManifestDoc = {
        schemaVersion: EVAL_PACKAGE_SCHEMA_VERSION,
        packageDigest,
        files: [...manifestFiles].sort((a, b) => a.path.localeCompare(b.path)),
        totalBytes,
      };
      const body = Buffer.from(`${JSON.stringify(doc)}\n`, "utf8");
      const put = await artifacts.put({
        source: Readable.from([body]),
        key: manifestKey,
        metadata: { contentType: "application/json" },
      });

      return {
        packageDigest,
        manifestKey,
        files: doc.files,
        totalBytes,
        alreadyExisted: put.alreadyExisted,
      };
    },

    /** Load the manifest by digest, then fetch every named blob. */
    async get(packageDigest: string): Promise<EvalPackageRead> {
      const manifestKey = packageManifestKey(packageDigest);
      let raw: Buffer;
      try {
        raw = await readStream((await artifacts.get(manifestKey)).stream);
      } catch (err) {
        if (err instanceof ArtifactStoreError && err.kind === "not_found") {
          throw new ArtifactStoreError("not_found", `no package at digest ${packageDigest}`, manifestKey);
        }
        throw err;
      }
      const doc = JSON.parse(raw.toString("utf8")) as PackageManifestDoc;
      if (doc.packageDigest !== packageDigest) {
        throw new ArtifactStoreError(
          "hash_mismatch",
          `manifest packageDigest ${doc.packageDigest} does not match requested ${packageDigest}`,
          manifestKey,
        );
      }
      const files: Array<EvalPackageManifestFile & { content: Buffer }> = [];
      for (const entry of doc.files) {
        const blob = await artifacts.get(blobKey(entry.sha256));
        const content = await readStream(blob.stream);
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== entry.sha256 || content.length !== entry.bytes) {
          throw new ArtifactStoreError(
            "hash_mismatch",
            `blob for ${entry.path} failed integrity check`,
            blobKey(entry.sha256),
          );
        }
        files.push({ ...entry, content });
      }
      return { packageDigest, manifestKey, files, totalBytes: doc.totalBytes };
    },

    /** Metadata-only probe for a package digest. */
    async head(packageDigest: string) {
      const manifestKey = packageManifestKey(packageDigest);
      const h = await artifacts.head(manifestKey);
      return { exists: h.exists, packageDigest, manifestKey };
    },
  };
}

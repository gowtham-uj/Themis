/**
 * WP-2 archive-manifest contract: the versioned canonical manifest and the
 * strict-superset validation contract. Types, constants, and validator
 * SIGNATURES only — no validation logic lives in this file.
 *
 * A canonical archive generation is a hash-addressed, order-independent list of
 * NORMALIZED entries. Each entry is the tuple
 * `(path, kind, bytes, sha256, symlink_target)`. The manifest is immutable and
 * content-derived: its canonical serialized bytes hash to the sha256 embedded
 * in its object key (`manifests/<run_id>/generation-1/<sha256>.manifest`; a
 * judgement view at `manifests/<run_id>/view/<result_version_id>/<sha256>.manifest`),
 * so a retry that produces different bytes lands at a different key and can
 * never overwrite a published view.
 *
 * SCHEMA VERSIONING (scale rule 9): the manifest carries an explicit
 * `schemaVersion`. Old manifests are read through versioned decoders and never
 * silently rewritten.
 *
 * CONTRACT BOUNDARY: this module is frozen. The BUILD stage ships runtime
 * functions conforming to `StrictSupersetValidator`, `ManifestSelfValidator`,
 * `ParseManifest`, `SerializeManifest`, and `NormalizeArchivePath` (in
 * archive-service.ts per plan §2) without changing the signatures, types, or
 * rejection taxonomy below.
 *
 * STRICT-SUPERSET CONTRACT
 * ------------------------
 * A judgement archive-view is the strict union of the unchanged base entries
 * and exactly one result version's fixed `judge/` tree. The validator compares
 * normalized tuples `(path, kind, bytes, sha256, symlink_target)` and rejects
 * when the view is not a strict superset of the base: every base tuple must
 * appear unchanged, and the view may only add entries. Additions are restricted
 * to the fixed `judge/` tree by archive-service publication policy, not by the
 * tuple comparison.
 *
 * Every rejection case (each is a row in the frozen test matrix):
 *   - invalid_entry             structurally malformed entry: missing/unknown
 *                               fields, non-integer or negative bytes, sha256
 *                               not 64 lowercase hex, a file carrying
 *                               symlink_target, or a symlink carrying sha256 or
 *                               bytes !== 0.
 *   - unsupported_schema_version  manifest schemaVersion is not the supported
 *                               version, or the view's schemaVersion differs
 *                               from the base's (comparison is defined only
 *                               within one schema version).
 *   - duplicate_path            the same normalized path appears more than once
 *                               in one manifest (a manifest is a set of paths).
 *   - colliding_path            two distinct raw paths normalize to the same
 *                               normalized path.
 *   - absolute_path             a path beginning with "/" or a drive/volume
 *                               prefix.
 *   - traversal                 a "." or ".." segment, an empty path, a
 *                               backslash separator, or any path/symlink target
 *                               that resolves outside the archive root.
 *   - unsupported_link          a node that is neither a regular file nor an
 *                               archive-relative symlink: hardlink, fifo,
 *                               socket, device, or an absolute symlink target.
 *   - ambiguous_hoist_basename  two distinct normalized paths share one
 *                               basename under hoisted addressing — reject,
 *                               never silently pick one.
 *   - missing_base_path         a base tuple is absent from the view.
 *   - replaced_base_path        a base path is present but its tuple changed;
 *                               `replaced` names the first differing axis in
 *                               tuple order: changed_kind | changed_bytes |
 *                               changed_sha256 | changed_symlink_target.
 *
 * PATH NORMALIZATION INVARIANTS (enforced by every validator):
 *   - forward slashes only; backslash is not a valid separator
 *   - relative to the archive root; no leading "/" or drive prefix
 *   - no "." or ".." segment; no empty segment; no empty path; no trailing "/"
 *   - the path (and every symlink target) resolves inside the archive root
 *   - UTF-8; no NUL or control characters
 *
 * SYMLINKS: either forbidden in production archives or confined to validated
 * archive-relative targets and served with no-follow semantics. An absolute or
 * root-escaping target is rejected.
 *
 * HOISTING: manifest-driven hoisting preserves source-relative identity or
 * fails on collision; it never silently overwrites one evidence file with
 * another. Callers that address entries by hoisted basename MUST enable
 * `rejectAmbiguousHoist`.
 */

/** Locked schema version of the canonical archive manifest. */
export const ARCHIVE_MANIFEST_SCHEMA_VERSION = 1 as const;

/** Content hash algorithm for every archive blob and manifest. */
export const MANIFEST_HASH_ALGORITHM = "sha256" as const;

/** Entry kinds a canonical manifest may contain. Anything else is rejected as
 *  an `unsupported_link` (or `invalid_entry`). */
export type ArchiveEntryKind = "file" | "symlink";

/**
 * A normalized archive entry — the tuple `(path, kind, bytes, sha256, symlink_target)`.
 *
 *   file:    (path, "file", byteLength, sha256Hex, null)
 *   symlink: (path, "symlink", 0, null, archiveRelativeTarget)
 */
export type ManifestEntry =
  | {
      path: string;
      kind: "file";
      bytes: number;
      sha256: string;
      symlinkTarget: null;
    }
  | {
      path: string;
      kind: "symlink";
      bytes: 0;
      sha256: null;
      symlinkTarget: string;
    };

/** The versioned canonical archive manifest: a set of normalized entries, one
 *  per normalized path (duplicates are rejected). */
export interface ArchiveManifest {
  schemaVersion: typeof ARCHIVE_MANIFEST_SCHEMA_VERSION;
  entries: ManifestEntry[];
}

/** Rejections of a single manifest's structure and normalization. */
export type ManifestRejectionKind =
  | "invalid_entry"
  | "unsupported_schema_version"
  | "duplicate_path"
  | "colliding_path"
  | "absolute_path"
  | "traversal"
  | "unsupported_link"
  | "ambiguous_hoist_basename";

/** Precise reason a base tuple was replaced in the view. When more than one
 *  axis differs, the first differing axis in tuple order is reported:
 *  kind, bytes, sha256, symlink_target. */
export type ReplacedReason =
  | "changed_kind"
  | "changed_bytes"
  | "changed_sha256"
  | "changed_symlink_target";

/** Every rejection kind the strict-superset validator can emit. */
export type StrictSupersetRejectionKind =
  | ManifestRejectionKind
  | "missing_base_path"
  | "replaced_base_path";

/** One concrete rejection of a single manifest. Collects ALL problems; not
 *  fail-fast. */
export interface ManifestRejection {
  kind: ManifestRejectionKind;
  /** The normalized archive-relative path (or hoist basename) involved. */
  path: string;
  /** Optional human-readable context. */
  detail?: string;
}

/** One concrete strict-superset rejection. */
export interface StrictSupersetRejection {
  kind: StrictSupersetRejectionKind;
  /** The normalized archive-relative path (or hoist basename) involved. */
  path: string;
  /** Reason when `kind === "replaced_base_path"`. */
  replaced?: ReplacedReason;
  /** Optional human-readable context. */
  detail?: string;
}

/** Result of structural self-validation of one manifest. */
export interface ManifestSelfValidationResult {
  ok: boolean;
  rejections: ManifestRejection[];
}

/** Result of strict-superset comparison. Verdict is `"rejected"` when any
 *  rejection exists; all rejections are collected, never fail-fast. */
export interface StrictSupersetResult {
  verdict: "superset" | "rejected";
  rejections: StrictSupersetRejection[];
}

/** Options controlling strict-superset comparison. */
export interface StrictSupersetOptions {
  /** Reject when two distinct normalized paths share one basename (hoisted
   *  addressing would be ambiguous). Defaults to false; plain path addressing
   *  does not need hoisting. Enabling it never changes a valid superset
   *  relationship — it only decides whether an ambiguous manifest is accepted. */
  rejectAmbiguousHoist?: boolean;
}

/** Result of parsing serialized manifest bytes. */
export type ParseManifestResult =
  | { ok: true; manifest: ArchiveManifest }
  | { ok: false; rejections: ManifestRejection[] };

// ---------------------------------------------------------------------------
// Validator / encoder signatures (contract only — no logic here)
// ---------------------------------------------------------------------------

/** Normalize a raw archive path to canonical form; `null` when it is not a
 *  valid archive-relative path (absolute, traversing, or malformed). */
export type NormalizeArchivePath = (raw: string) => string | null;

/** Structural self-validation of one manifest: normalization invariants and
 *  entry well-formedness, including the schema-version check. Returns every
 *  rejection (not fail-fast). */
export type ManifestSelfValidator = (
  manifest: ArchiveManifest,
) => ManifestSelfValidationResult;

/** Strict-superset validation of a judgement archive-view over an immutable
 *  base. Rejects any duplicate/colliding/absolute/traversing/ambiguous path,
 *  any unsupported link, and any replaced or missing base path (design §2).
 *  Returns every rejection; verdict is `"rejected"` when any exists. */
export type StrictSupersetValidator = (
  base: ArchiveManifest,
  view: ArchiveManifest,
  options?: StrictSupersetOptions,
) => StrictSupersetResult;

/** Canonical serialization of a manifest to bytes whose sha256 is the manifest
 *  hash (deterministic field order, UTF-8, LF line endings). */
export type SerializeManifest = (manifest: ArchiveManifest) => string;

/** Decode and validate a manifest from its canonical serialized bytes. */
export type ParseManifest = (serialized: string) => ParseManifestResult;

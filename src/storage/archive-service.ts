/**
 * WP-2 archive-service: the runtime behind the frozen archive-manifest contract.
 *
 * `archive-manifest.ts` declares the types, the rejection taxonomy, and the
 * validator signatures, and is frozen. This module ships the functions that
 * conform to them: path normalization, canonical serialization, parsing, and
 * the two validators.
 *
 * The load-bearing property here is SERIALIZATION STABILITY. A manifest's
 * sha256 is its identity — it is embedded in the object key, recorded in the
 * generation row, and compared on every adoption and recovery path. An
 * unstable serializer would mint a second key for bytes that are semantically
 * the same manifest, silently forking an archive generation. So the canonical
 * form fixes entry order, key order, and encoding, and `parse(serialize(m))`
 * must round-trip to identical bytes.
 *
 * Validators RETURN rejections rather than throwing, and collect every problem
 * instead of failing fast: an operator repairing an archive wants the whole
 * list, and each rejection names the specific invariant that broke rather than
 * a generic "invalid", because "which invariant" is the actionable part.
 */

import {
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  type ArchiveManifest,
  type ManifestEntry,
  type ManifestRejection,
  type ManifestSelfValidationResult,
  type ParseManifestResult,
  type ReplacedReason,
  type StrictSupersetOptions,
  type StrictSupersetRejection,
  type StrictSupersetResult,
} from "./archive-manifest.js";

/** A file entry's content hash: exactly 64 lowercase hex characters. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** NUL and C0/C1 control characters are never valid in an archive path. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** A Windows drive or volume prefix (`C:`), which makes a path absolute. */
const DRIVE_PREFIX_RE = /^[A-Za-z]:/;

/** Node kinds that are real filesystem objects but are never archivable. */
const UNSUPPORTED_KINDS = new Set(["hardlink", "fifo", "socket", "device", "block", "char"]);

/** Why a raw path is not a valid archive-relative path. */
type PathRejectionKind = "absolute_path" | "traversal";

type PathClassification =
  | { ok: true; normalized: string }
  | { ok: false; kind: PathRejectionKind; detail: string };

/**
 * Classify and normalize one raw archive path.
 *
 * Normalization collapses repeated separators and strips a trailing separator;
 * it does NOT collapse `.` or `..`. Those are rejected outright, because a
 * manifest that can express traversal at all is a manifest whose paths cannot
 * be trusted as identities. Collapsing separators (rather than rejecting them)
 * is what makes two distinct raw paths able to collide on one normalized path,
 * which the caller reports as `colliding_path`.
 *
 * Unicode is normalized to NFC so that the same filename typed on macOS (NFD)
 * and Linux (NFC) resolves to one archive identity instead of two entries that
 * render identically and silently shadow each other.
 */
function classifyPath(raw: string): PathClassification {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, kind: "traversal", detail: "empty path" };
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    return { ok: false, kind: "traversal", detail: "path contains a control character" };
  }
  if (raw.startsWith("/") || DRIVE_PREFIX_RE.test(raw)) {
    return { ok: false, kind: "absolute_path", detail: "path is absolute" };
  }
  if (raw.includes("\\")) {
    return {
      ok: false,
      kind: "traversal",
      detail: "backslash is not a valid path separator",
    };
  }

  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { ok: false, kind: "traversal", detail: "path has no addressable segment" };
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return { ok: false, kind: "traversal", detail: `path contains a "${segment}" segment` };
    }
  }
  return { ok: true, normalized: segments.join("/").normalize("NFC") };
}

/**
 * Normalize a raw archive path to canonical form, or `null` when it is not a
 * valid archive-relative path.
 */
export const normalizeArchivePath = (raw: string): string | null => {
  const classified = classifyPath(raw);
  return classified.ok ? classified.normalized : null;
};

/**
 * Classify a symlink target, which — unlike an entry path — may legitimately
 * contain `..` so long as it still lands inside the archive root. The target is
 * resolved against the directory holding the link.
 */
function classifySymlinkTarget(
  entryPath: string,
  target: string,
): { ok: true } | { ok: false; kind: "traversal" | "unsupported_link"; detail: string } {
  if (typeof target !== "string" || target.length === 0) {
    return { ok: false, kind: "traversal", detail: "empty symlink target" };
  }
  if (CONTROL_CHAR_RE.test(target)) {
    return { ok: false, kind: "traversal", detail: "symlink target contains a control character" };
  }
  if (target.startsWith("/") || DRIVE_PREFIX_RE.test(target)) {
    return {
      ok: false,
      kind: "unsupported_link",
      detail: "symlink target is absolute, not archive-relative",
    };
  }
  if (target.includes("\\")) {
    return {
      ok: false,
      kind: "traversal",
      detail: "backslash is not a valid path separator in a symlink target",
    };
  }

  // Resolve the target against the link's own directory and confirm it never
  // climbs above the archive root.
  const resolved = entryPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) {
        return {
          ok: false,
          kind: "traversal",
          detail: "symlink target resolves outside the archive root",
        };
      }
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (resolved.length === 0) {
    return {
      ok: false,
      kind: "traversal",
      detail: "symlink target resolves to the archive root itself",
    };
  }
  return { ok: true };
}

/** Structural checks on one entry, independent of the other entries. */
function validateEntry(entry: ManifestEntry, rejections: ManifestRejection[]): void {
  const path = typeof entry?.path === "string" ? entry.path : "<unknown>";
  const kind: unknown = entry?.kind;

  if (typeof kind === "string" && UNSUPPORTED_KINDS.has(kind)) {
    rejections.push({
      kind: "unsupported_link",
      path,
      detail: `"${kind}" is not a regular file or an archive-relative symlink`,
    });
    return;
  }
  if (kind !== "file" && kind !== "symlink") {
    rejections.push({ kind: "invalid_entry", path, detail: `unknown entry kind "${String(kind)}"` });
    return;
  }
  if (typeof entry.path !== "string" || entry.path.length === 0) {
    rejections.push({ kind: "invalid_entry", path, detail: "entry is missing a path" });
    return;
  }
  if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
    rejections.push({
      kind: "invalid_entry",
      path,
      detail: "bytes must be a non-negative integer",
    });
    return;
  }

  if (kind === "file") {
    if (entry.symlinkTarget !== null) {
      rejections.push({
        kind: "invalid_entry",
        path,
        detail: "a file entry must carry symlinkTarget: null",
      });
      return;
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      rejections.push({
        kind: "invalid_entry",
        path,
        detail: "a file entry needs a sha256 of 64 lowercase hex characters",
      });
    }
    return;
  }

  if (entry.sha256 !== null) {
    rejections.push({
      kind: "invalid_entry",
      path,
      detail: "a symlink entry must carry sha256: null",
    });
    return;
  }
  if (entry.bytes !== 0) {
    rejections.push({ kind: "invalid_entry", path, detail: "a symlink entry must have bytes: 0" });
    return;
  }
  if (typeof entry.symlinkTarget !== "string") {
    rejections.push({ kind: "invalid_entry", path, detail: "a symlink entry needs a target" });
  }
}

/** Reject two distinct normalized paths that share one basename, which makes
 *  hoisted addressing ambiguous. Never silently pick a winner. */
function checkAmbiguousHoist(paths: string[], rejections: ManifestRejection[]): void {
  const byBasename = new Map<string, Set<string>>();
  for (const path of paths) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const seen = byBasename.get(basename) ?? new Set<string>();
    seen.add(path);
    byBasename.set(basename, seen);
  }
  for (const [basename, owners] of byBasename) {
    if (owners.size > 1) {
      rejections.push({
        kind: "ambiguous_hoist_basename",
        path: basename,
        detail: `${owners.size} distinct paths share this basename: ${[...owners].sort().join(", ")}`,
      });
    }
  }
}

/**
 * Structural self-validation of one manifest: schema version, entry
 * well-formedness, path normalization, and path uniqueness. Collects every
 * rejection rather than failing on the first.
 */
export const validateManifestSelf = (
  manifest: ArchiveManifest,
  options: StrictSupersetOptions = {},
): ManifestSelfValidationResult => {
  const rejections: ManifestRejection[] = [];

  if (manifest?.schemaVersion !== ARCHIVE_MANIFEST_SCHEMA_VERSION) {
    rejections.push({
      kind: "unsupported_schema_version",
      path: "",
      detail: `expected schemaVersion ${ARCHIVE_MANIFEST_SCHEMA_VERSION}, got ${String(manifest?.schemaVersion)}`,
    });
    return { ok: false, rejections };
  }
  if (!Array.isArray(manifest.entries)) {
    rejections.push({ kind: "invalid_entry", path: "", detail: "entries must be an array" });
    return { ok: false, rejections };
  }

  const rawSeen = new Set<string>();
  const normalizedOwners = new Map<string, string>();
  const normalizedPaths: string[] = [];

  for (const entry of manifest.entries) {
    validateEntry(entry, rejections);

    const raw = entry?.path;
    if (typeof raw !== "string" || raw.length === 0) continue;

    const classified = classifyPath(raw);
    if (!classified.ok) {
      rejections.push({ kind: classified.kind, path: raw, detail: classified.detail });
      continue;
    }
    const normalized = classified.normalized;

    if (rawSeen.has(raw)) {
      rejections.push({
        kind: "duplicate_path",
        path: normalized,
        detail: "the same path appears more than once",
      });
    } else {
      rawSeen.add(raw);
      const owner = normalizedOwners.get(normalized);
      if (owner !== undefined) {
        rejections.push({
          kind: "colliding_path",
          path: normalized,
          detail: `"${owner}" and "${raw}" normalize to the same path`,
        });
      } else {
        normalizedOwners.set(normalized, raw);
        normalizedPaths.push(normalized);
      }
    }

    if (entry.kind === "symlink" && typeof entry.symlinkTarget === "string") {
      const target = classifySymlinkTarget(normalized, entry.symlinkTarget);
      if (!target.ok) {
        rejections.push({ kind: target.kind, path: normalized, detail: target.detail });
      }
    }
  }

  if (options.rejectAmbiguousHoist === true) {
    checkAmbiguousHoist(normalizedPaths, rejections);
  }

  return { ok: rejections.length === 0, rejections };
};

/** The tuple axes, compared in the locked order so the reported `replaced`
 *  reason is always the FIRST differing axis. */
function firstDifferingAxis(base: ManifestEntry, view: ManifestEntry): ReplacedReason | null {
  if (base.kind !== view.kind) return "changed_kind";
  if (base.bytes !== view.bytes) return "changed_bytes";
  if (base.sha256 !== view.sha256) return "changed_sha256";
  if (base.symlinkTarget !== view.symlinkTarget) return "changed_symlink_target";
  return null;
}

/**
 * Strict-superset validation of a judgement archive-view over an immutable
 * base: every base tuple must appear in the view unchanged, and the view may
 * only add entries.
 */
export const validateStrictSuperset = (
  base: ArchiveManifest,
  view: ArchiveManifest,
  options: StrictSupersetOptions = {},
): StrictSupersetResult => {
  const rejections: StrictSupersetRejection[] = [];

  const baseSelf = validateManifestSelf(base, options);
  for (const rejection of baseSelf.rejections) {
    rejections.push({ ...rejection, detail: `base: ${rejection.detail ?? ""}`.trim() });
  }
  const viewSelf = validateManifestSelf(view, options);
  for (const rejection of viewSelf.rejections) {
    rejections.push({ ...rejection, detail: `view: ${rejection.detail ?? ""}`.trim() });
  }

  // Comparison is defined only within one schema version. A version mismatch is
  // reported once and the tuple comparison is abandoned, because comparing
  // across decoders would produce meaningless diffs.
  if (base?.schemaVersion !== view?.schemaVersion) {
    rejections.push({
      kind: "unsupported_schema_version",
      path: "",
      detail: `view schemaVersion ${String(view?.schemaVersion)} differs from base ${String(base?.schemaVersion)}`,
    });
    return { verdict: "rejected", rejections };
  }
  if (!baseSelf.ok || !viewSelf.ok) {
    return { verdict: "rejected", rejections };
  }

  const viewByPath = new Map<string, ManifestEntry>();
  for (const entry of view.entries) {
    const normalized = normalizeArchivePath(entry.path);
    if (normalized !== null) viewByPath.set(normalized, entry);
  }

  for (const baseEntry of base.entries) {
    const normalized = normalizeArchivePath(baseEntry.path);
    if (normalized === null) continue;

    const viewEntry = viewByPath.get(normalized);
    if (viewEntry === undefined) {
      rejections.push({
        kind: "missing_base_path",
        path: normalized,
        detail: "a base entry is absent from the view",
      });
      continue;
    }
    const replaced = firstDifferingAxis(baseEntry, viewEntry);
    if (replaced !== null) {
      rejections.push({
        kind: "replaced_base_path",
        path: normalized,
        replaced,
        detail: "a base entry was replaced in the view",
      });
    }
  }

  return { verdict: rejections.length === 0 ? "superset" : "rejected", rejections };
};

/**
 * Canonical serialization. Entries are sorted by normalized path and each is
 * emitted with a fixed key order on its own LF-terminated line, so the bytes —
 * and therefore the manifest hash — are a pure function of the manifest's
 * content and not of insertion order.
 *
 * Sort is by UTF-16 code unit, which is deterministic across platforms; the
 * requirement is stability, not any particular collation.
 */
export const serializeManifest = (manifest: ArchiveManifest): string => {
  const lines = [JSON.stringify({ schemaVersion: manifest.schemaVersion })];
  const sorted = [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    lines.push(
      JSON.stringify({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        sha256: entry.sha256,
        symlinkTarget: entry.symlinkTarget,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
};

/** The exact key set a serialized entry line must carry — no more, no less. */
const ENTRY_KEYS = ["path", "kind", "bytes", "sha256", "symlinkTarget"] as const;

/** Decode and validate a manifest from its canonical serialized bytes. */
export const parseManifest = (serialized: string): ParseManifestResult => {
  const rejections: ManifestRejection[] = [];

  if (typeof serialized !== "string" || serialized.length === 0) {
    return {
      ok: false,
      rejections: [{ kind: "invalid_entry", path: "", detail: "empty manifest bytes" }],
    };
  }
  if (!serialized.endsWith("\n")) {
    rejections.push({
      kind: "invalid_entry",
      path: "",
      detail: "canonical manifest bytes must end with a newline",
    });
  }
  if (serialized.includes("\r")) {
    rejections.push({
      kind: "invalid_entry",
      path: "",
      detail: "canonical manifest bytes use LF line endings only",
    });
  }

  const lines = serialized.replace(/\n$/, "").split("\n");
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return {
      ok: false,
      rejections: [
        ...rejections,
        { kind: "invalid_entry", path: "", detail: "manifest header is not valid JSON" },
      ],
    };
  }

  const schemaVersion = (header as { schemaVersion?: unknown })?.schemaVersion;
  if (schemaVersion !== ARCHIVE_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      rejections: [
        ...rejections,
        {
          kind: "unsupported_schema_version",
          path: "",
          detail: `expected schemaVersion ${ARCHIVE_MANIFEST_SCHEMA_VERSION}, got ${String(schemaVersion)}`,
        },
      ],
    };
  }

  const entries: ManifestEntry[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(lines[i] as string);
    } catch {
      rejections.push({
        kind: "invalid_entry",
        path: "",
        detail: `entry on line ${i + 1} is not valid JSON`,
      });
      continue;
    }
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      rejections.push({
        kind: "invalid_entry",
        path: "",
        detail: `entry on line ${i + 1} is not an object`,
      });
      continue;
    }
    const keys = Object.keys(decoded as Record<string, unknown>).sort();
    const expected = [...ENTRY_KEYS].sort();
    if (keys.length !== expected.length || keys.some((key, idx) => key !== expected[idx])) {
      rejections.push({
        kind: "invalid_entry",
        path: String((decoded as { path?: unknown }).path ?? "<unknown>"),
        detail: `entry must carry exactly ${expected.join(", ")}`,
      });
      continue;
    }
    entries.push(decoded as ManifestEntry);
  }

  if (rejections.length > 0) return { ok: false, rejections };

  const manifest: ArchiveManifest = {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    entries,
  };
  const self = validateManifestSelf(manifest);
  if (!self.ok) return { ok: false, rejections: self.rejections };

  return { ok: true, manifest };
};

/**
 * Behavioral tests for the archive-manifest runtime (`src/storage/archive-service.ts`).
 *
 * `tests/themis-storage-contract.test.ts` freezes the SHAPE and carries the
 * rejection matrix (now also executing in that file). This file is the other half: one
 * real, executing test per matrix row.
 *
 * Each test asserts the SPECIFIC rejection kind (and `replaced` reason where the
 * matrix names one), never merely "it rejected". A validator that collapsed
 * every problem into one generic kind would pass a "did it reject?" test while
 * being useless to the operator who has to act on the rejection — so the kind
 * is the assertion.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  type ArchiveManifest,
  type ManifestEntry,
  type ManifestRejectionKind,
  type ReplacedReason,
  type StrictSupersetRejectionKind,
} from "../src/storage/archive-manifest.ts";
import {
  normalizeArchivePath,
  parseManifest,
  serializeManifest,
  validateManifestSelf,
  validateStrictSuperset,
} from "../src/storage/archive-service.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

/** A well-formed file entry. */
function file(path: string, sha256 = HASH_A, bytes = 10): ManifestEntry {
  return { path, kind: "file", bytes, sha256, symlinkTarget: null };
}

/** A well-formed archive-relative symlink entry. */
function symlink(path: string, symlinkTarget: string): ManifestEntry {
  return { path, kind: "symlink", bytes: 0, sha256: null, symlinkTarget };
}

/** A manifest at the supported schema version. */
function manifest(entries: ManifestEntry[]): ArchiveManifest {
  return { schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION, entries };
}

/** The rejection kinds a single-manifest validation produced. */
function selfKinds(m: ArchiveManifest, rejectAmbiguousHoist = false): ManifestRejectionKind[] {
  return validateManifestSelf(m, { rejectAmbiguousHoist }).rejections.map((r) => r.kind);
}

/** The rejection kinds a strict-superset comparison produced. */
function supersetKinds(base: ArchiveManifest, view: ArchiveManifest): StrictSupersetRejectionKind[] {
  return validateStrictSuperset(base, view).rejections.map((r) => r.kind);
}

const BASE = manifest([file("src/parse.ts", HASH_A, 120), file("README.md", HASH_B, 30)]);

/** A valid judgement view: the base plus a fixed judge/ tree. */
const VIEW = manifest([...BASE.entries, file("judge/evalJudge.yaml", HASH_C, 2048)]);

describe("path normalization", () => {
  it("normalizes to a canonical archive-relative form", () => {
    expect(normalizeArchivePath("src/parse.ts")).toBe("src/parse.ts");
    expect(normalizeArchivePath("src//parse.ts")).toBe("src/parse.ts");
    expect(normalizeArchivePath("src/parse.ts/")).toBe("src/parse.ts");
  });

  it("rejects paths that are not archive-relative", () => {
    for (const bad of ["/etc/passwd", "C:/tmp/x", "../escape", "./here", "", "a\\b"]) {
      expect(normalizeArchivePath(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("folds unicode so one filename is one archive identity", () => {
    // NFD "é" and NFC "é" render identically; treating them as two entries
    // would let one silently shadow the other.
    expect(normalizeArchivePath("caf\u0065\u0301.txt")).toBe(normalizeArchivePath("caf\u00e9.txt"));
  });
});

describe("canonical serialization", () => {
  it("is byte-stable across repeated serialization", () => {
    expect(serializeManifest(VIEW)).toBe(serializeManifest(VIEW));
  });

  it("is independent of entry insertion order", () => {
    // The manifest hash IS the archive generation's identity. If insertion
    // order changed the bytes, the same logical manifest would mint two keys
    // and silently fork the generation.
    const reordered = manifest([...VIEW.entries].reverse());
    expect(serializeManifest(reordered)).toBe(serializeManifest(VIEW));
    expect(createHash("sha256").update(serializeManifest(reordered)).digest("hex")).toBe(
      createHash("sha256").update(serializeManifest(VIEW)).digest("hex"),
    );
  });

  it("round-trips through parse with identical bytes", () => {
    const bytes = serializeManifest(VIEW);
    const parsed = parseManifest(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeManifest(parsed.manifest)).toBe(bytes);
  });

  it("emits LF-terminated bytes with no CR", () => {
    const bytes = serializeManifest(VIEW);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes).not.toContain("\r");
  });

  it("rejects bytes that are not canonical", () => {
    const bytes = serializeManifest(VIEW);
    expect(parseManifest(bytes.replace(/\n/g, "\r\n")).ok).toBe(false);
    expect(parseManifest(bytes.trimEnd()).ok).toBe(false);
    expect(parseManifest("").ok).toBe(false);
    expect(parseManifest("not json\n").ok).toBe(false);
  });
});

describe("a valid view is a strict superset", () => {
  it("accepts the base plus an added judge/ tree", () => {
    const result = validateStrictSuperset(BASE, VIEW);
    expect(result.rejections).toEqual([]);
    expect(result.verdict).toBe("superset");
  });

  it("accepts a view identical to the base", () => {
    expect(validateStrictSuperset(BASE, BASE).verdict).toBe("superset");
  });

  it("accepts archive-relative symlinks that stay inside the root", () => {
    const m = manifest([file("a/b/target.txt"), symlink("a/b/link.txt", "target.txt")]);
    expect(validateManifestSelf(m).rejections).toEqual([]);
    const nested = manifest([file("a/b/target.txt"), symlink("a/c/link.txt", "../b/target.txt")]);
    expect(validateManifestSelf(nested).rejections).toEqual([]);
  });
});

// --- the frozen rejection matrix, one executing test per row ----------------

describe("rejection matrix: single-manifest structure and normalization", () => {
  it("invalid-entry-missing-fields", () => {
    const broken = { path: "src/parse.ts", kind: "file" } as unknown as ManifestEntry;
    expect(selfKinds(manifest([broken]))).toContain("invalid_entry");
  });

  it("invalid-entry-bad-bytes", () => {
    expect(selfKinds(manifest([file("a.txt", HASH_A, -1)]))).toContain("invalid_entry");
    expect(selfKinds(manifest([file("a.txt", HASH_A, 1.5)]))).toContain("invalid_entry");
  });

  it("invalid-entry-bad-sha256", () => {
    for (const bad of ["A".repeat(64), "abc", `${HASH_A}0`]) {
      expect(selfKinds(manifest([file("a.txt", bad)])), `sha256 ${bad}`).toContain("invalid_entry");
    }
  });

  it("invalid-entry-file-symlink-mix", () => {
    const fileWithTarget = {
      path: "a.txt",
      kind: "file",
      bytes: 1,
      sha256: HASH_A,
      symlinkTarget: "b.txt",
    } as unknown as ManifestEntry;
    expect(selfKinds(manifest([fileWithTarget]))).toContain("invalid_entry");

    const symlinkWithHash = {
      path: "a.txt",
      kind: "symlink",
      bytes: 0,
      sha256: HASH_A,
      symlinkTarget: "b.txt",
    } as unknown as ManifestEntry;
    expect(selfKinds(manifest([symlinkWithHash]))).toContain("invalid_entry");

    const symlinkWithBytes = {
      path: "a.txt",
      kind: "symlink",
      bytes: 5,
      sha256: null,
      symlinkTarget: "b.txt",
    } as unknown as ManifestEntry;
    expect(selfKinds(manifest([symlinkWithBytes]))).toContain("invalid_entry");
  });

  it("unsupported-schema-version", () => {
    const wrong = { schemaVersion: 999, entries: [file("a.txt")] } as unknown as ArchiveManifest;
    expect(selfKinds(wrong)).toContain("unsupported_schema_version");
  });

  it("schema-version-mismatch (view differs from base)", () => {
    const wrong = { schemaVersion: 2, entries: BASE.entries } as unknown as ArchiveManifest;
    const result = validateStrictSuperset(BASE, wrong);
    expect(result.verdict).toBe("rejected");
    expect(result.rejections.map((r) => r.kind)).toContain("unsupported_schema_version");
  });

  it("duplicate-path", () => {
    expect(selfKinds(manifest([file("a.txt", HASH_A), file("a.txt", HASH_B)]))).toContain(
      "duplicate_path",
    );
  });

  it("colliding-path", () => {
    // Two distinct raw paths normalizing to one path is a COLLISION, not a
    // duplicate: neither raw string repeats, so a naive dedupe by raw string
    // accepts both and one silently shadows the other.
    const kinds = selfKinds(manifest([file("src/a.txt", HASH_A), file("src//a.txt", HASH_B)]));
    expect(kinds).toContain("colliding_path");
    expect(kinds).not.toContain("duplicate_path");
  });

  it("absolute-path", () => {
    expect(selfKinds(manifest([file("/etc/passwd")]))).toContain("absolute_path");
    expect(selfKinds(manifest([file("C:/windows/x")]))).toContain("absolute_path");
  });

  it("dot-segment", () => {
    expect(selfKinds(manifest([file("src/./a.txt")]))).toContain("traversal");
  });

  it("dotdot-segment", () => {
    expect(selfKinds(manifest([file("src/../../escape.txt")]))).toContain("traversal");
  });

  it("empty-path", () => {
    expect(selfKinds(manifest([file("")]))).toContain("invalid_entry");
    expect(selfKinds(manifest([file("/")]))).toContain("absolute_path");
  });

  it("backslash-separator", () => {
    expect(selfKinds(manifest([file("src\\a.txt")]))).toContain("traversal");
  });

  it("symlink-target-escape", () => {
    expect(selfKinds(manifest([symlink("a/link.txt", "../../outside.txt")]))).toContain("traversal");
  });

  it("unsupported-link-hardlink", () => {
    const hardlink = {
      path: "a.txt",
      kind: "hardlink",
      bytes: 0,
      sha256: null,
      symlinkTarget: "b.txt",
    } as unknown as ManifestEntry;
    expect(selfKinds(manifest([hardlink]))).toContain("unsupported_link");
  });

  it("unsupported-link-special (fifo/socket/device)", () => {
    for (const kind of ["fifo", "socket", "device"]) {
      const node = {
        path: "a.sock",
        kind,
        bytes: 0,
        sha256: null,
        symlinkTarget: null,
      } as unknown as ManifestEntry;
      expect(selfKinds(manifest([node])), `kind ${kind}`).toContain("unsupported_link");
    }
  });

  it("unsupported-absolute-symlink-target", () => {
    const kinds = selfKinds(manifest([symlink("a/link.txt", "/etc/passwd")]));
    expect(kinds).toContain("unsupported_link");
  });

  it("ambiguous-hoist-basename", () => {
    const m = manifest([file("src/config.json", HASH_A), file("test/config.json", HASH_B)]);
    // Only ambiguous when the caller addresses entries by hoisted basename.
    expect(selfKinds(m, false)).not.toContain("ambiguous_hoist_basename");
    expect(selfKinds(m, true)).toContain("ambiguous_hoist_basename");
  });
});

describe("rejection matrix: strict-superset over the immutable base", () => {
  it("missing-base-path", () => {
    const view = manifest([file("src/parse.ts", HASH_A, 120), file("judge/evalJudge.yaml", HASH_C)]);
    const result = validateStrictSuperset(BASE, view);
    expect(result.verdict).toBe("rejected");
    expect(result.rejections).toContainEqual(
      expect.objectContaining({ kind: "missing_base_path", path: "README.md" }),
    );
  });

  /** Replace one base entry in the view and return the reported reason. */
  function replacedReason(replacement: ManifestEntry): ReplacedReason | undefined {
    const view = manifest([replacement, file("README.md", HASH_B, 30)]);
    const rejection = validateStrictSuperset(BASE, view).rejections.find(
      (r) => r.kind === "replaced_base_path",
    );
    return rejection?.replaced;
  }

  it("replaced-base-changed-kind", () => {
    expect(replacedReason(symlink("src/parse.ts", "README.md"))).toBe("changed_kind");
  });

  it("replaced-base-changed-bytes", () => {
    expect(replacedReason(file("src/parse.ts", HASH_A, 121))).toBe("changed_bytes");
  });

  it("replaced-base-changed-sha256", () => {
    expect(replacedReason(file("src/parse.ts", HASH_C, 120))).toBe("changed_sha256");
  });

  it("replaced-base-changed-symlink-target", () => {
    const base = manifest([symlink("link.txt", "a.txt"), file("a.txt"), file("b.txt", HASH_B)]);
    const view = manifest([symlink("link.txt", "b.txt"), file("a.txt"), file("b.txt", HASH_B)]);
    const rejection = validateStrictSuperset(base, view).rejections.find(
      (r) => r.kind === "replaced_base_path",
    );
    expect(rejection?.replaced).toBe("changed_symlink_target");
  });

  it("reports the FIRST differing axis when several differ at once", () => {
    // Tuple order is kind, bytes, sha256, symlink_target. A view entry that
    // differs on every axis must still report changed_kind, so the reason is
    // deterministic rather than dependent on check order.
    expect(replacedReason(symlink("src/parse.ts", "elsewhere.txt"))).toBe("changed_kind");
  });

  it("collects every rejection rather than stopping at the first", () => {
    const view = manifest([file("src/parse.ts", HASH_C, 120)]);
    const result = validateStrictSuperset(BASE, view);
    expect(result.rejections.length).toBeGreaterThanOrEqual(2);
    expect(supersetKinds(BASE, view)).toEqual(
      expect.arrayContaining(["replaced_base_path", "missing_base_path"]),
    );
  });
});

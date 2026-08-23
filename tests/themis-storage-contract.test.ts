/**
 * WP-2 contract tests: artifact-store + archive-manifest.
 *
 * Written FIRST, before any implementation exists, and frozen. Two jobs:
 *
 *  1. SHAPE tests — runnable right now against the type contracts. They pin
 *     the ArtifactStore method surface, the async/streaming signatures, and the
 *     manifest/validator shapes so an implementation cannot drift from the
 *     contract.
 *  2. The strict-superset REJECTION MATRIX — an exhaustive, counted table of
 *     every locked rejection case. Each row now carries a `build()` that
 *     constructs the base/view pair exhibiting its scenario, so the row is both
 *     the checklist entry and the executing test. Two guards keep it honest:
 *     the count guard means a row cannot be quietly dropped, and each row
 *     asserts on ITS OWN rejection kind (and `replaced` reason), so a row
 *     cannot be satisfied by a validator that rejects indiscriminately.
 *
 * The matrix was originally `it.todo` while no runtime validator existed. It is
 * now driven against `validateStrictSuperset`. `tests/archive-manifest.test.ts`
 * covers the same ids from the other direction — unit-level, against
 * `validateManifestSelf` and the parser — so a rule that regresses in only one
 * of the two call paths still fails. `stubArtifactStore()` below remains a
 * structural stand-in, not an implementation.
 */

import { Readable } from "node:stream";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  MANIFEST_HASH_ALGORITHM,
} from "../src/storage/archive-manifest.ts";
import type {
  ArchiveManifest,
  ManifestEntry,
  ManifestSelfValidationResult,
  ManifestSelfValidator,
  ParseManifest,
  ParseManifestResult,
  ReplacedReason,
  SerializeManifest,
  StrictSupersetOptions,
  StrictSupersetRejection,
  StrictSupersetRejectionKind,
  StrictSupersetResult,
  StrictSupersetValidator,
} from "../src/storage/archive-manifest.ts";
import { validateStrictSuperset } from "../src/storage/archive-service.ts";
import { ArtifactStoreError } from "../src/storage/artifact-store.ts";
import type {
  ArtifactDeleteOutcome,
  ArtifactHead,
  ArtifactMetadata,
  ArtifactPut,
  ArtifactPutResult,
  ArtifactRangeRead,
  ArtifactRead,
  ArtifactStore,
  ByteRange,
  DeleteGuard,
} from "../src/storage/artifact-store.ts";

const LOCKED_OPERATIONS = ["deleteIfUnreferenced", "get", "head", "put", "range"] as const;

/** Minimal structural stand-in for ArtifactStore, used ONLY to pin the method
 *  surface and the async/streaming shape. Not an implementation. */
function stubArtifactStore(): ArtifactStore {
  return {
    put: async (_input: ArtifactPut): Promise<ArtifactPutResult> => {
      throw new Error("contract stub: not implemented");
    },
    get: async (key: string): Promise<ArtifactRead> => ({
      key,
      sha256: null,
      bytes: 0,
      contentType: null,
      stream: Readable.from([]),
    }),
    head: async (key: string): Promise<ArtifactHead> => ({ key, exists: false }),
    range: async (key: string, range: ByteRange): Promise<ArtifactRangeRead> => ({
      key,
      sha256: null,
      bytes: 0,
      contentType: null,
      stream: Readable.from([]),
      range: { offset: range.offset, length: range.length ?? 0 },
    }),
    deleteIfUnreferenced: async (
      key: string,
      _guard: DeleteGuard,
    ): Promise<ArtifactDeleteOutcome> => ({ deleted: false, key, reason: "not_found" }),
  };
}

// ---------------------------------------------------------------------------
// ArtifactStore — shape
// ---------------------------------------------------------------------------

describe("ArtifactStore contract — shape", () => {
  it("exposes exactly the five locked operations (no more, no fewer)", () => {
    const store = stubArtifactStore();
    expect(Object.keys(store).sort()).toEqual([...LOCKED_OPERATIONS].sort());
  });

  it("every operation returns a promise (nothing new is synchronous)", async () => {
    const store = stubArtifactStore();
    const putP = store.put({ source: Readable.from([Buffer.from("x")]) });
    const headP = store.head("blobs/sha256/ab/abcdef0123");
    const rangeP = store.range("blobs/sha256/ab/abcdef0123", { offset: 0, length: 1 });
    const delP = store.deleteIfUnreferenced("blobs/sha256/ab/abcdef0123", {
      isUnreferenced: async () => true,
    });
    for (const p of [putP, headP, rangeP, delP]) {
      expect(p).toBeInstanceOf(Promise);
    }
    await Promise.all([headP, rangeP, delP]);
    await expect(putP).rejects.toThrow("contract stub: not implemented");
  });

  it("put accepts a streaming Readable source and reports key/hash/bytes", async () => {
    const store = stubArtifactStore();
    const input: ArtifactPut = { source: Readable.from([Buffer.from("payload")]) };
    const result = store.put(input);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow("contract stub: not implemented");
  });

  it("get and range stream a Readable body (bounded-memory contract)", async () => {
    const store = stubArtifactStore();
    const full = await store.get("blobs/sha256/ab/abcdef0123");
    expect(full.stream).toBeInstanceOf(Readable);
    const window = await store.range("blobs/sha256/ab/abcdef0123", { offset: 0, length: 4 });
    expect(window.stream).toBeInstanceOf(Readable);
    expect(window.range).toEqual({ offset: 0, length: 4 });
  });

  it("head returns metadata only, never bytes", async () => {
    const store = stubArtifactStore();
    const head = await store.head("blobs/sha256/ab/abcdef0123");
    expect(head.key).toBe("blobs/sha256/ab/abcdef0123");
    expect(head.exists).toBe(false);
  });

  it("deleteIfUnreferenced is conditional and returns an explicit outcome", async () => {
    const store = stubArtifactStore();
    const outcome = await store.deleteIfUnreferenced("blobs/sha256/ab/abcdef0123", {
      expectedSha256: "ab".repeat(32),
      isUnreferenced: async () => true,
    });
    expect(outcome.deleted).toBe(false);
    expect(outcome.reason).toBe("not_found");
  });

  it("ArtifactStoreError carries a typed kind and key", () => {
    const err = new ArtifactStoreError(
      "immutable_key_conflict",
      "deterministic key already holds different bytes; refusing to overwrite",
      "manifests/run-1/generation-1/somehash.manifest",
    );
    expect(err.name).toBe("ArtifactStoreError");
    expect(err.kind).toBe("immutable_key_conflict");
    expect(err.key).toMatch(/^manifests\//);
  });

  it("every operation resolves to its promised result type", () => {
    expectTypeOf<ArtifactStore["put"]>().returns.toEqualTypeOf<Promise<ArtifactPutResult>>();
    expectTypeOf<ArtifactStore["get"]>().returns.toEqualTypeOf<Promise<ArtifactRead>>();
    expectTypeOf<ArtifactStore["head"]>().returns.toEqualTypeOf<Promise<ArtifactHead>>();
    expectTypeOf<ArtifactStore["range"]>().returns.toEqualTypeOf<Promise<ArtifactRangeRead>>();
    expectTypeOf<ArtifactStore["deleteIfUnreferenced"]>().returns.toEqualTypeOf<
      Promise<ArtifactDeleteOutcome>
    >();
  });
});

// ---------------------------------------------------------------------------
// ArchiveManifest — shape
// ---------------------------------------------------------------------------

describe("ArchiveManifest contract — shape", () => {
  it("declares an explicit locked schema version", () => {
    expect(ARCHIVE_MANIFEST_SCHEMA_VERSION).toBe(1);
  });

  it("uses sha256 as the content hash algorithm", () => {
    expect(MANIFEST_HASH_ALGORITHM).toBe("sha256");
  });

  it("a well-formed manifest literal satisfies ArchiveManifest", () => {
    const manifest = {
      schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
      entries: [
        {
          path: "retained/trace.jsonl",
          kind: "file",
          bytes: 12,
          sha256: "0f".repeat(32),
          symlinkTarget: null,
        } satisfies ManifestEntry,
      ],
    } satisfies ArchiveManifest;
    expect(manifest.entries[0]?.kind).toBe("file");
    expect(manifest.entries[0]?.symlinkTarget).toBeNull();
  });

  it("a well-formed symlink entry satisfies ManifestEntry", () => {
    const entry = {
      path: "judge/current",
      kind: "symlink",
      bytes: 0,
      sha256: null,
      symlinkTarget: "judge/evalJudge.yaml",
    } satisfies ManifestEntry;
    expect(entry.symlinkTarget).toBe("judge/evalJudge.yaml");
  });

  it("validator signatures return typed results and take the locked arguments", () => {
    expectTypeOf<StrictSupersetValidator>().returns.toEqualTypeOf<StrictSupersetResult>();
    expectTypeOf<ManifestSelfValidator>().returns.toEqualTypeOf<ManifestSelfValidationResult>();
    expectTypeOf<ParseManifest>().returns.toEqualTypeOf<ParseManifestResult>();
    expectTypeOf<SerializeManifest>().returns.toBeString();
    expectTypeOf<StrictSupersetValidator>().parameters.toEqualTypeOf<
      [ArchiveManifest, ArchiveManifest, StrictSupersetOptions?]
    >();
  });

  it("the rejection taxonomy is a closed, documented union", () => {
    const kinds: StrictSupersetRejectionKind[] = [
      "invalid_entry",
      "unsupported_schema_version",
      "duplicate_path",
      "colliding_path",
      "absolute_path",
      "traversal",
      "unsupported_link",
      "ambiguous_hoist_basename",
      "missing_base_path",
      "replaced_base_path",
    ];
    expect(kinds).toHaveLength(10);
    const reasons: ReplacedReason[] = ["changed_kind", "changed_bytes", "changed_sha256", "changed_symlink_target"];
    expect(reasons).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Strict-superset rejection matrix — frozen implementer checklist
// ---------------------------------------------------------------------------

/** A well-formed file entry, optionally mutated by `over` to build a defect. */
function file(path: string, over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    path,
    kind: "file",
    bytes: 3,
    sha256: "ab".repeat(32),
    symlinkTarget: null,
    ...over,
  } as ManifestEntry;
}

/** A well-formed archive-relative symlink entry. */
function link(path: string, target: string): ManifestEntry {
  return { path, kind: "symlink", bytes: 0, sha256: null, symlinkTarget: target };
}

/** The immutable base every view in this matrix is validated against. It is
 *  deliberately self-valid — a defective base would make every row reject for
 *  the wrong reason and the matrix would prove nothing. */
const BASE: ArchiveManifest = {
  schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
  entries: [file("retained/trace.jsonl"), link("retained/current", "trace.jsonl")],
};

/** The judge tree a legitimate view adds on top of the base. */
const JUDGE_TREE: ManifestEntry[] = [
  file("judge/evalJudge.yaml", { bytes: 42, sha256: "cd".repeat(32) }),
];

/** A view that is a valid strict superset of BASE. Every defective view in the
 *  matrix is this one with a single mutation, so a row proves that mutation —
 *  and not some unrelated defect — is what the validator rejects. */
function cleanView(): ArchiveManifest {
  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    entries: [...BASE.entries, ...JUDGE_TREE],
  };
}

/** A view carrying one extra (usually defective) entry. */
function viewPlus(...extra: ManifestEntry[]): ArchiveManifest {
  const view = cleanView();
  return { ...view, entries: [...view.entries, ...extra] };
}

/** A view in which one base path has been replaced by `replacement`. */
function viewReplacing(path: string, replacement: ManifestEntry): ArchiveManifest {
  const view = cleanView();
  return { ...view, entries: view.entries.map((e) => (e.path === path ? replacement : e)) };
}

/** The exact inputs one matrix row feeds to the validator. */
interface RejectionScenario {
  base: ArchiveManifest;
  view: ArchiveManifest;
  options?: StrictSupersetOptions;
}

/** One locked rejection case. `build()` makes the row executable: it drives the
 *  runtime validator (conforming to StrictSupersetValidator) and the test
 *  expects `kind` (+ `replaced`) in the result. The row is therefore both the
 *  checklist entry and the test fixture — a row cannot be marked done without
 *  an assertion, and cannot be dropped without failing the count guard. */
interface RejectionCase {
  /** Stable unique id; the checklist name. */
  id: string;
  /** The rejection kind the runtime validator must emit. */
  kind: StrictSupersetRejectionKind;
  /** Precise reason when kind is "replaced_base_path". */
  replaced?: ReplacedReason;
  /** Concrete scenario the validator must reject. */
  scenario: string;
  /** Construct the base/view pair that exhibits `scenario`. */
  build: () => RejectionScenario;
  /** Extra assertion on the rejection detail, where the `kind` alone does not
   *  distinguish this row from a neighbouring one. */
  detailMatch?: RegExp;
}

/** Minimum row count the matrix must never fall below. */
const EXPECTED_REJECTION_CASE_COUNT = 23;

const REJECTION_CASES = [
  // --- single-manifest structure / normalization ---
  {
    id: "invalid-entry-missing-fields",
    kind: "invalid_entry",
    scenario: "an entry missing required tuple fields (path/kind/bytes/sha256/symlink_target)",
    build: () => ({
      base: BASE,
      view: viewPlus({
        path: "judge/partial.yaml",
        bytes: 3,
        sha256: "ab".repeat(32),
        symlinkTarget: null,
      } as unknown as ManifestEntry),
    }),
    detailMatch: /unknown entry kind/,
  },
  {
    id: "invalid-entry-bad-bytes",
    kind: "invalid_entry",
    scenario: "an entry with a non-integer or negative bytes value",
    build: () => ({ base: BASE, view: viewPlus(file("judge/neg.yaml", { bytes: -1 })) }),
    detailMatch: /non-negative integer/,
  },
  {
    id: "invalid-entry-bad-sha256",
    kind: "invalid_entry",
    scenario: "a file entry whose sha256 is not 64 lowercase hex",
    build: () => ({
      base: BASE,
      view: viewPlus(file("judge/badhash.yaml", { sha256: "AB".repeat(32) })),
    }),
    detailMatch: /64 lowercase hex/,
  },
  {
    id: "invalid-entry-file-symlink-mix",
    kind: "invalid_entry",
    scenario: "a file carrying symlink_target or a symlink carrying sha256 or bytes !== 0",
    build: () => ({
      base: BASE,
      view: viewPlus(file("judge/mixed.yaml", { symlinkTarget: "judge/evalJudge.yaml" })),
    }),
    detailMatch: /symlinkTarget: null/,
  },
  {
    id: "unsupported-schema-version",
    kind: "unsupported_schema_version",
    scenario: "a manifest whose schemaVersion is not the supported version",
    // Base and view agree, so the mismatch rule cannot fire — the rejection can
    // only come from the version being unsupported at all.
    build: () => ({
      base: { ...BASE, schemaVersion: 999 },
      view: { ...cleanView(), schemaVersion: 999 },
    }),
    detailMatch: /expected schemaVersion 1/,
  },
  {
    id: "schema-version-mismatch",
    kind: "unsupported_schema_version",
    scenario: "a view whose schemaVersion differs from the base",
    build: () => ({ base: BASE, view: { ...cleanView(), schemaVersion: 2 } }),
    detailMatch: /differs from base/,
  },
  {
    id: "duplicate-path",
    kind: "duplicate_path",
    scenario: "the same normalized path appearing twice in one manifest",
    build: () => ({
      base: BASE,
      view: viewPlus(file("judge/twice.yaml"), file("judge/twice.yaml")),
    }),
  },
  {
    id: "colliding-path",
    kind: "colliding_path",
    scenario: "two distinct raw paths that normalize to the same normalized path",
    build: () => ({
      base: BASE,
      view: viewPlus(file("judge/collide.yaml"), file("judge//collide.yaml")),
    }),
  },
  {
    id: "absolute-path",
    kind: "absolute_path",
    scenario: "a path with a leading '/' (or a drive/volume prefix)",
    build: () => ({ base: BASE, view: viewPlus(file("/etc/passwd")) }),
  },
  {
    id: "dot-segment",
    kind: "traversal",
    scenario: "a path containing a '.' segment",
    build: () => ({ base: BASE, view: viewPlus(file("judge/./dot.yaml")) }),
    detailMatch: /"\." segment/,
  },
  {
    id: "dotdot-segment",
    kind: "traversal",
    scenario: "a path containing a '..' segment that escapes the archive root",
    build: () => ({ base: BASE, view: viewPlus(file("judge/../../escape.yaml")) }),
    detailMatch: /"\.\." segment/,
  },
  {
    // CORRECTED KIND. The matrix originally declared `traversal` here, which no
    // input can actually produce, and writing the row made that visible:
    //   - raw ""      -> `invalid_entry` ("entry is missing a path"); the raw
    //                    path is never handed to the classifier at all.
    //   - raw "/", "///" -> `absolute_path`; a string that normalizes to
    //                    nothing must be all separators, and all separators
    //                    means a leading "/", which is checked first.
    // So the classifier's "no addressable segment" traversal branch is
    // unreachable, and `traversal` was the wrong contract for this row. The
    // row now asserts what the system does. `tests/archive-manifest.test.ts`
    // independently pins both spellings, so neither can drift.
    id: "empty-path",
    kind: "invalid_entry",
    scenario: "an empty normalized path",
    build: () => ({ base: BASE, view: viewPlus(file("")) }),
    detailMatch: /missing a path/,
  },
  {
    id: "backslash-separator",
    kind: "traversal",
    scenario: "a path using a backslash separator (not a valid normalized separator)",
    build: () => ({ base: BASE, view: viewPlus(file("judge\\win.yaml")) }),
    detailMatch: /backslash/,
  },
  {
    id: "symlink-target-escape",
    kind: "traversal",
    scenario: "a symlink whose target resolves outside the archive root",
    build: () => ({ base: BASE, view: viewPlus(link("judge/out", "../../outside.yaml")) }),
    detailMatch: /outside the archive root/,
  },
  {
    id: "unsupported-link-hardlink",
    kind: "unsupported_link",
    scenario: "a hardlink node",
    build: () => ({
      base: BASE,
      view: viewPlus({
        path: "judge/hard",
        kind: "hardlink",
        bytes: 3,
        sha256: "ab".repeat(32),
        symlinkTarget: null,
      } as unknown as ManifestEntry),
    }),
    detailMatch: /hardlink/,
  },
  {
    id: "unsupported-link-special",
    kind: "unsupported_link",
    scenario: "a fifo/socket/device node",
    build: () => ({
      base: BASE,
      view: viewPlus({
        path: "judge/pipe",
        kind: "fifo",
        bytes: 0,
        sha256: null,
        symlinkTarget: null,
      } as unknown as ManifestEntry),
    }),
    detailMatch: /fifo/,
  },
  {
    id: "unsupported-absolute-symlink-target",
    kind: "unsupported_link",
    scenario: "a symlink whose target is absolute rather than archive-relative",
    build: () => ({ base: BASE, view: viewPlus(link("judge/abs", "/etc/passwd")) }),
    detailMatch: /absolute, not archive-relative/,
  },
  {
    id: "ambiguous-hoist-basename",
    kind: "ambiguous_hoist_basename",
    scenario: "two distinct normalized paths sharing one basename under hoisted addressing (rejectAmbiguousHoist)",
    build: () => ({
      base: BASE,
      view: viewPlus(file("judge/a/report.yaml"), file("judge/b/report.yaml")),
      options: { rejectAmbiguousHoist: true },
    }),
  },
  // --- strict-superset over the immutable base ---
  {
    id: "missing-base-path",
    kind: "missing_base_path",
    scenario: "a base tuple absent from the view",
    build: () => {
      const view = cleanView();
      return {
        base: BASE,
        view: { ...view, entries: view.entries.filter((e) => e.path !== "retained/trace.jsonl") },
      };
    },
  },
  {
    id: "replaced-base-changed-kind",
    kind: "replaced_base_path",
    replaced: "changed_kind",
    scenario: "a base file flipped to a symlink (or vice versa) in the view",
    build: () => ({
      base: BASE,
      view: viewReplacing("retained/trace.jsonl", link("retained/trace.jsonl", "current")),
    }),
  },
  {
    id: "replaced-base-changed-bytes",
    kind: "replaced_base_path",
    replaced: "changed_bytes",
    scenario: "a base path whose byte length changed in the view",
    build: () => ({
      base: BASE,
      view: viewReplacing("retained/trace.jsonl", file("retained/trace.jsonl", { bytes: 4 })),
    }),
  },
  {
    id: "replaced-base-changed-sha256",
    kind: "replaced_base_path",
    replaced: "changed_sha256",
    scenario: "a base path whose content hash changed in the view",
    build: () => ({
      base: BASE,
      view: viewReplacing(
        "retained/trace.jsonl",
        file("retained/trace.jsonl", { sha256: "ef".repeat(32) }),
      ),
    }),
  },
  {
    id: "replaced-base-changed-symlink-target",
    kind: "replaced_base_path",
    replaced: "changed_symlink_target",
    scenario: "a base symlink whose target changed in the view",
    build: () => ({
      base: BASE,
      view: viewReplacing("retained/current", link("retained/current", "other.jsonl")),
    }),
  },
] satisfies RejectionCase[];

describe("strict-superset rejection matrix — frozen checklist", () => {
  it("the matrix never falls below the locked case count (cannot be quietly dropped)", () => {
    expect(REJECTION_CASES.length).toBeGreaterThanOrEqual(EXPECTED_REJECTION_CASE_COUNT);
    const ids = REJECTION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the clean view every row mutates is itself accepted (rows reject the mutation, not the fixture)", () => {
    // Without this, a defect in BASE or cleanView() would make all 23 rows pass
    // for the wrong reason and the matrix would prove nothing.
    expect(validateStrictSuperset(BASE, cleanView(), { rejectAmbiguousHoist: true })).toEqual({
      verdict: "superset",
      rejections: [],
    });
  });

  it("every case the design doc lists is present by id", () => {
    const ids = new Set(REJECTION_CASES.map((c) => c.id));
    for (const required of [
      "duplicate-path",
      "colliding-path",
      "absolute-path",
      "dot-segment",
      "dotdot-segment",
      "ambiguous-hoist-basename",
      "unsupported-link-hardlink",
      "unsupported-absolute-symlink-target",
      "missing-base-path",
      "replaced-base-changed-kind",
      "replaced-base-changed-symlink-target",
      "replaced-base-changed-bytes",
      "replaced-base-changed-sha256",
    ]) {
      expect(ids.has(required), `missing required rejection case: ${required}`).toBe(true);
    }
  });

  for (const c of REJECTION_CASES) {
    it(`rejects ${c.id} (${c.kind}${c.replaced ? `/${c.replaced}` : ""}) — ${c.scenario}`, () => {
      const { base, view, options } = c.build();
      const result = validateStrictSuperset(base, view, options);

      expect(result.verdict).toBe("rejected");

      // Assert on the row's OWN rejection, not merely that something rejected.
      // A row that only checked `verdict === "rejected"` would pass against a
      // validator that rejects everything, and against a fixture broken in some
      // unrelated way.
      const matching = result.rejections.filter(
        (r) => r.kind === c.kind && (c.replaced === undefined || r.replaced === c.replaced),
      );
      expect(
        matching.length,
        `expected a ${c.kind}${c.replaced ? `/${c.replaced}` : ""} rejection, got: ${JSON.stringify(result.rejections)}`,
      ).toBeGreaterThan(0);

      if (c.detailMatch !== undefined) {
        expect(matching.some((r) => c.detailMatch!.test(r.detail ?? ""))).toBe(true);
      }
    });
  }
});

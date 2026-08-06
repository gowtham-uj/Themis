/**
 * Artifact retention — reclaiming run-output disk after judgement.
 *
 * The interesting constraint is not "delete files", it is "delete the right
 * files": a finding with a `kind:"artifact"` ref points at a specific output,
 * and purging that file turns located evidence into a broken link. So the
 * default policy keeps exactly what the verdict cites and drops the rest.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactsDir, listArtifacts } from "../src/runner/artifacts.ts";
import {
  collectReferencedArtifacts,
  purgeRunArtifacts,
  resolveRetentionPolicy,
  selectForPurge,
} from "../src/runner/artifact-retention.ts";
import { openDb } from "../src/db/index.ts";

/** Run dir seeded with outputs. */
function makeRunDir(files: Record<string, string>): string {
  const runDir = mkdtempSync(join(tmpdir(), "agenteval-retain-"));
  const root = artifactsDir(runDir);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return runDir;
}

describe("resolveRetentionPolicy", () => {
  it("passes through the three policies, case/space tolerant", () => {
    expect(resolveRetentionPolicy("keep")).toBe("keep");
    expect(resolveRetentionPolicy("referenced")).toBe("referenced");
    expect(resolveRetentionPolicy("all")).toBe("all");
    expect(resolveRetentionPolicy("  ALL ")).toBe("all");
  });

  it("falls back to keep — never to a deleting policy — for junk input", () => {
    // A missing column on an upgraded DB or a typo'd API value must not
    // silently opt a project into destroying its own evidence.
    expect(resolveRetentionPolicy(null)).toBe("keep");
    expect(resolveRetentionPolicy(undefined)).toBe("keep");
    expect(resolveRetentionPolicy("bogus")).toBe("keep");
    expect(resolveRetentionPolicy("")).toBe("keep");
  });
});

describe("collectReferencedArtifacts", () => {
  it("finds artifact refs anywhere in the verdict, both lenses included", () => {
    const verdict = {
      findings: [{ refs: [{ kind: "artifact", path: "shot.png" }] }],
      positiveFindings: [{ refs: [{ kind: "artifact", path: "good.png" }] }],
      metaFindings: [{ refs: [{ kind: "artifact", path: "meta.png" }] }],
      diagnostics: {
        looping: { value: false, refs: [{ kind: "artifact", path: "diag.png" }] },
      },
      improvements: {
        withoutSource: [{ refs: [{ kind: "artifact", path: "./nested/imp.png" }] }],
        withSource: [{ refs: [{ kind: "artifact", path: "src.png" }] }],
      },
    };
    expect(collectReferencedArtifacts(verdict)).toEqual(
      new Set([
        "shot.png",
        "good.png",
        "meta.png",
        "diag.png",
        "nested/imp.png",
        "src.png",
      ]),
    );
  });

  it("ignores non-artifact refs and tolerates junk", () => {
    expect(
      collectReferencedArtifacts({
        findings: [
          { refs: [{ kind: "diff", file: "a.ts", hunk: 1 }] },
          { refs: [{ kind: "artifact", path: "" }] },
          { refs: [{ kind: "artifact" }] },
        ],
      }),
    ).toEqual(new Set());
    expect(collectReferencedArtifacts(null)).toEqual(new Set());
    expect(collectReferencedArtifacts("nope")).toEqual(new Set());
  });

  it("does not hang on a self-referential object", () => {
    const v: Record<string, unknown> = {
      findings: [{ refs: [{ kind: "artifact", path: "shot.png" }] }],
    };
    v.self = v;
    expect(collectReferencedArtifacts(v)).toEqual(new Set(["shot.png"]));
  });
});

describe("selectForPurge", () => {
  const artifacts = [
    { path: "shot.png" },
    { path: "scratch.bin" },
  ] as Parameters<typeof selectForPurge>[0];

  it("keeps everything under policy keep", () => {
    const { deleted, kept } = selectForPurge(artifacts, "keep", new Set());
    expect(deleted).toEqual([]);
    expect(kept).toHaveLength(2);
  });

  it("deletes everything under policy all, cited or not", () => {
    const { deleted, kept } = selectForPurge(
      artifacts,
      "all",
      new Set(["shot.png"]),
    );
    expect(deleted).toHaveLength(2);
    expect(kept).toEqual([]);
  });

  it("keeps only cited artifacts under policy referenced", () => {
    const { deleted, kept } = selectForPurge(
      artifacts,
      "referenced",
      new Set(["shot.png"]),
    );
    expect(kept.map((a) => a.path)).toEqual(["shot.png"]);
    expect(deleted.map((a) => a.path)).toEqual(["scratch.bin"]);
  });
});

describe("purgeRunArtifacts", () => {
  it("keeps cited evidence and reclaims the rest", async () => {
    const runDir = makeRunDir({
      "shot.png": "cited-bytes",
      "scratch/trace.bin": "uncited-bytes-longer",
      "dump.json": "{}",
    });
    try {
      const result = await purgeRunArtifacts(runDir, {
        policy: "referenced",
        verdict: {
          findings: [{ refs: [{ kind: "artifact", path: "shot.png" }] }],
        },
      });
      expect(result.kept).toEqual(["shot.png"]);
      expect(result.deleted.sort()).toEqual(["dump.json", "scratch/trace.bin"]);
      expect(result.bytesReclaimed).toBe(
        "uncited-bytes-longer".length + "{}".length,
      );

      // The cited screenshot is still servable; the rest is gone.
      const remaining = await listArtifacts(runDir);
      expect(remaining.map((a) => a.path)).toEqual(["shot.png"]);
      // Emptied subdirectory is pruned too.
      expect(existsSync(join(artifactsDir(runDir), "scratch"))).toBe(false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("policy all removes cited evidence too", async () => {
    const runDir = makeRunDir({ "shot.png": "cited" });
    try {
      const result = await purgeRunArtifacts(runDir, {
        policy: "all",
        verdict: {
          findings: [{ refs: [{ kind: "artifact", path: "shot.png" }] }],
        },
      });
      expect(result.deleted).toEqual(["shot.png"]);
      expect(await listArtifacts(runDir)).toEqual([]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("policy keep touches nothing", async () => {
    const runDir = makeRunDir({ "shot.png": "x", "other.bin": "y" });
    try {
      const result = await purgeRunArtifacts(runDir, { policy: "keep" });
      expect(result.deleted).toEqual([]);
      expect(result.bytesReclaimed).toBe(0);
      expect(await listArtifacts(runDir)).toHaveLength(2);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("honors explicit keepPaths beyond what the verdict cites", async () => {
    const runDir = makeRunDir({ "shot.png": "x", "manual.png": "y" });
    try {
      const result = await purgeRunArtifacts(runDir, {
        policy: "referenced",
        verdict: {},
        keepPaths: ["manual.png"],
      });
      expect(result.kept).toEqual(["manual.png"]);
      expect(result.deleted).toEqual(["shot.png"]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("is safe on a run with no outputs and safe to run twice", async () => {
    const empty = mkdtempSync(join(tmpdir(), "agenteval-retain-empty-"));
    const runDir = makeRunDir({ "a.bin": "x" });
    try {
      expect(
        (await purgeRunArtifacts(empty, { policy: "all" })).deleted,
      ).toEqual([]);
      const first = await purgeRunArtifacts(runDir, { policy: "all" });
      expect(first.deleted).toEqual(["a.bin"]);
      const second = await purgeRunArtifacts(runDir, { policy: "all" });
      expect(second.deleted).toEqual([]);
      expect(second.bytesReclaimed).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("artifactRetention project setting", () => {
  it("defaults to keep and round-trips through create/update", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agenteval-retain-db-"));
    try {
      const { queries } = openDb(dataDir);
      const p = queries.createProject({
        name: "r",
        slug: "r",
        taskSource: { kind: "ui-builder" },
      });
      // New projects are space-efficient by default: keep cited evidence only.
      expect(p.artifactRetention).toBe("referenced");

      const updated = queries.updateProject(p.id, {
        artifactRetention: "keep",
      });
      expect(updated.artifactRetention).toBe("keep");
      expect(queries.getProject(p.id)!.artifactRetention).toBe("keep");

      // A bogus value normalizes to the non-deleting policy, not stored raw.
      expect(
        queries.updateProject(p.id, { artifactRetention: "nonsense" })
          .artifactRetention,
      ).toBe("keep");

      const explicit = queries.createProject({
        name: "r2",
        slug: "r2",
        taskSource: { kind: "ui-builder" },
        artifactRetention: "all",
      });
      expect(explicit.artifactRetention).toBe("all");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

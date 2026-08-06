/**
 * Run artifacts: the evidence a no-diff run leaves behind (screenshots,
 * exported outputs) and the `kind:"artifact"` refs that point at them.
 *
 * Three concerns:
 *  1. listing + path safety — artifact paths come from judge output, so
 *     traversal is a live input, not a hypothetical,
 *  2. the artifact Ref kind — schema validation, lens rules, fingerprinting,
 *  3. the HTTP surface — list, fetch, 404s, and the no-inline-HTML rule.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactContentType,
  artifactsDir,
  isImageArtifact,
  listArtifacts,
  resolveArtifactPath,
} from "../src/runner/artifacts.ts";
import { canonicalLocationOf } from "../src/db/findings.ts";
import {
  VERDICT_SCHEMA_VERSION,
  validateVerdict,
  type Diagnostic,
  type Ref,
  type Verdict,
} from "../src/judge/verdict.ts";
import { refHref, refLabel } from "../src/judge/report/render-helpers.ts";

// ---------------------------------------------------------------------------
// 1. listing + path safety
// ---------------------------------------------------------------------------

/** Make a run dir with the given files under workspace/outputs. */
function makeRunDir(files: Record<string, string>): string {
  const runDir = mkdtempSync(join(tmpdir(), "agenteval-artifacts-"));
  const root = artifactsDir(runDir);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return runDir;
}

describe("listArtifacts", () => {
  it("lists files recursively with size, hash and type, sorted by path", async () => {
    const runDir = makeRunDir({
      "shot.png": "fake-png-bytes",
      "nested/report.json": '{"ok":true}',
      "a-first.txt": "hello",
    });
    try {
      const list = await listArtifacts(runDir);
      expect(list.map((a) => a.path)).toEqual([
        "a-first.txt",
        "nested/report.json",
        "shot.png",
      ]);
      const png = list.find((a) => a.path === "shot.png")!;
      expect(png.isImage).toBe(true);
      expect(png.contentType).toBe("image/png");
      expect(png.sizeBytes).toBe("fake-png-bytes".length);
      expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(list.find((a) => a.path === "a-first.txt")!.isImage).toBe(false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the run wrote no outputs dir", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "agenteval-noart-"));
    try {
      expect(await listArtifacts(runDir)).toEqual([]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe("artifactContentType / isImageArtifact", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(artifactContentType("a/b/shot.PNG")).toBe("image/png");
    expect(artifactContentType("out.json")).toBe("application/json; charset=utf-8");
    expect(artifactContentType("trace.bin")).toBe("application/octet-stream");
    expect(artifactContentType("noext")).toBe("application/octet-stream");
    expect(isImageArtifact("x.webp")).toBe(true);
    expect(isImageArtifact("x.json")).toBe(false);
  });
});

describe("resolveArtifactPath", () => {
  it("resolves a normal relative path inside the outputs dir", () => {
    const runDir = "/data/runs/r1";
    expect(resolveArtifactPath(runDir, "nested/shot.png")).toBe(
      join(artifactsDir(runDir), "nested/shot.png"),
    );
  });

  it("refuses traversal, absolute paths, and empty input", () => {
    const runDir = "/data/runs/r1";
    // Judge output is model-authored text; these are real inputs.
    expect(resolveArtifactPath(runDir, "../../../etc/passwd")).toBeUndefined();
    expect(resolveArtifactPath(runDir, "nested/../../escape.png")).toBeUndefined();
    expect(resolveArtifactPath(runDir, "/etc/passwd")).toBeUndefined();
    expect(resolveArtifactPath(runDir, "")).toBeUndefined();
    expect(resolveArtifactPath(runDir, "   ")).toBeUndefined();
    expect(resolveArtifactPath(runDir, ".")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. the artifact Ref kind
// ---------------------------------------------------------------------------

/**
 * Minimal valid no-source verdict whose single finding is located on an
 * artifact — the shape a browser/data run produces (no diff to point at).
 */
function verdictWithArtifactRef(refPatch: Record<string, unknown> = {}): Verdict {
  const ref = { kind: "artifact", path: "shot.png", ...refPatch } as unknown as Ref;
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: { score: 0.5, verdict: "partial", summary: "partial" },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "reason",
        score: 0.5,
        evidence: ["e"],
        findingIds: ["f1"],
      },
    ],
    findings: [
      {
        id: "f1",
        category: "verification_skipped",
        severity: "major",
        confidence: 0.8,
        claim: "the captured page rendered unstyled",
        refs: [ref],
      },
    ],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: {
      looping: { value: false, refs: [], note: "none" } as Diagnostic,
    },
    attribution: { agent_vs_environment: "agent" },
    observations: ["note"],
    improvements: {
      summary: "ok",
      withoutSource: [
        {
          area: "verification",
          priority: "high",
          change: "capture the screenshot after styles load",
          why: "the current shot is taken pre-hydration",
          refs: [ref],
          linkedFindings: ["f1"],
        },
      ],
    },
  };
}

describe("artifact refs in the verdict schema", () => {
  it("accepts an artifact ref with just a path", () => {
    expect(() =>
      validateVerdict(verdictWithArtifactRef(), { hasSourceArtifacts: false }),
    ).not.toThrow();
  });

  it("accepts optional sha256 and note", () => {
    expect(() =>
      validateVerdict(
        verdictWithArtifactRef({ sha256: "a".repeat(64), note: "hero image" }),
        { hasSourceArtifacts: false },
      ),
    ).not.toThrow();
  });

  it("rejects an artifact ref with no path — an unlocatable finding", () => {
    const v = verdictWithArtifactRef();
    v.findings[0]!.refs = [{ kind: "artifact" } as unknown as Ref];
    expect(() =>
      validateVerdict(v, { hasSourceArtifacts: false }),
    ).toThrow(/artifact ref missing path/);
  });

  it("allows artifact refs in the withoutSource lens (they are not source)", () => {
    // The lens rule is "no diff refs", not "trace/tool only" — a screenshot is
    // execution evidence, so it is exactly what that lens is allowed to cite.
    const v = verdictWithArtifactRef();
    expect(v.improvements.withoutSource[0]!.refs[0]).toMatchObject({
      kind: "artifact",
    });
    expect(() =>
      validateVerdict(v, { hasSourceArtifacts: false }),
    ).not.toThrow();
  });
});

describe("canonicalLocationOf with artifact refs", () => {
  const claim = "the captured page rendered unstyled";

  it("fingerprints on the artifact path so recurrence works without a diff", () => {
    const loc = canonicalLocationOf({
      claim,
      refs: [{ kind: "artifact", path: "./shot.png" }],
    });
    expect(loc).toBe("artifact:shot.png");
  });

  it("ignores sha256 — a re-captured screenshot is the same defect", () => {
    const a = canonicalLocationOf({
      claim,
      refs: [{ kind: "artifact", path: "shot.png", sha256: "a".repeat(64) }],
    });
    const b = canonicalLocationOf({
      claim,
      refs: [{ kind: "artifact", path: "shot.png", sha256: "b".repeat(64) }],
    });
    expect(a).toBe(b);
  });

  it("still prefers a diff ref when both are present", () => {
    const loc = canonicalLocationOf({
      claim,
      refs: [
        { kind: "artifact", path: "shot.png" },
        { kind: "diff", file: "src/app.ts", hunk: 2 },
      ],
    });
    expect(loc).toBe("src/app.ts@2");
  });

  it("prefers an artifact ref over a tool ref", () => {
    const loc = canonicalLocationOf({
      claim,
      refs: [
        { kind: "tool", toolCallId: "tc-9" },
        { kind: "artifact", path: "shot.png" },
      ],
    });
    expect(loc).toBe("artifact:shot.png");
  });
});

describe("artifact ref rendering", () => {
  it("deep-links and labels artifact refs in the report renderer", () => {
    const ref = { kind: "artifact", path: "nested/shot.png" } as const;
    expect(refHref(ref)).toBe("#artifact:nested/shot.png");
    expect(refLabel(ref)).toBe("artifact nested/shot.png");
  });
});

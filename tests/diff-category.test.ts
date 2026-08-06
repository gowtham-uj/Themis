import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  captureDiffByCategory,
  categoryToDiffKind,
  redactManifestPath,
  type OutputManifestEntry,
} from "../src/runner/diff-category.ts";
import type { HunkIndexEntry } from "../src/runner/diff.ts";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@local"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "test"]);
}

describe("categoryToDiffKind", () => {
  it("maps the six pre-defined categories", () => {
    expect(categoryToDiffKind("coding")).toBe("git");
    expect(categoryToDiffKind("data")).toBe("outputs");
    expect(categoryToDiffKind("research")).toBe("none");
    expect(categoryToDiffKind("conversational")).toBe("none");
    expect(categoryToDiffKind("browser")).toBe("none");
  });

  it("maps general → git when workspace has changes, else none", () => {
    expect(
      categoryToDiffKind("general", { hasGitChanges: true, isGitRepo: true }),
    ).toBe("git");
    expect(
      categoryToDiffKind("general", { hasGitChanges: false, isGitRepo: true }),
    ).toBe("none");
    expect(categoryToDiffKind("general", { isGitRepo: false })).toBe("none");
    expect(categoryToDiffKind("general")).toBe("none");
  });

  it("defaults unknown categories to none", () => {
    expect(categoryToDiffKind("custom-agent")).toBe("none");
    expect(categoryToDiffKind("")).toBe("none");
  });
});

describe("captureDiffByCategory", () => {
  it("coding → git diff result with patchPath + hunk index", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-diffcat-coding-"));
    const ws = join(root, "ws");
    const out = join(root, "out");
    await mkdir(ws, { recursive: true });
    await mkdir(out, { recursive: true });
    await initRepo(ws);

    await writeFile(join(ws, "readme.txt"), "v1\n", "utf8");
    await execFileAsync("git", ["-C", ws, "add", "-A"]);
    await execFileAsync("git", ["-C", ws, "commit", "-m", "init"]);

    await writeFile(join(ws, "readme.txt"), "v1\nv2\n", "utf8");
    await writeFile(join(ws, "new.ts"), "export const x = 1;\n", "utf8");

    const result = await captureDiffByCategory("coding", ws, {
      outPath: join(out, "diff.patch"),
    });

    expect(result.kind).toBe("git");
    if (result.kind !== "git") return;

    expect(result.empty).toBe(false);
    expect(result.patchPath).toBe(join(out, "diff.patch"));
    expect(result.hunks.length).toBeGreaterThanOrEqual(1);

    const patchText = await readFile(result.patchPath, "utf8");
    expect(patchText).toContain("# agenteval-hunk: 1");
    expect(patchText).toContain("readme.txt");

    const index = JSON.parse(
      await readFile(result.indexPath, "utf8"),
    ) as HunkIndexEntry[];
    expect(index).toEqual(result.hunks);
    expect(index[0]?.hunk).toBe(1);
    expect(index[0]?.file.length).toBeGreaterThan(0);
  });

  it("none categories → {kind:'none'} and no files written", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-diffcat-none-"));
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "note.txt"), "hello\n", "utf8");

    for (const cat of ["research", "browser", "conversational"] as const) {
      const result = await captureDiffByCategory(cat, ws, {
        outPath: join(root, cat),
      });
      expect(result).toEqual({ kind: "none" });
    }

    // No diff.patch / outputs-manifest created under ws.
    await expect(readFile(join(ws, "diff.patch"), "utf8")).rejects.toThrow();
    await expect(
      readFile(join(ws, "outputs-manifest.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("data / outputs → manifest with sha256 entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-diffcat-out-"));
    const ws = join(root, "ws");
    const outputs = join(ws, "outputs");
    await mkdir(outputs, { recursive: true });
    await mkdir(join(outputs, "nested"), { recursive: true });

    const bodyA = "alpha-output-data\n";
    const bodyB = "beta-output-data\n";
    await writeFile(join(outputs, "result.csv"), bodyA, "utf8");
    await writeFile(join(outputs, "nested", "summary.json"), bodyB, "utf8");

    const result = await captureDiffByCategory("data", ws, {
      outPath: join(root, "run"),
    });

    expect(result.kind).toBe("outputs");
    if (result.kind !== "outputs") return;

    expect(result.entries).toHaveLength(2);
    expect(result.manifestPath).toMatch(/outputs-manifest\.json$/);

    const byPath = new Map(result.entries.map((e) => [e.path, e]));
    const a = byPath.get("result.csv");
    const b = byPath.get("nested/summary.json");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    expect(a!.sha256).toBe(
      createHash("sha256").update(bodyA).digest("hex"),
    );
    expect(b!.sha256).toBe(
      createHash("sha256").update(bodyB).digest("hex"),
    );
    expect(a!.sizeBytes).toBe(Buffer.byteLength(bodyA));
    expect(b!.sizeBytes).toBe(Buffer.byteLength(bodyB));

    // Manifest file on disk matches.
    const onDisk = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as { entries: OutputManifestEntry[] };
    expect(onDisk.entries).toEqual(result.entries);
  });

  it("general with dirty git workspace → git; clean → none", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-diffcat-gen-"));
    const ws = join(root, "ws");
    await mkdir(ws, { recursive: true });
    await initRepo(ws);
    await writeFile(join(ws, "a.txt"), "one\n", "utf8");
    await execFileAsync("git", ["-C", ws, "add", "-A"]);
    await execFileAsync("git", ["-C", ws, "commit", "-m", "init"]);

    // Clean → none
    const clean = await captureDiffByCategory("general", ws);
    expect(clean.kind).toBe("none");

    // Dirty → git
    await writeFile(join(ws, "a.txt"), "two\n", "utf8");
    const dirty = await captureDiffByCategory("general", ws, {
      outPath: join(root, "diff.patch"),
    });
    expect(dirty.kind).toBe("git");
    if (dirty.kind === "git") {
      expect(dirty.empty).toBe(false);
      expect(dirty.hunks.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("redactManifestPath", () => {
  it("redacts path segments that look like secrets", () => {
    expect(redactManifestPath("ok/file.csv")).toBe("ok/file.csv");
    expect(redactManifestPath("secrets/out.bin")).toContain("REDACTED");
    expect(redactManifestPath("dir/api_key.txt")).toContain("REDACTED");
    expect(redactManifestPath("dir/my_token.pem")).toContain("REDACTED");
    expect(redactManifestPath("dir/cred-store.json")).toContain("REDACTED");
  });
});

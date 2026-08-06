import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  captureDiff,
  injectHunkMarkers,
  numberHunks,
  type HunkIndexEntry,
} from "../src/runner/diff.ts";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@local"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "test"]);
}

describe("numberHunks", () => {
  it("assigns stable 1-based hunk numbers with file + line ranges", () => {
    const patch = `diff --git a/alpha.ts b/alpha.ts
index 1111111..2222222 100644
--- a/alpha.ts
+++ b/alpha.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3
@@ -10,2 +11,3 @@
 ten
+eleven
 twelve
diff --git a/beta.ts b/beta.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/beta.ts
@@ -0,0 +1,2 @@
+hello
+world
`;
    const hunks = numberHunks(patch);
    expect(hunks).toHaveLength(3);

    expect(hunks[0]).toMatchObject({
      hunk: 1,
      file: "alpha.ts",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
    } satisfies Partial<HunkIndexEntry>);

    expect(hunks[1]).toMatchObject({
      hunk: 2,
      file: "alpha.ts",
      oldStart: 10,
      oldLines: 2,
      newStart: 11,
      newLines: 3,
    });

    expect(hunks[2]).toMatchObject({
      hunk: 3,
      file: "beta.ts",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
    });
  });

  it("injects addressable markers before each @@ header", () => {
    const patch = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1 +1,2 @@
 hello
+world
`;
    const hunks = numberHunks(patch);
    const numbered = injectHunkMarkers(patch, hunks);
    expect(numbered).toContain("# agenteval-hunk: 1 file=f.txt");
    expect(numbered).toMatch(/# agenteval-hunk: 1[^\n]*\n@@ -1 \+1,2 @@/);
    // Original @@ still present once.
    expect(numbered.match(/^@@/gm)?.length ?? 0).toBe(1);
  });

  it("returns empty for empty/whitespace diffs", () => {
    expect(numberHunks("")).toEqual([]);
    expect(numberHunks("\n\n")).toEqual([]);
  });
});

describe("captureDiff", () => {
  it("stages changes, writes patch + hunk index for a fixture repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-diff-"));
    const ws = join(root, "ws");
    const out = join(root, "out");
    await mkdir(ws, { recursive: true });
    await mkdir(out, { recursive: true });
    await initRepo(ws);

    // Initial commit so subsequent edits produce a non-trivial diff.
    await writeFile(join(ws, "readme.txt"), "v1\n", "utf8");
    await execFileAsync("git", ["-C", ws, "add", "-A"]);
    await execFileAsync("git", ["-C", ws, "commit", "-m", "init"]);

    // Agent-like edits: modify + add.
    await writeFile(join(ws, "readme.txt"), "v1\nv2\n", "utf8");
    await writeFile(join(ws, "new.ts"), "export const x = 1;\n", "utf8");

    const result = await captureDiff(ws, { outPath: join(out, "diff.patch") });

    expect(result.empty).toBe(false);
    expect(result.hunks.length).toBeGreaterThanOrEqual(2);

    const patchText = await readFile(result.patchPath, "utf8");
    expect(patchText).toContain("# agenteval-hunk: 1");
    expect(patchText).toContain("readme.txt");
    expect(patchText).toContain("new.ts");

    const index = JSON.parse(await readFile(result.indexPath, "utf8")) as HunkIndexEntry[];
    expect(index).toEqual(result.hunks);

    // Every hunk is addressable: unique increasing numbers, file set, ranges present.
    const seen = new Set<number>();
    for (const h of index) {
      expect(h.hunk).toBeGreaterThan(0);
      expect(seen.has(h.hunk)).toBe(false);
      seen.add(h.hunk);
      expect(h.file.length).toBeGreaterThan(0);
      expect(typeof h.oldStart).toBe("number");
      expect(typeof h.newStart).toBe("number");
      expect(h.header.startsWith("@@")).toBe(true);
    }

    // Hunk numbers are dense 1..N
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: index.length }, (_, i) => i + 1),
    );
  });

  it("produces an empty patch when the workspace is clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-diff-empty-"));
    await initRepo(root);
    await writeFile(join(root, "a.txt"), "ok\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "-A"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "init"]);

    const result = await captureDiff(root);
    expect(result.empty).toBe(true);
    expect(result.hunks).toEqual([]);
    const patchText = await readFile(result.patchPath, "utf8");
    expect(patchText.trim()).toBe("");
  });
});

describe("agent-internal state exclusion", () => {
  // Regression: agents write their own bookkeeping into the workspace —
  // ReaperCode keeps .reaper/ (trajectory, model-call transcripts, run
  // manifests) beside the code. Those landed in the captured diff, so the judge
  // would have scored an agent on its own log files. Found by running the real
  // agent: 13 of the 14 "changed files" were its own logs.
  it("excludes .reaper/ and friends by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenteval-diffx-"));
    try {
      execFileSync("git", ["-C", dir, "init", "-q"]);
      execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
      execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/app.js"), "const a = 1;\n");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-qm", "seed"]);

      // The agent edits real code AND writes its own state.
      writeFileSync(join(dir, "src/app.js"), "const a = 2;\n");
      mkdirSync(join(dir, ".reaper/runs/x/logs"), { recursive: true });
      writeFileSync(join(dir, ".reaper/runs/x/logs/trajectory.jsonl"), "{}\n");
      writeFileSync(join(dir, ".reaper/latest-run.json"), "{}\n");

      const res = await captureDiff(dir, { outPath: join(dir, "out.patch") });
      expect(res.rawDiff).toContain("src/app.js");
      expect(res.rawDiff).not.toContain(".reaper");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps everything when exclusions are explicitly cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenteval-diffx2-"));
    try {
      execFileSync("git", ["-C", dir, "init", "-q"]);
      execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
      execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
      writeFileSync(join(dir, "seed.txt"), "x\n");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-qm", "seed"]);
      mkdirSync(join(dir, ".reaper"), { recursive: true });
      writeFileSync(join(dir, ".reaper/state.json"), "{}\n");

      const res = await captureDiff(dir, {
        outPath: join(dir, "out.patch"),
        excludePaths: [],
      });
      expect(res.rawDiff).toContain(".reaper");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

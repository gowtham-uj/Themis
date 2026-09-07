/**
 * The archive navigator must describe the archive it is in.
 *
 * It used to be a fixed list naming `model-calls/`, `tool-logs/`, and
 * `further-evidence/` for every run. ReaperCode declares none of those, so the
 * README of a real sealed archive sent a reader hunting for three folders that
 * were never captured, which reads as lost evidence rather than as evidence the
 * adapter does not produce.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { organizeArchiveLayout } from "../src/runner/eval-archive.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A run directory holding the files an adapter left at its root. */
async function runDir(files: readonly string[]): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "agenteval-readme-"));
  dirs.push(d);
  for (const name of files) await writeFile(join(d, name), "x", "utf8");
  return d;
}

async function readme(dir: string): Promise<string> {
  return readFile(join(dir, "eval_lifecycle_logs", "README.md"), "utf8");
}

describe("archive README navigator", () => {
  it("describes only the folders the run produced", async () => {
    const dir = await runDir([
      "verifier-result.json", "session.jsonl", "conversation.md",
      "diff.patch", "raw-stdout.log", "run.json", "events.jsonl",
    ]);
    await organizeArchiveLayout(dir);
    const text = await readme(dir);

    for (const present of ["verifier_res/", "session/", "diffs/", "raw_std/", "eval_lifecycle_logs/"]) {
      expect(text).toContain(`## ${present}`);
    }
    // Nothing captured these, so they must not be advertised as sections.
    for (const absent of ["model-calls", "tool-logs", "further-evidence"]) {
      expect(text).not.toContain(`## ${absent}/`);
    }
    // They are named once, under the section that explains the absence.
    expect(text).toContain("## Not captured for this run");
    expect(text).toContain("`model-calls/`");
  });

  it("describes suite folders when the adapter did capture them", async () => {
    const dir = await runDir([
      "verifier-result.json", "session.jsonl", "diff.patch", "raw-stdout.log", "run.json",
    ]);
    for (const folder of ["model-calls", "tool-logs", "further-evidence", "retained", "tmp"]) {
      await mkdir(join(dir, folder), { recursive: true });
      await writeFile(join(dir, folder, "a.json"), "{}", "utf8");
    }
    await organizeArchiveLayout(dir);
    const text = await readme(dir);

    for (const folder of ["model-calls", "tool-logs", "further-evidence"]) {
      expect(text).toContain(`## ${folder}/`);
    }
    expect(text).not.toContain("## Not captured for this run");
  });

  it("always documents eval_lifecycle_logs, which is written after the layout", async () => {
    const dir = await runDir(["diff.patch"]);
    await organizeArchiveLayout(dir);
    expect(await readme(dir)).toContain("## eval_lifecycle_logs/");
  });
});

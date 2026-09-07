/**
 * A partially sealed layer must be completable, not a dead end.
 *
 * Live case 8cc17b8a sealed a judge/ holding only quality-report.json while the
 * courtroom was still running. The quality gate writes that file into the same
 * directory that becomes the sealed layer, so an empty court still leaves a
 * non-empty judge/. Reseal then refused every retry with "already carries layer
 * judge", and the complete ruling produced 18 minutes later was lost with no
 * way back. Completing a layer now adds only the files the archive lacks, and
 * every already-sealed byte stays exactly as it was.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resealEvalArchive } from "../src/runner/eval-archive.ts";
import { publishJudgeArchiveView } from "../src/judge/results/publish-view.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "agenteval-reseal-"));
  dirs.push(d);
  return d;
}

/** Write a file and every directory above it. */
async function put(root: string, rel: string, body: string): Promise<void> {
  const p = join(root, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body, "utf8");
}

/** Write the manifest a sealed archive carries, over whatever is on disk. */
async function writeManifest(archiveDir: string, layers: string[]): Promise<void> {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      if ((await stat(p)).isDirectory()) {
        await walk(p);
        continue;
      }
      const body = await readFile(p);
      const rel = relative(archiveDir, p).replace(/\\/g, "/");
      if (rel === "eval_lifecycle_logs/archive.json") continue;
      files.push({
        path: rel,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      });
    }
  }
  await walk(archiveDir);
  await put(
    archiveDir,
    "eval_lifecycle_logs/archive.json",
    `${JSON.stringify({ runId: "run_partial", layers, files, totalBytes: 0 }, null, 2)}\n`,
  );
}

/** A sealed base archive with one partial layer already added. */
async function sealedWithPartialJudge(): Promise<{ archiveDir: string; root: string }> {
  const root = await tmp();
  const archiveDir = join(root, "archive");
  await put(archiveDir, "verifier_res/verifier-result.json", '{"officialReward":1}');
  await put(archiveDir, "diffs/diff.patch", "--- a\n+++ b\n");
  // The crash shape: judge/ sealed carrying only the gate's own output.
  await put(archiveDir, "judge/quality-report.json", '{"passed":false}');
  await writeManifest(archiveDir, ["judge"]);
  return { archiveDir, root };
}

describe("completing a partially sealed layer", () => {
  it("adds the missing court records to an already-sealed judge/", async () => {
    const { archiveDir, root } = await sealedWithPartialJudge();

    // The retry that actually produced a ruling.
    const full = join(root, "full-judge");
    await put(full, "quality-report.json", '{"passed":true}');
    await put(full, "evalJudge.yaml", "verdict: covered\n");
    await put(full, "minos-report.yaml", "ruling: ok\n");

    const { manifest } = await resealEvalArchive({
      runId: "run_partial",
      archiveDir,
      layers: [{ name: "judge", sourceDir: full }],
    });

    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("judge/evalJudge.yaml");
    expect(paths).toContain("judge/minos-report.yaml");
    // The layer is named once, not twice.
    expect(manifest.layers?.filter((l) => l === "judge")).toHaveLength(1);
  });

  it("keeps the already-sealed bytes even when the retry disagrees", async () => {
    const { archiveDir, root } = await sealedWithPartialJudge();

    const full = join(root, "full-judge");
    // Same path, different content. The sealed copy must win.
    await put(full, "quality-report.json", '{"passed":true}');
    await put(full, "evalJudge.yaml", "verdict: covered\n");

    await resealEvalArchive({
      runId: "run_partial",
      archiveDir,
      layers: [{ name: "judge", sourceDir: full }],
    });

    expect(await readFile(join(archiveDir, "judge", "quality-report.json"), "utf8")).toBe(
      '{"passed":false}',
    );
  });

  it("still refuses a retry that adds nothing new", async () => {
    const { archiveDir, root } = await sealedWithPartialJudge();
    const same = join(root, "same-judge");
    await put(same, "quality-report.json", '{"passed":false}');

    await expect(
      resealEvalArchive({
        runId: "run_partial",
        archiveDir,
        layers: [{ name: "judge", sourceDir: same }],
      }),
    ).rejects.toThrow(/adds nothing new/);
  });
});

describe("Phase 1 publication guard", () => {
  it("refuses to spend the seal on a judge/ with no court record", async () => {
    const root = await tmp();
    const judgeDir = join(root, "node4", "judge");
    await mkdir(judgeDir, { recursive: true });
    await writeFile(join(judgeDir, "quality-report.json"), '{"passed":false}', "utf8");

    await expect(
      publishJudgeArchiveView({
        runId: "run_none",
        trackId: "default",
        baseArchiveDir: join(root, "archive"),
        judgeDir,
      }),
    ).rejects.toThrow(/no court record/);
  });

  it("proceeds once any court record exists", async () => {
    const root = await tmp();
    const judgeDir = join(root, "node4", "judge");
    await mkdir(judgeDir, { recursive: true });
    await writeFile(join(judgeDir, "kratos-report.yaml"), "findings: []\n", "utf8");

    // No sealed base archive here, so it fails later, past the guard.
    await expect(
      publishJudgeArchiveView({
        runId: "run_partial3",
        trackId: "default",
        baseArchiveDir: join(root, "archive"),
        judgeDir,
      }),
    ).rejects.not.toThrow(/no court record/);
  });
});

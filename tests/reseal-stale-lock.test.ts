/**
 * A reseal lock left by a dead worker must not block the run forever.
 *
 * The lock was an empty file removed only in the writer's `finally`, so a killed
 * or restarted worker stranded it on disk. Every later reseal of that run then
 * failed with "already in progress" against a writer that no longer existed, and
 * a live case lost a complete ruling to it.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resealEvalArchive } from "../src/runner/eval-archive.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function sealedArchive(): Promise<{ archiveDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "agenteval-seal-lock-"));
  dirs.push(root);
  const archiveDir = join(root, "archive");
  await mkdir(join(archiveDir, "verifier_res"), { recursive: true });
  const body = '{"officialReward":1}';
  await writeFile(join(archiveDir, "verifier_res", "verifier-result.json"), body);
  await mkdir(join(archiveDir, "eval_lifecycle_logs"), { recursive: true });
  const files = [
    {
      path: "verifier_res/verifier-result.json",
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  ];
  await writeFile(
    join(archiveDir, "eval_lifecycle_logs", "archive.json"),
    `${JSON.stringify({ runId: "run_lock", layers: [], files, totalBytes: 0 }, null, 2)}\n`,
  );
  return { archiveDir, root };
}

async function judgeSource(root: string): Promise<string> {
  const dir = join(root, "judge-src");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "minos-report.yaml"), "ruling: ok\n");
  return dir;
}

describe("reseal seal lock", () => {
  it("reclaims a lock whose owning process is gone", async () => {
    const { archiveDir, root } = await sealedArchive();
    // pid 1 is init, never this worker; an owner recorded as a pid that is not
    // running is exactly the crashed-writer case.
    const dead = { pid: 2147483646, takenAt: new Date().toISOString() };
    await writeFile(`${archiveDir}.seal.lock`, `${JSON.stringify(dead)}\n`);

    const { manifest } = await resealEvalArchive({
      runId: "run_lock",
      archiveDir,
      layers: [{ name: "judge", sourceDir: await judgeSource(root) }],
    });

    expect(manifest.files.some((f) => f.path === "judge/minos-report.yaml")).toBe(true);
  });

  it("refuses while a live worker holds the lock", async () => {
    const { archiveDir, root } = await sealedArchive();
    // This process is alive by definition, so its lock is honored.
    await writeFile(
      `${archiveDir}.seal.lock`,
      `${JSON.stringify({ pid: process.pid, takenAt: new Date().toISOString() })}\n`,
    );

    await expect(
      resealEvalArchive({
        runId: "run_lock",
        archiveDir,
        layers: [{ name: "judge", sourceDir: await judgeSource(root) }],
      }),
    ).rejects.toThrow(/already in progress/);
  });

  it("reclaims an ownerless lock once it is older than the staleness window", async () => {
    const { archiveDir, root } = await sealedArchive();
    // Locks written before the owner record existed carry no pid, so age is the
    // only thing that can judge them.
    const lockPath = `${archiveDir}.seal.lock`;
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(lockPath, old, old);

    const { manifest } = await resealEvalArchive({
      runId: "run_lock",
      archiveDir,
      layers: [{ name: "judge", sourceDir: await judgeSource(root) }],
    });

    expect(manifest.files.some((f) => f.path === "judge/minos-report.yaml")).toBe(true);
  });
});

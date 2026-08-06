import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ensureGitRepo,
  prepareWorkspace,
} from "../src/runner/workspace.ts";

const execFileAsync = promisify(execFile);

async function makeLocalRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-src-repo-"));
  await execFileAsync("git", ["-C", dir, "init"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "test@local"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "test"]);
  // Need a commit for clone + rev-parse to work reliably.
  await writeFile(join(dir, "seed.txt"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", ["-C", dir, "commit", "-m", "seed"]);
  // Create a named branch some gits default to master, some to main — capture it.
  return dir;
}

describe("prepareWorkspace", () => {
  it("source=empty creates a git-initialized directory", async () => {
    const target = await mkdtemp(join(tmpdir(), "agenteval-ws-empty-"));
    const prepared = await prepareWorkspace(
      { source: "empty" },
      { targetDir: target },
    );
    expect(prepared.source).toBe("empty");
    expect(prepared.dir).toBe(target);
    expect(prepared.commit).toBeUndefined();

    // .git exists
    await access(join(target, ".git"));
    const { stdout } = await execFileAsync("git", [
      "-C",
      target,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    expect(stdout.trim()).toBe("true");
  });

  it("source=git shallow-clones a local repo and records resolved sha (no network)", async () => {
    const src = await makeLocalRepo();
    const { stdout: headOut } = await execFileAsync("git", [
      "-C",
      src,
      "rev-parse",
      "HEAD",
    ]);
    const expectedSha = headOut.trim();

    const target = join(
      await mkdtemp(join(tmpdir(), "agenteval-ws-git-parent-")),
      "clone",
    );

    const prepared = await prepareWorkspace(
      { source: "git", repo: src },
      { targetDir: target },
    );

    expect(prepared.source).toBe("git");
    expect(prepared.repo).toBe(src);
    expect(prepared.commit).toBe(expectedSha);
    await access(join(target, "seed.txt"));
  });

  it("source=git respects ref when cloning a local repo", async () => {
    const src = await makeLocalRepo();
    // Create a branch + second commit.
    await execFileAsync("git", ["-C", src, "checkout", "-b", "feature"]);
    await writeFile(join(src, "feature.txt"), "feat\n", "utf8");
    await execFileAsync("git", ["-C", src, "add", "-A"]);
    await execFileAsync("git", ["-C", src, "commit", "-m", "feature"]);
    const { stdout: featureShaOut } = await execFileAsync("git", [
      "-C",
      src,
      "rev-parse",
      "HEAD",
    ]);
    const featureSha = featureShaOut.trim();

    const target = join(
      await mkdtemp(join(tmpdir(), "agenteval-ws-ref-parent-")),
      "clone",
    );

    const prepared = await prepareWorkspace(
      { source: "git", repo: src, ref: "feature" },
      { targetDir: target },
    );

    expect(prepared.commit).toBe(featureSha);
    expect(prepared.ref).toBe("feature");
    await access(join(target, "feature.txt"));
  });

  it("rejects empty repo string for git source", async () => {
    const target = await mkdtemp(join(tmpdir(), "agenteval-ws-bad-"));
    await expect(
      prepareWorkspace(
        { source: "git", repo: "" },
        { targetDir: target },
      ),
    ).rejects.toThrow(/non-empty/);
  });
});

describe("ensureGitRepo", () => {
  it("inits git only when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenteval-ensure-"));
    await ensureGitRepo(dir);
    await access(join(dir, ".git"));
    // Second call is a no-op (still a repo).
    await ensureGitRepo(dir);
    await access(join(dir, ".git"));
  });
});

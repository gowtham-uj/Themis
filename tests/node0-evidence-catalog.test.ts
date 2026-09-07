/**
 * Node 0's evidence catalog must list evidence, not machine bookkeeping.
 *
 * A retained ReaperCode workspace carries the agent's whole task tree. In the
 * first live Phase 1 case, 1626 catalog entries broke down as 811 `.git/`
 * internals, 777 harness cache files, and 2 actual source files. Investigators
 * read that catalog to decide what to open, so the two files that mattered were
 * buried under git objects and hook samples.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNode0 } from "../src/judge/graph/node0-bind-summarize.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Write a file and every directory above it. */
async function put(root: string, rel: string, body: string): Promise<void> {
  const p = join(root, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, body, "utf8");
}

/** A gateway that records what it was asked and answers with fixed prose. */
function stubGateway(): { chat: (req: unknown) => Promise<{ content: string }>; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async chat(req: unknown) {
      const messages = (req as { messages: { content: string }[] }).messages;
      seen.push(messages.map((m) => m.content).join("\n"));
      return { content: "## Official result\nstub" };
    },
  };
}

describe("Node 0 evidence catalog", () => {
  it("omits version-control and cache subtrees and says how many it dropped", async () => {
    const archive = await tmp("agenteval-node0-arch-");
    const work = await tmp("agenteval-node0-work-");

    await put(archive, "verifier_res/verifier-result.json", '{"officialReward":1}');
    await put(archive, "diffs/diff.patch", "--- a\n+++ b\n");
    await put(archive, "retained/agent/task/mvcc/store.go", "package mvcc\n");
    await put(archive, "retained/agent/task/mvcc/store_test.go", "package mvcc\n");
    for (const noise of [
      "retained/agent/task/.git/HEAD",
      "retained/agent/task/.git/hooks/pre-commit.sample",
      "retained/agent/task/.git/objects/ab/cdef",
      "retained/agent/task/.reaper/cache/a.bin",
      "retained/agent/task/.reaper/cache/deep/b.bin",
      "retained/agent/task/node_modules/left-pad/index.js",
    ]) {
      await put(archive, noise, "x");
    }

    const gateway = stubGateway();
    const state = await runNode0({
      caseId: "case_1",
      runId: "run_1",
      archiveDir: archive,
      workDir: work,
      // biome-ignore lint/suspicious/noExplicitAny: test double for the gateway contract
      gateway: gateway as any,
      attemptId: "attempt_1",
    });

    const text = await readFile(state.paths.evalContextPath, "utf8");
    expect(text).toContain("retained/agent/task/mvcc/store.go");
    expect(text).toContain("verifier_res/verifier-result.json");
    for (const gone of [".git/", ".reaper/cache/", "node_modules/"]) {
      expect(text).not.toContain(gone);
    }
    // Six pruned files, and the catalog must admit it rather than look truncated.
    expect(text).toContain("skipped_files: 6");
    expect(text).toContain("file_count: 4");

    // The model gets the same pruned list, which is the whole point.
    expect(gateway.seen.join("\n")).not.toContain(".git/HEAD");
  });

  it("reports no pruning when the archive has none", async () => {
    const archive = await tmp("agenteval-node0-arch-");
    const work = await tmp("agenteval-node0-work-");
    await put(archive, "diffs/diff.patch", "--- a\n");

    const state = await runNode0({
      caseId: "case_2",
      runId: "run_2",
      archiveDir: archive,
      workDir: work,
      // biome-ignore lint/suspicious/noExplicitAny: test double for the gateway contract
      gateway: stubGateway() as any,
      attemptId: "attempt_2",
    });

    const text = await readFile(state.paths.evalContextPath, "utf8");
    expect(text).toContain("file_count: 1");
    expect(text).not.toContain("skipped_files:");
  });
});

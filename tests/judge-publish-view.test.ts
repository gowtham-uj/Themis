import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { publishJudgeArchiveView } from "../src/judge/results/publish-view.ts";
import { sealBaseArchive } from "./helpers/seal-base-archive.ts";

describe("WP-12 publishJudgeArchiveView", () => {
  it("reseals the eval's own archive with judge/ added", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-view-"));
    const base = join(root, "base");
    const judge = join(root, "judge-src");
    const traces = join(root, "traces-src");
    await mkdir(join(base, "retained"), { recursive: true });
    await writeFile(join(base, "retained", "a.txt"), "A");
    await sealBaseArchive(base, "run_1");
    await mkdir(judge, { recursive: true });
    await writeFile(join(judge, "evalJudge.yaml"), "final_report: true\nverdict:\n  approach: principled\n");
    await mkdir(join(traces, "sessions"), { recursive: true });
    await writeFile(join(traces, "pi-stdout.jsonl"), `${JSON.stringify({type:"turn",message:{reasoning_content:"private chain",content:"public answer"}})}\n`.repeat(100));
    await writeFile(join(traces, "sessions", "case.jsonl"), `${JSON.stringify({session:true,message:{reasoning_content:"private child chain",content:"filed report"}})}\n`);
    const work = join(root, "work");
    await mkdir(join(work, "node1"), { recursive: true });
    await mkdir(join(work, "checkpoints"), { recursive: true });
    await writeFile(join(work, "node1", "evalCase.yaml"), "case: 1\n");
    await writeFile(join(work, "checkpoints", "node1.json"), "{}\n");

    const { result, manifestPath } = await publishJudgeArchiveView({
      runId: "run_1",
      trackId: "track_1",
      baseArchiveDir: base,
      judgeDir: judge,
      traceDir: traces,
      workDir: work,
    });

    expect(result.publicationState).toBe("published");
    expect(result.archiveViewPath).toBe(base);
    expect(result.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestPath).toBe(join(base, "eval_lifecycle_logs", "archive.json"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain("retained/a.txt");
    expect(paths).toContain("judge/evalJudge.yaml");
    expect(paths).toContain("phase1/judge_traces/pi-stdout.jsonl.gz");
    expect(paths).toContain("phase1/judge_traces/sessions/case.jsonl");
    expect(paths).not.toContain("phase1/judge_traces/pi-stdout.jsonl");
    const stdout = gunzipSync(await readFile(join(base, "phase1", "judge_traces", "pi-stdout.jsonl.gz"))).toString("utf8");
    const session = await readFile(join(base, "phase1", "judge_traces", "sessions", "case.jsonl"), "utf8");
    expect(stdout).toContain("public answer");
    expect(session).toContain("filed report");
    expect(stdout).not.toContain("reasoning_content");
    expect(session).not.toContain("reasoning_content");
    expect(paths).toContain("phase1/node1/evalCase.yaml");
    expect(paths).toContain("phase1/checkpoints/node1.json");
    expect(manifest.layers).toEqual(["judge", "phase1"]);
    expect(manifest.resealedAt).toMatch(/^\d{4}-/);
  });

  // Republishing an identical judge/ is the postcondition already met, so it
  // returns the standing view instead of failing. This used to throw, and a
  // live run paid for it: its judge/ was complete, the retry added nothing, and
  // the item was recorded `failed` beside a sealed ruling.
  it("republishes an identical judge layer as a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-view2-"));
    const base = join(root, "base");
    const judge = join(root, "judge-src");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "evidence.txt"), "E");
    await sealBaseArchive(base, "run_2");
    await mkdir(judge, { recursive: true });
    await writeFile(join(judge, "evalJudge.yaml"), "final_report: true\n");

    const args = { runId: "run_2", trackId: "t", baseArchiveDir: base, judgeDir: judge };
    const first = await publishJudgeArchiveView(args);
    const again = await publishJudgeArchiveView(args);

    expect(again.result.reportSha256).toBe(first.result.reportSha256);
    expect(await readFile(join(base, "judge", "evalJudge.yaml"), "utf8")).toBe(
      "final_report: true\n",
    );
    const manifest = JSON.parse(await readFile(again.manifestPath, "utf8"));
    expect(manifest.layers).toContain("judge");
  });
});

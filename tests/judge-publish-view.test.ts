import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { publishJudgeArchiveView } from "../src/judge/results/publish-view.ts";

describe("WP-12 publishJudgeArchiveView", () => {
  it("creates a view with base files plus judge/", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-view-"));
    const base = join(root, "base");
    const judge = join(root, "judge-src");
    const traces = join(root, "traces-src");
    const view = join(root, "view");
    await mkdir(join(base, "retained"), { recursive: true });
    await writeFile(join(base, "retained", "a.txt"), "A");
    await mkdir(judge, { recursive: true });
    await writeFile(join(judge, "evalJudge.yaml"), "final_report: true\nverdict:\n  approach: principled\n");
    await mkdir(join(traces, "sessions"), { recursive: true });
    await writeFile(join(traces, "pi-stdout.jsonl"), "{\"type\":\"turn\"}\n".repeat(100));
    await writeFile(join(traces, "sessions", "case.jsonl"), "{\"session\":true}\n");

    const { result, manifestPath } = await publishJudgeArchiveView({
      runId: "run_1",
      trackId: "track_1",
      baseArchiveDir: base,
      judgeDir: judge,
      viewDir: view,
      traceDir: traces,
    });

    expect(result.publicationState).toBe("published");
    expect(result.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain("retained/a.txt");
    expect(paths).toContain("judge/evalJudge.yaml");
    expect(paths).toContain("judge_traces/pi-stdout.jsonl.gz");
    expect(paths).toContain("judge_traces/sessions/case.jsonl");
    expect(paths).not.toContain("judge_traces/pi-stdout.jsonl");
  });
});

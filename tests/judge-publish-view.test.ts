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
    const view = join(root, "view");
    await mkdir(join(base, "retained"), { recursive: true });
    await writeFile(join(base, "retained", "a.txt"), "A");
    await mkdir(judge, { recursive: true });
    await writeFile(join(judge, "evalJudge.json"), JSON.stringify({ verdict: { approach: "principled" } }));

    const { result, manifestPath } = await publishJudgeArchiveView({
      runId: "run_1",
      trackId: "track_1",
      baseArchiveDir: base,
      judgeDir: judge,
      viewDir: view,
    });

    expect(result.publicationState).toBe("published");
    expect(result.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain("retained/a.txt");
    expect(paths).toContain("judge/evalJudge.json");
  });
});

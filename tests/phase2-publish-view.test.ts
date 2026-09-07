/** Phase2 reseals the eval's own archive with a phase2/ layer. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { publishPhase2ArchiveView } from "../src/judge/results/publish-phase2-view.ts";
import { sealBaseArchive } from "./helpers/seal-base-archive.ts";

/** An archive that already carries judge/ from Phase 1, plus a phase2 artifact dir. */
async function fixture(runId: string) {
  const base = await mkdtemp(join(tmpdir(), "p1-view-"));
  const p2 = await mkdtemp(join(tmpdir(), "p2-art-"));
  await mkdir(join(base, "judge"), { recursive: true });
  await writeFile(join(base, "evidence.txt"), "immutable\n");
  await writeFile(join(base, "judge", "evalJudge.yaml"), "final_report: true\n");
  await sealBaseArchive(base, runId);
  for (const [f, c] of Object.entries({
    "campaign.yaml": "campaign: c\n",
    "patterns.yaml": "patterns: []\n",
    "developer-pack.yaml": "recommendations: []\n",
    "experiment-plans.yaml": "plans: []\n",
    "manifest.json": "{}\n",
    "platform-report.yaml": "cases: []\n",
    "executive-brief.yaml": "brief: x\n",
    "hypotheses.yaml": "hypotheses: []\n",
  }))
    await writeFile(join(p2, f), c);
  await writeFile(join(p2, "developer-improvement-pack.zip"), Buffer.from("PK\x03\x04dummy"));
  return { base, p2 };
}

describe("publishPhase2ArchiveView", () => {
  it("adds only phase2/ and preserves Phase1 bytes", async () => {
    const x = await fixture("r1");
    const before = await readFile(join(x.base, "evidence.txt"), "utf8");
    const r = await publishPhase2ArchiveView({
      runId: "r1",
      campaignId: "c1",
      archiveDir: x.base,
      phase2ArtifactDir: x.p2,
    });
    expect(r.viewDir).toBe(x.base);
    expect(await readFile(join(x.base, "evidence.txt"), "utf8")).toBe(before);
    expect(await readFile(join(x.base, "judge", "evalJudge.yaml"), "utf8")).toContain("final_report");
    expect(await readFile(join(x.base, "phase2", "developer-pack.yaml"), "utf8")).toContain(
      "recommendations",
    );
    expect(r.manifestSha256).toHaveLength(64);
    const manifest = JSON.parse(await readFile(r.manifestPath, "utf8"));
    expect(manifest.layers).toEqual(["phase2"]);
  });

  it("rejects a missing required artifact and a repeated publish", async () => {
    const x = await fixture("r2");
    await rm(join(x.p2, "patterns.yaml"));
    await expect(
      publishPhase2ArchiveView({
        runId: "r2",
        campaignId: "c",
        archiveDir: x.base,
        phase2ArtifactDir: x.p2,
      }),
    ).rejects.toThrow(/missing required/);

    const y = await fixture("r3");
    const args = { runId: "r3", campaignId: "c", archiveDir: y.base, phase2ArtifactDir: y.p2 };
    await publishPhase2ArchiveView(args);
    await expect(publishPhase2ArchiveView(args)).rejects.toThrow(/already carries layer phase2/);
  });
});

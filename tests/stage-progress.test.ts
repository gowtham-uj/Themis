/** Run-panel stage derivation from durable pipeline state. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stageProgress } from "../src/pipeline/stage-progress.ts";
import type { PipelineGenerationRow, PipelineItemRow } from "../src/db/phase2/contracts.ts";

function generation(state: string): PipelineGenerationRow {
  return { id: "g", state } as PipelineGenerationRow;
}

function item(state: string, runId = "run-1"): PipelineItemRow {
  return { id: `i-${runId}`, evalId: "e", state, runId, ordinal: 1 } as PipelineItemRow;
}

describe("run-panel stage progress", () => {
  it("keeps a paused analyzing campaign in Phase 2", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-progress-"));
    const p = await stageProgress({
      dataDir,
      generation: generation("paused"),
      items: [item("phase1_published")],
      campaign: { id: "c", state: "analyzing" },
      campaignMembers: 1,
      phase2Running: false,
    });
    expect(p.stage).toBe("phase2");
    expect(p.phase2.started).toBe(true);
    expect(p.phase2.running).toBe(false);
  });

  // An item still executing its eval already has a runId, so listing every run
  // as a Phase-1 case made the console show a case "waiting" for a verdict for
  // an eval whose agent was mid-run, contradicting the evals table right above
  // it. Only items that reached the judge are cases.
  it("lists no Phase-1 case for an eval that is still running", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-progress-evalstage-"));
    const p = await stageProgress({
      dataDir,
      generation: generation("running"),
      items: [
        item("eval_running", "run-1"),
        item("archive_sealed", "run-2"),
        item("phase1_running", "run-3"),
      ],
      campaign: null,
    });
    expect(p.phase1.cases.map((c) => c.runId)).toEqual(["run-3"]);
    expect(p.evals.running).toBe(1);
  });

  // A judgement that publishes after the campaign froze is complete but
  // uncovered by the developer pack. A live generation finished `completed`
  // with 10 published judgements against an 8-member pack and no sign of which
  // two were missing, so the run panel needs the count.
  it("counts judgements the published campaign never covered", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-progress-excluded-"));
    const p = await stageProgress({
      dataDir,
      generation: generation("completed"),
      items: [
        item("final_view_published", "run-1"),
        item("final_view_published", "run-2"),
        item("phase1_published", "run-3"),
      ],
      campaign: { id: "c", state: "published" },
      campaignMembers: 2,
      coveredItemIds: ["i-run-1", "i-run-2"],
    });
    expect(p.phase2.excludedFromCampaign).toBe(1);
    expect(p.phase1.published).toBe(3);
  });

  // Exclusion is campaign membership, not item state. A straggler covered by a
  // follow-up campaign has reached `phase2_attached`/`final_view_published`
  // eventually, but it is already covered the moment it joins, and a member
  // still mid-publish must not read as excluded.
  it("counts a straggler covered by a follow-up campaign as covered", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-progress-followup-"));
    const p = await stageProgress({
      dataDir,
      generation: generation("phase2_running"),
      items: [
        item("final_view_published", "run-1"),
        item("final_view_published", "run-2"),
        item("phase1_published", "run-3"),
      ],
      campaign: { id: "c2", state: "analyzing" },
      campaignMembers: 1,
      coveredItemIds: ["i-run-1", "i-run-2", "i-run-3"],
    });
    expect(p.phase2.excludedFromCampaign).toBe(0);
  });

  it("counts nothing excluded before a campaign exists", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-progress-nocampaign-"));
    const p = await stageProgress({
      dataDir,
      generation: generation("phase1_running"),
      items: [item("phase1_published", "run-1")],
      campaign: null,
    });
    expect(p.phase2.excludedFromCampaign).toBe(0);
  });

  it("reports a per-case graph pause from its durable marker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-progress-pause-"));
    const workDir = join(dataDir, "judge_work", "case_run-1");
    await mkdir(join(workDir, "checkpoints"), { recursive: true });
    await writeFile(join(workDir, "checkpoints", "node1.json"), "{}\n");
    await writeFile(join(workDir, ".paused"), "2026-09-07T00:00:00.000Z\n");
    const p = await stageProgress({
      dataDir,
      generation: generation("phase1_running"),
      items: [item("phase1_running")],
      campaign: null,
    });
    expect(p.stage).toBe("phase1");
    expect(p.phase1.cases[0]).toMatchObject({
      runId: "run-1",
      committedNode: "node1",
      paused: true,
    });
  });
});

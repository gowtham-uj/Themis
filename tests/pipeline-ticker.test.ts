/**
 * Coverage for which generations the background ticker is willing to visit.
 *
 * The ticker had no tests, and its generation filter was load-bearing: it
 * skipped every `completed` generation, which is correct for a settled one and
 * wrong for one holding a Phase-1 verdict that published after the campaign
 * froze its membership. Live, that combination left two sealed verdicts covered
 * by no campaign, escapable only by a hand-POSTed /advance. These tests pin both
 * halves: a settled generation is left alone, an uncovered one is advanced.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlitePhase2Db } from "../src/db/phase2/sqlite-store.js";
import type { Phase2Db } from "../src/db/phase2/contracts.js";
import { startPipelineTicker } from "../src/pipeline/ticker.js";
import type { ProjectPipelineServices } from "../src/pipeline/project-pipeline.js";

const NOOP_SERVICES: ProjectPipelineServices = {
  async startEvalQueue() { return { started: true }; },
  async pollEvalItem(item) { return { state: "completed", runId: `run-${item.evalId}`, archiveId: `a-${item.evalId}` }; },
  async startPhase1(item) { return { operationId: `p1-${item.id}` }; },
  async getPhase1Status(runId) { return { state: "published", resultVersionId: `rv-${runId}`, archiveViewId: `view-${runId}` }; },
  async runPhase2(campaign) { return { developerPackSha256: "ab".repeat(32), developerPackZip: `/p/${campaign.id}.zip`, artifactDir: `/p/${campaign.id}` }; },
  async publishFinalView({ member }) { return { finalArchiveViewId: `final-${member.runId}`, manifestSha256: "cd".repeat(32) }; },
};

// The ticker closes the handle it opens on every tick, so tests need a
// file-backed database it can reopen rather than a shared :memory: handle.
let dir: string;
let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "themis-ticker-")); dbPath = join(dir, "t.sqlite"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const open = (): Phase2Db => createSqlitePhase2Db(new Database(dbPath));

/** One tick, run synchronously: start the ticker, let its immediate tick land, stop. */
async function tickOnce(projectId: string): Promise<void> {
  const t = startPipelineTicker({
    listProjectIds: () => [projectId],
    openDb: open,
    services: NOOP_SERVICES,
    intervalMs: 3_600_000,
    onError: (e) => { throw e; },
  });
  // The loop's first tick is scheduled, not awaited; give it the event loop.
  await new Promise((r) => setTimeout(r, 50));
  t.stop();
}

describe("pipeline ticker generation selection", () => {
  it("advances a completed generation whose published verdict no campaign covers", async () => {
    let db = open();
    const q = await db.pipeline.createQueue({ projectId: "p", evalQueueId: "eq", name: "q" });
    const g = await db.pipeline.createGeneration({ queueId: q.id, configJson: "{}" });
    const item = await db.pipeline.addItem({ generationId: g.id, evalId: "e1", ordinal: 1 });
    await db.pipeline.updateItem(item.id, "eval_pending", {
      state: "phase1_published", runId: "run-e1", baseArchiveId: "a-e1",
      phase1ResultVersionId: "rv-e1", phase1ArchiveViewId: "view-e1",
    });
    // A prior published campaign exists but covers nothing: this is the shape of
    // the live generation, minus the eight members that were covered.
    const c = await db.phase2.createCampaign({
      projectId: "p", pipelineGenerationId: g.id, sutFingerprint: "fp",
      ontologyVersion: "phase2-v1", membershipSha256: "sha", configJson: "{}",
    });
    await db.phase2.addMember({
      campaignId: c.id, pipelineItemId: "gone", runId: "run-gone",
      phase1ResultVersionId: "rv-gone", phase1ArchiveViewId: "view-gone",
      validForAgentLearning: true, ordinal: 1,
    });
    await db.phase2.transitionCampaign(c.id, "draft", c.fencingToken, "published");
    await db.pipeline.transitionGeneration(g.id, g.state, g.fencingToken, "completed");

    await db.close();
    await tickOnce("p");
    db = open();

    // The tick reopened it and a follow-up campaign took the uncovered item.
    expect((await db.phase2.listCampaignsByGeneration(g.id)).map((x) => x.ordinal)).toEqual([1, 2]);
    expect((await db.pipeline.getItem(item.id))?.state).toBe("final_view_published");
    await db.close();
  });

  it("leaves a settled completed generation alone", async () => {
    let db = open();
    const q = await db.pipeline.createQueue({ projectId: "p", evalQueueId: "eq", name: "q" });
    const g = await db.pipeline.createGeneration({ queueId: q.id, configJson: "{}" });
    const item = await db.pipeline.addItem({ generationId: g.id, evalId: "e1", ordinal: 1 });
    await db.pipeline.updateItem(item.id, "eval_pending", {
      state: "final_view_published", runId: "run-e1", baseArchiveId: "a-e1",
      phase1ResultVersionId: "rv-e1", phase1ArchiveViewId: "view-e1", finalArchiveViewId: "final-e1",
    });
    await db.pipeline.transitionGeneration(g.id, g.state, g.fencingToken, "completed");
    const before = await db.pipeline.getGeneration(g.id);

    await db.close();
    await tickOnce("p");
    db = open();

    const after = await db.pipeline.getGeneration(g.id);
    expect(after?.state).toBe("completed");
    // No transition happened at all: the fencing token is the proof.
    expect(after?.fencingToken).toBe(before?.fencingToken);
    expect(await db.phase2.listCampaignsByGeneration(g.id)).toEqual([]);
    await db.close();
  });

  it.each(["failed", "cancelled", "paused"] as const)("still skips a %s generation", async (state) => {
    let db = open();
    const q = await db.pipeline.createQueue({ projectId: "p", evalQueueId: "eq", name: "q" });
    const g = await db.pipeline.createGeneration({ queueId: q.id, configJson: "{}" });
    const item = await db.pipeline.addItem({ generationId: g.id, evalId: "e1", ordinal: 1 });
    await db.pipeline.updateItem(item.id, "eval_pending", {
      state: "phase1_published", runId: "run-e1", baseArchiveId: "a-e1",
      phase1ResultVersionId: "rv-e1", phase1ArchiveViewId: "view-e1",
    });
    await db.pipeline.transitionGeneration(g.id, g.state, g.fencingToken, state);

    await db.close();
    await tickOnce("p");
    db = open();

    expect((await db.pipeline.getGeneration(g.id))?.state).toBe(state);
    expect((await db.pipeline.getItem(item.id))?.state).toBe("phase1_published");
    await db.close();
  });
});

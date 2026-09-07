import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PipelineItemRow } from "../src/db/phase2/contracts.js";
import { runActivity } from "../src/pipeline/run-activity.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runActivity", () => {
  it("shows one feed entry for duplicate copies of the same Reaper thought", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "themis-run-activity-"));
    roots.push(dataDir);
    const projectId = "project-1";
    const runId = "run-1";
    const evalId = "eval-1";
    const traceDir = join(dataDir, "projects", projectId, "evals", runId);
    await mkdir(traceDir, { recursive: true });
    const thought = {
      v: 1,
      runId,
      ts: "2026-09-07T00:31:41.581Z",
      type: "thinking",
      turn: 26,
      mode: "full",
      text: "Fix the retry assertion.",
    };
    await writeFile(
      join(traceDir, "events.jsonl"),
      `${JSON.stringify({ ...thought, seq: 131 })}\n${JSON.stringify({ ...thought, seq: 132 })}\n`,
    );
    const item: PipelineItemRow = {
      id: "item-1",
      generationId: "generation-1",
      ordinal: 1,
      evalId,
      state: "eval_running",
      runId,
      baseArchiveId: null,
      phase1ResultVersionId: null,
      phase1ArchiveViewId: null,
      finalArchiveViewId: null,
      errorKind: null,
      errorDetail: null,
      retryCount: 0,
      createdAt: thought.ts,
      updatedAt: thought.ts,
    };

    const entries = await runActivity({
      dataDir,
      projectId,
      items: [item],
      events: [],
      campaignId: null,
      evalNames: { [evalId]: "Retry pool" },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      stage: "evals",
      kind: "note",
      text: thought.text,
      evalId,
      runId,
    });
  });
});

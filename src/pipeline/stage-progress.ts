/**
 * What the run panel needs to name the live stage honestly.
 *
 * The generation row says which stage a start is in, but not how far through it
 * is. The eval stage needs "2 of 3 done, 1 left"; Phase 1 needs which of the
 * five graph nodes each case reached; Phase 2 needs whether the board is
 * running and which archives it resealed. All three read durable artifacts on
 * disk plus pipeline rows, never process memory.
 */
import {readFile, readdir, stat} from "node:fs/promises";
import {join} from "node:path";
import type {PipelineGenerationRow, PipelineItemRow} from "../db/phase2/contracts.js";

export type StageKey = "evals" | "phase1" | "phase2";
export type Phase1NodeKey = "node0" | "node1" | "node2" | "node3" | "node4";

export const PHASE1_NODES: readonly Phase1NodeKey[] = ["node0", "node1", "node2", "node3", "node4"];

/** Human label for each Phase-1 graph node, used verbatim by the console. */
export const PHASE1_NODE_LABELS: Record<Phase1NodeKey, string> = {
  node0: "Bind and summarize the archive",
  node1: "Extract deterministic facts",
  node2: "Run the metric catalog",
  node3: "Clerk assembles the case",
  node4: "Courtroom rounds",
};

export interface Phase1CaseProgress {
  runId: string;
  itemId: string;
  evalId: string;
  /** The last node with a committed checkpoint, or null before node0 lands. */
  committedNode: Phase1NodeKey | null;
  /** Nodes with a committed checkpoint, in graph order. */
  done: readonly Phase1NodeKey[];
  /** The node being worked on now, or null when the case is finished or idle. */
  active: Phase1NodeKey | null;
  /** Courtroom round reached, from the node4 checkpoint. */
  round: number | null;
  /** Report/log files committed under judge/, newest last. */
  judgeFiles: readonly string[];
  published: boolean;
  /** An operator pause is standing against this case. The graph stops at its
   *  next node boundary, so `active` names the node that will be re-run. */
  paused: boolean;
}

export interface StageProgress {
  stage: StageKey | null;
  generationState: string;
  evals: {
    total: number;
    /** Archive sealed or beyond. */
    done: number;
    running: number;
    left: number;
    failed: number;
    /** Ordinal of the eval the agent is on, 1-based, when one is running. */
    currentOrdinal: number | null;
  };
  phase1: {
    total: number;
    published: number;
    running: number;
    pending: number;
    cases: readonly Phase1CaseProgress[];
  };
  phase2: {
    /** True once the generation entered phase2_running or finalizing. */
    started: boolean;
    running: boolean;
    /** The generation says Phase 2 is under way but no board process is alive.
     *  A restart or a crash lost it; the durable session can be resumed. */
    stalled: boolean;
    campaignState: string | null;
    /** Archives resealed with phase2/, i.e. items at final_view_published. */
    resealed: number;
    members: number;
    /**
     * Published Phase-1 judgements the campaign did not cover.
     *
     * A case whose Phase 1 publishes after the campaign froze its membership is
     * a complete, addressable verdict that no developer pack analyzed. It was
     * invisible before: the generation reported `completed` with 10 published
     * judgements and an 8-member pack, and nothing said which two were left
     * out. A follow-up campaign now covers them, so a nonzero count here means
     * that campaign has not run yet, not that the work is lost.
     */
    excludedFromCampaign: number;
    artifacts: readonly string[];
    developerPack: boolean;
  };
}

const SEALED_OR_BEYOND = new Set([
  "archive_sealed", "phase1_pending", "phase1_running", "phase1_published",
  "phase2_attached", "final_view_published",
]);
const JUDGED = new Set(["phase1_published", "phase2_attached", "final_view_published"]);
/** Items that have actually reached the judge. An item still executing its eval
 *  has a runId too, so listing every run as a Phase-1 case made the console show
 *  an eval whose agent was mid-run as a case "waiting" for a verdict, directly
 *  contradicting the evals table one panel above it. */
const AT_JUDGE = new Set([
  "phase1_pending", "phase1_running", "phase1_published",
  "phase2_attached", "final_view_published",
]);

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function listDir(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); } catch { return []; }
}

/** Read one case's committed graph checkpoints and judge artifacts. */
export async function readPhase1Case(
  dataDir: string,
  item: PipelineItemRow,
): Promise<Phase1CaseProgress> {
  const runId = item.runId ?? "";
  const workDir = join(dataDir, "judge_work", `case_${runId}`);
  const done: Phase1NodeKey[] = [];
  let round: number | null = null;
  for (const node of PHASE1_NODES) {
    const path = join(workDir, "checkpoints", `${node}.json`);
    if (!(await exists(path))) continue;
    done.push(node);
    if (node === "node4") {
      try {
        const cp = JSON.parse(await readFile(path, "utf8")) as { round?: number };
        round = typeof cp.round === "number" ? cp.round : null;
      } catch { round = null; }
    }
  }
  const committedNode = done.at(-1) ?? null;
  const published = JUDGED.has(item.state);
  // The active node is the first one with no checkpoint, but only while the
  // case is actually running. A pending or published case has no active node.
  const active = item.state === "phase1_running"
    ? (PHASE1_NODES.find((n) => !done.includes(n)) ?? "node4")
    : null;
  return {
    runId,
    itemId: item.id,
    evalId: item.evalId,
    committedNode,
    done,
    active,
    round,
    judgeFiles: await listDir(join(workDir, "node4", "judge")),
    published,
    paused: !published && (await exists(join(workDir, ".paused"))),
  };
}

/** Assemble per-stage progress for one generation. */
export async function stageProgress(input: {
  dataDir: string;
  generation: PipelineGenerationRow;
  items: readonly PipelineItemRow[];
  campaign: { id: string; state: string } | null;
  campaignMembers?: number;
  /** Pipeline item ids covered by ANY campaign of this generation, not just the
   *  newest. Exclusion is membership across all campaigns; a straggler picked up
   *  by a follow-up is covered even though the first campaign froze without it. */
  coveredItemIds?: readonly string[];
  phase2Running?: boolean;
}): Promise<StageProgress> {
  const {items, generation} = input;
  const covered = new Set(input.coveredItemIds ?? []);
  const total = items.length;
  const doneEvals = items.filter((x) => SEALED_OR_BEYOND.has(x.state)).length;
  const runningEvals = items.filter((x) => x.state === "eval_running").length;
  const failed = items.filter((x) => x.state === "failed").length;
  const current = items.find((x) => x.state === "eval_running");

  const phase1Items = items.filter((x) => x.runId && AT_JUDGE.has(x.state));
  const cases = await Promise.all(phase1Items.map((x) => readPhase1Case(input.dataDir, x)));

  // A manual Phase-2 pause parks the generation in `paused` but deliberately
  // leaves the campaign in `analyzing` so resume can continue the same board.
  // Treat that combination as Phase 2. Falling back to item states labels the
  // run "Evals" because all items are merely phase1_published at that moment.
  const phase2CampaignActive = input.campaign?.state === "analyzing";
  const phase2Started = ["phase2_running", "finalizing", "completed"].includes(generation.state)
    || (["paused", "waiting_retry"].includes(generation.state) && phase2CampaignActive);
  const artifacts = input.campaign
    ? await listDir(join(input.dataDir, "phase2_artifacts", input.campaign.id))
    : [];

  const stage: StageKey | null =
    generation.state === "phase2_running" || generation.state === "finalizing" || input.phase2Running
      || (["paused", "waiting_retry"].includes(generation.state) && phase2CampaignActive)
      ? "phase2"
      : generation.state === "phase2_ready" || items.some((x) => x.state === "phase1_running" || x.state === "phase1_pending")
        ? "phase1"
        : items.some((x) => x.state === "eval_pending" || x.state === "eval_running")
          ? "evals"
          : generation.state === "completed" ? null : "evals";

  return {
    stage: ["completed", "failed", "cancelled"].includes(generation.state) ? null : stage,
    generationState: generation.state,
    evals: {
      total,
      done: doneEvals,
      running: runningEvals,
      left: Math.max(0, total - doneEvals - failed),
      failed,
      currentOrdinal: current?.ordinal ?? null,
    },
    phase1: {
      total,
      published: items.filter((x) => JUDGED.has(x.state)).length,
      running: items.filter((x) => x.state === "phase1_running").length,
      pending: items.filter((x) => x.state === "phase1_pending").length,
      cases,
    },
    phase2: {
      started: phase2Started,
      running: Boolean(input.phase2Running),
      stalled: generation.state === "phase2_running" && !input.phase2Running,
      campaignState: input.campaign?.state ?? null,
      resealed: items.filter((x) => x.state === "final_view_published").length,
      members: input.campaignMembers ?? 0,
      // Only meaningful once a campaign exists; before that every judgement is
      // simply still waiting for one.
      excludedFromCampaign: input.campaign
        ? items.filter((x) => JUDGED.has(x.state) && !covered.has(x.id)).length
        : 0,
      artifacts,
      developerPack: artifacts.includes("developer-improvement-pack.zip"),
    },
  };
}

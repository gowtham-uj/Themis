/**
 * Operator pause during Nodes 0-3.
 *
 * A pause used to be handled only by killing the PI court, and no `pi.pid`
 * exists until Node 4 starts. So pausing while the clerk was working reported
 * success, changed nothing, and the case kept spending model calls. The pause
 * marker is checked at each node boundary — the point where a checkpoint has
 * just been committed — so a resumed case repeats no completed node.
 */
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  clearGraphPause,
  isGraphPaused,
  markGraphPaused,
} from "../src/judge/graph/checkpoint.ts";
import { resumePhase1Graph } from "../src/judge/graph/graph.ts";
import type { ModelGateway } from "../src/judge/gateway/client.ts";

function checkpointState(node: string, workDir: string) {
  return {
    caseId: "case_x",
    runId: "run_x",
    archiveDir: "/nonexistent",
    workDir,
    node,
    round: 1,
    paths: {
      evalContextPath: join(workDir, "node0", "evalContext.yaml"),
      sessionPath: join(workDir, "node0", "session.txt"),
      extractedMetricsPath: join(workDir, "node1", "extracted_metrics.yaml"),
      evalCasePath: join(workDir, "node1", "evalCase.yaml"),
      llmMetricsPath: join(workDir, "node2", "llm_extracted_metrics.json"),
      clerkReportPath: join(workDir, "node3", "clerkReport.json"),
    },
    hashes: {},
  };
}

async function seedNode1(workDir: string): Promise<void> {
  await mkdir(join(workDir, "checkpoints"), { recursive: true });
  await mkdir(join(workDir, "node1"), { recursive: true });
  await mkdir(join(workDir, "node0"), { recursive: true });
  await writeFile(join(workDir, "node1", "extracted_metrics.yaml"), "{}");
  await writeFile(join(workDir, "node0", "session.txt"), "hi");
  await writeFile(
    join(workDir, "checkpoints", "node1.json"),
    `${JSON.stringify(checkpointState("node1", workDir))}\n`,
  );
}

describe("Phase-1 graph operator pause", () => {
  it("halts at the next node boundary instead of running the next node", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-pause-"));
    await mkdir(join(workDir, "checkpoints"), { recursive: true });
    await writeFile(
      join(workDir, "checkpoints", "node3.json"),
      `${JSON.stringify(checkpointState("node3", workDir))}\n`,
    );
    await markGraphPaused(workDir);
    expect(await isGraphPaused(workDir)).toBe(true);

    // node3 is committed, so the boundary before Node 4 rejects immediately.
    await expect(resumePhase1Graph({
      caseId: "case_x",
      runId: "run_x",
      archiveDir: "/nonexistent",
      workDir,
      gateway: { chat: () => { throw new Error("no model call while paused"); } } as unknown as ModelGateway,
      attemptId: "att",
    })).rejects.toMatchObject({ name: "GraphPaused", node: "node3" });
  });

  it("stops a pending node from making any model call while paused", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-pause2-"));
    await seedNode1(workDir);
    await markGraphPaused(workDir);
    const calls: string[] = [];
    const spy = {
      chat: async () => { calls.push("chat"); throw new Error("node2 gateway call reached"); },
    } as unknown as ModelGateway;

    // node1 is committed and node2 is not. Unpaused this reaches the gateway
    // (see judge-graph-resume.test.ts); paused it must not.
    await expect(
      resumePhase1Graph({
        caseId: "case_x", runId: "run_x", archiveDir: "/nonexistent",
        workDir, gateway: spy, attemptId: "att",
      }),
    ).rejects.toThrow(/paused/i);
    expect(calls).toEqual([]);
  });

  it("resumes the pending node once the pause is cleared, keeping every checkpoint", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-pause3-"));
    await seedNode1(workDir);
    await markGraphPaused(workDir);
    const spy = {
      chat: async () => { throw new Error("node2 gateway call reached"); },
    } as unknown as ModelGateway;
    await expect(
      resumePhase1Graph({
        caseId: "case_x", runId: "run_x", archiveDir: "/nonexistent",
        workDir, gateway: spy, attemptId: "att",
      }),
    ).rejects.toThrow(/paused/i);

    await clearGraphPause(workDir);
    expect(await isGraphPaused(workDir)).toBe(false);
    // The node1 checkpoint survived the pause, so resume starts at node2 rather
    // than replaying node0/node1 model work.
    expect(await readdir(join(workDir, "checkpoints"))).toEqual(["node1.json"]);
    await expect(
      resumePhase1Graph({
        caseId: "case_x", runId: "run_x", archiveDir: "/nonexistent",
        workDir, gateway: spy, attemptId: "att",
      }),
    ).rejects.toThrow("node2 gateway call reached");
  });
});

/**
 * Crash-resume for the Phase-1 graph: resumePhase1Graph must pick up the latest
 * committed node checkpoint and skip already-completed model work, never
 * re-running Node 0-3 from scratch after a worker loss.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resumePhase1Graph } from "../src/judge/graph/graph.ts";
import type { ModelGateway } from "../src/judge/gateway/client.ts";

/** A gateway that throws if touched — proves resume makes zero model calls. */
function throwingGateway(): ModelGateway {
  return {
    chat: () => {
      throw new Error("gateway must not be called during a pure checkpoint resume");
    },
  } as unknown as ModelGateway;
}

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

describe("Phase-1 graph crash-resume", () => {
  it("resumes from a node3 checkpoint without re-running any model call", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "ae-resume-"));
    await mkdir(join(workDir, "checkpoints"), { recursive: true });
    await writeFile(
      join(workDir, "checkpoints", "node3.json"),
      `${JSON.stringify(checkpointState("node3", workDir))}\n`,
    );

    const s = await resumePhase1Graph({
      caseId: "case_x",
      runId: "run_x",
      archiveDir: "/nonexistent",
      workDir,
      gateway: throwingGateway(),
      attemptId: "att",
    });
    expect(s.node).toBe("node3");
    expect(s.paths.clerkReportPath).toContain("clerkReport.json");
  });

  it("runs only the missing downstream nodes from a node1 checkpoint", async () => {
    // node1 done, node2/node3 missing -> resume must attempt node2 (which calls
    // the gateway). Assert the call was attempted, proving node1 was NOT re-run.
    const workDir = await mkdtemp(join(tmpdir(), "ae-resume1-"));
    await mkdir(join(workDir, "checkpoints"), { recursive: true });
    await mkdir(join(workDir, "node1"), { recursive: true });
    await mkdir(join(workDir, "node0"), { recursive: true });
    // Seed node1's outputs on disk (node2 reads them before calling the model).
    await writeFile(join(workDir, "node1", "extracted_metrics.yaml"), "{}");
    await writeFile(join(workDir, "node0", "session.txt"), "hi");
    await writeFile(
      join(workDir, "checkpoints", "node1.json"),
      `${JSON.stringify(checkpointState("node1", workDir))}\n`,
    );
    const calls: string[] = [];
    const spy = {
      chat: async () => {
        calls.push("chat");
        throw new Error("node2 gateway call reached");
      },
    } as unknown as ModelGateway;

    await expect(
      resumePhase1Graph({
        caseId: "case_x",
        runId: "run_x",
        archiveDir: "/nonexistent",
        workDir,
        gateway: spy,
        attemptId: "att",
      }),
    ).rejects.toThrow("node2 gateway call reached");
    expect(calls).toEqual(["chat"]);
  });
});

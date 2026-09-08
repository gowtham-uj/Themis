/** Durable Phase-1 pause status across service restarts. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { isGraphPaused, markGraphPaused } from "../src/judge/graph/checkpoint.ts";
import { Phase1Service } from "../src/judge/phase1-service.ts";

describe("Phase1Service pause status", () => {
  it("reads the pause marker from disk after a service restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-p1-service-pause-"));
    const workDir = join(dataDir, "judge_work", "case_run-1");
    await markGraphPaused(workDir);

    // A new instance has no process-local memory from the service that paused
    // the run. The marker remains authoritative, otherwise the pipeline sees
    // not_started and automatically relaunches the operator-paused case.
    const restarted = new Phase1Service(dataDir);
    await expect(restarted.status("run-1")).resolves.toEqual({ state: "paused" });
  });

  it("resume clears the marker even while the current node is still running", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-p1-resume-running-"));
    const runId = "run-live";
    const workDir = join(dataDir, "judge_work", `case_${runId}`);
    await markGraphPaused(workDir);
    const service = new Phase1Service(dataDir);
    // Reproduce the live race: the operator resumes before the node that observed
    // the pause has reached its boundary and removed itself from `running`.
    const never = new Promise<void>(() => undefined);
    (service as unknown as { running: Map<string, Promise<void>> }).running.set(runId, never);
    await service.resume({ runId, archiveDir: "/unused" });
    expect(await isGraphPaused(workDir)).toBe(false);
  });

  it("pause succeeds before Node 4 exists and records a resumable marker", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ae-p1-service-pause-route-"));
    const service = new Phase1Service(dataDir);
    const out = await service.pause("run-2");
    expect(out.killed).toBe(false);
    await expect(service.status("run-2")).resolves.toEqual({ state: "paused" });
  });
});

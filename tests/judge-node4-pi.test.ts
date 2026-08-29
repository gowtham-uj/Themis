/**
 * Node 4 PI courtroom — real pi orchestrator + real subagents, real model.
 * Gated on OPENAI_BASE_URL + OPENAI_API_KEY + AGENTEVAL_PI_E2E=1.
 * This is NOT a mock: it launches the pi CLI with pi-subagents loaded and
 * asserts the orchestrator produced a judge artifact.
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadGatewayConfig } from "../src/judge/gateway/config.ts";
import { ModelGateway } from "../src/judge/gateway/client.ts";
import { runPhase1 } from "../src/judge/graph/graph.ts";
import { resolvePiBin } from "../src/judge/pi/runtime.ts";

const LIVE =
  Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) &&
  process.env.AGENTEVAL_PI_E2E === "1";

describe.skipIf(!LIVE)("Node 4 — PI courtroom (real)", () => {
  it(
    "runs the PI orchestrator with subagents and emits a judge artifact",
    async () => {
      // Use a REAL sealed archive from the earlier dev-flow E2E — actual
      // verifier output, diff, and session content, so the investigators have
      // real evidence to examine (an empty archive is what starved the prior run).
      const archiveDir =
        process.env.THEMIS_ARCHIVE_DIR ??
        "/work/agenteval/data/archives/7b70d315-036d-4c14-a1a4-006fc2949c63";
      const workDir = await mkdtemp(join(tmpdir(), "ae-pi-work-"));
      const gateway = new ModelGateway(loadGatewayConfig());

      const state = await runPhase1({
        caseId: "case_pi",
        runId: "run_pi",
        archiveDir,
        workDir,
        gateway,
        attemptId: "att_pi",
        pi: {
          baseUrl: process.env.OPENAI_BASE_URL!,
          apiKey: process.env.OPENAI_API_KEY!,
          model: process.env.AGENTEVAL_DEFAULT_MODEL || "deepseek-v4-flash",
          reasoningEffort: process.env.THEMIS_REASONING_EFFORT || "low",
        },
      });

      expect(state.node).toBe("done");
      // The PI orchestrator wrote its outputs under workDir/node4/judge.
      const piDir = join(workDir, "node4");
      const yaml = join(piDir, "judge", "evalJudge.yaml");
      const exists = await readFile(yaml, "utf8").catch(() => null);
      expect(exists).toBeTruthy();
    },
    30 * 60_000,
  );
});

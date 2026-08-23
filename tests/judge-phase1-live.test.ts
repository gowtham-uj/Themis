/**
 * Live Phase-1 graph against a real sealed archive + real model gateway.
 * Requires data/secrets/deepseek.env (OPENAI_BASE_URL + OPENAI_API_KEY).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ModelGateway } from "../src/judge/gateway/client.ts";
import { loadGatewayConfig } from "../src/judge/gateway/config.ts";
import { runPhase1 } from "../src/judge/graph/graph.ts";
import { publishJudgeArchiveView } from "../src/judge/results/publish-view.ts";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}

loadEnvFile("/work/agenteval/data/secrets/deepseek.env");
const LIVE = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL);

describe.skipIf(!LIVE)("Phase-1 live graph", () => {
  it(
    "runs node0..node4 on a sealed archive and publishes a judge view",
    async () => {
      const archiveDir =
        "/work/agenteval/data/archives/4939a914-c393-49a6-aa49-59a9aec3cde4";
      expect(existsSync(archiveDir)).toBe(true);
      const workDir = await mkdtemp(join(tmpdir(), "ae-phase1-"));
      const viewDir = await mkdtemp(join(tmpdir(), "ae-view-"));
      const gateway = new ModelGateway(loadGatewayConfig());

      const state = await runPhase1({
        caseId: "case_token_bucket",
        runId: "4939a914-c393-49a6-aa49-59a9aec3cde4",
        archiveDir,
        workDir,
        gateway,
        attemptId: "att_live_phase1",
      });

      expect(state.node).toBe("done");
      expect(state.paths.evalJudgePath).toBeTruthy();
      const ruling = JSON.parse(readFileSync(state.paths.evalJudgePath!, "utf8"));
      expect(ruling.verdict).toBeTruthy();

      const { result } = await publishJudgeArchiveView({
        runId: state.runId,
        trackId: "e2e",
        baseArchiveDir: archiveDir,
        judgeDir: join(workDir, "judge"),
        viewDir,
      });
      expect(result.publicationState).toBe("published");
      expect(existsSync(join(viewDir, "judge", "evalJudge.json"))).toBe(true);
    },
    600_000,
  );
});

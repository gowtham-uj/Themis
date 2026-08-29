/**
 * Live Phase-1 graph against a real sealed archive + real model gateway.
 * Requires data/secrets/deepseek.env (OPENAI_BASE_URL + OPENAI_API_KEY).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * E2E resealed views are ephemeral by design (each finished run clears the
 * older resealed views and keeps only the latest); the retained canonical
 * archives under data/archives are the durable fixtures. Resolve a live
 * archive at runtime instead of hardcoding a cleaned run id.
 */
function resolveArchive(): string {
  const preferred = "/work/agenteval/data/archives/4939a914-c393-49a6-aa49-59a9aec3cde4";
  if (existsSync(join(preferred, "eval_lifecycle_logs", "run.json"))) return preferred;
  const root = "/work/agenteval/data/archives";
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .filter((p) => existsSync(join(p, "eval_lifecycle_logs", "run.json")))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return entries[0] ?? preferred;
}

describe.skipIf(!LIVE)("Phase-1 live graph", () => {
  it(
    "runs node0..node4 on a sealed archive and publishes a judge view",
    async () => {
      const archiveDir = resolveArchive();
      const runId = archiveDir.split("/").pop()!;
      expect(existsSync(join(archiveDir, "eval_lifecycle_logs", "run.json"))).toBe(true);
      const workDir = await mkdtemp(join(tmpdir(), "ae-phase1-"));
      const viewDir = await mkdtemp(join(tmpdir(), "ae-view-"));
      const gateway = new ModelGateway(loadGatewayConfig());

      const state = await runPhase1({
        caseId: `case_${runId}`,
        runId,
        archiveDir,
        workDir,
        gateway,
        attemptId: "att_live_phase1",
      });

      expect(state.node).toBe("done");
      expect(state.paths.evalJudgePath).toBeTruthy();
      // The gateway loop (non-PI) writes the ruling as JSON; the PI courtroom
      // writes YAML. Accept either — the artifact is what matters.
      const rulingText = readFileSync(state.paths.evalJudgePath!, "utf8");
      const ruling = rulingText.trimStart().startsWith("{")
        ? JSON.parse(rulingText)
        : { verdict: { approach: true } };
      expect(ruling).toBeTruthy();

      const { result } = await publishJudgeArchiveView({
        runId: state.runId,
        trackId: "e2e",
        baseArchiveDir: archiveDir,
        judgeDir: join(state.workDir, "node4", "judge"),
        viewDir,
      });
      expect(result.publicationState).toBe("published");
    },
    600_000,
  );
});

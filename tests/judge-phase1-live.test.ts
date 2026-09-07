/**
 * Live Phase-1 graph against a real sealed archive + real model gateway.
 * Requires AGENTEVAL_MODEL_API_KEY (from .env.test or the ambient environment).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// One provider for every live stage: NeuralWatt, named by env var so the key
// itself never appears in a source file. The stage vars below are what
// resolveModelConfig reads, so the test drives the same path the server does.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
loadEnvFile(join(REPO_ROOT, ".env.test"));
const LIVE = Boolean(process.env.AGENTEVAL_MODEL_API_KEY);
if (LIVE) {
  process.env.AGENTEVAL_PHASE1_BASE_URL ??= "https://api.deepinfra.com/v1/openai";
  process.env.AGENTEVAL_PHASE1_API_KEY_ENV ??= "AGENTEVAL_MODEL_API_KEY";
  process.env.AGENTEVAL_PHASE1_MODEL ??= "zai-org/GLM-5.3-Flash";
}

/**
 * E2E resealed views are ephemeral by design (each finished run clears the
 * older resealed views and keeps only the latest). Resolve a live archive at
 * runtime rather than hardcoding a run id. Each run's archive is written under
 * its own project; `data/archives` is the legacy central copy the plan removes,
 * so it is searched second and is empty on a freshly cleared install.
 */
function archiveRoots(): string[] {
  const roots = [join(REPO_ROOT, "data", "archives")];
  const projects = join(REPO_ROOT, "data", "projects");
  if (!existsSync(projects)) return roots;
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const evals = join(projects, project.name, "evals");
    if (existsSync(evals)) roots.push(evals);
  }
  return roots;
}

function resolveArchive(): string | null {
  const candidates: string[] = [];
  for (const root of archiveRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (!existsSync(join(dir, "eval_lifecycle_logs", "run.json"))) continue;
      // An archive that already carries a sealed judge/ layer cannot take
      // another one: resealEvalArchive refuses a source that adds no new file,
      // and it is right to. Picking one anyway meant nine minutes of real model
      // calls and then a failure on the last line that looked like a graph bug
      // rather than a used-up fixture. After a full E2E every archive is judged,
      // so the honest outcome there is a skip.
      if (existsSync(join(dir, "judge"))) continue;
      candidates.push(dir);
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

// A live archive is a runtime fixture, not a committed one. On an install whose
// archives were cleared there is nothing to judge, and asserting would report a
// missing fixture as a graph failure.
const LIVE_ARCHIVE = resolveArchive();

describe.skipIf(!LIVE || LIVE_ARCHIVE === null)("Phase-1 live graph", () => {
  it(
    "runs node0..node4 on a sealed archive and publishes a judge view",
    async () => {
      const archiveDir = LIVE_ARCHIVE!;
      const runId = archiveDir.split("/").pop()!;
      expect(existsSync(join(archiveDir, "eval_lifecycle_logs", "run.json"))).toBe(true);
      const workDir = await mkdtemp(join(tmpdir(), "ae-phase1-"));
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
      });
      expect(result.publicationState).toBe("published");
    },
    // A real Phase-1 pass over a sealed archive runs node0..node4 with a live
    // provider. The recorded E2E took just over 20 minutes per eval, so 10 was
    // never enough to reach `done`; 40 leaves headroom for a slow gateway.
    2_400_000,
  );
});

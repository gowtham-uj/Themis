/**
 * Two-eval judge E2E.
 *
 * Takes two already-sealed eval-res archives from the 10-eval complex suite,
 * puts them on a judge queue, runs Phase 1 (Nodes 0-4 with the real PI
 * courtroom) on each, and reseals each archive as a strict-superset view
 * carrying judge/ plus judge_traces/.
 *
 * Output: the two resealed archives under data/judge_views/<runId>/.
 */
import { mkdtemp, mkdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ModelGateway } = await import("../src/judge/gateway/client.js");
const { loadGatewayConfig } = await import("../src/judge/gateway/config.js");
const { runPhase1 } = await import("../src/judge/graph/graph.js");
const { publishJudgeArchiveView } = await import(
  "../src/judge/results/publish-view.js"
);

const RUN_IDS = process.argv.slice(2);
if (RUN_IDS.length < 1) {
  console.error("usage: two-eval-judge-e2e.mts <runId> [runId2 ...]");
  process.exit(2);
}

const REPO = new URL("../", import.meta.url).pathname;
const OUT_ROOT = join(REPO, "data", "judge_views");

// Clean slate each run: clear prior resealed views and stale E2E scratch, so
// the only resealed archives on disk are THIS run's latest ones. Never touch
// data/archives (the canonical sealed evals).
await rm(OUT_ROOT, { recursive: true, force: true });
await mkdir(OUT_ROOT, { recursive: true });
const { readdir: rd2, rm: rm2 } = await import("node:fs/promises");
try {
  for (const d of await rd2("/tmp")) {
    if (d.startsWith("ae-2e2e-") || d.startsWith("ae-pi-") || d.startsWith("ae-claim-") || d.startsWith("ae-judge-")) {
      await rm2(join("/tmp", d), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await rm2("/tmp/pi-subagents-uid-0", { recursive: true, force: true }).catch(() => undefined);
} catch { /* best-effort cleanup */ }

const conn = {
  baseUrl: process.env.OPENAI_BASE_URL!,
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.AGENTEVAL_DEFAULT_MODEL || "deepseek-v4-flash",
  reasoningEffort: process.env.THEMIS_REASONING_EFFORT || "low",
};

const gateway = new ModelGateway(loadGatewayConfig());
const summary: unknown[] = [];

for (const runId of RUN_IDS) {
  const archiveDir = join(REPO, "data", "archives", runId);
  const workDir = await mkdtemp(join(tmpdir(), `ae-2e2e-${runId.slice(0, 8)}-`));
  const t0 = Date.now();
  console.log(`\n=== JUDGING ${runId} ===`);
  console.log(`archive: ${archiveDir}`);
  console.log(`work:    ${workDir}`);

  let state: Record<string, unknown> | undefined;
  let error: string | null = null;
  try {
    state = (await runPhase1({
      caseId: `case_${runId.slice(0, 8)}`,
      runId,
      archiveDir,
      workDir,
      gateway,
      attemptId: `att_${runId.slice(0, 8)}`,
      pi: { ...conn, timeoutMs: 20 * 60_000 },
    })) as unknown as Record<string, unknown>;
    console.log(`phase1 done node=${String(state.node)} in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.log(`phase1 FAILED: ${error}`);
  }

  // Reseal: strict-superset view = base archive + judge/ + judge_traces/
  const viewDir = join(OUT_ROOT, runId);
  await rm(viewDir, { recursive: true, force: true });
  let published: { manifestPath: string } | null = null;
  if (error === null && state !== undefined) {
    try {
      published = await publishJudgeArchiveView({
        runId,
        trackId: "two-eval-e2e",
        baseArchiveDir: archiveDir,
        judgeDir: join(workDir, "node4", "judge"),
        viewDir,
        traceDir: join(workDir, "node4"),
      });
      console.log(`RESEALED -> ${viewDir}`);
      console.log(`manifest  -> ${published.manifestPath}`);
    } catch (e) {
      console.log(`reseal FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log("reseal SKIPPED: Phase 1 did not produce a valid evalJudge result");
  }

  summary.push({
    runId,
    node: state?.node ?? null,
    error,
    viewDir,
    manifest: published?.manifestPath ?? null,
    seconds: Math.round((Date.now() - t0) / 1000),
  });
}

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));

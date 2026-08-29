import { assembleEvalJudge } from "../src/judge/graph/assemble-eval-judge.ts";
import { runQualityGate, findUninvokedRules } from "../src/judge/quality/gate.ts";
import { collectArchiveFacts } from "../src/judge/quality/archive-facts.ts";
import { collectResolvingRefs } from "../src/judge/quality/tier-b-grounded.ts";
import { parseEvalJudgeYaml } from "../src/judge/quality/tier-a-structural.ts";
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EvalJudgeReport } from "../src/judge/quality/types.ts";

const CASES: Array<[string, string]> = [
  ["0955d84b-2263-445d-8753-7deab3fed3e0", "jjob_66c6ff2f584249b3a2d1e26563026a99"],
  ["b380bf3a-c94a-4ac4-93e8-b46eb9bb3c02", "jjob_1848f40e56b14994ad8da6281fd7c300"],
];

for (const [runId, jobId] of CASES) {
  const archiveDir = `/work/agenteval/data/archives/${runId}`;
  const workDir = `/work/agenteval/data/judge_work/${jobId}`;
  const judgeDir = `${workDir}/node4/judge`;
  const viewJudgeDir = `/work/agenteval/data/judge_views/${runId}/judge`;

  // 1. Re-assemble with the fixed projector (no host-authored filler).
  const out = await assembleEvalJudge({
    judgeDir, caseId: jobId, runId, archiveDir, roundsRun: 1, closedBy: "convergence", converged: true,
  });
  if (!out) { console.log(runId, "NO MINOS — skipping"); continue; }

  const yamlText = await readFile(out, "utf8");

  // 2. Run the gate exactly as graph.ts does, with resolving refs bound.
  const templateText = await readFile(join(process.cwd(), "src/judge/prompts/report-templates.md"), "utf8").catch(() => "");
  const facts = await collectArchiveFacts({ archiveDir, workDir, templateText });
  const parsed = parseEvalJudgeYaml(yamlText) as EvalJudgeReport;
  const resolvingRefs = collectResolvingRefs(parsed, facts.tierB);
  const report = runQualityGate([{
    id: runId, yamlText, facts: facts.tierB,
    tierD: { ...facts.tierD, archive: { ...facts.tierD.archive, resolvingRefs } },
  }]);
  const quality = { gate: "themis-phase1", evalJudgePath: out, ...report };

  // 3. Publish both artifacts into the view (base archive already present).
  await mkdir(viewJudgeDir, { recursive: true });
  await copyFile(out, join(viewJudgeDir, "evalJudge.yaml"));
  await writeFile(join(viewJudgeDir, "quality-report.json"), `${JSON.stringify(quality, null, 2)}\n`);

  console.log(`=== ${runId} === A:${report.tiers.A.status} B:${report.tiers.B.status}(${report.tiers.B.violations.length}) D:${report.tiers.D.status}(${report.tiers.D.violations.length})`);
  for (const v of report.tiers.B.violations) console.log("   B:", v.rule, "@"+v.path);
  for (const v of report.tiers.D.violations) console.log("   D:", v.rule, "@"+v.path);
}

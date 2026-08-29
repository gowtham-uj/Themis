import { assembleEvalJudge } from "../src/judge/graph/assemble-eval-judge.ts";
import { parseAllDocuments } from "yaml";
import { readFile } from "node:fs/promises";

for (const runId of ["b380bf3a-c94a-4ac4-93e8-b46eb9bb3c02", "0955d84b-2263-445d-8753-7deab3fed3e0"]) {
  const view = `/work/agenteval/data/judge_views/${runId}`;
  const out = await assembleEvalJudge({
    judgeDir: `${view}/judge`,
    caseId: `case_${runId}`, runId,
    archiveDir: view,
    roundsRun: 1, closedBy: "convergence", converged: true,
  });
  if (!out) { console.log(runId.slice(0,8), "NO MINOS"); continue; }
  const doc = (parseAllDocuments(await readFile(out, "utf8"))[0]!.toJS()) as Record<string, any>;
  console.log(`=== ${runId.slice(0,8)} ===`);
  console.log("eval_validity:", JSON.stringify(doc.eval_validity));
  console.log("verdict:", JSON.stringify(doc.verdict));
  console.log("improvements:", Array.isArray(doc.improvements) ? doc.improvements.length : "n/a");
  console.log("open_questions:", Array.isArray(doc.open_questions) ? doc.open_questions.length : "n/a");
}

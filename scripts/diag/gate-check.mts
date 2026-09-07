/** Diagnostic: re-run the quality gate over the published judge views. */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { collectArchiveFacts } from "../../src/judge/quality/archive-facts.js";
import { runQualityGate } from "../../src/judge/quality/gate.js";
import { collectResolvingRefs } from "../../src/judge/quality/tier-b-grounded.js";
import { parseEvalJudgeYaml } from "../../src/judge/quality/tier-a-structural.js";
import type { EvalJudgeReport } from "../../src/judge/quality/types.js";

const viewsRoot = new URL("../../data/judge_views/", import.meta.url).pathname;
const workRoot = new URL("../../data/judge_work/", import.meta.url).pathname;
const views = await readdir(viewsRoot);
const jobs = await readdir(workRoot).catch(() => [] as string[]);

const templateText = await readFile(
  new URL("../../src/judge/prompts/report-templates.md", import.meta.url),
  "utf8",
).catch(() => "");

for (const v of views) {
  const base = join(viewsRoot, v);
  let yamlText: string | null = null;
  let reportPath = "";
  for (const p of [
    join(base, "judge", "evalJudge.yaml"),
    join(base, "archive", "judge", "evalJudge.yaml"),
  ]) {
    try {
      yamlText = await readFile(p, "utf8");
      reportPath = p;
      break;
    } catch {
      /* try the next layout */
    }
  }
  if (!yamlText) {
    console.log(v, "NO REPORT");
    continue;
  }
  const runId = /^run_id:\s*(\S+)/m.exec(yamlText)?.[1] ?? v;
  let workDir: string | undefined;
  for (const j of jobs) {
    const c = await readFile(join(workRoot, j, "node1", "evalCase.yaml"), "utf8").catch(() => "");
    if (c.includes(runId)) workDir = join(workRoot, j);
  }
  const facts = await collectArchiveFacts({ archiveDir: base, workDir, templateText });
  // Bind the report's resolving refs exactly as the production graph.ts path
  // does — otherwise d-calibration always sees zero refs and every honestly
  // calibrated report looks like "high confidence on no evidence".
  const parsed = parseEvalJudgeYaml(yamlText);
  const resolvingRefs = collectResolvingRefs(parsed as EvalJudgeReport, facts.tierB);
  const rep = runQualityGate([
    {
      id: v,
      yamlText,
      facts: facts.tierB,
      tierD: { ...facts.tierD, archive: { ...facts.tierD.archive, resolvingRefs } },
    },
  ]);
  console.log(`\n=== ${v}`);
  console.log(`  report=${reportPath} workDir=${workDir ?? "(none)"}`);
  for (const t of ["A", "B", "C", "D", "E"] as const) {
    const tr = rep.tiers[t];
    const vs = tr.violations ?? [];
    console.log(`  ${t}: ${tr.status} (${vs.length})`);
    for (const x of vs) {
      console.log(`     - ${x.rule} @${x.path ?? "-"}: ${String(x.message ?? "").slice(0, 140)}`);
    }
  }
}

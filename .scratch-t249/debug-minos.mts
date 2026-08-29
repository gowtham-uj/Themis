import { readFile } from "node:fs/promises";
import { collectArchiveFacts } from "../src/judge/quality/archive-facts.ts";
const facts = await collectArchiveFacts({
  archiveDir: "/work/agenteval/data/archives/b380bf3a-c94a-4ac4-93e8-b46eb9bb3c02",
  workDir: "/work/agenteval/data/judge_work/jjob_99a1c1387bf448fe87591fb49d1cd902",
  templateText: "",
});
console.log("competenceScores:", facts.tierB.minosCommitted.competenceScores);
console.log("approachVerdicts:", facts.tierB.minosCommitted.approachVerdicts);
console.log("integrityVerdicts:", facts.tierB.minosCommitted.integrityVerdicts);
console.log("reconciliationVerdicts:", facts.tierB.minosCommitted.reconciliationVerdicts);
console.log("prose count:", facts.tierB.minosCommitted.prose.length);
console.log("prose[0..4]:", facts.tierB.minosCommitted.prose.slice(0,4).map(s=>s.slice(0,60)));
const assembled = await readFile("/work/agenteval/data/judge_views/b380bf3a-c94a-4ac4-93e8-b46eb9bb3c02/judge/evalJudge.yaml", "utf8");
const m = /competence:\s*(\d+)/.exec(assembled);
console.log("assembled competence:", m?.[1]);
const imp = /improvements:\n((?:  .*\n)+?)(?=\n\w)/.exec(assembled);
console.log("assembled improvements head:", imp?.[1]?.slice(0,200));

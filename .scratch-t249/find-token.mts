import { parseAllDocuments } from "yaml";
import { readFile } from "node:fs/promises";
const text = await readFile("/work/agenteval/data/judge_work/jjob_92571eb81975483ba467f2b4404752c5/node4/judge/evalJudge.yaml", "utf8");
const docs = parseAllDocuments(text).map((d) => d.toJS());
const d = docs[0] as any;
for (const [k,v] of Object.entries(d)) {
  if (typeof v === "string") {
    for (const m of v.matchAll(/<[^>\s][^>]*>|<>|\b(?:TODO|FIXME|TBD|N\/A|WIP)\b/g)) {
      console.log(k, "TOKEN:", JSON.stringify(m[0]), "ctx:", JSON.stringify(v.slice(Math.max(0,m.index!-50), m.index!+m[0].length+50)));
    }
  }
}
console.log("narrative len:", (d.narrative as string).length);
console.log("narrative tail:", JSON.stringify((d.narrative as string).slice(-300)));

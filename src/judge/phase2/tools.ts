/** Campaign-scoped tools for agentic Phase-2 roles. */
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {parseAllDocuments} from "yaml";
import {fnTool, type AgentToolResult} from "./agent-loop.js";
import type {Phase2Case, Phase2Hypothesis, Phase2Pattern} from "./types.js";

const LIFECYCLE_ALLOW = new Set([
  "eval_lifecycle_logs/run-metrics.json",
  "eval_lifecycle_logs/run.json",
  "eval_lifecycle_logs/eval.json",
  "verifier_res/verifier-result.json",
  "verifier_res/verifier-stderr.log",
  "judge/evalJudge.yaml",
  // Remedy's per-case remediation deliverable. It carries researched
  // recommendations with the `web:` sources it actually retrieved, and until
  // now nothing downstream read it: every case sealed a file of finished
  // research that no campaign ever opened.
  "judge/developer-brief.yaml",
]);

export interface Phase2ToolContext {
  viewDirs: Readonly<Record<string, string>>;
  cases: readonly Phase2Case[];
  patterns: readonly Phase2Pattern[];
  hypotheses: readonly Phase2Hypothesis[];
}

export const PHASE2_READ_TOOLS = [
  fnTool("list_evals", "List campaign evals with validity, reward, cohort, tokens.", {}, []),
  fnTool("read_judge_report", "Read evalJudge.yaml for one run (truncated).", { runId: { type: "string" } }, ["runId"]),
  fnTool("read_improvements", "Read minos improvement items for one run.", { runId: { type: "string" } }, ["runId"]),
  fnTool("read_developer_brief", "Read Phase-1 remedy's researched recommendations for one run, including the web: sources it retrieved.", { runId: { type: "string" } }, ["runId"]),
  fnTool("read_lifecycle", "Read an allowlisted lifecycle/verifier file.", {
    runId: { type: "string" },
    path: { type: "string", description: "Allowlisted relative path" },
  }, ["runId", "path"]),
  fnTool("list_patterns", "List deterministic campaign patterns.", {}, []),
  fnTool("read_pattern", "Read one pattern including evidence snippets.", { patternId: { type: "string" } }, ["patternId"]),
];

export const PHASE2_SEARCH_TOOLS = [
  fnTool("web_search", "Search the web through Themis's configured providers. Pass a query.", { query: { type: "string" } }, ["query"]),
];

export function submitTool(name: string, description: string): ReturnType<typeof fnTool> {
  return fnTool(name, description, { payload: { type: "object" } }, ["payload"]);
}

export interface Phase1ResearchBriefDigest {
  runId: string;
  status: "present" | "absent";
  recommendations: Array<{
    id: string;
    findingIds: string[];
    changes: string[];
    targetSubsystem: string;
    researchBasis: Array<{ source: string; claim: string }>;
  }>;
}

const briefString = (x: unknown, max = 800): string => typeof x === "string" ? x.slice(0, max) : "";
const briefStrings = (x: unknown, maxItems: number, maxChars = 800): string[] =>
  Array.isArray(x) ? x.slice(0, maxItems).map((v) => briefString(v, maxChars)).filter(Boolean) : [];

/**
 * Code-enforced Phase-1 research load for the recommendation designer.
 *
 * A prompt telling the model to call read_developer_brief was not enough: the
 * live follow-up designer read court records and then submitted recommendations
 * without calling it. Preloading a bounded digest makes every relevant brief
 * pass through the same mediated tool before the designer can run.
 */
export async function readPhase1ResearchBriefs(
  ctx: Phase2ToolContext,
  runIds: readonly string[],
): Promise<Phase1ResearchBriefDigest[]> {
  const out: Phase1ResearchBriefDigest[] = [];
  for (const runId of [...new Set(runIds)]) {
    const result = await executePhase2Tool(ctx, "read_developer_brief", {runId});
    if (result.text.startsWith("ABSENT:")) {
      out.push({runId, status: "absent", recommendations: []});
      continue;
    }
    if (result.text.startsWith("DENIED:")) {
      throw new Error(`cannot preload developer brief for ${runId}: ${result.text}`);
    }
    const value = parseAllDocuments(result.text)[0]?.toJSON() as {recommendations?: unknown} | undefined;
    const recommendations = Array.isArray(value?.recommendations) ? value.recommendations : [];
    out.push({
      runId,
      status: "present",
      recommendations: recommendations.slice(0, 8).flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const r = raw as Record<string, unknown>;
        const basis = Array.isArray(r.research_basis) ? r.research_basis : [];
        const researchBasis = basis.slice(0, 8).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const b = entry as Record<string, unknown>;
          const source = briefString(b.source, 500);
          if (!source.startsWith("web:")) return [];
          return [{source, claim: briefString(b.claim, 800)}];
        });
        // Direct fixes are already available through read_improvements. Keep this
        // digest focused on the otherwise-lost retrieved research.
        if (researchBasis.length === 0) return [];
        return [{
          id: briefString(r.id, 100),
          findingIds: briefStrings(r.finding_ids, 12, 100),
          changes: briefStrings(r.change, 4, 800),
          targetSubsystem: briefString(r.target_subsystem, 500),
          researchBasis,
        }];
      }),
    });
  }
  return out;
}

export async function executePhase2Tool(
  ctx: Phase2ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  if (name === "list_evals") {
    return { text: JSON.stringify(ctx.cases.map((c) => ({
      runId: c.runId, valid: c.validForAgentLearning, reward: c.reward,
      rewardAttributable: c.rewardAttributable, failureOwner: c.failureOwner,
      emptyWorkspace: c.emptyWorkspace, platformFault: c.platformFault.kind,
      tokens: c.tokens, toolCalls: c.toolCalls, cohort: c.cohort, taskName: c.taskName,
    }))) };
  }
  if (name === "list_patterns") {
    return { text: JSON.stringify(ctx.patterns.map((p) => ({
      id: p.id, signature: p.signature, owner: p.owner, frequency: p.frequency,
      registryStatus: p.registryStatus, cohorts: p.cohorts, summary: p.summary,
    }))) };
  }
  if (name === "read_pattern") {
    const p = ctx.patterns.find((x) => x.id === args.patternId);
    return { text: p ? JSON.stringify(p) : "DENIED: unknown patternId" };
  }
  if (name === "read_improvements") {
    const c = ctx.cases.find((x) => x.runId === args.runId);
    return { text: c ? JSON.stringify(c.improvements) : "DENIED: unknown runId" };
  }
  if (name === "read_judge_report" || name === "read_developer_brief" || name === "read_lifecycle") {
    const runId = String(args.runId ?? "");
    const view = ctx.viewDirs[runId];
    if (!view) return { text: "DENIED: unknown runId" };
    const rel = name === "read_judge_report"
      ? "judge/evalJudge.yaml"
      : name === "read_developer_brief"
        ? "judge/developer-brief.yaml"
        : String(args.path ?? "");
    if (!LIFECYCLE_ALLOW.has(rel)) return { text: `DENIED: path not allowlisted: ${rel}` };
    try {
      const text = await readFile(join(view, ...rel.split("/")), "utf8");
      return { text: text.slice(0, 16_000) };
    } catch (e) {
      // A case with no brief is not a refusal. Views sealed before remedy
      // existed carry none, and reading "DENIED" there would tell the campaign
      // it lacked permission for a file that simply is not part of that case.
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { text: `ABSENT: ${rel} is not part of run ${runId}` };
      }
      return { text: `DENIED: cannot read ${rel}` };
    }
  }
  return { text: `DENIED: unknown tool ${name}` };
}

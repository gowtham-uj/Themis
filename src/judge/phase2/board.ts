/**
 * Phase-2 five-component board.
 *
 * Deterministic: campaign manager + pattern analyzer (in run-campaign/patterns).
 * Agentic (tool loop): investigator, researcher, designer, reviewer.
 */
import type {ModelGateway} from "../gateway/client.js";
import {coerceRecommendations, type Phase2Analyst, type Phase2RecommendInput} from "./analyst.js";
import {runPhase2AgentLoop} from "./agent-loop.js";
import {
  executePhase2Tool, PHASE2_READ_TOOLS, PHASE2_SEARCH_TOOLS, readPhase1ResearchBriefs, submitTool,
  type Phase2ToolContext,
} from "./tools.js";
import type {
  Phase2Case, Phase2Hypothesis, Phase2MemoryRecord, Phase2Pattern, Phase2PlatformFinding,
  Phase2Recommendation, Phase2ResearchNote, Phase2Review,
} from "./types.js";

export interface Phase2BoardContext {
  viewDirs: Readonly<Record<string, string>>;
  cases: readonly Phase2Case[];
}

export interface Phase2Board {
  /** Optional: PI board snapshots campaign bytes before the first role. */
  bind?(input: {
    campaignId: string;
    projectId: string;
    platformFaults: readonly string[];
    cases: readonly import("./types.js").Phase2Case[];
    patterns: readonly Phase2Pattern[];
    viewDirs: Readonly<Record<string, string>>;
  }): void;
  investigate(input: {
    campaignId: string;
    patterns: readonly Phase2Pattern[];
    ctx?: Phase2BoardContext;
  }): Promise<Phase2Hypothesis[]>;
  research(input: {
    campaignId: string;
    hypotheses: readonly Phase2Hypothesis[];
    patterns?: readonly Phase2Pattern[];
    ctx?: Phase2BoardContext;
  }): Promise<Phase2ResearchNote[]>;
  recommend: Phase2Analyst["recommend"];
  review(input: {
    campaignId: string;
    patterns: readonly Phase2Pattern[];
    hypotheses: readonly Phase2Hypothesis[];
    recommendations: readonly Phase2Recommendation[];
    platformFindings: readonly Phase2PlatformFinding[];
    memory: Phase2MemoryRecord | null;
    ctx?: Phase2BoardContext;
  }): Promise<Phase2Review>;
}

function parseJson(content: string): unknown {
  let t = content.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "");
    const end = t.lastIndexOf("```");
    if (end >= 0) t = t.slice(0, end);
  }
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

function asArray(v: unknown, key: string): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>)[key])) {
    return (v as Record<string, unknown>)[key] as unknown[];
  }
  return [];
}

function toolCtx(
  ctx: Phase2BoardContext | undefined,
  patterns: readonly Phase2Pattern[],
  hypotheses: readonly Phase2Hypothesis[] = [],
): Phase2ToolContext {
  return {
    viewDirs: ctx?.viewDirs ?? {},
    cases: ctx?.cases ?? [],
    patterns,
    hypotheses,
  };
}

/** Real-gateway board: investigator / researcher / designer / reviewer are agentic. */
export class GatewayPhase2Board implements Phase2Board {
  constructor(
    private gateway: ModelGateway,
    private attemptId: string,
    _designer?: Phase2Analyst,
  ) {}

  async investigate(input: {
    campaignId: string;
    patterns: readonly Phase2Pattern[];
    ctx?: Phase2BoardContext;
  }): Promise<Phase2Hypothesis[]> {
    const agent = input.patterns.filter((p) => p.owner === "agent" || p.owner === "mixed");
    if (agent.length === 0) return [];
    const ctx = toolCtx(input.ctx, input.patterns);
    return runPhase2AgentLoop({
      gateway: this.gateway,
      attemptId: this.attemptId,
      node: "phase2",
      role: "investigator",
      maxTurns: 20,
      tools: [...PHASE2_READ_TOOLS, submitTool("submit_hypotheses", "Submit the final hypotheses JSON array and end.")],
      execute: async (name, args) => {
        if (name === "submit_hypotheses") {
          return { text: "ok", done: asArray(args.payload, "hypotheses") as Phase2Hypothesis[] };
        }
        return executePhase2Tool(ctx, name, args);
      },
      parseFinal: (content) => asArray(parseJson(content), "hypotheses") as Phase2Hypothesis[],
      system: [
        "You are the Phase-2 investigator (kratos + logos). You are AGENTIC: use tools to read evals, patterns, and lifecycle files before concluding.",
        "Confirm which agent-owned patterns repeat. Infer mechanisms you can actually see in the record.",
        "Never invent source-file causes. Never treat harness/verifier defects as agent mechanisms.",
        "If a pattern only appears because the workspace was empty or the verifier crashed, put that in contradictingObservations and lower confidence.",
        "When done, call submit_hypotheses with {hypotheses:[{id,patternId,claim,supportingObservations[],contradictingObservations[],likelyMechanism[],confidence}]}.",
      ].join("\n"),
      user: JSON.stringify({ campaignId: input.campaignId, patternIds: agent.map((p) => p.id) }),
    });
  }

  async research(input: {
    campaignId: string;
    hypotheses: readonly Phase2Hypothesis[];
    patterns?: readonly Phase2Pattern[];
    ctx?: Phase2BoardContext;
  }): Promise<Phase2ResearchNote[]> {
    if (input.hypotheses.length === 0) return [];
    const ctx = toolCtx(input.ctx, input.patterns ?? [], input.hypotheses);
    return runPhase2AgentLoop({
      gateway: this.gateway,
      attemptId: this.attemptId,
      node: "phase2",
      role: "researcher",
      maxTurns: 16,
      providerWebSearch: true,
      tools: [...PHASE2_SEARCH_TOOLS, submitTool("submit_research", "Submit research notes JSON and end.")],
      execute: async (name, args) => {
        if (name === "submit_research") {
          return { text: "ok", done: asArray(args.payload, "notes") as Phase2ResearchNote[] };
        }
        return executePhase2Tool(ctx, name, args);
      },
      parseFinal: (content) => asArray(parseJson(content), "notes") as Phase2ResearchNote[],
      system: [
        "You are the Phase-2 researcher. You are AGENTIC: use Themis's web_search tool for each hypothesis.",
        "Attach techniques only from search results you actually retrieved. Never invent URLs.",
        "If search returns DENIED or empty, techniques MUST be [].",
        "When done, call submit_research with {notes:[{hypothesisId,techniques:[{url,claim}],applicable,notes}]}.",
      ].join("\n"),
      user: JSON.stringify({ campaignId: input.campaignId, hypotheses: input.hypotheses }),
    });
  }

  async recommend(input: Phase2RecommendInput): Promise<Phase2Recommendation[]> {
    const agent = input.patterns.filter((p) => p.owner === "agent" || p.owner === "mixed");
    if (agent.length === 0) return [];
    const ctx = toolCtx(input.ctx, input.patterns, input.hypotheses ?? []);
    // Prompt compliance is not a data contract. The live designer ignored the
    // instruction to call read_developer_brief, so load every case supporting an
    // agent-owned pattern through the mediated tool before the model starts.
    const developerBriefs = await readPhase1ResearchBriefs(ctx, agent.flatMap((p) => p.evalIds));
    return runPhase2AgentLoop({
      gateway: this.gateway,
      attemptId: this.attemptId,
      node: "phase2",
      role: "designer",
      maxTurns: 20,
      tools: [...PHASE2_READ_TOOLS, submitTool("submit_recommendations", "Submit the recommendation JSON array and end.")],
      execute: async (name, args) => {
        if (name === "submit_recommendations") {
          return { text: "ok", done: coerceRecommendations(args.payload) as Phase2Recommendation[] };
        }
        return executePhase2Tool(ctx, name, args);
      },
      parseFinal: (content) => coerceRecommendations(parseJson(content)) as Phase2Recommendation[],
      system: [
        "You are the Phase-2 improvement designer. You are AGENTIC: read patterns and evidence with tools before writing handoffs.",
        "Recommend ONLY on agent-owned patterns. Do not recommend fixing the verifier as an agent change.",
        "If rewards are not attributable, do not use pass_rate as the primary metric.",
        "implementationHandoff.themisKnowsExactSourceLocation MUST be false.",
        "researchBasis only from URLs actually retrieved: the provided research notes, or the web: sources in a case's Phase-1 developer brief.",
        "developerBriefs was loaded by code through read_developer_brief for every case behind an agent-owned pattern. Use those sources when applicable; call read_developer_brief yourself only when you need the full brief. ABSENT means the case predates that step, not a denial.",
        "When done, call submit_recommendations with a JSON array of recommendations (or {recommendations:[...]}).",
      ].join("\n"),
      user: JSON.stringify({
        campaignId: input.campaignId,
        projectId: input.projectId,
        platformContext: input.platformContext,
        hypotheses: input.hypotheses ?? [],
        research: input.research ?? [],
        // Bounded, code-loaded Phase-1 remedy research. This exists even when
        // the model makes no read_developer_brief tool call of its own.
        developerBriefs,
        memory: input.memory ?? null,
        patternIds: agent.map((p) => p.id),
      }),
    });
  }

  async review(input: {
    campaignId: string;
    patterns: readonly Phase2Pattern[];
    hypotheses: readonly Phase2Hypothesis[];
    recommendations: readonly Phase2Recommendation[];
    platformFindings: readonly Phase2PlatformFinding[];
    memory: Phase2MemoryRecord | null;
    ctx?: Phase2BoardContext;
  }): Promise<Phase2Review> {
    if (input.recommendations.length === 0) return { keptIds: [], dropped: [], notes: "no recommendations" };
    const ctx = toolCtx(input.ctx, input.patterns, input.hypotheses);
    return runPhase2AgentLoop({
      gateway: this.gateway,
      attemptId: this.attemptId,
      node: "phase2",
      role: "reviewer",
      maxTurns: 16,
      tools: [...PHASE2_READ_TOOLS, submitTool("submit_review", "Submit {keptIds,dropped,notes} and end.")],
      execute: async (name, args) => {
        if (name === "submit_review") {
          const p = args.payload as Record<string, unknown>;
          return {
            text: "ok",
            done: {
              keptIds: Array.isArray(p.keptIds) ? p.keptIds as string[] : [],
              dropped: Array.isArray(p.dropped) ? p.dropped as { id: string; reason: string }[] : [],
              notes: String(p.notes ?? ""),
            } satisfies Phase2Review,
          };
        }
        return executePhase2Tool(ctx, name, args);
      },
      parseFinal: (content) => {
        const v = parseJson(content) as Record<string, unknown>;
        return {
          keptIds: Array.isArray(v.keptIds) ? v.keptIds as string[] : [],
          dropped: Array.isArray(v.dropped) ? v.dropped as { id: string; reason: string }[] : [],
          notes: String(v.notes ?? ""),
        };
      },
      system: [
        "You are the Phase-2 reviewer (Minos portfolio). You are AGENTIC: re-read evidence with tools before keeping a rec.",
        "Drop a rec if it blames the agent for a platform defect, ignores an empty workspace or verifier crash, or was rejected in memory.",
        "Keep recs grounded in evidence and honest about uncertainty.",
        "When done, call submit_review with {keptIds, dropped:[{id,reason}], notes}.",
      ].join("\n"),
      user: JSON.stringify({
        campaignId: input.campaignId,
        recommendations: input.recommendations,
        hypotheses: input.hypotheses,
        platformFindings: input.platformFindings,
        memory: input.memory,
      }),
    });
  }
}

/** Wrap a designer-only analyst so tests that stub recommend still run the campaign. */
export function designerOnlyBoard(analyst: Phase2Analyst): Phase2Board {
  return {
    async investigate({ patterns }) {
      return patterns
        .filter((p) => p.owner === "agent" || p.owner === "mixed")
        .map((p) => ({
          id: `HYP-${p.id}`,
          patternId: p.id,
          claim: p.summary,
          supportingObservations: p.evalIds,
          contradictingObservations: [],
          likelyMechanism: [p.summary.slice(0, 200)],
          confidence: "medium" as const,
        }));
    },
    async research() { return []; },
    recommend: (input) => analyst.recommend(input),
    async review({ recommendations }) {
      return { keptIds: recommendations.map((r) => r.id), dropped: [], notes: "designer-only board (no live review)" };
    },
  };
}

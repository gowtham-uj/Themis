/** Agentic black-box hypothesis/recommendation interface and real gateway adapter. */
import type {ModelGateway} from "../gateway/client.js";
import {chatJsonObject} from "../gateway/structured.js";
import type {
  Phase2Hypothesis, Phase2MemoryRecord, Phase2Pattern, Phase2Recommendation, Phase2ResearchNote,
} from "./types.js";

export interface Phase2RecommendInput {
  campaignId: string;
  projectId: string;
  patterns: readonly Phase2Pattern[];
  platformContext: {
    platformFailures: number;
    rewardNotAttributable: number;
    platformFaults: readonly string[];
  };
  hypotheses?: readonly Phase2Hypothesis[];
  research?: readonly Phase2ResearchNote[];
  memory?: Phase2MemoryRecord | null;
  ctx?: { viewDirs: Readonly<Record<string, string>>; cases: readonly import("./types.js").Phase2Case[] };
}

export interface Phase2Analyst {
  recommend(input: Phase2RecommendInput): Promise<Phase2Recommendation[]>;
}

const classes = ["direct_fix", "research_backed", "experimental"];
const priorities = ["P0", "P1", "P2", "P3"];
const levels = ["high", "medium", "low"];

function toStrList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.trim());
  const s = String(v ?? "").trim();
  // Semicolon/newline-separated prose ("a; b; c") from the PI designer.
  if (!s) return [];
  return s.split(/[;\n]/).map((p) => p.trim()).filter((p) => p.length > 0);
}

function normConfidence(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  // Conservative on mixed qualifiers: "medium-high" → medium.
  if (s.includes("low")) return "low";
  if (s.includes("medium")) return "medium";
  if (s.includes("high")) return "high";
  return "medium";
}

function normEvidenceLevel(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  if (s.includes("research")) return "research_supported";
  if (s.includes("mechanis")) return "mechanistically_supported";
  if (s.includes("experiment")) return "experiment_proposed";
  return "observational";
}

/** Coerce model drift (recommendationId→id, verdict-style review, free-text enums). */
export function coerceRecommendations(v: unknown): unknown {
  const raw = Array.isArray(v)
    ? v
    : (v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).recommendations)
      ? (v as Record<string, unknown>).recommendations as unknown[]
      : null);
  if (!raw) return [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const x = item as Record<string, unknown>;
    // PI designer files `recommendationId`; host canonical is `id`.
    if (typeof x.id !== "string" && typeof x.recommendationId === "string") x.id = x.recommendationId;
    if (!classes.includes(String(x.class))) {
      const c = String(x.class ?? "").toLowerCase();
      x.class = c.includes("research") ? "research_backed" : c.includes("experiment") ? "experimental" : "direct_fix";
    }
    if (!priorities.includes(String(x.priority))) x.priority = "P2";
    x.confidence = normConfidence(x.confidence);
    x.evidenceLevel = normEvidenceLevel(x.evidenceLevel);
    const rawBasis = Array.isArray(x.researchBasis) ? x.researchBasis : [];
    x.researchBasis = rawBasis.flatMap((entry) => {
      if (typeof entry === "string") {
        const url = entry.replace(/^web:/, "").trim();
        return /^https?:\/\//.test(url) ? [{url, claim: ""}] : [];
      }
      if (!entry || typeof entry !== "object") return [];
      const b = entry as Record<string, unknown>;
      const url = String(b.url ?? b.source ?? "").replace(/^web:/, "").trim();
      if (!/^https?:\/\//.test(url)) return [];
      return [{url, claim: String(b.claim ?? "")}];
    });
    x.implementationRequirements = Array.isArray(x.implementationRequirements)
      ? x.implementationRequirements
      : [String(x.implementationRequirements ?? "")].filter((t) => t);
    x.risks = Array.isArray(x.risks) ? x.risks : [String(x.risks ?? "")].filter((t) => t);
    if (!Array.isArray(x.patternIds)) x.patternIds = typeof x.patternIds === "string" ? [x.patternIds] : [];
    if (typeof x.targetCapability !== "string") x.targetCapability = String(x.target ?? "unspecified");
    const h = (x.implementationHandoff && typeof x.implementationHandoff === "object")
      ? x.implementationHandoff as Record<string, unknown>
      : {};
    h.targetCapability = String(h.targetCapability ?? x.targetCapability ?? "unspecified");
    h.observedInterface = String(h.observedInterface ?? "unspecified");
    // PI files these as block-scalar strings or arrays; preserve both forms.
    h.likelyInternalAreas = toStrList(h.likelyInternalAreas);
    h.requiredBehavior = toStrList(h.requiredBehavior);
    h.themisKnowsExactSourceLocation = false;
    x.implementationHandoff = h;
    const p = (x.experimentPlan && typeof x.experimentPlan === "object")
      ? x.experimentPlan as Record<string, unknown>
      : {};
    p.id = String(p.id ?? `EXP-${String(x.id ?? "unknown")}`);
    p.claimToTest = String(p.claimToTest ?? "");
    p.control = String(p.control ?? "");
    p.treatment = String(p.treatment ?? "");
    p.constants = toStrList(p.constants);
    p.targetTasks = toStrList(p.targetTasks);
    p.regressionTasks = toStrList(p.regressionTasks);
    p.secondaryMetrics = toStrList(p.secondaryMetrics);
    p.successConditions = toStrList(p.successConditions);
    const primary = (p.primaryMetric && typeof p.primaryMetric === "object")
      ? p.primaryMetric as Record<string, unknown>
      : {};
    p.primaryMetric = {
      name: String(primary.name ?? "unspecified"),
      minimumWorthwhileEffect: String(primary.minimumWorthwhileEffect ?? "unspecified"),
    };
    p.regressionLimits = p.regressionLimits && typeof p.regressionLimits === "object" && !Array.isArray(p.regressionLimits)
      ? p.regressionLimits
      : {policy: String(p.regressionLimits ?? "")};
    const sample = (p.suggestedSample && typeof p.suggestedSample === "object")
      ? p.suggestedSample as Record<string, unknown>
      : {};
    p.suggestedSample = {
      tasks: Math.max(1, Number(sample.tasks ?? 1) || 1),
      seedsPerTask: Math.max(1, Number(sample.seedsPerTask ?? p.seedsPerTask ?? 1) || 1),
    };
    x.experimentPlan = p;
    if (x.class === "research_backed" && !(x.researchBasis as unknown[]).length) x.class = "direct_fix";
  }
  return raw;
}

/** Normalize a reviewer's `decisions` list into {keptIds, dropped, notes}. */
export function coerceReview(v: unknown, fallbackIds: string[]): { keptIds: string[]; dropped: { id: string; reason: string }[]; notes: string } {
  const doc = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const decisions = Array.isArray(doc.decisions)
    ? doc.decisions as Record<string, unknown>[]
    : null;
  if (!decisions) {
    return {
      keptIds: Array.isArray(doc.keptIds) ? doc.keptIds.map(String) : fallbackIds,
      dropped: Array.isArray(doc.dropped) ? doc.dropped as { id: string; reason: string }[] : [],
      notes: String(doc.notes ?? ""),
    };
  }
  const kept: string[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const d of decisions) {
    const id = String(d.recommendationId ?? d.id ?? "");
    const verdict = String(d.verdict ?? "").toUpperCase();
    if (verdict.startsWith("KEEP")) kept.push(id);
    else dropped.push({ id, reason: String(d.rationale ?? d.reason ?? "") });
  }
  return { keptIds: kept, dropped, notes: String(doc.notes ?? "") };
}

/** Validate and normalize a model-authored recommendation list. */
export function validateRecommendations(v: unknown): string | null {
  v = coerceRecommendations(v);
  if (!Array.isArray(v)) return "root must be an array";
  for (let i = 0; i < v.length; i++) {
    const x = v[i] as Record<string, unknown>;
    if (!x || typeof x !== "object") return `recommendation ${i} must be object`;
    for (const k of [
      "id", "patternIds", "class", "priority", "targetCapability", "observedBehavior",
      "likelyMechanism", "implementationRequirements", "implementationHandoff", "risks",
      "researchBasis", "experimentPlan", "confidence", "evidenceLevel",
    ]) {
      if (!(k in x)) return `recommendation ${i} missing ${k}`;
    }
    if (!classes.includes(String(x.class))) return `bad class ${String(x.class)}`;
    if (!priorities.includes(String(x.priority))) return `bad priority ${String(x.priority)}`;
    if (!levels.includes(String(x.confidence))) return `bad confidence`;
    if (String(x.class) === "research_backed" && !(Array.isArray(x.researchBasis) && (x.researchBasis as unknown[]).length > 0)) {
      return `recommendation ${i} claims research_backed with empty researchBasis`;
    }
    for (const [j, basis] of ((x.researchBasis as unknown[]) ?? []).entries()) {
      if (!basis || typeof basis !== "object") return `recommendation ${i} researchBasis ${j} must be object`;
      const b = basis as Record<string, unknown>;
      if (typeof b.url !== "string" || !/^https?:\/\//.test(b.url)) return `recommendation ${i} researchBasis ${j} has invalid url`;
      if (typeof b.claim !== "string") return `recommendation ${i} researchBasis ${j} claim must be string`;
    }
    const h = x.implementationHandoff as Record<string, unknown> | undefined;
    if (!h || typeof h !== "object" || !h.targetCapability || !h.observedInterface || !Array.isArray(h.likelyInternalAreas) || !Array.isArray(h.requiredBehavior)) {
      return `recommendation ${i} invalid implementationHandoff`;
    }
    if (h.themisKnowsExactSourceLocation !== false) {
      return `recommendation ${i} must set themisKnowsExactSourceLocation:false`;
    }
    const p = x.experimentPlan as Record<string, unknown>;
    if (!p || typeof p !== "object" || !p.control || !p.treatment || !p.primaryMetric || !Array.isArray(p.successConditions)) {
      return `recommendation ${i} invalid experimentPlan`;
    }
  }
  return null;
}

/** Real DeepSeek/OpenAI-compatible analyst; receives evidence-backed patterns only. */
export class GatewayPhase2Analyst implements Phase2Analyst {
  constructor(private gateway: ModelGateway, private attemptId: string) {}

  async recommend(input: Phase2RecommendInput): Promise<Phase2Recommendation[]> {
    const agentPatterns = input.patterns.filter((p) => p.owner === "agent" || p.owner === "mixed");
    if (agentPatterns.length === 0) return [];

    const { value } = await chatJsonObject(this.gateway, {
      attemptId: this.attemptId,
      node: "phase2",
      metricOrRole: "improvement_designer",
      maxTokens: 8192,
      messages: [
        {
          role: "system",
          content: [
            "You design black-box agent improvement handoffs for the DEVELOPER OF THE TESTED AGENT.",
            "You NEVER access or patch agent source and NEVER claim an experiment was run.",
            "",
            "RULES:",
            "1. Recommend ONLY on agent-owned patterns. Ignore harness-owned patterns.",
            "2. Ground every recommendation in evidence and in the investigator hypotheses when provided.",
            "3. researchBasis MUST be empty unless a real URL was actually retrieved: one from the campaign research notes, or a web: source in a case's Phase-1 developer brief (read_developer_brief). class research_backed requires a non-empty researchBasis.",
            "4. If rewards were NOT attributable, do NOT use pass_rate as the primary metric; use process metrics. Do not recommend fixing the verifier as an agent change.",
            "5. Skip any recommendation id listed in memory.rejectedRecommendationIds.",
            "6. implementationHandoff.themisKnowsExactSourceLocation MUST be false. likelyInternalAreas are navigation hints, not file claims.",
            "7. experimentPlan is a DEVELOPER-RUN preregistered plan.",
            "8. Return a JSON ARRAY. If nothing warrants a recommendation, return [].",
            "",
            "Shape: id, patternIds[], class, priority, targetCapability, observedBehavior, likelyMechanism, implementationRequirements[], implementationHandoff{targetCapability,observedInterface,likelyInternalAreas[],requiredBehavior[],themisKnowsExactSourceLocation:false}, risks[], researchBasis[{url,claim}], confidence, evidenceLevel, experimentPlan{id,claimToTest,control,treatment,constants[],targetTasks[],regressionTasks[],primaryMetric{name,minimumWorthwhileEffect},secondaryMetrics[],regressionLimits,suggestedSample{tasks,seedsPerTask},successConditions[]}.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            campaignId: input.campaignId,
            projectId: input.projectId,
            platformContext: input.platformContext,
            patterns: agentPatterns,
            hypotheses: input.hypotheses ?? [],
            research: input.research ?? [],
            memory: input.memory ?? null,
          }),
        },
      ],
      validate: validateRecommendations,
    });
    return coerceRecommendations(value) as Phase2Recommendation[];
  }
}

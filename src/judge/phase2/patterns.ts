/** Deterministic observation extraction and per-eval pattern aggregation. */
import {classifySignatures, type FindingSignature} from "../validity/signatures.js";
import type {FailureOwner, Phase2Case, Phase2Observation, Phase2Pattern} from "./types.js";

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Platform-owned signatures: never attributed to the agent. */
function isPlatformSignature(s: FindingSignature): boolean {
  return (
    s === "INFRA_SETUP_FAILURE" ||
    s === "METRIC_ATTRIBUTION_ERROR" ||
    s === "HARNESS_LIFECYCLE_ARTIFACT" ||
    s === "VERIFIER_ON_WRONG_TREE"
  );
}

/** Signature → who owns the behavior it describes. */
function ownerFor(s: FindingSignature, fallback: FailureOwner): FailureOwner {
  if (isPlatformSignature(s)) return "eval_harness";
  return fallback;
}

/**
 * Extract observations for agent-pattern mining.
 *
 * Agent observations come from minos's IMPROVEMENTS list — the developer-facing
 * items the judge wrote about what THIS agent should change. The narrative is
 * NOT keyword-matched: it interleaves agent and verifier prose, so matching it
 * produced false attributions (e.g. "python3: command not found" from the
 * VERIFIER was filed as the agent's INTERPRETER_ASSUMPTION). Platform defects
 * are detected deterministically in {@link loadPhase2Case} and reported as
 * platform findings, not as agent observations.
 */
export function extractObservations(cases: readonly Phase2Case[]): Phase2Observation[] {
  const out: Phase2Observation[] = [];
  for (const c of cases) {
    if (!c.validForAgentLearning) continue;
    const items = c.improvements.filter((x) => typeof x === "object" && x !== null);
    const sources: Array<{ text: string; refs: string[]; owner: FailureOwner }> = [];
    for (const it of items) {
      const issue = String((it as Record<string, unknown>).issue ?? "");
      const rec = String((it as Record<string, unknown>).recommendation ?? "");
      const text = `${issue}\n${rec}`.trim();
      if (!text) continue;
      const refs: string[] = [];
      if (Array.isArray((it as Record<string, unknown>).evidence)) {
        for (const e of (it as Record<string, unknown>).evidence as Record<string, unknown>[]) {
          if (typeof e?.ref === "string") refs.push(e.ref);
        }
      }
      sources.push({ text, refs, owner: "agent" });
    }
    if (sources.length === 0 && c.narrative.trim()) {
      // No minos improvements: fall back to the narrative. The narrative
      // describes the AGENT's behavior; platform signatures are still re-mapped
      // to eval_harness by ownerFor, so a verifier/harness mention never lands
      // in the agent patterns.
      sources.push({ text: c.narrative, refs: [], owner: "agent" });
    }
    const seen = new Set<string>();
    for (const src of sources) {
      for (const sig of classifySignatures(src.text)) {
        if (sig === "UNCLASSIFIED" || seen.has(sig)) continue;
        seen.add(sig);
        out.push({
          id: `${c.runId}:${sig}`,
          evalId: c.runId,
          signature: sig,
          owner: ownerFor(sig, src.owner),
          summary: src.text.slice(0, 500),
          refs: src.refs,
          reward: c.reward,
          rewardAttributable: c.rewardAttributable,
          tokens: c.tokens,
          wallTimeMs: c.wallTimeMs,
          toolCalls: c.toolCalls,
          cohort: c.cohort ?? { language: "unknown", category: "unknown", profile: "unknown", model: "unknown" },
        });
      }
    }
  }
  return out;
}

function registryStatus(signature: FindingSignature, frequency: number): Phase2Pattern["registryStatus"] {
  if (signature === "UNCLASSIFIED") return "candidate";
  if (frequency >= 3) return "canonical";
  if (frequency >= 2) return "provisional";
  return "candidate";
}

function cohortKey(c: { language: string; category: string; profile: string; model: string }): string {
  return `${c.language}|${c.category}|${c.profile}|${c.model}`;
}

/** Aggregate one occurrence per signature per eval (never per repeated finding). */
export function aggregatePatterns(obs: readonly Phase2Observation[]): Phase2Pattern[] {
  const m = new Map<FindingSignature, Phase2Observation[]>();
  for (const o of obs) {
    const a = m.get(o.signature) ?? [];
    a.push(o);
    m.set(o.signature, a);
  }
  const out: Phase2Pattern[] = [];
  for (const [signature, rows] of m) {
    const ids = [...new Set(rows.map((x) => x.evalId))];
    const one = ids.map((id) => rows.find((x) => x.evalId === id)!);
    const nums = one.map((x) => x.tokens).filter((x): x is number => x !== null);
    const owners = new Set(one.map((x) => x.owner));
    const owner: FailureOwner | "mixed" =
      owners.size === 1 ? [...owners][0]! : "mixed";
    // Count pass/fail ONLY on attributable rewards. A verifier crash / empty
    // workspace makes reward=0 an infrastructure artifact — never an agent
    // "failure" in the pattern catalog (observed live: both evals scored 0 via
    // verifier crash and were wrongly counted as failed agent patterns).
    const attributable = one.filter((x) => x.rewardAttributable);
    const passed = attributable.filter((x) => x.reward === 1).length;
    const failed = attributable.filter((x) => x.reward === 0).length;
    const unattributable = one.length - attributable.length;
    // A "silent weakness" is an agent-owned weakness present in a run that still
    // passed (reward=1) — the failure that a regression experiment must not
    // re-introduce. Harness-owned observations are never silent agent weaknesses.
    const silentWeaknesses = attributable.filter((x) => x.owner === "agent" && x.reward === 1).length;
    const evidence = one.map((x) => ({
      evalId: x.evalId,
      summary: x.summary.slice(0, 400),
      refs: x.refs,
    }));
    const ownerWord = owner === "eval_harness" ? "platform/harness" : owner === "mixed" ? "mixed" : "agent";
    out.push({
      id: `PAT-${signature}`,
      signature,
      owner,
      evalIds: ids,
      frequency: ids.length,
      passed,
      failed,
      unattributable,
      averageTokens: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
      silentWeaknesses,
      evidence,
      summary: `${signature} (owner: ${ownerWord}) in ${ids.length} valid eval(s): ${one
        .map((x) => x.summary.replace(/\s+/g, " ").slice(0, 160))
        .join(" || ")}`,
      registryStatus: registryStatus(signature, ids.length),
      cohorts: (() => {
        const g = new Map<string, { count: number; passed: number; failed: number; unattributable: number }>();
        for (const x of one) {
          const k = cohortKey(x.cohort);
          const cur = g.get(k) ?? { count: 0, passed: 0, failed: 0, unattributable: 0 };
          cur.count += 1;
          if (!x.rewardAttributable) cur.unattributable += 1;
          else if (x.reward === 1) cur.passed += 1;
          else if (x.reward === 0) cur.failed += 1;
          g.set(k, cur);
        }
        return [...g.entries()].map(([key, v]) => ({ key, ...v }));
      })(),
    });
  }
  return out.sort((a, b) => b.frequency - a.frequency || a.signature.localeCompare(b.signature));
}

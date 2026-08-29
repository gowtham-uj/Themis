/**
 * Shape-agnostic projection of `minos-report.yaml` content.
 *
 * Minos's committed report has appeared in three shapes across the project's
 * life, and the final `evalJudge.yaml` must be a byte-for-byte projection of
 * whatever shape was actually written:
 *
 *   A. template-3 nested  `rulings.approach.{verdict, justification}`,
 *      `findings: ["F1: …"]`, string-list `improvements`, block `still_open`.
 *   B. flat `*_ruling`   `approach` / `approach_ruling`, object
 *      `improvements[]`, `still_open[]`, `limitations`.
 *   C. full evalJudge    `verdict:{approach,integrity,competence,reconciliation}`,
 *      `narrative`, `integrity_summary`, `reward_reconciliation`,
 *      `open_questions[]`, `confidence_basis`, `confidence_in_this_report`.
 *
 * Both the mechanical assembler (`assemble-eval-judge.ts`) and the gate's fact
 * extractor (`archive-facts.ts`) resolve fields through THIS module, so they
 * can never disagree about what minos committed — which is exactly what
 * `b-verbatim-assembly` checks.
 */

import { parseAllDocuments } from "yaml";

/** One minos report document (a per-round mapping from an append-only stream). */
export interface MinosDoc {
  readonly [key: string]: unknown;
}

export function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join("\n");
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

export function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Read an append-only multi-document YAML stream into its mappings, in order. */
export function yamlStream(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    for (const doc of parseAllDocuments(text)) {
      const v = doc.toJS() as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>);
      }
    }
  } catch {
    /* malformed stream contributes nothing */
  }
  return out;
}

/** The frozen ref grammar (report-templates.md #4 / tools REF_RE). */
const REF_RE =
  /^(tool_call:.+|diff:[^#]+#\d+|file:[^#]+#L\d+-L\d+|verifier:\d+|report:(kratos|logos|minos)#round\d+|scratchpad:[A-Za-z0-9._-]+|web:https?:\/\/.+|trace:[^\s:]+:seq:\d+|artifact:[^#\s]+#\/\S+|source:[^#\s]+#symbol=\S+|metric:\S+)$/;

/** Keep a ref verbatim only when it matches the frozen grammar; else null. */
export function validRef(v: unknown): string | null {
  return typeof v === "string" && REF_RE.test(v) ? v : null;
}

/**
 * Evidence `.report` is a REPORT ref (`report:logos#round1`), but minos has
 * written the bare agent name (`logos`). Normalize to the report ref for the
 * document's own round rather than dropping the evidence.
 */
export function reportRefOf(v: unknown, round: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (/^(kratos|logos|minos)$/.test(s)) return `report:${s}#round${round}`;
  return validRef(s);
}

/**
 * The evalJudge template's `why_unresolved` enum collapses minos's per-round
 * prose into three values. A question only another investigator could settle is
 * `failed_triage`; anything the archive cannot answer (platform-side,
 * unarchived, host access) is `unsolvable_from_record`.
 */
export function whyUnresolvedOf(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (/(further investigation|another round|a kratos|a logos|investigator could)/.test(s)) return "failed_triage";
  return "unsolvable_from_record";
}

/** Map any host-supplied closure reason onto the frozen enum. */
export function closedByOf(v: string): string {
  if (v === "no_new_tangents" || v === "triage_exhausted" || v === "round_ceiling") return v;
  // "convergence" is the legacy host value for a converged close with no
  // remaining tangent worth running.
  return "no_new_tangents";
}

/** The competence score minos actually committed, or null when it never wrote one. */
export function competenceScoreOf(doc: MinosDoc): number | null {
  const v = obj(doc.verdict); // Shape C
  const ruling = obj(doc.rulings); // Shape A
  const raw = doc.competence ?? v?.competence ?? obj(ruling?.competence)?.score;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : null;
}

/** The verdict scalars across every shape (defaults are NOT minos verdicts). */
export function verdictOf(doc: MinosDoc): {
  approach: string;
  integrity: string;
  competence: number;
  reconciliation: string;
} {
  const v = obj(doc.verdict); // Shape C
  const ruling = obj(doc.rulings); // Shape A
  const approach = str(doc.approach ?? v?.approach ?? obj(ruling?.approach)?.verdict ?? "");
  const integrity = str(doc.integrity ?? v?.integrity ?? obj(ruling?.integrity)?.verdict ?? "");
  const reconciliation = str(doc.reconciliation ?? v?.reconciliation ?? obj(ruling?.reconciliation)?.verdict ?? "");
  return {
    approach,
    integrity,
    competence: competenceScoreOf(doc) ?? 1,
    reconciliation,
  };
}

/**
 * The canonical narrative join for the flat `*_ruling` / `*_reasoning` and
 * template-3 nested shapes. Shape C (top-level `narrative`) is NOT this join —
 * see `narrativeOf`.
 */
export function canonicalNarrativeJoin(doc: MinosDoc): string {
  const flat = [
    doc.approach_ruling ?? doc.approach_reasoning,
    doc.integrity_ruling ?? doc.integrity_reasoning,
    doc.competence_ruling ?? doc.competence_reasoning,
    doc.reconciliation_ruling ?? doc.reconciliation_reasoning,
  ];
  const ruling = obj(doc.rulings);
  const nested = ruling
    ? [ruling.approach, ruling.integrity, ruling.competence, ruling.reconciliation].map(
        (r) => obj(r)?.justification,
      )
    : [];
  return [...flat, ...nested].map(str).filter((s) => s.trim().length > 0).join("\n\n");
}

/** The narrative text minos committed, whichever shape carried it. */
export function narrativeOf(doc: MinosDoc): string {
  const top = str(doc.narrative ?? "");
  if (top.trim()) return top; // Shape C
  return canonicalNarrativeJoin(doc) || str(doc.case_completeness ?? "");
}

/** The reward-reconciliation text minos committed, whichever shape carried it. */
export function rewardReconciliationOf(doc: MinosDoc, verdict: { reconciliation: string }): string {
  const top = str(doc.reward_reconciliation ?? "");
  if (top.trim()) return top; // Shape C
  const flat = str(doc.reconciliation_ruling ?? obj(obj(doc.rulings)?.reconciliation)?.justification ?? "");
  if (flat.trim()) return flat; // Shapes B / A
  return verdict.reconciliation ? `reconciliation: ${verdict.reconciliation}` : "";
}

/** The confidence-basis text minos committed, whichever shape carried it. */
export function confidenceBasisOf(doc: MinosDoc): string {
  const top = str(doc.confidence_basis ?? "");
  if (top.trim()) return top; // Shape C
  const limitations = str(doc.limitations ?? "");
  if (limitations.trim()) return limitations; // Shape B
  // A round-only minos report carries neither field. The final report must
  // still copy a COMMITTED minos source — never host-authored filler — so fall
  // back to the committed narrative (the same projection the gate extractor
  // records as a minos source, so b-verbatim-assembly still matches).
  return narrativeOf(doc);
}

/** The confidence minos committed, or a derived value (the gate allows this). */
export function confidenceOf(
  doc: MinosDoc,
  verdict: { integrity: string; competence: number },
): "high" | "medium" | "low" {
  const c = str(doc.confidence_in_this_report ?? "").toLowerCase();
  if (c === "high" || c === "medium" || c === "low") return c;
  if (verdict.integrity === "clean" && verdict.competence >= 4) return "high";
  if (verdict.integrity === "violation" || verdict.competence <= 2) return "low";
  return "medium";
}

/** The integrity summary minos committed, projected into the frozen shape. */
export function integritySummaryOf(
  doc: MinosDoc,
  verdict: { integrity: string },
): { verdict: string; findings: Array<Record<string, unknown>> } {
  const sum = obj(doc.integrity_summary); // Shape C
  const project = (item: unknown): { finding: string; ref: string | null; round: number } => {
    const o = obj(item);
    return {
      finding: str(o?.finding ?? o?.statement ?? ""),
      ref: validRef(o?.ref),
      round: typeof o?.round === "number" ? (o!.round as number) : 1,
    };
  };
  if (sum !== null) {
    return {
      verdict: str(sum.verdict ?? verdict.integrity),
      findings: arr(sum.findings).map(project).filter((f) => f.finding.length > 0),
    };
  }
  return {
    verdict: verdict.integrity,
    findings: arr(doc.integrity_findings).map(project).filter((f) => f.finding.length > 0),
  };
}

/** The open questions minos committed, projected into the frozen shape. */
export function openQuestionsOf(doc: MinosDoc): Array<{
  question: string;
  why_unresolved: string;
  what_would_settle_it: string;
}> {
  const cq = arr(doc.open_questions); // Shape C
  if (cq.length > 0) {
    return cq.map((item) => {
      const o = obj(item);
      return {
        question: str(o?.question ?? ""),
        why_unresolved: whyUnresolvedOf(o?.why_unresolved),
        what_would_settle_it: str(o?.what_would_settle_it ?? ""),
      };
    });
  }
  const so = arr(doc.still_open); // Shape B
  return so.map((item) => {
    const o = obj(item);
    // Minos has written `would_it_change_ruling` where the frozen template says
    // `what_would_settle_it`; project the committed text rather than an empty
    // string, which the gate would read as host-authored filler.
    const settle = o?.what_would_settle_it ?? o?.would_it_change_ruling ?? o?.would_it_change_the_ruling;
    return {
      question: str(o?.question ?? ""),
      why_unresolved: whyUnresolvedOf(o?.why_unresolved),
      what_would_settle_it: str(settle ?? ""),
    };
  });
}

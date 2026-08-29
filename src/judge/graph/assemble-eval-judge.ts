/**
 * WP-10 final assembly — enforced in code, not left to the model.
 *
 * Locked rule (themis-orchestrator.md): the orchestrator ASSEMBLES
 * `judge/evalJudge.yaml` from minos's committed rulings VERBATIM and contributes
 * only the case record it alone holds — `rounds_run`, `closed_by`, `converged`,
 * coverage counts, and declined-tangent facts. Every verdict, justification,
 * strength, improvement, integrity finding, and open question must be a
 * byte-for-byte copy of text minos actually committed; the host must never
 * author or rewrite a word of judgement.
 *
 * The live courtroom proved why this must be a code path rather than an
 * instruction: the orchestrator paraphrased minos's prose. So this module is the
 * AUTHORITATIVE projector. Field resolution goes through
 * `minos-projection.ts`, which understands all three minos report shapes seen in
 * practice, so an older or differently-shaped ruling still projects verbatim.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";

import { classifyEvalValidity } from "../validity/classify.js";
import {
  arr,
  closedByOf,
  confidenceBasisOf,
  confidenceOf,
  integritySummaryOf,
  narrativeOf,
  obj,
  openQuestionsOf,
  reportRefOf,
  rewardReconciliationOf,
  str,
  validRef,
  verdictOf,
  yamlStream,
  type MinosDoc,
} from "../quality/minos-projection.js";

async function readIf(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** The official reward as recorded by the sealed verifier, not by the court. */
async function readOfficialReward(archiveDir: string | undefined): Promise<number | null> {
  if (!archiveDir) return null;
  const { readdir } = await import("node:fs/promises");
  const { join: pj } = await import("node:path");
  let entries: string[] = [];
  try {
    entries = await readdir(pj(archiveDir, "verifier_res"));
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const text = await readIf(pj(archiveDir, "verifier_res", name));
    if (!text) continue;
    try {
      const o = JSON.parse(text) as { officialReward?: unknown; reward?: unknown };
      const value = typeof o.officialReward === "number" ? o.officialReward : o.reward;
      if (typeof value === "number") return value;
    } catch {
      /* not the verifier result */
    }
  }
  return null;
}

/** The evaluated agent id, from the sealed run record (never authored by the court). */
async function readAgentId(archiveDir: string | undefined): Promise<string | null> {
  if (!archiveDir) return null;
  const text = await readIf(join(archiveDir, "eval_lifecycle_logs", "run.json"));
  if (!text) return null;
  try {
    const o = JSON.parse(text) as { agentId?: unknown; agent_id?: unknown };
    const id = o.agentId ?? o.agent_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** The strengths/improvements minos committed, aggregated across rounds. */
function minosDeliverables(docs: Array<Record<string, unknown>>): {
  whatTheyDidWell: Array<Record<string, unknown>>;
  improvements: Array<Record<string, unknown>>;
} {
  const whatTheyDidWell: Array<Record<string, unknown>> = [];
  const improvements: Array<Record<string, unknown>> = [];
  const seenImprovements = new Set<string>();

  for (const d of docs) {
    const m = d as MinosDoc;
    const round = typeof m.round === "number" && Number.isInteger(m.round) ? m.round : 1;
    for (const item of arr(m.what_the_agent_did_well)) {
      const o = obj(item);
      if (!o || typeof o.observation !== "string") continue;
      whatTheyDidWell.push({ observation: o.observation, ref: validRef(o.ref) });
    }
    // Earlier template-3 shape: strengths filed as `findings` lines prefixed
    // `F<n>:` and improvements as a string list.
    for (const item of arr(m.findings)) {
      if (typeof item !== "string") continue;
      if (/^F\d+:\s*/.test(item)) whatTheyDidWell.push({ observation: item, ref: null });
    }
    const improveItems: unknown[] = arr(m.improvements).length > 0
      ? arr(m.improvements)
      : typeof m.improvements === "string"
        ? (m.improvements as string).split("\n").filter((l) => l.trim().length > 0)
        : [];
    for (const item of improveItems) {
      const o = obj(item);
      const issue = o ? str(o.issue) : str(item);
      if (!issue || seenImprovements.has(issue)) continue;
      seenImprovements.add(issue);
      if (o) {
        const evidence = arr(o.evidence)
          .map((ev) => obj(ev))
          .filter((ev): ev is Record<string, unknown> => ev !== null)
          .map((ev) => ({ report: reportRefOf(ev.report, round), ref: validRef(ev.ref) }));
        improvements.push({ ...o, evidence });
      } else {
        improvements.push({
          issue,
          evidence: [],
          recommendation: issue,
          category: "process",
          impact: "medium",
          confidence: "high",
        });
      }
    }
  }
  return { whatTheyDidWell, improvements };
}

/** Case record from the orchestrator's committed log books. */
async function caseRecord(judgeDir: string, roundsRunFallback: number): Promise<{
  roundsRun: number;
  closedBy: string;
  converged: boolean;
  tangentsTotal: number;
  tangentsResolved: number;
  tangentsOpen: number;
  agentUnderEvaluation: string;
}> {
  const summary = await readIf(join(judgeDir, "case-summary.yaml"));
  const roundLog = await readIf(join(judgeDir, "round-log.yaml"));
  const tangentLog = await readIf(join(judgeDir, "tangent-log.yaml"));
  const tangentLogMd = await readIf(join(judgeDir, "tangent-log.md"));

  const summaryDocs = summary ? yamlStream(summary) : [];
  const roundDocs = roundLog ? yamlStream(roundLog) : [];
  const tangentDocs = tangentLog ? yamlStream(tangentLog) : [];

  const sum = summaryDocs.at(-1) ?? {};
  // Distinct committed rounds (a double-filed round section must not buy an
  // extra round).
  const distinctRounds = new Set<string>();
  for (const doc of roundDocs) {
    const r = doc.round;
    if (typeof r === "number" && Number.isInteger(r)) distinctRounds.add(String(r));
  }
  const roundsRun =
    typeof sum.rounds_run === "number"
      ? (sum.rounds_run as number)
      : distinctRounds.size || roundsRunFallback;
  const converged = sum.converged === true;

  // A tangent is OPEN only while work is still owed on it. `declined` is a
  // triage decision; `assigned`/resolved dispositions are closed. Only
  // `deferred` — work still pending — stays open. Tangents the orchestrator
  // filed in the scratchpad-style markdown log (`tangent-log.md`) count too —
  // ignoring them would report a case with logged tangents as empty.
  const mdTangents = (tangentLogMd?.match(/^##\s+(T-[A-Za-z0-9._-]+)/gm) ?? []).length;
  const tangentsTotal = Math.max(tangentDocs.length, mdTangents);
  const tangentsOpen = tangentDocs.filter((t) => str(t.disposition).toLowerCase() === "deferred").length;
  const tangentsResolved = Math.max(0, tangentsTotal - tangentsOpen);

  const allText = [str(sum.why_closed), str(roundDocs.at(-1)?.["continue_or_close"]), str(sum.how_the_case_ran)].join("\n");
  let closedBy = converged ? "no_new_tangents" : "round_ceiling";
  for (const candidate of ["triage_exhausted", "no_new_tangents", "round_ceiling"] as const) {
    if (allText.includes(candidate)) {
      closedBy = candidate;
      break;
    }
  }

  const agentUnderEvaluation = str(sum.agent ?? sum.agent_under_evaluation ?? "unknown");

  return { roundsRun, closedBy, converged, tangentsTotal, tangentsResolved, tangentsOpen, agentUnderEvaluation };
}

/**
 * Project minos's committed rulings into the frozen template-4 evalJudge.yaml.
 * Returns the written path, or null when minos never ruled.
 */
export async function assembleEvalJudge(input: {
  judgeDir: string;
  caseId: string;
  runId: string;
  archiveDir?: string;
  roundsRun: number;
  closedBy: string;
  converged: boolean;
  officialReward?: number | null;
  agentUnderEvaluation?: string | null;
}): Promise<string | null> {
  const minosRaw = await readIf(join(input.judgeDir, "minos-report.yaml"));
  if (minosRaw === null) return null;
  const minosDocs = yamlStream(minosRaw);
  if (minosDocs.length === 0) return null;

  const last = minosDocs.at(-1)!;
  const verdict = verdictOf(last);
  const deliverables = minosDeliverables(minosDocs);
  const integritySummary = integritySummaryOf(last, verdict);
  const openQuestions = openQuestionsOf(last);
  const record = await caseRecord(input.judgeDir, input.roundsRun);

  const officialReward = input.officialReward ?? (await readOfficialReward(input.archiveDir));

  const agentUnderEvaluation =
    (input.agentUnderEvaluation ?? record.agentUnderEvaluation) !== "unknown"
      ? (input.agentUnderEvaluation ?? record.agentUnderEvaluation)
      : ((await readAgentId(input.archiveDir)) ?? "unknown");

  // WP-13 validity gate: a run where the harness failed before the agent phase
  // must NOT score the agent. The deterministic classifier decides this; when
  // it says "agent never executed", the verdict is projected to the
  // non-attributable shape (competence null, approach not_observed, integrity
  // not_applicable) and `eval_validity` is stamped for Phase-2 routing.
  const validity = input.archiveDir ? await classifyEvalValidity(input.archiveDir) : null;
  const attributable = validity === null || validity.valid_for_agent_learning;

  const doc: Record<string, unknown> = {
    final_report: true,
    eval_id: input.runId,
    agent_under_evaluation: agentUnderEvaluation,
    rounds_run: record.roundsRun,
    official_reward: officialReward,
    ...(validity !== null ? { eval_validity: validity } : {}),
    verdict: attributable
      ? {
          approach: verdict.approach || "insufficient_evidence",
          integrity: verdict.integrity || "insufficient_evidence",
          competence: verdict.competence,
          reconciliation: verdict.reconciliation || "unexplained",
        }
      : {
          approach: "not_observed",
          integrity: "not_applicable",
          competence: null,
          reconciliation: verdict.reconciliation || "unexplained",
        },
    narrative: narrativeOf(last) || "(the committed minos ruling carried no narrative prose)",
    what_the_agent_did_well: attributable ? deliverables.whatTheyDidWell : [],
    improvements: attributable ? deliverables.improvements : [],
    integrity_summary: attributable
      ? integritySummary
      : { verdict: "not_applicable", findings: [] },
    reward_reconciliation: rewardReconciliationOf(last, verdict),
    case_coverage: {
      tangents_total: record.tangentsTotal,
      tangents_resolved: record.tangentsResolved,
      tangents_open: record.tangentsOpen,
      closed_by: closedByOf(input.closedBy ?? record.closedBy),
      converged: input.converged ?? record.converged,
    },
    open_questions: attributable ? openQuestions : [],
    revision_history: [],
    confidence_in_this_report: confidenceOf(last, verdict),
    confidence_basis: confidenceBasisOf(last),
  };

  await mkdir(input.judgeDir, { recursive: true });
  const out = join(input.judgeDir, "evalJudge.yaml");
  await writeFile(out, stringify(doc, { lineWidth: 0 }));
  return out;
}

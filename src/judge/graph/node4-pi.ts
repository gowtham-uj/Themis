/**
 * Node 4 — the real PI courtroom.
 *
 * One `pi` process runs the themis-orchestrator system prompt (locked draft),
 * with pi-subagents + pi-dynamic-workflows loaded, so the orchestrator spawns
 * real kratos/logos/minos subagents (project `.pi/agents/*.md`) via the
 * subagent tool — not role-labeled calls in the host process.
 *
 * The connection object is the same saved proxy the eval runner uses.
 */

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadPromptAsset,
  PI_CHILD_RESUME_MANIFEST,
  PI_RESUME_POINTER,
  runPiOrchestrator,
  writePiSubagentDefs,
  type PiConnection,
  type PiRunResult,
} from "../pi/runtime.js";
import { judgeMode, type JudgeMode } from "../config/mode.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

/**
 * Quote the exact quality-gate violations from the previous attempt.
 *
 * The retry used to say "read quality-report.json and repair the failing rule",
 * but no mediated tool exposes that file, so the orchestrator was told to fix a
 * violation it could not see. Live cases then burned both retries and failed on
 * one wrong enum value or one invented key. The rules are short, so inline
 * them.
 */
async function priorViolations(node4Dir: string): Promise<string> {
  const generic =
    "If evalJudge.yaml already exists, repair only its failing rules. Do not redo investigators or unrelated rulings.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(node4Dir, "judge", "quality-report.json"), "utf8"),
    );
  } catch {
    return generic;
  }
  const tierA = (parsed as { tiers?: { A?: { violations?: unknown } } })?.tiers?.A?.violations;
  if (!Array.isArray(tierA) || tierA.length === 0) return generic;

  const lines = tierA
    .slice(0, 20)
    .map((v) => {
      const { rule, message } = v as { rule?: unknown; message?: unknown };
      return `- [${String(rule ?? "tier-a")}] ${String(message ?? "")}`;
    })
    .join("\n");
  return [
    "judge/evalJudge.yaml exists but failed structural validation. Rewrite ONLY the",
    "fields named below, using write_to_yaml_template. Every value must come from a",
    "committed report; do not invent findings and do not redo investigators.",
    lines,
  ].join("\n");
}

export interface PiNode4Options {
  connection: PiConnection;
  /** Max pi wall-clock. */
  timeoutMs?: number;
  /** Judge run mode: dev surfaces platform findings; prod keeps the agent
   *  report strictly agent-only. Defaults to the process `THEMIS_MODE`. */
  mode?: JudgeMode;
  /** Project prompt overrides keyed by filename (`kratos.md`, …). */
  promptOverrides?: Record<string, string> | null;
}

/** Run Node 4 through the real PI orchestrator + subagents. */
export async function runNode4Pi(
  state: Phase1GraphState,
  opts: PiNode4Options,
): Promise<{ state: Phase1GraphState; result: PiRunResult }> {
  const agentDir = await mkdtemp(join(tmpdir(), "ae-pi-"));
  const workDir = join(state.workDir, "node4");
  const mode = opts.mode ?? judgeMode();

  const prompts = opts.promptOverrides ?? null;
  const [orchestrator, kratos, logos, minosBase, remedy] = await Promise.all([
    loadPromptAsset("themis-orchestrator.md", prompts),
    loadPromptAsset("kratos.md", prompts),
    loadPromptAsset("logos.md", prompts),
    loadPromptAsset("minos.md", prompts),
    loadPromptAsset("remedy.md", prompts),
  ]);
  // The minos prompt already carries the PROD rule (platform findings → channel,
  // never into the report). In dev mode, relax it so platform findings may also
  // surface in `open_questions` for operator visibility.
  const minos =
    mode === "dev"
      ? `${minosBase}\n\nDEV MODE is ON for this run. You may record platform findings (harness / evaluation-machinery defects) in \`open_questions\` in addition to agent questions, marked \`unsolvable_from_record\`, with \`what_would_settle_it\` naming the harness source.\n`
      : minosBase;
  await writePiSubagentDefs(agentDir, { kratos, logos, minos, remedy }, opts.connection);

  // The user prompt hands the orchestrator the case: archive root, work dir,
  // and where the clerk report + evidence catalog live. The orchestrator
  // prompt + subagent tool do the rest.
  const userPrompt = [
    `CASE ${state.caseId} — run ${state.runId}`,
    `MODE: ${mode}`,
    mode === "dev"
      ? "DEV MODE is ON. Minos may surface platform findings in open_questions for operator visibility."
      : "PROD MODE is ON. The evalJudge report is the AGENT-improvement deliverable only. When minos reports platform findings on the channel, record them in your own case record (case-summary), never in evalJudge.yaml.",
    `Archive (sealed, read-only): ${state.archiveDir}`,
    `Judge work dir: ${workDir}`,
    `Clerk report: ${state.paths.clerkReportPath ?? "(none)"}`,
    `Session summary: ${state.paths.sessionPath ?? "(none)"}`,
    `Extracted metrics: ${state.paths.extractedMetricsPath ?? "(none)"}`,
    "",
    "TOOLS: call evidence_list with no arguments to list the archive root.",
    "Directory entries end with '/'; pass one to evidence_list to descend.",
    "read_evidence takes an archive-relative path from those listings.",
    "",
    "RUN THE COURTROOM:",
    "1. evidence_list the root to learn the layout before dispatching.",
    "2. Round 1 baseline — dispatch BOTH investigators, one BLOCKING call each.",
    "   You MUST pass async:false so the call returns the child's result instead",
    "   of a background handle (background children are why the case stalls:",
    "   the orchestrator polls status instead of receiving the report):",
    "     subagent({agent:'kratos', task:'<brief>', async:false})",
    "     subagent({agent:'logos',  task:'<brief>', async:false})",
    "   Do NOT use workflowScript, runs.all, status, steer, or resume/revive.",
    "   Do NOT call subagent with action:'status'. A blocking async:false call is",
    "   the only dispatch form you need — its result IS the report.",
    "   Each brief must name the objective, the boundaries, where to look, and",
    "   what a complete answer contains. Tell each to file its findings with",
    "   write_to_yaml_template (templates 'kratos-report' / 'logos-report').",
    "3. Send the assembled case to the bench in ONE blocking call and WAIT:",
    "     subagent({agent:'minos', task:'<case + what to rule on>', async:false})",
    "   Minos files 'minos-report'. Do not proceed until its result returns. Do",
    "   not use status/resume/steer on it — a plain blocking async:false call.",
    "4. Iterate rounds only while new tangents survive triage (10-round ceiling).",
    "5. YOU assemble the final artifact — this is yours, not the host's: call",
    "   write_to_yaml_template with template 'evalJudge'. The tool validates the",
    "   schema, so fill EXACTLY these fields (a missing key or bad enum is a",
    "   rejected call you fix):",
    "     final_report: true",
    "     eval_id: <case run id>",
    "     agent_under_evaluation: <agent id>",
    "     rounds_run: <int>",
    "     official_reward: <verifier's number, reproduced never modified>",
    "     verdict: { approach, integrity, competence: 1..5, reconciliation }",
    "       approach: principled|narrow|symptomatic|insufficient_evidence",
    "       integrity: clean|suspicious|violation|contested|insufficient_evidence",
    "       reconciliation: consistent|passed_for_wrong_reason|failed_despite_sound_work|unexplained",
    "     narrative: <what happened and why, grounded in the record>",
    "     what_the_agent_did_well: [ {observation, ref} ]",
    "     improvements: [ {issue, evidence: [{report, ref}], recommendation,",
    "       category: correctness|approach|process|integrity|efficiency|tooling,",
    "       impact: high|medium|low, confidence: high|medium|low} ]",
    "     integrity_summary: { verdict, findings: [ {finding, ref, round: <int>} ] }",
    "     reward_reconciliation: <does the reward follow from the process?>",
    "     case_coverage: { tangents_total, tangents_resolved, tangents_open, closed_by: no_new_tangents|triage_exhausted|round_ceiling, converged: true|false }",
    "     open_questions: [ {question, why_unresolved, what_would_settle_it} ]",
    "     revision_history: [ {ruling, changed_in_round, from, to, why} ]  (empty list if none)",
    "     confidence_in_this_report: high|medium|low",
    "     confidence_basis: <what this rests on and where it is thin>",
    "   Copy minos's verdict / narrative / improvements VERBATIM. Never invent a",
    "   verdict, finding, or improvement that no minos ruling contains.",
    "6. Dispatch the remediation researcher (BLOCKING) on minos's CONFIRMED",
    "   findings:",
    "     subagent({agent:'remedy', task:'<the confirmed findings + validity>', async:false})",
    "   The researcher does NOT re-diagnose; it turns confirmed findings into",
    "   research-backed developer recommendations and files 'developer-brief'.",
    "   Pass it: the confirmed findings with refs and attribution owner, the",
    "   validity verdict, and the mode. Do not end your turn until BOTH",
    "   evalJudge.yaml and developer-brief.yaml are written.",
    "7. Also file 'case-summary' for your record.",
    "Do not end your turn until evalJudge and the developer brief have been",
    "written and confirmed.",
    "If a child run was revived/resumed, you must still assemble from the ruling",
    "that eventually returns before ending your turn.",
  ].join("\n");

  const sessionDir = join(workDir, "sessions");
  // True session replay: if this case already has an orchestrator session (a
  // paused quota/rate-limit run, worker loss, or operator pause), continue that
  // exact session instead of starting over. The persisted child session files
  // and committed reports remain in the same workDir as well.
  let resumeSessionPath: string | undefined;
  try {
    const pointer = (await readFile(join(sessionDir, PI_RESUME_POINTER), "utf8")).trim();
    if (pointer) resumeSessionPath = pointer;
  } catch {
    /* no pause pointer */
  }
  if (!resumeSessionPath) {
    try {
      const allSessions = (await readdir(sessionDir))
        .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".frozen.jsonl"))
        .sort();
      const stableSuffix = `_ae-${state.caseId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80)}.jsonl`;
      const exact = allSessions.filter((name) => name.endsWith(stableSuffix));
      const latest = exact.at(-1) ?? allSessions.at(-1);
      if (latest) resumeSessionPath = join(sessionDir, latest);
    } catch {
      // No prior session: this is a fresh case.
    }
  }

  let childResume = "";
  if (resumeSessionPath) {
    try {
      const parsed = JSON.parse(
        await readFile(join(sessionDir, PI_CHILD_RESUME_MANIFEST), "utf8"),
      ) as { children?: Array<{ runId?: string; index?: number; agent?: string }> };
      const targets = (parsed.children ?? []).filter((c) => c.runId);
      if (targets.length) {
        childResume = targets.map((c) =>
          `Resume interrupted ${c.agent ?? "subagent"} with subagent({ action: "resume", id: "${c.runId}", index: ${c.index ?? 0}, message: "Continue from the exact paused child session. Do not repeat completed evidence reads. Finish your assigned report." }).`,
        ).join("\n");
      }
    } catch { /* no interrupted child */ }
  }
  const resumePrompt = resumeSessionPath
    ? [
        "Paused. Continue this same session. Do not redo finished reports.",
        childResume,
        await priorViolations(workDir),
        "Otherwise, after the unfinished child returns, dispatch only the next unpaid role, then write evalJudge.yaml.",
      ].filter(Boolean).join("\n")
    : userPrompt;

  const result = await runPiOrchestrator({
    connection: opts.connection,
    systemPrompt: orchestrator,
    userPrompt: resumePrompt,
    agentDir,
    workDir,
    caseId: state.caseId,
    archiveDir: state.archiveDir,
    sessionDir,
    resumeSessionPath,
    timeoutMs: opts.timeoutMs ?? 2_700_000,
  });

  const next: Phase1GraphState = {
    ...state,
    node: "node4",
    round: state.round || 1,
    paths: {
      ...state.paths,
      node4PiAgentDir: agentDir,
      node4PiStdout: join(workDir, "pi-stdout.jsonl"),
    },
  };
  await saveCheckpoint(next);
  return { state: next, result };
}


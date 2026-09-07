/**
 * Phase-1 graph: Node0 → Node1 → Node2 → Node3 → Node4(round1).
 * Requires a real ModelGateway — no offline fake rulings.
 */

import type { ModelApiType } from "../../config/model-config.js";
import { MemoryDocumentLedger } from "../documents/ledger.js";
import { GatewayError, type ModelGateway } from "../gateway/client.js";
import { loadCheckpoint } from "./checkpoint.js";
import { runNode0 } from "./node0-bind-summarize.js";
import { runNode1 } from "./node1-extract.js";
import { runNode2 } from "./node2-metrics.js";
import { runNode3 } from "./node3-clerk.js";
import { runNode4Pi } from "./node4-pi.js";
import type { Phase1GraphState } from "./state.js";

/** Run Phase 1 against a sealed archive using the live model gateway. */
export async function runPhase1(input: {
  caseId: string;
  runId: string;
  archiveDir: string;
  workDir: string;
  gateway: ModelGateway;
  attemptId: string;
  ledger?: MemoryDocumentLedger;
  maxRounds?: number;
  /** When set, Node 4 runs through the real PI orchestrator + subagents. */
  pi?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
    timeoutMs?: number;
    /** Wire format of the endpoint. Omitting it wrote the wrong provider kind
     *  into pi's models.json, so an Anthropic-compatible stage was called as
     *  OpenAI Chat Completions. */
    apiType?: ModelApiType;
  };
  /** Project prompt overrides keyed by filename. Missing keys use the built-in draft. */
  promptOverrides?: Record<string, string> | null;
}): Promise<Phase1GraphState> {
  const ledger = input.ledger ?? new MemoryDocumentLedger();
  // Crash-resume: every node persists a checkpoint after it completes. A worker
  // loss mid-case (server crash/restart, timeout kill) resumes from the latest
  // committed node instead of re-running Node 0–3 model calls. Node 4 resumes the
  // SAME persisted PI session (see runNode4Pi), so subagent work is never redone
  // from scratch.
  let state = await resumePhase1Graph(input);
  if (input.pi) {
    // Real PI courtroom: themis-orchestrator spawns kratos/logos/minos subagents.
    // A node4 checkpoint without evalJudge means the court was killed mid-round
    // (timeout/pause). Skip only when the verdict actually exists; otherwise
    // --continue the same PI session.
    const node4Cp = await loadCheckpoint(input.workDir, "node4");
    if (!node4Cp?.paths.evalJudgePath) {
      const { state: piState, result } = await runNode4Pi(
        { ...state, round: 1 },
        {
          connection: {
            baseUrl: input.pi.baseUrl,
            apiKey: input.pi.apiKey,
            model: input.pi.model,
            reasoningEffort: input.pi.reasoningEffort,
            ...(input.pi.apiType ? { apiType: input.pi.apiType } : {}),
          },
          timeoutMs: input.pi.timeoutMs,
          promptOverrides: input.promptOverrides,
        },
      );
      state = piState;
    } else {
      state = node4Cp;
    }
    {
      // WP-10 mechanical assembly, ALWAYS enforced in code: the orchestrator
      // directs the court and writes the log books, but the final evalJudge.yaml
      // is a deterministic projection of minos's committed rulings VERBATIM.
      // The host contributes only the case record (rounds_run, closed_by,
      // converged, coverage counts, declined tangents) and copies every
      // verdict/narrative/strength/improvement/finding straight out of
      // minos-report.yaml. This is a copy, never authorship — a paraphrase
      // here is exactly the b-verbatim-assembly breach the gate catches, so the
      // assembly is code, not an instruction the orchestrator may or may not
      // follow.
      const { assembleEvalJudge } = await import("./assemble-eval-judge.js");
      const { join } = await import("node:path");
      const judgeOut = join(state.workDir, "node4", "judge");
      const out = await assembleEvalJudge({
        judgeDir: judgeOut,
        caseId: input.caseId,
        runId: input.runId,
        archiveDir: state.archiveDir,
        roundsRun: state.round || 1,
        closedBy: "convergence",
        converged: true,
      });
      if (out !== null) state.paths.evalJudgePath = out;
    }
  } else {
    const { runNode4Loop } = await import("./node4-loop.js");
    state = await runNode4Loop(
      { ...state, round: 1 },
      {
        gateway: input.gateway,
        attemptId: input.attemptId,
        ledger,
        maxRounds: input.maxRounds ?? 10,
      },
    );
  }
  let structuralPassed = false;
  // WP-14: the FULL five-tier quality gate (A structural / B groundedness /
  // C behavioral / D usefulness / E stability), run against facts derived from
  // the real sealed archive — not a tier-A-only structural peek.
  //
  // The evalJudge artifact may be absent when a case produced no ruling; the
  // gate then reports that honestly rather than silently "passing".
  {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { runQualityGate, findUninvokedRules } = await import("../quality/gate.js");
    const { collectArchiveFacts } = await import("../quality/archive-facts.js");

    const judgeOut = join(state.workDir, "node4", "judge");
    const evalJudgePath =
      state.paths.evalJudgePath ?? join(judgeOut, "evalJudge.yaml");

    let yamlText: string | null = null;
    try {
      yamlText = await readFile(evalJudgePath, "utf8");
    } catch {
      yamlText = null;
    }

    let quality: unknown;
    if (yamlText === null) {
      quality = {
        gate: "themis-phase1",
        passed: false,
        reason: "no evalJudge artifact was produced for this case",
        evalJudgePath,
        uninvokedRules: findUninvokedRules(),
      };
    } else {
      const templateText = await readFile(
        join(process.cwd(), "src", "judge", "prompts", "report-templates.md"),
        "utf8",
      ).catch(() => "");
      const facts = await collectArchiveFacts({
        archiveDir: state.archiveDir,
        workDir: state.workDir,
        templateText,
      });

      // Tier D `d-calibration` needs the distinct refs THIS REPORT cites that
      // resolve. That depends on the report, so it cannot be computed in
      // collectArchiveFacts (which sees only the archive). Tier B owns ref
      // resolution; bind its result into the Tier D archive facts here rather
      // than re-implementing it or leaving the set empty (empty made every
      // honestly calibrated report look like "high confidence on zero evidence").
      const { parseEvalJudgeYaml } = await import("../quality/tier-a-structural.js");
      const { collectResolvingRefs } = await import("../quality/tier-b-grounded.js");
      const parsed = parseEvalJudgeYaml(yamlText);
      const resolvingRefs = collectResolvingRefs(
        parsed as import("../quality/types.js").EvalJudgeReport,
        facts.tierB,
      );

      const report = runQualityGate([
        {
          id: state.caseId,
          yamlText,
          facts: facts.tierB,
          tierD: {
            ...facts.tierD,
            archive: { ...facts.tierD.archive, resolvingRefs },
          },
        },
      ]);
      structuralPassed = report.tiers.A.status === "passed";
      quality = { gate: "themis-phase1", evalJudgePath, ...report };
    }

    await mkdir(judgeOut, { recursive: true });
    const qPath = join(judgeOut, "quality-report.json");
    await writeFile(qPath, `${JSON.stringify(quality, null, 2)}\n`);
    state.paths.qualityReportPath = qPath;
  }

  // A PI case without a valid final report is NOT complete. Surface a schema
  // retry so the durable worker resumes the same session and continues to minos
  // / assembly. Never let a partial court (kratos/logos only) publish as done.
  if (input.pi && (!state.paths.evalJudgePath || !structuralPassed)) {
    throw new GatewayError(
      state.paths.evalJudgePath
        ? "Phase 1 evalJudge.yaml failed Tier A structural validation; resume the same PI session to repair it"
        : "Phase 1 courtroom ended without judge/evalJudge.yaml; resume the same PI session",
      "schema",
    );
  }
  return { ...state, node: "done" };
}

/**
 * Resume Node 0–3 from the latest committed checkpoint, running only the nodes
 * that have not completed yet. Node 0 is the only node with no upstream paths,
 * so a missing node0 checkpoint means a fresh start.
 */
export async function resumePhase1Graph(input: {
  caseId: string;
  runId: string;
  archiveDir: string;
  workDir: string;
  gateway: ModelGateway;
  attemptId: string;
}): Promise<Phase1GraphState> {
  const cp =
    (await loadCheckpoint(input.workDir, "node3")) ??
    (await loadCheckpoint(input.workDir, "node2")) ??
    (await loadCheckpoint(input.workDir, "node1")) ??
    (await loadCheckpoint(input.workDir, "node0"));
  if (!cp) {
    let s = await runNode0(input);
    s = await runNode1(s, input);
    s = await runNode2(s, input);
    s = await runNode3(s, input);
    return s;
  }
  let s = cp;
  if (cp.node === "node0") {
    s = await runNode1(s, input);
    s = await runNode2(s, input);
    s = await runNode3(s, input);
  } else if (cp.node === "node1") {
    s = await runNode2(s, input);
    s = await runNode3(s, input);
  } else if (cp.node === "node2") {
    s = await runNode3(s, input);
  }
  // node3 (or later): Nodes 0–3 are complete; proceed to Node 4.
  return s;
}

/**
 * Phase-1 graph: Node0 → Node1 → Node2 → Node3 → Node4(round1).
 * Requires a real ModelGateway — no offline fake rulings.
 */

import { MemoryDocumentLedger } from "../documents/ledger.js";
import { GatewayError, type ModelGateway } from "../gateway/client.js";
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
    model?: string;
    reasoningEffort?: string;
    timeoutMs?: number;
  };
}): Promise<Phase1GraphState> {
  const ledger = input.ledger ?? new MemoryDocumentLedger();
  let state = await runNode0(input);
  state = await runNode1(state, input);
  state = await runNode2(state, input);
  state = await runNode3(state, input);
  if (input.pi) {
    // Real PI courtroom: themis-orchestrator spawns kratos/logos/minos subagents.
    const { state: piState, result } = await runNode4Pi(
      { ...state, round: 1 },
      {
        connection: {
          baseUrl: input.pi.baseUrl,
          apiKey: input.pi.apiKey,
          model: input.pi.model ?? "deepseek-v4-flash",
          reasoningEffort: input.pi.reasoningEffort ?? "max",
        },
        timeoutMs: input.pi.timeoutMs,
      },
    );
    state = piState;
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

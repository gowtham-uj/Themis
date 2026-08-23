/**
 * Phase-1 graph: Node0 → Node1 → Node2 → Node3 → Node4(round1).
 * Requires a real ModelGateway — no offline fake rulings.
 */

import { MemoryDocumentLedger } from "../documents/ledger.js";
import type { ModelGateway } from "../gateway/client.js";
import { checkTierA } from "../quality/tier-a-structural.js";
import { runNode0 } from "./node0-bind-summarize.js";
import { runNode1 } from "./node1-extract.js";
import { runNode2 } from "./node2-metrics.js";
import { runNode3 } from "./node3-clerk.js";
import { runNode4Loop } from "./node4-loop.js";
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
}): Promise<Phase1GraphState> {
  const ledger = input.ledger ?? new MemoryDocumentLedger();
  let state = await runNode0(input);
  state = await runNode1(state, input);
  state = await runNode2(state, input);
  state = await runNode3(state, input);
  state = await runNode4Loop(
    { ...state, round: 1 },
    {
      gateway: input.gateway,
      attemptId: input.attemptId,
      ledger,
      maxRounds: input.maxRounds ?? 10,
    },
  );
  // Structural quality gate on the produced evalJudge artifact.
  if (state.paths.evalJudgePath) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = await readFile(state.paths.evalJudgePath, "utf8");
    let quality: unknown;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const required = [
        "verdict",
        "narrative",
        "confidence_in_this_report",
        "improvements",
      ] as const;
      const missing = required.filter((k) => !(k in parsed));
      const verdict = (parsed.verdict ?? {}) as Record<string, unknown>;
      const verdictMissing = ["approach", "integrity", "competence", "reconciliation"].filter(
        (k) => !(k in verdict),
      );
      quality = {
        format: "json",
        passed: missing.length === 0 && verdictMissing.length === 0,
        missing_keys: missing,
        missing_verdict_keys: verdictMissing,
        keys: Object.keys(parsed),
      };
    } catch {
      quality = checkTierA(raw);
    }
    const qPath = `${state.workDir}/judge/quality-report.json`;
    await writeFile(qPath, `${JSON.stringify(quality, null, 2)}\n`);
    state.paths.qualityReportPath = qPath;
  }
  return { ...state, node: "done" };
}

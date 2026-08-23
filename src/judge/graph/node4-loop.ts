/**
 * Multi-round Node 4 loop — real Minos calls decide whether to continue.
 */

import { readFile } from "node:fs/promises";

import type { ModelGateway } from "../gateway/client.js";
import { chatJsonObject } from "../gateway/structured.js";
import { MemoryDocumentLedger } from "../documents/ledger.js";
import { runNode4Round } from "./node4-themis.js";
import type { Phase1GraphState } from "./state.js";

const DEFAULT_MAX_ROUNDS = 10;

/** Run Node 4 rounds until Minos reports no new tangents or maxRounds. */
export async function runNode4Loop(
  state: Phase1GraphState,
  opts: {
    gateway: ModelGateway;
    attemptId: string;
    maxRounds?: number;
    ledger?: MemoryDocumentLedger;
  },
): Promise<Phase1GraphState> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let current = await runNode4Round(
    { ...state, round: 1 },
    { gateway: opts.gateway, attemptId: opts.attemptId, ledger: opts.ledger },
  );

  for (let round = 2; round <= maxRounds; round += 1) {
    const rulingRaw = await readFile(current.paths.evalJudgePath!, "utf8");
    const clerkRaw = await readFile(current.paths.clerkReportPath!, "utf8");
    const { value } = await chatJsonObject(opts.gateway, {
      attemptId: opts.attemptId,
      node: "node4",
      metricOrRole: `continue_round_${round}`,
      maxTokens: 2048,
      messages: [
        {
          role: "system",
          content:
            'Return JSON {continue:boolean, tangents:[{id,question}], reason:string}. ' +
            "continue=false when the case is decided or no productive tangents remain.",
        },
        {
          role: "user",
          content: JSON.stringify({
            round,
            ruling: JSON.parse(rulingRaw),
            clerk: JSON.parse(clerkRaw),
          }).slice(0, 60_000),
        },
      ],
      validate: (v) =>
        typeof v === "object" && v !== null && typeof (v as { continue?: unknown }).continue === "boolean"
          ? null
          : "continue boolean required",
    });
    const decision = value as { continue: boolean; tangents?: unknown[] };
    if (!decision.continue || !(decision.tangents && decision.tangents.length > 0)) {
      break;
    }
    current = await runNode4Round(
      { ...current, round },
      { gateway: opts.gateway, attemptId: opts.attemptId, ledger: opts.ledger },
    );
  }
  return current;
}

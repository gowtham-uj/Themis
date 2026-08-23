/**
 * Real LangGraph StateGraph for Phase-1: node0→node1→node2→node3→node4loop.
 */

import { Annotation, StateGraph, END, START } from "@langchain/langgraph";

import type { ModelGateway } from "../gateway/client.js";
import { MemoryDocumentLedger } from "../documents/ledger.js";
import { runNode0 } from "./node0-bind-summarize.js";
import { runNode1 } from "./node1-extract.js";
import { runNode2 } from "./node2-metrics.js";
import { runNode3 } from "./node3-clerk.js";
import { runNode4Loop } from "./node4-loop.js";
import type { Phase1GraphState } from "./state.js";

const Phase1Annotation = Annotation.Root({
  caseId: Annotation<string>,
  runId: Annotation<string>,
  archiveDir: Annotation<string>,
  workDir: Annotation<string>,
  attemptId: Annotation<string>,
  maxRounds: Annotation<number>,
  state: Annotation<Phase1GraphState | null>,
});

export type Phase1LangGraphState = typeof Phase1Annotation.State;

/** Compile the Phase-1 LangGraph. Gateway is closed over (real client). */
export function compilePhase1Graph(gateway: ModelGateway, ledger?: MemoryDocumentLedger) {
  const pad = ledger ?? new MemoryDocumentLedger();

  const g = new StateGraph(Phase1Annotation)
    .addNode("node0", async (s) => {
      const state = await runNode0({
        caseId: s.caseId,
        runId: s.runId,
        archiveDir: s.archiveDir,
        workDir: s.workDir,
        gateway,
        attemptId: s.attemptId,
      });
      return { state };
    })
    .addNode("node1", async (s) => {
      if (!s.state) throw new Error("node1 missing prior state");
      const state = await runNode1(s.state, { gateway, attemptId: s.attemptId });
      return { state };
    })
    .addNode("node2", async (s) => {
      if (!s.state) throw new Error("node2 missing prior state");
      const state = await runNode2(s.state, { gateway, attemptId: s.attemptId });
      return { state };
    })
    .addNode("node3", async (s) => {
      if (!s.state) throw new Error("node3 missing prior state");
      const state = await runNode3(s.state, { gateway, attemptId: s.attemptId });
      return { state };
    })
    .addNode("node4", async (s) => {
      if (!s.state) throw new Error("node4 missing prior state");
      const state = await runNode4Loop(
        { ...s.state, round: 1 },
        { gateway, attemptId: s.attemptId, ledger: pad, maxRounds: s.maxRounds || 10 },
      );
      return { state: { ...state, node: "done" as const } };
    })
    .addEdge(START, "node0")
    .addEdge("node0", "node1")
    .addEdge("node1", "node2")
    .addEdge("node2", "node3")
    .addEdge("node3", "node4")
    .addEdge("node4", END);

  return g.compile();
}

/** Run the compiled LangGraph Phase-1 pipeline. */
export async function runPhase1LangGraph(input: {
  caseId: string;
  runId: string;
  archiveDir: string;
  workDir: string;
  gateway: ModelGateway;
  attemptId: string;
  maxRounds?: number;
  ledger?: MemoryDocumentLedger;
}): Promise<Phase1GraphState> {
  const graph = compilePhase1Graph(input.gateway, input.ledger);
  const out = await graph.invoke({
    caseId: input.caseId,
    runId: input.runId,
    archiveDir: input.archiveDir,
    workDir: input.workDir,
    attemptId: input.attemptId,
    maxRounds: input.maxRounds ?? 10,
    state: null,
  });
  if (!out.state) throw new Error("phase1 langgraph produced no state");
  return out.state;
}

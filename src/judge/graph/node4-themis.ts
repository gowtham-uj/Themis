/**
 * WP-10 Node 4: courtroom round with real investigator + Minos gateway calls.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChatMessage, ModelGateway } from "../gateway/client.js";
import { chatJsonObject } from "../gateway/structured.js";
import { MemoryDocumentLedger } from "../documents/ledger.js";
import { PetitionLog } from "../tools/petition.js";
import {
  JUDGE_TOOL_DEFINITIONS,
  buildEvidenceCatalog,
  executeJudgeTool,
  listCatalogPaths,
  type ToolRuntimeContext,
} from "../tools/runtime.js";
import { ScratchpadStore } from "../tools/scratchpad.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

async function investigatorReport(
  gateway: ModelGateway,
  attemptId: string,
  role: "kratos" | "logos",
  state: Phase1GraphState,
  clerk: string,
): Promise<Record<string, unknown>> {
  const session = await readFile(state.paths.sessionPath!, "utf8");

  const catalog = buildEvidenceCatalog(await listCatalogPaths(state.archiveDir));
  const ctx: ToolRuntimeContext = {
    archiveRoot: state.archiveDir,
    catalog,
    scratchpads: new ScratchpadStore(),
    petitions: new PetitionLog(),
    caseId: state.caseId,
    agentId: role,
  };
  const catalogIds = [...catalog.keys()].join(", ");

  const system =
    role === "kratos"
      ? "You are Kratos (trajectory/process). Investigate using the provided tools, then return JSON {findings:[{claim,refs:[],label}], notes}. refs are archive paths only."
      : "You are Logos (diff/artifact forensics). Investigate using the provided tools, then return JSON {findings:[{claim,refs:[],label}], notes}. refs are archive paths only.";

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `CASE ${state.caseId}\nCATALOG_IDS: ${catalogIds}\nCLERK:\n${clerk.slice(0, 20_000)}\n\nSUMMARY:\n${session.slice(0, 40_000)}`,
    },
  ];

  // Round 1: tool-augmented investigation.
  const first = await gateway.chat({
    attemptId,
    node: "node4",
    metricOrRole: role,
    maxTokens: 4096,
    tools: JUDGE_TOOL_DEFINITIONS,
    toolChoice: "auto",
    messages,
  });

  if (first.toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: first.content || "",
      tool_calls: first.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });
    for (const tc of first.toolCalls) {
      const result = await executeJudgeTool(ctx, tc.function.name, tc.function.arguments);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: result,
      });
    }
    // Bounded single follow-up then final structured answer.
    const follow = await gateway.chat({
      attemptId,
      node: "node4",
      metricOrRole: `${role}:followup`,
      maxTokens: 4096,
      tools: JUDGE_TOOL_DEFINITIONS,
      toolChoice: "auto",
      messages,
    });
    if (follow.content && follow.content.trim()) {
      try {
        const parsed = JSON.parse(follow.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, ""));
        if (parsed && Array.isArray((parsed as { findings?: unknown }).findings)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through to structured extraction
      }
    }
  }

  let value: unknown;
  try {
    const got = await chatJsonObject(gateway, {
      attemptId,
      node: "node4",
      metricOrRole: `${role}:final`,
      maxTokens: 8192,
      messages: [
        ...messages,
        {
          role: "user",
          content: "Now produce the final findings JSON (findings:[{claim,refs,label}], notes).",
        },
      ],
      validate: (v) =>
        typeof v === "object" && v !== null && Array.isArray((v as { findings?: unknown }).findings)
          ? null
          : "findings required",
    });
    value = got.value;
  } catch {
    // The model returned no parseable JSON even after repair. Fall back to
    // findings assembled from the tool results actually executed above —
    // real evidence the investigators read, not fabricated claims.
    const toolResults = messages
      .filter((m) => m.role === "tool")
      .map((m) => ({ call: m.name ?? "", content: m.content.slice(0, 400) }));
    const findings =
      toolResults.length > 0
        ? toolResults.map((t, i) => ({
            claim: `${role} evidence-read[${i}]`,
            refs: [],
            label: "FACT",
            detail: t.content,
          }))
        : [{ claim: `${role} found no additional evidence this round`, refs: [], label: "FACT" }];
    value = { findings, notes: `assembled from ${toolResults.length} tool result(s)` };
  }
  return value as Record<string, unknown>;
}

/** Run one Node-4 round with real model calls for kratos, logos, and minos. */
export async function runNode4Round(
  state: Phase1GraphState,
  opts: { gateway: ModelGateway; attemptId: string; ledger?: MemoryDocumentLedger },
): Promise<Phase1GraphState> {
  const round = Math.max(1, state.round || 1);
  const judgeDir = join(state.workDir, "judge");
  await mkdir(judgeDir, { recursive: true });
  const clerk = await readFile(state.paths.clerkReportPath!, "utf8");

  const kratos = await investigatorReport(opts.gateway, opts.attemptId, "kratos", state, clerk);
  const logos = await investigatorReport(opts.gateway, opts.attemptId, "logos", state, clerk);
  const kratosPath = join(judgeDir, `kratos.round${round}.json`);
  const logosPath = join(judgeDir, `logos.round${round}.json`);
  await writeFile(kratosPath, `${JSON.stringify(kratos, null, 2)}\n`);
  await writeFile(logosPath, `${JSON.stringify(logos, null, 2)}\n`);

  if (opts.ledger) {
    opts.ledger.stage({
      id: `${state.caseId}:kratos:${round}`,
      caseId: state.caseId,
      node: "node4",
      round,
      agentId: "kratos",
      sequence: round * 10,
      body: JSON.stringify(kratos),
    });
    opts.ledger.stage({
      id: `${state.caseId}:logos:${round}`,
      caseId: state.caseId,
      node: "node4",
      round,
      agentId: "logos",
      sequence: round * 10 + 1,
      body: JSON.stringify(logos),
    });
  }

  const { value: ruling } = await chatJsonObject(opts.gateway, {
    attemptId: opts.attemptId,
    node: "node4",
    metricOrRole: "minos",
    maxTokens: 8192,
    reasoningEffort: process.env.THEMIS_REASONING_EFFORT || "max",
    messages: [
      {
        role: "system",
        content:
          "You are Minos. Return JSON {verdict:{approach,integrity,competence,reconciliation},narrative," +
          "official_reward_reproduced:0|1,confidence_in_this_report,confidence_basis,improvements:[{issue,recommendation,category,impact,confidence}]}. " +
          "Do not invent archive paths. Prefer verifier evidence.",
      },
      {
        role: "user",
        content: JSON.stringify({
          caseId: state.caseId,
          clerk: JSON.parse(clerk),
          kratos,
          logos,
        }).slice(0, 90_000),
      },
    ],
    validate: (v) =>
      typeof v === "object" && v !== null && "verdict" in (v as object) ? null : "verdict required",
  });

  const minosPath = join(judgeDir, `minos.round${round}.json`);
  const evalJudgePath = join(judgeDir, "evalJudge.json");
  await writeFile(minosPath, `${JSON.stringify(ruling, null, 2)}\n`);
  await writeFile(evalJudgePath, `${JSON.stringify(ruling, null, 2)}\n`);
  if (opts.ledger) {
    const staged = opts.ledger.stage({
      id: `${state.caseId}:minos:${round}`,
      caseId: state.caseId,
      node: "node4",
      round,
      agentId: "minos",
      sequence: round * 10 + 2,
      body: JSON.stringify(ruling),
    });
    opts.ledger.commit([
      `${state.caseId}:kratos:${round}`,
      `${state.caseId}:logos:${round}`,
      staged.doc.id,
    ]);
  }

  const next: Phase1GraphState = {
    ...state,
    node: "node4",
    round,
    paths: { ...state.paths, kratosPath, logosPath, minosPath, evalJudgePath },
  };
  await saveCheckpoint(next);
  return next;
}

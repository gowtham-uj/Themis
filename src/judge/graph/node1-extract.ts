/**
 * WP-8 Node 1: extract structured eval-case fields from Node 0 products via gateway.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelGateway } from "../gateway/client.js";
import { chatJsonObject } from "../gateway/structured.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

/** Extract metrics + evalCase JSON/YAML from Node 0 summary and archive cues. */
export async function runNode1(
  state: Phase1GraphState,
  input: { gateway: ModelGateway; attemptId: string },
): Promise<Phase1GraphState> {
  const outDir = join(state.workDir, "node1");
  await mkdir(outDir, { recursive: true });
  const session = await readFile(state.paths.sessionPath!, "utf8");
  const evalContext = await readFile(state.paths.evalContextPath!, "utf8");

  const { value } = await chatJsonObject(input.gateway, {
    attemptId: input.attemptId,
    node: "node1",
    metricOrRole: "extract",
    maxTokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "You are Themis Node 1 extractor. Return JSON with keys: " +
          "official_reward (0|1|null), checks (array of {name,passed,detail}), " +
          "changed_files (string[]), summary (string). Use only provided evidence.",
      },
      {
        role: "user",
        content: `CASE ${state.caseId}\nEVAL_CONTEXT:\n${evalContext.slice(0, 20_000)}\n\nSESSION_SUMMARY:\n${session.slice(0, 40_000)}`,
      },
    ],
    validate: (v) =>
      typeof v === "object" && v !== null && "summary" in (v as object)
        ? null
        : "missing summary",
  });

  const extractedMetricsPath = join(outDir, "extracted_metrics.yaml");
  const evalCasePath = join(outDir, "evalCase.yaml");
  const extractedJson = JSON.stringify(value, null, 2);
  await writeFile(extractedMetricsPath, extractedJson + "\n");
  await writeFile(
    evalCasePath,
    JSON.stringify(
      {
        case_id: state.caseId,
        run_id: state.runId,
        extracted: value,
      },
      null,
      2,
    ) + "\n",
  );

  const next: Phase1GraphState = {
    ...state,
    node: "node1",
    paths: { ...state.paths, extractedMetricsPath, evalCasePath },
    hashes: {
      ...state.hashes,
      extractedMetricsPath: createHash("sha256").update(extractedJson).digest("hex"),
    },
  };
  await saveCheckpoint(next);
  return next;
}

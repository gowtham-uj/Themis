/**
 * WP-9 Node 2: LLM metric overlay via gateway (real model call).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelGateway } from "../gateway/client.js";
import { chatJsonObject } from "../gateway/structured.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

/** Produce llm_extracted_metrics.json from extracted case + session summary. */
export async function runNode2(
  state: Phase1GraphState,
  input: { gateway: ModelGateway; attemptId: string },
): Promise<Phase1GraphState> {
  const outDir = join(state.workDir, "node2");
  await mkdir(outDir, { recursive: true });
  const extracted = await readFile(state.paths.extractedMetricsPath!, "utf8");
  const session = await readFile(state.paths.sessionPath!, "utf8");

  const { value } = await chatJsonObject(input.gateway, {
    attemptId: input.attemptId,
    node: "node2",
    metricOrRole: "llm_metrics",
    maxTokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "You are Themis Node 2. Return JSON {metrics:[{id,value,reason,refs:[]}], notes:string}. " +
          "ids must be snake_case. refs must be archive-relative paths mentioned in evidence.",
      },
      {
        role: "user",
        content: `EXTRACTED:\n${extracted.slice(0, 30_000)}\n\nSUMMARY:\n${session.slice(0, 30_000)}`,
      },
    ],
    validate: (v) =>
      typeof v === "object" && v !== null && Array.isArray((v as { metrics?: unknown }).metrics)
        ? null
        : "metrics array required",
  });

  const path = join(outDir, "llm_extracted_metrics.json");
  const body = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, body);
  const next: Phase1GraphState = {
    ...state,
    node: "node2",
    paths: { ...state.paths, llmMetricsPath: path },
    hashes: { ...state.hashes, llmMetricsPath: createHash("sha256").update(body).digest("hex") },
  };
  await saveCheckpoint(next);
  return next;
}

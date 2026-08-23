/**
 * WP-9 Node 3: clerk report via gateway (tool-less).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelGateway } from "../gateway/client.js";
import { chatJsonObject } from "../gateway/structured.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

/** Assemble clerkReport.json for Node 4 intake. */
export async function runNode3(
  state: Phase1GraphState,
  input: { gateway: ModelGateway; attemptId: string },
): Promise<Phase1GraphState> {
  const outDir = join(state.workDir, "node3");
  await mkdir(outDir, { recursive: true });
  const pack = {
    evalCase: await readFile(state.paths.evalCasePath!, "utf8"),
    metrics: await readFile(state.paths.llmMetricsPath!, "utf8"),
    summary: await readFile(state.paths.sessionPath!, "utf8"),
  };

  const { value } = await chatJsonObject(input.gateway, {
    attemptId: input.attemptId,
    node: "node3",
    metricOrRole: "clerk",
    maxTokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "You are Themis clerk. Return JSON {briefing:string, tangents:[{id,question,priority}], coverage_notes:string}. " +
          "Round-1 tangents should include at least trajectory/process and diff/artifact angles when evidence exists.",
      },
      { role: "user", content: JSON.stringify(pack).slice(0, 80_000) },
    ],
    validate: (v) =>
      typeof v === "object" && v !== null && "briefing" in (v as object)
        ? null
        : "briefing required",
  });

  const path = join(outDir, "clerkReport.json");
  const body = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, body);
  const next: Phase1GraphState = {
    ...state,
    node: "node3",
    paths: { ...state.paths, clerkReportPath: path },
    hashes: { ...state.hashes, clerkReportPath: createHash("sha256").update(body).digest("hex") },
  };
  await saveCheckpoint(next);
  return next;
}

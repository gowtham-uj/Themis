/**
 * WP-8 Node 0: bind archive evidence and summarize via the model gateway.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ModelGateway } from "../gateway/client.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

async function listRelFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else out.push(relative(root, p).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return out.sort();
}

async function readSnippet(root: string, rel: string, max = 12_000): Promise<string> {
  try {
    const buf = await readFile(join(root, rel));
    return buf.subarray(0, max).toString("utf8");
  } catch {
    return "";
  }
}

/** Bind archive paths and produce grounded Node 0 summaries using the gateway. */
export async function runNode0(input: {
  caseId: string;
  runId: string;
  archiveDir: string;
  workDir: string;
  gateway: ModelGateway;
  attemptId: string;
}): Promise<Phase1GraphState> {
  const files = await listRelFiles(input.archiveDir);
  const outDir = join(input.workDir, "node0");
  await mkdir(outDir, { recursive: true });

  const preferred = [
    "verifier_res/verifier-result.json",
    "diffs/diff.patch",
    "session/conversation.md",
    "eval_lifecycle_logs/run.json",
    "raw_std/raw-stdout.log",
  ];
  const snippets: Record<string, string> = {};
  for (const rel of preferred) {
    if (files.includes(rel)) snippets[rel] = await readSnippet(input.archiveDir, rel);
  }
  // Always include up to 8 other small text files for binding
  for (const rel of files) {
    if (snippets[rel]) continue;
    if (!/\.(json|jsonl|md|txt|log|yaml|yml|patch)$/i.test(rel)) continue;
    snippets[rel] = await readSnippet(input.archiveDir, rel, 4_000);
    if (Object.keys(snippets).length >= 12) break;
  }

  const catalog = files.map((f) => `  - path: ${JSON.stringify(f)}`).join("\n");
  const evalContextPath = join(outDir, "evalContext.yaml");
  await writeFile(
    evalContextPath,
    `case_id: ${JSON.stringify(input.caseId)}\nrun_id: ${JSON.stringify(input.runId)}\nfiles:\n${catalog}\n`,
  );

  const summary = await input.gateway.chat({
    attemptId: input.attemptId,
    node: "node0",
    metricOrRole: "summarize",
    maxTokens: 4096,
    messages: [
      {
        role: "system",
        content:
          "You are Themis Node 0. Summarize the sealed eval archive for later investigators. " +
          "Return concise markdown with sections: Official result, Diff summary, Process notes, Open risks. " +
          "Cite only filenames you were given. Do not invent paths.",
      },
      {
        role: "user",
        content: `Case ${input.caseId} run ${input.runId}.\nFILES:\n${files.join("\n")}\n\nSNIPPETS:\n${JSON.stringify(snippets).slice(0, 60_000)}`,
      },
    ],
  });

  const sessionPath = join(outDir, "session.txt");
  await writeFile(sessionPath, summary.content);
  const toolCallsPath = join(outDir, "toolCalls.jsonl");
  // Deterministic extraction of tool-looking lines from conversation if present
  const conv = snippets["session/conversation.md"] || "";
  const toolLines: string[] = [];
  for (const line of conv.split(/\r?\n/)) {
    if (/tool|bash|read_file|edit|write/i.test(line)) {
      toolLines.push(JSON.stringify({ line: line.slice(0, 500) }));
    }
  }
  await writeFile(toolCallsPath, toolLines.map((l) => l).join("\n") + (toolLines.length ? "\n" : ""));

  const state: Phase1GraphState = {
    caseId: input.caseId,
    runId: input.runId,
    archiveDir: input.archiveDir,
    workDir: input.workDir,
    node: "node0",
    round: 0,
    paths: { evalContextPath, toolCallsPath, sessionPath },
    hashes: {
      evalContextPath: createHash("sha256").update(await readFile(evalContextPath)).digest("hex"),
      sessionPath: createHash("sha256").update(summary.content).digest("hex"),
    },
  };
  await saveCheckpoint(state);
  return state;
}

/**
 * WP-8 Node 0: bind archive evidence and summarize via the model gateway.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ModelGateway } from "../gateway/client.js";
import { saveCheckpoint } from "./checkpoint.js";
import type { Phase1GraphState } from "./state.js";

/**
 * Directory names that hold machine bookkeeping rather than evidence.
 *
 * A retained workspace carries the agent's whole task tree, so `.git/` object
 * and hook files and the harness's own caches outnumber real source files by
 * two orders of magnitude. Cataloging them buries the handful of paths the
 * investigators need and spends the model's context on git plumbing.
 */
const CATALOG_NOISE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  ".gradle",
  ".cargo",
  ".npm",
  ".cache",
  "cache",
]);

/** True when a path segment marks a subtree the evidence catalog should skip. */
function isNoiseDir(name: string): boolean {
  return CATALOG_NOISE_DIRS.has(name);
}

/**
 * List archive files worth cataloging, with counts of what was pruned.
 *
 * Pruning is reported rather than silent: a judge that sees "2 source files"
 * must be able to tell a small diff from a truncated catalog.
 */
async function listRelFiles(root: string): Promise<{ files: string[]; skipped: number }> {
  const out: string[] = [];
  let skipped = 0;
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const s = await stat(p);
      if (s.isDirectory()) {
        if (isNoiseDir(name)) {
          skipped += await countFiles(p);
          continue;
        }
        await walk(p);
      } else out.push(relative(root, p).replace(/\\/g, "/"));
    }
  }
  await walk(root);
  return { files: out.sort(), skipped };
}

/** Count files under a pruned subtree so the catalog can say what it dropped. */
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) n += await countFiles(p);
    else n += 1;
  }
  return n;
}

async function readSnippet(root: string, rel: string, max = 12_000): Promise<string> {
  try {
    const buf = await readFile(join(root, rel));
    return buf.subarray(0, max).toString("utf8");
  } catch {
    return "";
  }
}

/** One deterministically extracted tool call, keyed by its real provider id. */
interface ExtractedToolCall {
  id: string;
  name: string | null;
  source: string;
  seq: number | null;
}

/**
 * Deterministic tool-call extraction from the sealed archive's event records.
 *
 * The ids here are the SAME ids investigators cite as `tool_call:<id>` refs, so
 * they must be the provider's real call ids read out of the canonical
 * `eval_lifecycle_logs/events.jsonl` (`tool.call`) and the adapter's native
 * `session/session.jsonl` (`tool_started`) — never text scraped from prose. A
 * scraped line carries no id, which silently makes every `tool_call:` ref
 * unresolvable in Tier B.
 */
async function extractToolCalls(archiveDir: string): Promise<ExtractedToolCall[]> {
  const byId = new Map<string, ExtractedToolCall>();
  const sources = ["eval_lifecycle_logs/events.jsonl", "session/session.jsonl"];

  for (const rel of sources) {
    let text: string;
    try {
      text = await readFile(join(archiveDir, rel), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // a malformed line is not an extractable fact
      }
      const type = typeof event.type === "string" ? event.type : "";
      const isCanonical = type === "tool.call";
      const isNative = type === "tool_started";
      if (!isCanonical && !isNative) continue;

      const rawId = isCanonical ? event.id : event.toolCallId;
      if (typeof rawId !== "string" || !rawId) continue;
      if (byId.has(rawId)) continue; // first source wins; ids are stable across both

      const rawName = isCanonical ? event.name : event.toolName;
      byId.set(rawId, {
        id: rawId,
        name: typeof rawName === "string" ? rawName : null,
        source: rel,
        seq: typeof event.seq === "number" ? event.seq : null,
      });
    }
  }

  return [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id));
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
  const { files, skipped } = await listRelFiles(input.archiveDir);
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
  const pruned =
    skipped > 0
      ? `skipped_files: ${skipped}\nskipped_reason: "version-control, dependency, and cache directories are not evidence"\n`
      : "";
  await writeFile(
    evalContextPath,
    `case_id: ${JSON.stringify(input.caseId)}\n` +
      `run_id: ${JSON.stringify(input.runId)}\n` +
      `file_count: ${files.length}\n` +
      pruned +
      `files:\n${catalog}\n`,
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
  await writeFile(
    toolCallsPath,
    (await extractToolCalls(input.archiveDir)).map((c) => `${JSON.stringify(c)}\n`).join(""),
  );

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

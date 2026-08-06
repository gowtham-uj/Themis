#!/usr/bin/env node
/**
 * agenteval CLI — Phase 1 capture foundations.
 *
 *   agenteval run <agent> --task "<prompt>" --workspace <dir>
 *     [--provider p --model m] [--data-dir ./data] [--run-id id]
 *
 * Writes data/runs/<runId>/{events.jsonl,diff.patch,diff.hunks.json,run.json}.
 */

import { resolve } from "node:path";
import { runAgent } from "../runner/run.js";
import type { WorkspaceSpec } from "../adapters/types.js";

export interface ParsedArgs {
  command: string;
  agent?: string;
  task?: string;
  workspace?: string;
  provider?: string;
  model?: string;
  dataDir?: string;
  runId?: string;
  /** When set, clone this repo into --workspace (git source). */
  gitRepo?: string;
  gitRef?: string;
  help?: boolean;
  raw: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = { command: "", raw: args };

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    out.help = true;
    out.command = "help";
    return out;
  }

  out.command = args[0] ?? "";
  let i = 1;

  // Positional agent for `run <agent>`.
  if (out.command === "run" && args[i] && !args[i]!.startsWith("-")) {
    out.agent = args[i];
    i += 1;
  }

  while (i < args.length) {
    const a = args[i]!;
    const next = args[i + 1];
    const take = (flag: string): string | undefined => {
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      i += 2;
      return next;
    };

    switch (a) {
      case "--task":
      case "-t":
        out.task = take(a);
        break;
      case "--workspace":
      case "-w":
        out.workspace = take(a);
        break;
      case "--provider":
        out.provider = take(a);
        break;
      case "--model":
      case "-m":
        out.model = take(a);
        break;
      case "--data-dir":
        out.dataDir = take(a);
        break;
      case "--run-id":
        out.runId = take(a);
        break;
      case "--git-repo":
        out.gitRepo = take(a);
        break;
      case "--git-ref":
        out.gitRef = take(a);
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new Error(`Unknown flag: ${a}`);
        }
        // Allow `run --task ...` without positional agent? require agent.
        i += 1;
        break;
    }
  }

  return out;
}

export function usage(): string {
  return `agenteval — general agent evaluation platform

Usage:
  agenteval run <agent> --task "<prompt>" --workspace <dir> [options]

Agents:
  pi          Live (spawns \`pi --mode json\`)
  reapercode  Parse-only until ReaperCode changes land (errors if run live)

Options:
  --task, -t          Task prompt (required)
  --workspace, -w     Host workspace directory (required)
  --provider          Model provider (default: anthropic)
  --model, -m         Model id
  --data-dir          Output root (default: ./data)
  --run-id            Fixed run id (default: random UUID)
  --git-repo          If set, prepare workspace by cloning this repo
  --git-ref           Branch/tag/sha for --git-repo
  -h, --help          Show help

Output (under <data-dir>/runs/<runId>/):
  events.jsonl        Canonical event stream
  diff.patch          Hunk-numbered git diff
  diff.hunks.json     Hunk index (hunk# → file + line range)
  run.json            Run provenance snapshot
`;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    console.error(usage());
    return 2;
  }

  if (parsed.help || parsed.command === "help") {
    console.log(usage());
    return 0;
  }

  if (parsed.command !== "run") {
    console.error(`error: unknown command "${parsed.command}"`);
    console.error(usage());
    return 2;
  }

  if (!parsed.agent) {
    console.error("error: missing agent (pi | reapercode)");
    console.error(usage());
    return 2;
  }
  if (!parsed.task) {
    console.error("error: --task is required");
    return 2;
  }
  if (!parsed.workspace) {
    console.error("error: --workspace is required");
    return 2;
  }

  let workspaceSpec: WorkspaceSpec | undefined;
  if (parsed.gitRepo) {
    workspaceSpec = {
      source: "git",
      repo: parsed.gitRepo,
      ...(parsed.gitRef ? { ref: parsed.gitRef } : {}),
    };
  }

  try {
    const result = await runAgent({
      agent: parsed.agent,
      task: parsed.task,
      workspace: resolve(parsed.workspace),
      provider: parsed.provider,
      model: parsed.model,
      dataDir: parsed.dataDir ? resolve(parsed.dataDir) : undefined,
      runId: parsed.runId,
      workspaceSpec,
    });

    console.log(`runId: ${result.runId}`);
    console.log(`status: ${result.status}`);
    console.log(`runDir: ${result.runDir}`);
    console.log(`events: ${result.eventsPath}`);
    if (result.diffPath) console.log(`diff: ${result.diffPath}`);
    if (result.hunkIndexPath) console.log(`hunks: ${result.hunkIndexPath}`);
    return result.status === "completed" ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    return 1;
  }
}

// Run only when this file is the process entrypoint (not when imported by tests).
const entry = process.argv[1];
const isDirect =
  typeof entry === "string" &&
  (entry.endsWith("/cli/index.ts") ||
    entry.endsWith("/cli/index.js") ||
    entry.endsWith("\\cli\\index.ts") ||
    entry.endsWith("\\cli\\index.js"));

if (isDirect) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}

/**
 * WP-13 validity gate — is this eval attributable to the agent at all?
 *
 * An eval where the harness failed before the agent phase began must NEVER
 * score the agent. `competence: 1` on a run with zero agent activity would
 * poison Phase-2 statistics ("Reaper fails undo/redo tasks") when the true
 * statement is "the harness aborted before Reaper started."
 *
 * This classifier is DETERMINISTIC — it reads the sealed lifecycle records,
 * never a model's opinion. It runs before agent judgement and its result is
 * stamped into the final report as `eval_validity`, so downstream consumers
 * can exclude non-attributable runs without re-deriving anything.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface EvalValidity {
  /** May this run be used to learn about the AGENT's behavior? */
  valid_for_agent_learning: boolean;
  execution_status: "agent_ran" | "infrastructure_failure" | "unknown";
  failure_owner: "agent" | "eval_harness" | "none" | "unknown";
  agent_started: boolean;
  /** The verifier reward describes agent work (false: it graded the untouched seed). */
  official_reward_attributable_to_agent: boolean;
  /** Phase-2 routing: include in agent-pattern mining? */
  include_in_agent_patterns: boolean;
  /** Phase-2 routing: include in platform-reliability mining? */
  include_in_platform_patterns: boolean;
  exclusion_reason: string | null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Classify an eval archive deterministically from the sealed lifecycle
 * records. Returns the validity facts the report and Phase-2 consume.
 */
export async function classifyEvalValidity(archiveDir: string): Promise<EvalValidity> {
  const metrics = await readJson(join(archiveDir, "eval_lifecycle_logs", "run-metrics.json"));
  const setup = await readJson(join(archiveDir, "eval_lifecycle_logs", "setup-manifest.json"));
  const run = await readJson(join(archiveDir, "eval_lifecycle_logs", "run.json"));

  const toolCallCount = num(metrics?.toolCallCount ?? metrics?.tool_calls) ?? 0;
  const messageCount = num(metrics?.messageCount ?? metrics?.messages) ?? 0;
  const mutationCount = num(metrics?.mutationCount ?? metrics?.files_modified) ?? 0;

  // Any of these signals proves the agent phase produced activity.
  const agentStarted = toolCallCount > 0 || messageCount > 0 || mutationCount > 0;

  const setupStatus = typeof setup?.setup_status === "string" ? setup.setup_status : null;
  const setupExit = num(setup?.exit_code);
  const setupFailed = setupStatus === "failed" || (setupExit !== null && setupExit !== 0);
  const runFailed = run?.status === "failed" || run?.outcome === "failed";

  if (agentStarted) {
    return {
      valid_for_agent_learning: true,
      execution_status: "agent_ran",
      failure_owner: "none",
      agent_started: true,
      official_reward_attributable_to_agent: true,
      include_in_agent_patterns: true,
      include_in_platform_patterns: false,
      exclusion_reason: null,
    };
  }

  if (setupFailed || runFailed) {
    return {
      valid_for_agent_learning: false,
      execution_status: "infrastructure_failure",
      failure_owner: "eval_harness",
      agent_started: false,
      official_reward_attributable_to_agent: false,
      include_in_agent_patterns: false,
      include_in_platform_patterns: true,
      exclusion_reason: "agent_never_executed",
    };
  }

  return {
    valid_for_agent_learning: false,
    execution_status: "unknown",
    failure_owner: "unknown",
    agent_started: false,
    official_reward_attributable_to_agent: false,
    include_in_agent_patterns: false,
    include_in_platform_patterns: true,
    exclusion_reason: "agent_never_executed",
  };
}

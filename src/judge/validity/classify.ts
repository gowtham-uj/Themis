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

/** SHA-256 of the empty byte string — the signature of an unparseable/empty
 *  verifier stdout, which is what a crashed verifier produces. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * True when the verifier crashed or produced no gradable output. In that case
 * the official reward is an infrastructure artifact, NOT a measurement of the
 * agent, even though the agent itself ran.
 */
function verifierCrashed(vr: Record<string, unknown> | null): boolean {
  if (!vr) return false;
  const exit = num(vr.exitCode);
  if (exit === null) return false;
  // 126/127 = command/permission not found; any non-zero exit with an empty
  // result hash means the suite died before emitting a parseable verdict.
  if (exit !== 0) {
    const checks = Array.isArray(vr.checks) ? vr.checks : [];
    const allError = checks.length > 0 && checks.every((c) => (c as Record<string, unknown>)?.status === "error");
    const emptyOut = String(vr.resultSha256 ?? "") === EMPTY_SHA256;
    return allError || emptyOut;
  }
  return false;
}

/**
 * Classify an eval archive deterministically from the sealed lifecycle
 * records. Returns the validity facts the report and Phase-2 consume.
 *
 * Dimensions are independent on purpose: an eval whose agent RAN can still
 * have its reward be a verifier artifact (verifier crash), which must route to
 * platform patterns while the agent's process behavior still feeds agent
 * patterns.
 */
export async function classifyEvalValidity(archiveDir: string): Promise<EvalValidity> {
  const metrics = await readJson(join(archiveDir, "eval_lifecycle_logs", "run-metrics.json"));
  const setup = await readJson(join(archiveDir, "eval_lifecycle_logs", "setup-manifest.json"));
  const run = await readJson(join(archiveDir, "eval_lifecycle_logs", "run.json"));
  const verifier = await readJson(join(archiveDir, "verifier_res", "verifier-result.json"));
  const verifierFailed = verifierCrashed(verifier);

  const toolCallCount = num(metrics?.toolCallCount ?? metrics?.tool_calls) ?? 0;
  const messageCount = num(metrics?.messageCount ?? metrics?.messages) ?? 0;
  const mutationCount = num(metrics?.mutationCount ?? metrics?.files_modified) ?? 0;

  // Any of these signals proves the agent phase produced activity.
  const agentStarted = toolCallCount > 0 || messageCount > 0 || mutationCount > 0;

  const setupStatus = typeof setup?.setup_status === "string" ? setup.setup_status : null;
  const setupExit = num(setup?.exit_code);
  const setupFailed = setupStatus === "failed" || (setupExit !== null && setupExit !== 0);
  const runFailed = run?.status === "failed" || run?.outcome === "failed";

  if (!agentStarted) {
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

  // The agent ran. But a crashed verifier makes the official reward an
  // infrastructure artifact: the reward must NOT be attributed to the agent,
  // and the failure routes to platform patterns, while the agent's process
  // behavior remains valid material for agent patterns.
  // A failed setup means the agent ran against an unseeded workspace, so its
  // reward measures the harness, not the agent. `eval.json` workspace.source is
  // NOT that signal: it is the constant "empty" on every package-sourced eval.
  if (verifierFailed || setupFailed) {
    return {
      valid_for_agent_learning: true,
      execution_status: "agent_ran",
      failure_owner: "eval_harness",
      agent_started: true,
      official_reward_attributable_to_agent: false,
      include_in_agent_patterns: true,
      include_in_platform_patterns: true,
      exclusion_reason: null,
    };
  }

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

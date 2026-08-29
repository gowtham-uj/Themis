/**
 * WP-13 validity gate — an eval that never ran the agent must not score it.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyEvalValidity } from "../src/judge/validity/classify.ts";

async function archiveWith(lifecycle: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ae-validity-"));
  const lc = join(dir, "eval_lifecycle_logs");
  await mkdir(lc, { recursive: true });
  for (const [name, value] of Object.entries(lifecycle)) {
    await writeFile(join(lc, name), JSON.stringify(value));
  }
  return dir;
}

describe("classifyEvalValidity", () => {
  it("flags an eval that never ran the agent as infrastructure_failure, not agent-scored", async () => {
    const dir = await archiveWith({
      "run-metrics.json": { toolCallCount: 0, messageCount: 0, mutationCount: 0 },
      "setup-manifest.json": { setup_status: "failed", exit_code: 2 },
      "run.json": { status: "failed", startedAt: null, error: "eval setup exited 2" },
    });
    const v = await classifyEvalValidity(dir);
    expect(v.valid_for_agent_learning).toBe(false);
    expect(v.execution_status).toBe("infrastructure_failure");
    expect(v.failure_owner).toBe("eval_harness");
    expect(v.agent_started).toBe(false);
    expect(v.official_reward_attributable_to_agent).toBe(false);
    expect(v.include_in_agent_patterns).toBe(false);
    expect(v.include_in_platform_patterns).toBe(true);
    expect(v.exclusion_reason).toBe("agent_never_executed");
  });

  it("marks an eval with agent activity as attributable", async () => {
    const dir = await archiveWith({
      "run-metrics.json": { toolCallCount: 9, messageCount: 6, mutationCount: 1 },
      "setup-manifest.json": { setup_status: "ok", exit_code: 0 },
      "run.json": { status: "completed" },
    });
    const v = await classifyEvalValidity(dir);
    expect(v.valid_for_agent_learning).toBe(true);
    expect(v.execution_status).toBe("agent_ran");
    expect(v.failure_owner).toBe("none");
    expect(v.official_reward_attributable_to_agent).toBe(true);
    expect(v.include_in_agent_patterns).toBe(true);
    expect(v.include_in_platform_patterns).toBe(false);
  });
});

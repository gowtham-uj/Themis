/**
 * Multi-round Node4 loop using the real ModelGateway class with an injected chat
 * implementation (transport seam). No offline stub graph.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ModelGateway } from "../src/judge/gateway/client.ts";
import { loadGatewayConfig } from "../src/judge/gateway/config.ts";
import { MemoryProviderOperationLedger } from "../src/judge/gateway/ledger.ts";
import { runNode4Loop } from "../src/judge/graph/node4-loop.ts";
import type { Phase1GraphState } from "../src/judge/graph/state.ts";

function choice(content: unknown) {
  return JSON.stringify(content);
}

describe("runNode4Loop", () => {
  it("runs round 1 then stops when continue=false", async () => {
    const root = await mkdtemp(join(tmpdir(), "ae-n4-"));
    const workDir = join(root, "work");
    await mkdir(join(workDir, "node0"), { recursive: true });
    await mkdir(join(workDir, "node3"), { recursive: true });
    await writeFile(join(workDir, "node0", "session.txt"), "summary");
    await writeFile(
      join(workDir, "node3", "clerkReport.json"),
      JSON.stringify({ briefing: "b", tangents: [{ id: "t1", question: "q" }] }),
    );

    const state: Phase1GraphState = {
      caseId: "c",
      runId: "r",
      archiveDir: root,
      workDir,
      node: "node3",
      round: 0,
      paths: {
        sessionPath: join(workDir, "node0", "session.txt"),
        clerkReportPath: join(workDir, "node3", "clerkReport.json"),
      },
      hashes: {},
    };

    const gateway = new ModelGateway(
      loadGatewayConfig({
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_API_KEY: "test",
        THEMIS_MAX_TOKENS_FLOOR: "256",
      }),
      new MemoryProviderOperationLedger(),
    );

    const calls: string[] = [];
    gateway.chat = (async (req) => {
      const role = req.metricOrRole;
      calls.push(role);
      let content: string;
      if (role.startsWith("kratos")) {
        content = choice({ findings: [{ claim: "k", refs: [], label: "FACT" }], notes: "" });
      } else if (role.startsWith("logos")) {
        content = choice({ findings: [{ claim: "l", refs: [], label: "FACT" }], notes: "" });
      } else if (role === "minos" || role === "minos:repair") {
        content = choice({
          verdict: {
            approach: "principled",
            integrity: "clean",
            competence: 4,
            reconciliation: "consistent",
          },
          narrative: "n",
          confidence_in_this_report: "medium",
          improvements: [],
        });
      } else {
        content = choice({ continue: false, tangents: [], reason: "done" });
      }
      return {
        operationId: `op_${calls.length}`,
        content,
        finishReason: "stop",
        usage: {},
        model: "deepseek-v4-flash",
        toolCalls: [],
        raw: {},
      };
    }) as typeof gateway.chat;

    const out = await runNode4Loop(state, { gateway, attemptId: "att", maxRounds: 3 });
    expect(out.round).toBe(1);
    expect(calls.filter((c) => c === "minos")).toHaveLength(1);
    expect(calls).toContain("continue_round_2");
    expect(calls.some((c) => c.startsWith("kratos"))).toBe(true);
    expect(calls.some((c) => c.startsWith("logos"))).toBe(true);
  });
});

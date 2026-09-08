/**
 * Phase 2 must be able to read Phase 1's researched remedy.
 *
 * Remedy runs `web_search` per case and files real retrieved sources into
 * `judge/developer-brief.yaml`. Every live case in the ten-eval run sealed one,
 * and no Phase-2 role could open it: the campaign designer was told its
 * `researchBasis` could come only from its own research notes, so finished
 * research was archived and then ignored. The first live Phase-2 pack still had
 * its own research-backed items, but none could use the 54 sources Phase 1 had
 * already retrieved across the ten cases.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ModelGateway } from "../src/judge/gateway/client.ts";
import { GatewayPhase2Board } from "../src/judge/phase2/board.ts";
import { executePhase2Tool, PHASE2_READ_TOOLS, readPhase1ResearchBriefs } from "../src/judge/phase2/tools.ts";

async function view(withBrief: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ae-p2brief-"));
  await mkdir(join(dir, "judge"), { recursive: true });
  await writeFile(join(dir, "judge", "evalJudge.yaml"), "final_report: true\n");
  if (withBrief) {
    await writeFile(
      join(dir, "judge", "developer-brief.yaml"),
      "recommendations:\n  - id: R1\n    class: research_backed\n    research_basis:\n      - source: web:https://example.org/loop-guards\n",
    );
  }
  return dir;
}

const ctx = (viewDirs: Record<string, string>) => ({
  viewDirs,
  cases: [],
  patterns: [],
  hypotheses: [],
});

describe("Phase-2 access to the Phase-1 developer brief", () => {
  it("offers the brief as its own tool, not a path the model must guess", () => {
    expect(PHASE2_READ_TOOLS.map((t) => t.function.name)).toContain("read_developer_brief");
  });

  it("returns the retrieved web sources remedy filed", async () => {
    const dir = await view(true);
    const r = await executePhase2Tool(ctx({ "run-1": dir }), "read_developer_brief", {
      runId: "run-1",
    });
    expect(r.text).toContain("web:https://example.org/loop-guards");
    expect(r.text).toContain("research_backed");
  });

  it("builds a bounded research digest through the mediated tool", async () => {
    const dir = await view(true);
    const [brief] = await readPhase1ResearchBriefs(ctx({ "run-1": dir }), ["run-1", "run-1"]);
    expect(brief).toEqual({
      runId: "run-1",
      status: "present",
      recommendations: [{
        id: "R1",
        findingIds: [],
        changes: [],
        targetSubsystem: "",
        researchBasis: [{ source: "web:https://example.org/loop-guards", claim: "" }],
      }],
    });
  });

  it("preloads the digest into the designer request even if the model makes no read call", async () => {
    const dir = await view(true);
    let user = "";
    const gateway = {
      async chat(req: { messages: Array<{ role: string; content: string }> }) {
        user = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { operationId: "op", content: "[]", finishReason: "stop", usage: null, model: "test", toolCalls: [], raw: null };
      },
    } as unknown as ModelGateway;
    const board = new GatewayPhase2Board(gateway, "attempt-1");
    await board.recommend({
      campaignId: "c1",
      projectId: "p1",
      patterns: [{
        id: "PAT-1", signature: "VERIFICATION_GAP", owner: "agent", evalIds: ["run-1"],
        frequency: 1, passed: 0, failed: 1, unattributable: 0, averageTokens: 10,
        silentWeaknesses: 0, evidence: [], summary: "gap", registryStatus: "candidate",
        cohorts: [{ key: "all", count: 1, passed: 0, failed: 1 }],
      }],
      platformContext: { platformFailures: 0, rewardNotAttributable: 0, platformFaults: [] },
      ctx: { viewDirs: { "run-1": dir }, cases: [] },
    });
    const payload = JSON.parse(user) as { developerBriefs: unknown };
    expect(JSON.stringify(payload.developerBriefs)).toContain("web:https://example.org/loop-guards");
  });

  // A case sealed before remedy existed has no brief. Calling that a denial
  // tells the campaign it lacked permission for a file that was never part of
  // the case, and a model reading DENIED will reasonably retry or work around it.
  it("reports a case with no brief as absent, not denied", async () => {
    const dir = await view(false);
    const r = await executePhase2Tool(ctx({ "run-1": dir }), "read_developer_brief", {
      runId: "run-1",
    });
    expect(r.text).toMatch(/^ABSENT:/);
    expect(r.text).not.toContain("DENIED");
  });

  it("still denies an unknown run", async () => {
    const r = await executePhase2Tool(ctx({}), "read_developer_brief", { runId: "nope" });
    expect(r.text).toBe("DENIED: unknown runId");
  });

  it("keeps the lifecycle allowlist closed to arbitrary judge paths", async () => {
    const dir = await view(true);
    const r = await executePhase2Tool(ctx({ "run-1": dir }), "read_lifecycle", {
      runId: "run-1",
      path: "judge/minos-report.yaml",
    });
    expect(r.text).toContain("not allowlisted");
  });
});

/**
 * Phase 2 must be able to read Phase 1's researched remedy.
 *
 * Remedy runs `web_search` per case and files real retrieved sources into
 * `judge/developer-brief.yaml`. Every live case in the ten-eval run sealed one,
 * and no Phase-2 role could open it: the campaign designer was told its
 * `researchBasis` could come only from its own research notes, so finished
 * research was archived and then ignored. `research_backed` was 0 across all ten
 * final reports while nine of them had actually searched the web.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { executePhase2Tool, PHASE2_READ_TOOLS } from "../src/judge/phase2/tools.ts";

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

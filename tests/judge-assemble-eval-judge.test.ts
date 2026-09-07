/**
 * WP-10 mechanical final assembly — evalJudge.yaml is projected VERBATIM from
 * the committed minos ruling (new shape: approach/integrity/competence/
 * reconciliation + *_reasoning + improvements). The host adds only the case
 * record.
 */
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { assembleEvalJudge } from "../src/judge/graph/assemble-eval-judge.ts";
import { parseAllDocuments } from "yaml";

describe("mechanical evalJudge assembly", () => {
  it("projects minos's ruling verbatim into the frozen template-4 shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-assemble-"));
    const minos = [
      "case_id: c1",
      "round: 2",
      "approach: narrow",
      "integrity: clean",
      "competence: 3",
      "reconciliation: consistent",
      "approach_reasoning: The regex is over-permissive.",
      "reconciliation_reasoning: The reward follows from the process.",
      "improvements:",
      "  - 1. Fix the regex to be exact.",
      "findings:",
      "  - F1: regex is over-permissive",
      "limitations: The hidden verifier internals were not in the archive.",
      "---",
    ].join("\n");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "minos-report.yaml"), minos);

    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "c1",
      runId: "r1",
      roundsRun: 2,
      closedBy: "no_new_tangents",
      converged: true,
      officialReward: 0,
      agentUnderEvaluation: "reapercode",
    });

    expect(out).not.toBeNull();
    const doc = (parseAllDocuments(await readFile(out!, "utf8"))[0]!.toJS()) as Record<string, unknown>;

    // Verbatim verdict fields.
    expect((doc.verdict as Record<string, unknown>).approach).toBe("narrow");
    expect((doc.verdict as Record<string, unknown>).integrity).toBe("clean");
    expect((doc.verdict as Record<string, unknown>).competence).toBe(3);
    expect((doc.verdict as Record<string, unknown>).reconciliation).toBe("consistent");

    // Verbatim narrative + improvements.
    expect(doc.narrative).toContain("The regex is over-permissive.");
    const imps = doc.improvements as Array<Record<string, unknown>>;
    expect(imps.length).toBe(1);
    expect(imps[0]!.issue).toContain("Fix the regex to be exact.");

    // Case record the orchestrator owns.
    expect(doc.final_report).toBe(true);
    expect(doc.eval_id).toBe("r1");
    expect(doc.agent_under_evaluation).toBe("reapercode");
    expect(doc.official_reward).toBe(0);
    expect((doc.case_coverage as Record<string, unknown>).closed_by).toBe("no_new_tangents");
    expect((doc.case_coverage as Record<string, unknown>).converged).toBe(true);
  });

  it("projects a single verdict_basis paragraph as the narrative (observed live)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-assemble-basis-"));
    const basis =
      "officialReward 1 with public_tests 13/13 and hidden_contract pass is consistent with the process the round documented.";
    await writeFile(
      join(dir, "minos-report.yaml"),
      ["case_id: c1", "round: 1", "verdict:", "  approach: principled", "  integrity: clean", "  competence: 5", "  reconciliation: consistent", `verdict_basis: "${basis}"`, "---"].join("\n"),
    );

    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "c1",
      runId: "r1",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
      officialReward: 1,
      agentUnderEvaluation: "reapercode",
    });
    const doc = parseAllDocuments(await readFile(out!, "utf8"))[0]!.toJS() as Record<string, unknown>;
    expect(doc.narrative).toBe(basis);
    expect(doc.confidence_basis).toBe(basis);
  });

  it("returns null when minos never ruled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-assemble-empty-"));
    expect(
      await assembleEvalJudge({
        judgeDir: dir,
        caseId: "c",
        runId: "r",
        roundsRun: 1,
        closedBy: "convergence",
        converged: false,
      }),
    ).toBeNull();
  });
});

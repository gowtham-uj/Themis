/**
 * The final report is a host projection of committed minos rulings, never a
 * document the court writes.
 *
 * A live case filed its whole ruling straight to the `evalJudge` template. That
 * produced a judge/evalJudge.yaml the orchestrator had authored, so
 * minos-report.yaml never existed, the verbatim assembler found nothing to
 * project, and Tier B failed the case permanently — a complete judgement lost
 * with no retry that could recover it.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { finalReportTemplateTarget } from "../src/judge/tools/themis-tools-extension.ts";
import { assembleEvalJudge } from "../src/judge/graph/assemble-eval-judge.ts";

const saved = process.env.THEMIS_JUDGE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.THEMIS_JUDGE_DIR;
  else process.env.THEMIS_JUDGE_DIR = saved;
});

describe("final report authority", () => {
  it("routes an evalJudge template write to the minos ruling, not the final report", () => {
    // The court keeps its own name for the deliverable; what changes is where
    // those bytes land. Letting them land on judge/evalJudge.yaml overwrites the
    // one artifact the host must own.
    expect(finalReportTemplateTarget("evalJudge")).toBe("judge/minos-report.yaml");
    expect(finalReportTemplateTarget("minos-report")).toBe("judge/minos-report.yaml");
  });

  it("assembles the final report from a ruling filed under the evalJudge shape", async () => {
    const judgeDir = await mkdtemp(join(tmpdir(), "ae-final-report-"));
    // Exactly the shape the live court filed: template-4 field names, appended
    // to the minos report because that is where the tool now sends them.
    await writeFile(
      join(judgeDir, "minos-report.yaml"),
      [
        "final_report: true",
        "round: 1",
        "verdict:",
        "  approach: principled",
        "  integrity: clean",
        "  competence: 4",
        "  reconciliation: consistent",
        'narrative: "The agent rebuilt the engine rather than patching symptoms."',
        "---",
        "",
      ].join("\n"),
    );

    const out = await assembleEvalJudge({
      judgeDir,
      caseId: "case_r1",
      runId: "r1",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
    });

    expect(out).not.toBeNull();
    const text = await readFile(out as string, "utf8");
    // Verbatim projection: the host copies the ruling it was handed and never
    // substitutes insufficient_evidence for a verdict minos actually made.
    expect(text).toContain("approach: principled");
    expect(text).toContain("integrity: clean");
    expect(text).toContain("competence: 4");
    expect(text).toContain("The agent rebuilt the engine rather than patching symptoms.");
  });
});

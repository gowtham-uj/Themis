/**
 * `evalJudge.yaml` is projected deterministically from minos's committed ruling,
 * so an off-enum value in that ruling was previously unfixable: every retry
 * regenerated the same violation from the same report, and four live cases
 * burned both attempts on one wrong word. The projector now maps the near miss
 * onto the frozen enum and keeps what minos actually wrote, along with any key
 * the template never named, under `extra`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { assembleEvalJudge } from "../src/judge/graph/assemble-eval-judge.ts";
import { checkTierAReport } from "../src/judge/quality/tier-a-structural.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

/** A judge dir holding one committed minos ruling. */
async function judgeDirWith(minos: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "agenteval-assemble-"));
  dirs.push(d);
  await writeFile(join(d, "minos-report.yaml"), minos, "utf8");
  return d;
}

const RULING = `round: 1
verdict:
  approach: narrow
  integrity: ""
  competence: 3
  reconciliation: consistent
narrative: The agent fixed the symptom without reading the contract.
improvements:
  - issue: The capacity gate rejects encodes that would fit.
    recommendation: Compute the exact required size instead of worst-casing.
    category: robustness
    impact: critical
    confidence: medium
    pattern: conservative worst-casing on a numeric bound
    root_cause: the spec phrase "would not fit" was read as worst case
    evidence:
      - report: logos
        ref: "source:src/framer.c#symbol=frame_encode"
`;

describe("projecting minos's ruling into evalJudge.yaml", () => {
  it("maps near-miss enum words onto the frozen members", async () => {
    const dir = await judgeDirWith(RULING);
    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "case_x",
      runId: "run_x",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
    });
    expect(out).not.toBeNull();
    const doc = parse(await readFile(out!, "utf8")) as Record<string, any>;

    // "robustness" is not a category and "critical" is not an impact.
    expect(doc.improvements[0].category).toBe("correctness");
    expect(doc.improvements[0].impact).toBe("high");
    // An unnamed integrity verdict is not the court clearing the agent.
    expect(doc.integrity_summary.verdict).toBe("insufficient_evidence");
  });

  it("keeps the word minos wrote and every surprise key under extra", async () => {
    const dir = await judgeDirWith(RULING);
    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "case_x",
      runId: "run_x",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
    });
    const doc = parse(await readFile(out!, "utf8")) as Record<string, any>;
    const extra = doc.improvements[0].extra;

    expect(extra.category_as_written).toBe("robustness");
    // Fields the template never named are signal about the agent, not noise.
    expect(extra.pattern).toBe("conservative worst-casing on a numeric bound");
    expect(extra.root_cause).toContain("would not fit");
  });

  it("names the subsystem, the fix type, and the pathology", async () => {
    const dir = await judgeDirWith(RULING);
    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "case_x",
      runId: "run_x",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
    });
    const doc = parse(await readFile(out!, "utf8")) as Record<string, any>;
    const imp = doc.improvements[0];

    // This ruling's prose describes a numeric bound, not any part of the agent,
    // so there is nothing to name. `unknown` is the honest answer; a guessed
    // subsystem would send a developer to the wrong file.
    expect(imp.subsystem).toBe("unknown");
    // No web ref in the evidence, so `research_backed` is not available.
    expect(imp.fix_type).toBe("direct_fix");
    expect(typeof imp.signature).toBe("string");
    expect(imp.signature.length).toBeGreaterThan(0);
  });

  it("only calls a fix research_backed when a web ref is actually cited", async () => {
    const dir = await judgeDirWith(`round: 1
verdict:
  approach: narrow
  integrity: clean
  competence: 3
  reconciliation: consistent
narrative: The agent never ran the suite it changed.
improvements:
  - issue: The agent shipped the patch without running the test suite.
    recommendation: Require a verification step before declaring the task done.
    category: process
    impact: high
    confidence: high
    evidence:
      - report: logos
        ref: "file:src/patch.js#L1-L20"
      - report: "web:https://example.invalid/agent-verification"
        ref: "web:https://example.invalid/agent-verification"
`);
    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "case_z",
      runId: "run_z",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
    });
    const doc = parse(await readFile(out!, "utf8")) as Record<string, any>;
    const imp = doc.improvements[0];

    expect(imp.fix_type).toBe("research_backed");
    expect(imp.subsystem).toBe("verification");
    expect(imp.signature).toBe("VERIFICATION_GAP");
  });

  it("passes Tier A, so the case is no longer a dead end", async () => {
    const dir = await judgeDirWith(RULING);
    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "case_x",
      runId: "run_x",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
      // No sealed archive here, so the reward is supplied directly; it is
      // reproduced from the verifier either way, never authored by the court.
      officialReward: 0,
    });
    const doc = parse(await readFile(out!, "utf8"));
    const tierA = checkTierAReport(doc);
    const blocking = tierA.violations.filter(
      (v) => v.rule === "a-enums-exact" || v.rule === "a-no-invented-keys",
    );
    expect(blocking).toEqual([]);
  });

  it("does not require extra, and omits it when minos filed nothing surprising", async () => {
    const dir = await judgeDirWith(`round: 1
verdict:
  approach: principled
  integrity: clean
  competence: 4
  reconciliation: consistent
narrative: Clean run.
improvements:
  - issue: Dead helper left in the diff.
    recommendation: Remove it or wire it to the guard it was written for.
    category: process
    impact: low
    confidence: high
    evidence:
      - report: logos
        ref: "file:src/patch.js#L1-L266"
`);
    const out = await assembleEvalJudge({
      judgeDir: dir,
      caseId: "case_y",
      runId: "run_y",
      roundsRun: 1,
      closedBy: "no_new_tangents",
      converged: true,
    });
    const doc = parse(await readFile(out!, "utf8")) as Record<string, any>;
    expect("extra" in doc.improvements[0]).toBe(false);
    expect(checkTierAReport(doc).violations.filter((v) => v.rule === "a-required-keys")).toEqual([]);
  });
});

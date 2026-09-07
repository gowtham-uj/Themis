/** Phase-2 PI subagent defs: customized prompts and tool allowlists. */
import {mkdir, mkdtemp, readFile, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {isPhase2BoardInterrupted} from "../src/judge/phase2/errors.ts";
import {resolveBoardOutcome, writePhase2PiSubagentDefs} from "../src/judge/phase2/phase2-pi.ts";

describe("writePhase2PiSubagentDefs", () => {
  it("writes investigator/researcher/designer/reviewer with Phase-2 tools and custom prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-p2-pi-"));
    const written = await writePhase2PiSubagentDefs(dir, {
      investigator: "INVESTIGATOR BODY",
      researcher: "RESEARCHER BODY",
      designer: "DESIGNER BODY",
      reviewer: "REVIEWER BODY",
    }, { model: "deepseek-v4-flash" });
    expect(written).toHaveLength(4);
    const names = (await readdir(join(dir, "agents"))).sort();
    expect(names).toEqual(["designer.md", "investigator.md", "researcher.md", "reviewer.md"]);

    const investigator = await readFile(join(dir, "agents", "investigator.md"), "utf8");
    expect(investigator).toContain("name: investigator");
    expect(investigator).toContain("list_evals");
    expect(investigator).toContain("read_judge_report");
    expect(investigator).toContain("INVESTIGATOR BODY");
    expect(investigator).toContain("themis-proxy/deepseek-v4-flash");
    expect(investigator).not.toContain("kratos");

    const researcher = await readFile(join(dir, "agents", "researcher.md"), "utf8");
    expect(researcher).toContain("web_search");
    expect(researcher).toContain("RESEARCHER BODY");
    expect(researcher).not.toContain("list_evals");

    const designer = await readFile(join(dir, "agents", "designer.md"), "utf8");
    expect(designer).toContain("write_to_yaml_template");
    expect(designer).toContain("DESIGNER BODY");

    const reviewer = await readFile(join(dir, "agents", "reviewer.md"), "utf8");
    expect(reviewer).toContain("read_court_record");
    expect(reviewer).toContain("REVIEWER BODY");
    expect(reviewer).not.toContain("web_search");
  });
});

describe("resolveBoardOutcome", () => {
  const ROLES = {
    "phase2-hypotheses.yaml": "hypotheses:\n  - id: h1\n    statement: agents skip the failing test\n",
    "phase2-research.yaml": "notes:\n  - id: n1\n    hypothesisId: h1\n    summary: read the docs\n",
    "phase2-recommendations.yaml": "recommendations:\n  - id: r1\n    title: run the tests first\n",
    "phase2-review.yaml": "verdict: accept\n",
  };

  async function board(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ae-p2-outcome-"));
    await mkdir(join(dir, "judge"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, "judge", name), body, "utf8");
    }
    return dir;
  }

  it("returns the record set when every role filed", async () => {
    const out = await resolveBoardOutcome(await board(ROLES));
    expect(out.hypotheses).toHaveLength(1);
    expect(out.research).toHaveLength(1);
    expect(out.recommendations).toHaveLength(1);
  });

  it("refuses a board killed before its first role filed anything", async () => {
    // This is the exact shape a paused campaign left on disk: an empty judge/
    // dir plus a frozen, resumable session. It used to read as a finished board
    // with nothing to say, and published an empty pack over sealed archives.
    const dir = await board({});
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "sessions", ".resume-session"), `${join(dir, "sessions", "s.jsonl")}\n`, "utf8");
    const err = await resolveBoardOutcome(dir).catch((e: unknown) => e);
    expect(isPhase2BoardInterrupted(err)).toBe(true);
    expect((err as Error).message).toContain("nothing");
    expect((err as {resumable: boolean}).resumable).toBe(true);
  });

  it("refuses a partially filed board and names what it committed", async () => {
    const partial = { ...ROLES } as Record<string, string>;
    delete partial["phase2-review.yaml"];
    const err = await resolveBoardOutcome(await board(partial)).catch((e: unknown) => e);
    expect(isPhase2BoardInterrupted(err)).toBe(true);
    expect((err as {filed: string[]}).filed).toEqual([
      "phase2-hypotheses.yaml", "phase2-recommendations.yaml", "phase2-research.yaml",
    ]);
    // No pause pointer: a crash is still interrupted, but not resumable.
    expect((err as {resumable: boolean}).resumable).toBe(false);
  });
});

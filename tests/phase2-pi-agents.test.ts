/** Phase-2 PI subagent defs: customized prompts and tool allowlists. */
import {mkdtemp, readFile, readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {writePhase2PiSubagentDefs} from "../src/judge/phase2/phase2-pi.ts";

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

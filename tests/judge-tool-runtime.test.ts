import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PetitionLog } from "../src/judge/tools/petition.ts";
import { ScratchpadStore } from "../src/judge/tools/scratchpad.ts";
import {
  buildEvidenceCatalog,
  executeJudgeTool,
  JUDGE_TOOL_DEFINITIONS,
} from "../src/judge/tools/runtime.ts";

describe("judge tool runtime", () => {
  it("exposes tool definitions and executes evidence_read", async () => {
    expect(JUDGE_TOOL_DEFINITIONS.some((t) => t.function.name === "evidence_read")).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "ae-rt-"));
    await mkdir(join(root, "retained"), { recursive: true });
    await writeFile(join(root, "retained", "a.txt"), "hello-world");
    const catalog = buildEvidenceCatalog([{ path: "retained/a.txt", bytes: 11 }]);
    const id = [...catalog.keys()][0]!;
    const ctx = {
      archiveRoot: root,
      catalog,
      scratchpads: new ScratchpadStore(),
      petitions: new PetitionLog(),
      caseId: "c",
      agentId: "kratos",
    };
    const out = JSON.parse(
      await executeJudgeTool(ctx, "evidence_read", JSON.stringify({ catalogId: id, offset: 0, length: 5 })),
    );
    expect(out.content).toBe("hello");
  });
});

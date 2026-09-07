import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writePiModelsJson, writePiSubagentDefs } from "../src/judge/pi/runtime.ts";
import { writePhase2PiSubagentDefs } from "../src/judge/phase2/phase2-pi.ts";

const model = "provider-model-under-test";
const qualified = `themis-proxy/${model}`;

describe("PI child provider pinning", () => {
  it("pins every Phase-1 parent and child to the supplied provider model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-p1-provider-"));
    await writePiModelsJson(dir, {
      baseUrl: "https://provider.invalid/v1",
      apiKey: "SYNTHETIC_PROVIDER_KEY",
      model,
      reasoningEffort: "medium",
      apiType: "openai",
    });
    await writePiSubagentDefs(dir, {
      kratos: "K", logos: "L", minos: "M", remedy: "R",
    }, { model });

    const models = JSON.parse(await readFile(join(dir, "models.json"), "utf8")) as {
      providers: Record<string, { models: Array<{ id: string }> }>;
    };
    expect(Object.keys(models.providers)).toEqual(["themis-proxy"]);
    expect(models.providers["themis-proxy"]?.models[0]?.id).toBe(model);

    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
      subagents: { defaultModel: string; agentOverrides: Record<string, { model: string }> };
    };
    expect(settings.subagents.defaultModel).toBe(qualified);
    expect(Object.values(settings.subagents.agentOverrides).every((x) => x.model === qualified)).toBe(true);
    for (const role of ["kratos", "logos", "minos", "remedy"]) {
      expect(await readFile(join(dir, "agents", `${role}.md`), "utf8")).toContain(`model: ${qualified}`);
    }
  });

  it("pins every Phase-2 child to the supplied provider model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-p2-provider-"));
    await writePhase2PiSubagentDefs(dir, {
      investigator: "I", researcher: "R", designer: "D", reviewer: "V",
    }, { model });
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
      subagents: { defaultModel: string; agentOverrides: Record<string, { model: string }> };
    };
    expect(settings.subagents.defaultModel).toBe(qualified);
    expect(Object.values(settings.subagents.agentOverrides).every((x) => x.model === qualified)).toBe(true);
    for (const role of ["investigator", "researcher", "designer", "reviewer"]) {
      expect(await readFile(join(dir, "agents", `${role}.md`), "utf8")).toContain(`model: ${qualified}`);
    }
  });
});

/** Project prompt copies: PATCH stores them, loadPromptAsset reads them, resume would too. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { loadPromptAsset } from "../src/judge/pi/runtime.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("project prompt copies", () => {
  it("GET lists builtin text and PATCH is what loadPromptAsset reads", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "prompt-cfg-"));
    dirs.push(dataDir);
    const api = createServer({ dataDir });
    servers.push(api);
    const port = await api.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Prompts", slug: `prompts-${Date.now()}` }),
    });
    expect(created.status).toBe(201);
    const projectId = ((await created.json()) as { id: string }).id;

    const listed = await fetch(`${base}/api/projects/${projectId}/prompts`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      prompts: Array<{ id: string; body: string; source: string; builtin: string }>;
    };
    const kratos = body.prompts.find((p) => p.id === "kratos.md");
    expect(kratos).toBeTruthy();
    expect(kratos!.source).toBe("builtin");
    expect(kratos!.body.length).toBeGreaterThan(20);

    const edited = `${kratos!.builtin}\n\nPROJECT COPY: look at the transcript first.\n`;
    const patched = await fetch(`${base}/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt_config: { "kratos.md": edited } }),
    });
    expect(patched.status).toBe(200);
    const saved = (await patched.json()) as { prompt_config: Record<string, string> };
    expect(saved.prompt_config["kratos.md"]).toBe(edited);

    const fromDisk = await loadPromptAsset("kratos.md");
    expect(fromDisk).toBe(kratos!.builtin);
    const fromProject = await loadPromptAsset("kratos.md", saved.prompt_config);
    expect(fromProject).toBe(edited);
    expect(fromProject).not.toBe(fromDisk);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import { validEvalPackageUpload } from "./helpers/eval-package.ts";

const servers: ApiServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "agenteval-eval-api-"));
  dirs.push(dataDir);
  const api = createServer({ dataDir });
  servers.push(api);
  const port = await api.listen(0);
  return { api, base: `http://127.0.0.1:${port}` };
}

async function zipPackage(): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [path, value] of Object.entries(validEvalPackageUpload().files)) {
    const content = typeof value === "string"
      ? Buffer.from(value)
      : Buffer.from(value.content, value.encoding === "base64" ? "base64" : "utf8");
    zip.addBuffer(content, `eval-package/${path}`);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("canonical eval creation API", () => {
  it("accepts the JSON file-map transport and exposes category metadata", async () => {
    const { api, base } = await boot();
    const project = api.queries.createProject({ name: "P", slug: "canonical-json" });
    const response = await fetch(`${base}/api/projects/${project.id}/evals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validEvalPackageUpload()),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; category_name: string; package_digest: string };
    expect(body.category_name).toBe("javascript-bugfix");
    expect(body.package_digest).toMatch(/^[a-f0-9]{64}$/);

    const categories = await fetch(`${base}/api/projects/${project.id}/eval-categories`);
    expect(await categories.json()).toEqual({
      categories: [{ name: "javascript-bugfix", eval_count: 1 }],
    });
  });

  it("accepts a quarantined ZIP transport and rejects invalid archives atomically", async () => {
    const { api, base } = await boot();
    const project = api.queries.createProject({ name: "P", slug: "canonical-zip" });
    const response = await fetch(
      `${base}/api/projects/${project.id}/evals:import-archive?format=zip`,
      { method: "POST", headers: { "Content-Type": "application/zip" }, body: await zipPackage() },
    );
    expect(response.status).toBe(201);
    expect(api.queries.listTasks(project.id)).toHaveLength(1);

    const bad = await fetch(
      `${base}/api/projects/${project.id}/evals:import-archive?format=zip`,
      { method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from("not a zip") },
    );
    expect(bad.status).toBe(400);
    expect(api.queries.listTasks(project.id)).toHaveLength(1);
  });
});

import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import yazl from "yazl";
import { describe, expect, it } from "vitest";
import { decodeEvalArchiveFile } from "../src/evals/archive.ts";
import {
  decodePackageFiles,
  loadEvalPackageRuntimeConfig,
  materializeEvalPackage,
  prepareEvalPackageWorkspace,
  verifyMaterializedEvalPackage,
} from "../src/evals/package.ts";
import { captureDiff } from "../src/runner/diff.ts";
import { commitWorkspaceBaseline } from "../src/runner/workspace.ts";
import { validEvalPackageUpload } from "./helpers/eval-package.ts";

describe("canonical eval packages", () => {
  it("strictly validates, hashes, materializes, and copies only agent-visible inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-package-"));
    const destination = join(root, "eval", "package");
    const workspace = join(root, "workspace");
    try {
      const result = await materializeEvalPackage({
        upload: validEvalPackageUpload(),
        destination,
      });
      expect(result.validation.valid).toBe(true);
      expect(result.validation.category).toBe("javascript-bugfix");
      expect(result.packageDigest).toMatch(/^[a-f0-9]{64}$/);
      await verifyMaterializedEvalPackage({
        packagePath: result.packagePath,
        packageDigest: result.packageDigest,
        manifest: result.manifest as unknown as Record<string, unknown>,
      });
      await prepareEvalPackageWorkspace({
        packagePath: result.packagePath,
        packageDigest: result.packageDigest,
        manifest: result.manifest as unknown as Record<string, unknown>,
        workspaceDir: workspace,
      });
      expect(await readFile(join(workspace, "src/value.js"), "utf8")).toContain("41");
      await expect(readFile(join(workspace, "solution/solve.sh"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(workspace, "tests/test.sh"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(workspace, "validation/expected_results.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(workspace, ".agenteval/environment/healthcheck.sh"), "utf8")).toContain("node --version");

      await commitWorkspaceBaseline(workspace);
      await writeFile(join(workspace, "src/value.js"), "export function value() { return 42; }\n");
      const diff = await captureDiff(workspace, { outPath: join(root, "diff.patch") });
      expect(diff.rawDiff).toContain("return 42");
      expect(diff.rawDiff).not.toContain("tests/test_functional.js");
      expect(diff.rawDiff).not.toContain(".agenteval/environment");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows public repository tests but rejects protected grading copies", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-public-tests-"));
    try {
      const accepted = await materializeEvalPackage({
        upload: validEvalPackageUpload({
          "environment/repo/tests/public.test.js": "// public repository test\n",
        }),
        destination: join(root, "accepted"),
      });
      expect(accepted.validation.valid).toBe(true);

      await expect(materializeEvalPackage({
        upload: validEvalPackageUpload({
          "environment/repo/tests/oracle/expected.json": "{\"value\":42}\n",
        }),
        destination: join(root, "rejected"),
      })).rejects.toThrow(/protected grading content/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads runtime settings only from digest-covered task.toml", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-runtime-config-"));
    try {
      const result = await materializeEvalPackage({
        upload: validEvalPackageUpload(),
        destination: join(root, "package"),
      });
      const config = await loadEvalPackageRuntimeConfig({
        packagePath: result.packagePath,
        packageDigest: result.packageDigest,
        manifest: {
          ...result.manifest,
          taskConfig: {
            timeouts: { agent_seconds: 9999 },
            verifier: { command: ["/tampered"] },
          },
        },
      });
      expect(config.agentTimeoutMs).toBe(120_000);
      expect(config.verifierCommand).toEqual(["/tests/test.sh"]);
      expect(config.verifierChecks.map((check) => check.kind)).toEqual([
        "functional",
        "hidden_test",
        "regression",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing required files and path traversal", async () => {
    const missing = validEvalPackageUpload();
    delete missing.files["tests/Dockerfile"];
    await expect(materializeEvalPackage({
      upload: missing,
      destination: join(tmpdir(), `invalid-eval-${Date.now()}`),
    })).rejects.toThrow(/tests\/Dockerfile/);
    expect(() => decodePackageFiles({ files: { "../solution.txt": "leak" } })).toThrow(/unsafe/);
  });

  it("rejects duplicate verifier check ids", async () => {
    const upload = validEvalPackageUpload();
    const taskToml = String(upload.files["task.toml"]);
    upload.files["task.toml"] = taskToml.replace(
      '{ id = "hidden-edge", kind = "hidden_test" }',
      '{ id = "functional-value", kind = "hidden_test" }',
    );
    await expect(materializeEvalPackage({
      upload,
      destination: join(tmpdir(), `duplicate-check-${Date.now()}`),
    })).rejects.toThrow(/duplicate verifier check id/);
  });

  it("rejects an environment Dockerfile that does not inherit the selected adapter image", async () => {
    await expect(materializeEvalPackage({
      upload: validEvalPackageUpload({
        "environment/Dockerfile": "FROM node:22\n",
      }),
      destination: join(tmpdir(), `invalid-image-${Date.now()}`),
    })).rejects.toThrow(/AGENTEVAL_AGENT_IMAGE/);
  });
});

describe("eval archive transport", () => {
  it("rejects traversal before single-root normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-traversal-"));
    const zipPath = join(root, "traversal.zip");
    try {
      const zip = new yazl.ZipFile();
      const safeName = "wrapper/xx/instruction.md";
      const unsafeName = "wrapper/../instruction.md";
      zip.addBuffer(Buffer.from("prompt"), safeName);
      zip.end();
      const chunks: Buffer[] = [];
      for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
      let bytes = Buffer.concat(chunks);
      let offset = bytes.indexOf(safeName);
      while (offset >= 0) {
        Buffer.from(unsafeName).copy(bytes, offset);
        offset = bytes.indexOf(safeName, offset + safeName.length);
      }
      await writeFile(zipPath, bytes);
      await expect(decodeEvalArchiveFile(zipPath, "zip")).rejects.toThrow(/traversal|relative path|unsafe/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts TAR.GZ and ZIP archives through the same package decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-archive-"));
    const source = join(root, "source");
    const upload = validEvalPackageUpload();
    try {
      for (const [path, value] of Object.entries(upload.files)) {
        const content = typeof value === "string" ? value : Buffer.from(value.content, value.encoding === "base64" ? "base64" : "utf8");
        const full = join(source, path);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(join(full, ".."), { recursive: true }));
        await writeFile(full, content);
      }
      const tarPath = join(root, "eval.tar.gz");
      await createTar({ cwd: source, file: tarPath, gzip: true }, ["."]);
      const tarUpload = await decodeEvalArchiveFile(tarPath, "tar.gz");
      expect(Object.keys(tarUpload.files)).toContain("instruction.md");

      const zipPath = join(root, "eval.zip");
      const zip = new yazl.ZipFile();
      for (const [path, value] of Object.entries(upload.files)) {
        const content = typeof value === "string" ? Buffer.from(value) : Buffer.from(value.content, value.encoding === "base64" ? "base64" : "utf8");
        zip.addBuffer(content, `eval-name/${path}`);
      }
      zip.end();
      await new Promise<void>((resolve, reject) => {
        zip.outputStream.pipe(createWriteStream(zipPath)).on("close", resolve).on("error", reject);
      });
      const zipUpload = await decodeEvalArchiveFile(zipPath, "zip");
      expect(Object.keys(zipUpload.files)).toContain("instruction.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

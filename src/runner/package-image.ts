/**
 * Build the agent image for a suite eval task: build the suite's own
 * environment image as-is, then overlay the reaper CLI runtime on top so the
 * agent container has both the task toolchain and the reaper CLI. The suite
 * author's Dockerfile is never rewritten; a generated Containerfile.agenteval
 * adds a `FROM` stage that copies the reaper runtime in.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../db/queries.js";
import {
  evalEnvironmentDigest,
  loadEvalPackageRuntimeConfig,
  verifyMaterializedEvalPackage,
} from "../evals/package.js";
import type { ContainerRuntime } from "./runtime.js";

export interface BuiltEvalAgentImage {
  image: string;
  imageId: string;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the agent image for one suite eval task. The suite's own environment
 * image is built unchanged; a wrapper stage overlays the reaper runtime from
 * the project's real reaper CLI image.
 */
export async function buildEvalAgentImage(input: {
  runtime: ContainerRuntime;
  task: Task;
  adapterImage: string;
  buildRoot: string;
}): Promise<BuiltEvalAgentImage> {
  const task = input.task;
  if (!task.packagePath || !task.packageDigest || !task.packageManifest) {
    throw new Error(`eval ${task.id} is not a canonical package`);
  }
  await verifyMaterializedEvalPackage({
    packagePath: task.packagePath,
    packageDigest: task.packageDigest,
    manifest: task.packageManifest,
  });
  const config = await loadEvalPackageRuntimeConfig({
    packagePath: task.packagePath,
    packageDigest: task.packageDigest,
    manifest: task.packageManifest,
  });
  if (config.suite === false) {
    // Legacy canonical path: inject the adapter image via the placeholder.
    return buildLegacyAgentImage(input);
  }
  const environmentDigest = evalEnvironmentDigest(task.packageManifest);
  const key = createHash("sha256")
    .update(input.adapterImage)
    .update("\0")
    .update(environmentDigest)
    .digest("hex");
  const suiteEnvImage = `agenteval/suite-env:${environmentDigest.slice(0, 24)}`;
  // The suite env Dockerfile COPYs seed_repo/ and instruction.md from the build
  // context root, so the context must be the package root minus protected dirs.
  const contextDir = join(input.buildRoot, `${key}-env`);
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });
  await copySuiteBuildContext(task.packagePath, contextDir);
  await input.runtime.buildImage({
    contextDir,
    containerfilePath: "environment/Dockerfile",
    image: suiteEnvImage,
    timeoutMs: config.buildTimeoutMs,
  });

  // Wrapper that overlays the reaper runtime onto the suite env image. The
  // `adapterImage` (the project's real reaper CLI image) provides the runtime;
  // we copy its reaper CLI + node modules onto the suite image so the agent
  // container has both the task toolchain and reaper.
  const wrapperDir = join(input.buildRoot, `${key}-wrapper`);
  await rm(wrapperDir, { recursive: true, force: true });
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(join(wrapperDir, "Containerfile.agenteval"), [
    `FROM ${suiteEnvImage}`,
    "USER root",
    `COPY --from=${input.adapterImage} /usr/local/lib/node_modules /usr/local/lib/node_modules`,
    `COPY --from=${input.adapterImage} /usr/local/bin /usr/local/bin`,
    `COPY --from=${input.adapterImage} /opt/reapercode /opt/reapercode`,
    "RUN ln -sf /opt/reapercode/bin/reaper /usr/local/bin/reaper",
    `USER 10001`,
  ].join("\n") + "\n", "utf8");
  const image = `agenteval/eval-agent:${key.slice(0, 32)}`;
  const result = await input.runtime.buildImage({
    contextDir: wrapperDir,
    containerfilePath: "Containerfile.agenteval",
    image,
    timeoutMs: config.buildTimeoutMs,
  });
  return result;
}

/** Copy the package root into a build context, excluding protected dirs. */
async function copySuiteBuildContext(packageRoot: string, dest: string): Promise<void> {
  for (const entry of await import("node:fs/promises").then(({ readdir }) => readdir(packageRoot))) {
    if (entry === "solution" || entry === "tests" || entry === "validation") continue;
    await cp(join(packageRoot, entry), join(dest, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

/** Rehydrate the legacy canonical path (placeholder FROM injection). */
async function buildLegacyAgentImage(input: {
  runtime: ContainerRuntime;
  task: Task;
  adapterImage: string;
  buildRoot: string;
}): Promise<BuiltEvalAgentImage> {
  const { task } = input;
  const config = await loadEvalPackageRuntimeConfig({
    packagePath: task.packagePath!,
    packageDigest: task.packageDigest!,
    manifest: task.packageManifest!,
  });
  const environmentDigest = evalEnvironmentDigest(task.packageManifest!);
  const key = createHash("sha256")
    .update(input.adapterImage)
    .update("\0")
    .update(environmentDigest)
    .digest("hex");
  const contextDir = join(input.buildRoot, key);
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });
  await cp(join(task.packagePath!, "environment"), contextDir, { recursive: true });
  await rm(join(contextDir, "repo"), { recursive: true, force: true });
  const original = await readFile(join(contextDir, "Dockerfile"), "utf8");
  const replaced = original.replace(
    /^\s*FROM\s+\$\{?AGENTEVAL_AGENT_IMAGE\}?(?=\s|$)/gim,
    `FROM ${input.adapterImage}`,
  );
  if (replaced === original) {
    throw new Error("environment/Dockerfile does not contain FROM ${AGENTEVAL_AGENT_IMAGE}");
  }
  await writeFile(join(contextDir, "Containerfile.agenteval"), replaced, "utf8");
  const image = `agenteval/eval-agent:${key.slice(0, 32)}`;
  return input.runtime.buildImage({
    contextDir,
    containerfilePath: "Containerfile.agenteval",
    image,
    timeoutMs: config.buildTimeoutMs,
  });
}



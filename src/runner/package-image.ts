/** Build an agent image from the isolated environment/ context only. */

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

/** Inject the selected adapter image into a package's environment Dockerfile. */
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
  const environmentDigest = evalEnvironmentDigest(task.packageManifest);
  const key = createHash("sha256")
    .update(input.adapterImage)
    .update("\0")
    .update(environmentDigest)
    .digest("hex");
  const contextDir = join(input.buildRoot, key);
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });
  await cp(join(task.packagePath, "environment"), contextDir, { recursive: true });
  // Repository seeds are mounted at runtime and never baked into the shared
  // queue image, so different evals may share one environment image safely.
  await rm(join(contextDir, "repo"), { recursive: true, force: true });
  const original = await readFile(join(contextDir, "Dockerfile"), "utf8");
  const replaced = original.replace(
    /^\s*FROM\s+\$\{?AGENTEVAL_AGENT_IMAGE\}?(?=\s|$)/gim,
    `FROM ${input.adapterImage}`,
  );
  if (replaced === original) {
    throw new Error("environment/Dockerfile does not contain FROM ${AGENTEVAL_AGENT_IMAGE}");
  }
  const containerfilePath = "Containerfile.agenteval";
  await writeFile(join(contextDir, containerfilePath), replaced, "utf8");
  const image = `agenteval/eval-agent:${key.slice(0, 32)}`;
  const result = await input.runtime.buildImage({
    contextDir,
    containerfilePath,
    image,
    timeoutMs: config.buildTimeoutMs,
  });
  return result;
}

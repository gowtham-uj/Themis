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

/** Tag of the prebuilt reaper CLI runtime layer overlay stage. */
export const REAPER_CLI_LAYER = "agenteval/reaper-cli-runtime:latest";

/**
 * One-time build of the reaper CLI runtime layer: a self-contained node
 * runtime (for non-node suite base images) plus the reaper CLI install. This
 * image is used as `COPY --from=...` by every suite agent-image build.
 */
export async function ensureReaperCliLayer(runtime: ContainerRuntime): Promise<void> {
  const containerfile = `FROM docker.io/library/node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/reapercode
COPY reaper-src/ /opt/reapercode/
RUN npm ci && npm run build && ln -s /opt/reapercode/bin/reaper /usr/local/bin/reaper
CMD ["reaper", "--help"]
`;
  const dir = "/tmp/agenteval-reaper-cli-layer";
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp("/work/_inspect/reaper", join(dir, "reaper-src"), { recursive: true });
  await writeFile(join(dir, "Containerfile"), containerfile, "utf8");
  try {
    await runtime.buildImage({
      contextDir: dir,
      containerfilePath: "Containerfile",
      image: REAPER_CLI_LAYER,
      timeoutMs: 15 * 60_000,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Build the agent image for one suite eval task. The suite's own environment
 * image is built unchanged; a wrapper stage overlays the reaper runtime.
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

  // Wrapper that overlays the reaper runtime onto the suite env image.
  const wrapperDir = join(input.buildRoot, `${key}-wrapper`);
  await rm(wrapperDir, { recursive: true, force: true });
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(join(wrapperDir, "Containerfile.agenteval"), [
    `FROM ${suiteEnvImage}`,
    "USER root",
    "COPY --from=agenteval/reaper-cli-runtime:latest /usr/local/lib/node_modules /usr/local/lib/node_modules",
    "COPY --from=agenteval/reaper-cli-runtime:latest /usr/local/bin /usr/local/bin",
    "COPY --from=agenteval/reaper-cli-runtime:latest /opt/reapercode /opt/reapercode",
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



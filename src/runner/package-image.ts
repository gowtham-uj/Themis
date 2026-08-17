/**
 * Build the agent image for a suite eval task. Suite evals share ONE
 * platform-provided "fat base" image (Debian + build-essential + git) across the
 * whole queue; each eval installs its own language toolchain at eval time via
 * setup.sh and removes it via cleanup.sh. The reaper CLI runtime is overlaid onto
 * the fat base once per adapter. Heterogeneous suite evals resolve to the same
 * image, so they can run sequentially in one persistent queue container.
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
 * Platform fat base for suite-format evals: one shared image carrying only the
 * common toolchain (build-essential, git, apt, sudo). Each eval's setup.sh
 * installs its own language at eval time and cleanup.sh removes it. The reaper
 * CLI is layered on top via the wrapper stage (see {@link buildEvalAgentImage}).
 */
const SUITE_BASE_CONTAINERFILE = [
  "FROM docker.io/library/debian:bookworm-slim",
  "RUN apt-get update \\",
  " && apt-get install -y --no-install-recommends \\",
  "      build-essential libc6-dev git sudo apt procps ca-certificates bash coreutils findutils \\",
  " && rm -rf /var/lib/apt/lists/* \\",
  " && useradd --create-home --uid 10001 --shell /bin/bash agent \\",
  " && echo 'agent ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \\",
  " && mkdir -p /workspace/task /workspace/.agenteval/environment \\",
  " && chown -R 10001:10001 /workspace",
  "WORKDIR /workspace/task",
  "USER 10001",
].join("\n") + "\n";

/**
 * Build the agent image for one suite eval task. The base is a shared
 * platform-provided fat image (built once, cached); the reaper CLI runtime is
 * overlaid from the project's real adapter image.
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
  // Fat base, content-addressed by the base Containerfile. Built once and shared
  // across every suite eval (and across queues), guarded by image existence so
  // repeated runs do not rebuild it.
  const baseDigest = createHash("sha256")
    .update(SUITE_BASE_CONTAINERFILE, "utf8")
    .digest("hex");
  const fatBaseImage = `agenteval/suite-fat-base:${baseDigest.slice(0, 24)}`;
  if (!(await input.runtime.imageExists(fatBaseImage))) {
    const baseDir = join(input.buildRoot, "suite-fat-base");
    await rm(baseDir, { recursive: true, force: true });
    await mkdir(baseDir, { recursive: true });
    await writeFile(join(baseDir, "Containerfile"), SUITE_BASE_CONTAINERFILE, "utf8");
    await input.runtime.buildImage({
      contextDir: baseDir,
      containerfilePath: "Containerfile",
      image: fatBaseImage,
      timeoutMs: config.buildTimeoutMs,
    });
  }

  // The agent image key is derived from the adapter image's immutable content id
  // (when available) + the (constant) base digest + the overlay script itself —
  // NOT the per-eval environment digest — so heterogeneous suite evals resolve
  // to the SAME image and can share one persistent queue container. Keying by
  // the image *id* (not the tag string) means retagging a tag to new content
  // invalidates the cache; keying by the overlay script means an edit to how we
  // assemble the agent image also invalidates it (not just the adapter image).
  //
  // Wrapper that overlays the agent runtime onto the fat base. The adapter image
  // is self-contained: it carries the agent CLI (node_modules + built bin/, or a
  // committed single-file bundle) and its own /usr/local/bin shims. Copy both
  // trees verbatim; the shim already resolves the real entrypoint, so do NOT
  // re-symlink over it (that broke the bundle layout where
  // /opt/reapercode/bin/reaper does not exist).
  const overlayScript = [
    `FROM ${fatBaseImage}`,
    "USER root",
    `COPY --from=${input.adapterImage} /usr/local/lib/node_modules /usr/local/lib/node_modules`,
    `COPY --from=${input.adapterImage} /usr/local/bin /usr/local/bin`,
    `COPY --from=${input.adapterImage} /opt/reapercode /opt/reapercode`,
    `USER 10001`,
  ].join("\n") + "\n";
  const adapterImageId = (await input.runtime.imageId?.(input.adapterImage)) ?? input.adapterImage;
  const key = createHash("sha256")
    .update(adapterImageId)
    .update("\0")
    .update(baseDigest)
    .update("\0")
    .update(overlayScript)
    .digest("hex");

  const wrapperDir = join(input.buildRoot, `${key}-wrapper`);
  await rm(wrapperDir, { recursive: true, force: true });
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(join(wrapperDir, "Containerfile.agenteval"), overlayScript, "utf8");
  const image = `agenteval/suite-base:${key.slice(0, 32)}`;
  // The wrapper is content-addressed by adapter+base; if an image for this key
  // already exists in the backend, reuse it instead of re-running the overlay build.
  if (await input.runtime.imageExists(image)) {
    return {
      image,
      imageId: image,
      durationMs: 0,
      stdout: "",
      stderr: "",
    };
  }
  const result = await input.runtime.buildImage({
    contextDir: wrapperDir,
    containerfilePath: "Containerfile.agenteval",
    image,
    timeoutMs: config.buildTimeoutMs,
  });
  return result;
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



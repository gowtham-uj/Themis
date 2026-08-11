/** Build and run the hidden verifier in a container separate from the agent. */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../db/queries.js";
import {
  loadEvalPackageRuntimeConfig,
  verifyMaterializedEvalPackage,
  type EvalPackageVerifierCheck,
} from "../evals/package.js";
import type { CheckResult } from "../judge/verdict.js";
import type { ContainerRuntime } from "./runtime.js";

export interface PackageVerifierResult {
  schemaVersion: 1;
  runId: string;
  image: string;
  imageId: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  officialReward: 0 | 1;
  checks: CheckResult[];
  stdoutPath: string;
  stderrPath: string;
  resultSha256: string | null;
}

/** Run a package's hidden verifier after the agent process has ended. */
export async function runCanonicalPackageVerifier(input: {
  runtime: ContainerRuntime;
  task: Task;
  runId: string;
  workspaceDir: string;
  runDir: string;
}): Promise<PackageVerifierResult> {
  const { task } = input;
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
  if (config.verifierCommand.length === 0) {
    throw new Error("canonical eval verifier command is empty");
  }
  const verifierContext = join(task.packagePath, "tests");
  const image = `agenteval/verifier:${task.packageDigest.slice(0, 24)}`;
  const build = await input.runtime.buildImage({
    contextDir: verifierContext,
    containerfilePath: "Dockerfile",
    image,
    timeoutMs: config.buildTimeoutMs,
  });

  const resultPath = join(input.workspaceDir, ".agenteval", "verifier-results.json");
  await rm(resultPath, { force: true });
  await mkdir(join(input.workspaceDir, ".agenteval"), { recursive: true });
  const verifierStartedAt = Date.now();
  const handle = await input.runtime.run({
    image,
    workspaceDir: input.workspaceDir,
    argv: config.verifierCommand,
    env: {
      AGENTEVAL_TRIAL_ID: input.runId,
      AGENTEVAL_VERIFIER_RESULTS: "/workspace/.agenteval/verifier-results.json",
    },
    limits: { cpus: config.cpus, pids: 256 },
    timeoutMs: config.verifierTimeoutMs,
    network: "offline",
    nonRoot: false,
    workdir: "/workspace",
  });
  const stdoutPath = join(input.runDir, "verifier-stdout.log");
  const stderrPath = join(input.runDir, "verifier-stderr.log");
  try {
    const [stdout, stderr, wait] = await Promise.all([
      drain(handle.stdout()),
      drain(handle.stderr()),
      handle.wait(),
    ]);
    await writeFile(stdoutPath, stdout);
    await writeFile(stderrPath, stderr);
    const parsed = await readVerifierResults(resultPath, config.verifierChecks, wait.exitCode);
    const checks = wait.timedOut
      ? config.verifierChecks.map((check) => ({
          checkId: check.id,
          kind: check.kind,
          status: "error" as const,
          detail: "isolated verifier timed out",
        }))
      : parsed.checks;
    const officialReward: 0 | 1 =
      !wait.timedOut && wait.exitCode === 0 && checks.length > 0 &&
      checks.every((check) => check.status === "pass")
        ? 1
        : 0;
    return {
      schemaVersion: 1,
      runId: input.runId,
      image,
      imageId: build.imageId,
      exitCode: wait.exitCode,
      timedOut: wait.timedOut,
      durationMs: Date.now() - verifierStartedAt,
      officialReward,
      checks,
      stdoutPath,
      stderrPath,
      resultSha256: parsed.sha256,
    };
  } finally {
    await handle.remove().catch(() => undefined);
  }
}

async function readVerifierResults(
  path: string,
  expectedChecks: EvalPackageVerifierCheck[],
  exitCode: number,
): Promise<{ checks: CheckResult[]; sha256: string | null }> {
  const errorChecks = (detail: string): CheckResult[] => expectedChecks.map((check) => ({
    checkId: check.id,
    kind: check.kind,
    status: "error",
    detail,
  }));
  const raw = await readFile(path).catch(() => null);
  if (!raw) {
    return {
      checks: errorChecks(`verifier exited ${exitCode} without writing verifier-results.json`),
      sha256: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return {
      checks: errorChecks("verifier-results.json is invalid JSON"),
      sha256: sha256(raw),
    };
  }
  const values = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    Array.isArray((parsed as { checks?: unknown }).checks)
    ? (parsed as { checks: unknown[] }).checks
    : [];
  const expectedById = new Map(expectedChecks.map((check) => [check.id, check]));
  const byId = new Map<string, CheckResult>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const checkId = typeof record.id === "string"
      ? record.id
      : typeof record.check_id === "string"
        ? record.check_id
        : "";
    const expected = expectedById.get(checkId);
    const status = record.status;
    if (!expected || !["pass", "fail", "error", "skipped"].includes(String(status))) continue;
    if (byId.has(checkId)) {
      duplicates.add(checkId);
      continue;
    }
    if (record.kind !== undefined && record.kind !== expected.kind) {
      byId.set(checkId, {
        checkId,
        kind: expected.kind,
        status: "error",
        detail: `verifier result kind ${String(record.kind)} does not match declared ${expected.kind}`,
      });
      continue;
    }
    byId.set(checkId, {
      checkId,
      kind: expected.kind,
      status: status as CheckResult["status"],
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      ...(typeof record.duration_ms === "number" ? { durationMs: record.duration_ms } : {}),
      ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}),
    });
  }
  const checks = expectedChecks.map((expected) => duplicates.has(expected.id)
    ? {
        checkId: expected.id,
        kind: expected.kind,
        status: "error" as const,
        detail: "declared verifier check appears more than once in verifier-results.json",
      }
    : byId.get(expected.id) ?? {
        checkId: expected.id,
        kind: expected.kind,
        status: "error" as const,
        detail: "declared verifier check missing from verifier-results.json",
      });
  return { checks, sha256: sha256(raw) };
}

async function drain(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

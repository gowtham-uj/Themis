/** Build and run the hidden verifier in a container separate from the agent. */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "../db/queries.js";
import {
  AGENT_TASK_WORKSPACE,
  loadEvalPackageRuntimeConfig,
  verifyMaterializedEvalPackage,
  type EvalPackageRuntimeConfig,
  type EvalPackageVerifierCheck,
} from "../evals/package.js";
import type { CheckResult } from "../check-types.js";
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
  // Suite verifier Dockerfiles COPY tests/ from the package root, so the build
  // context is a package-root copy excluding protected dirs (solution/,
  // validation/, seed_repo/). Legacy verifiers build from tests/ directly.
  const verifierContext = config.suite
    ? await verifierSuiteContext(task.packagePath)
    : join(task.packagePath, "tests");
  const image = `agenteval/verifier:${task.packageDigest.slice(0, 24)}`;
  const build = await input.runtime.buildImage({
    contextDir: verifierContext,
    containerfilePath: config.suite ? "tests/Dockerfile" : "Dockerfile",
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
    // The suite verifier image sets ENTRYPOINT /verifier/test.sh and takes the
    // graded submission path as its argv[1] (CMD). Legacy verifiers pass the
    // full command as argv.
    argv: config.suite ? [AGENT_TASK_WORKSPACE] : config.verifierCommand,
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
    const parsed = await readVerifierResults(
      resultPath,
      stdout,
      config,
      wait.exitCode,
    );
    const checks = wait.timedOut
      ? (config.suite
          ? [{
              checkId: "verifier",
              kind: "test_suite",
              status: "error" as const,
              detail: "isolated verifier timed out",
            }]
          : config.verifierChecks.map((check) => ({
              checkId: check.id,
              kind: check.kind,
              status: "error" as const,
              detail: "isolated verifier timed out",
            })))
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
  stdout: Buffer,
  config: EvalPackageRuntimeConfig,
  exitCode: number,
): Promise<{ checks: CheckResult[]; sha256: string | null }> {
  if (config.suite) return parseSuiteVerifier(stdout, exitCode);
  // ---- legacy canonical verifier-results.json contract ----
  const raw = await readFile(path).catch(() => null);
  const errorChecks = (detail: string): CheckResult[] => config.verifierChecks.map((check) => ({
    checkId: check.id,
    kind: check.kind,
    status: "error",
    detail,
  }));
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
    return { checks: errorChecks("verifier-results.json is invalid JSON"), sha256: sha256(raw) };
  }
  const values = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    Array.isArray((parsed as { checks?: unknown }).checks)
    ? (parsed as { checks: unknown[] }).checks
    : [];
  const expectedById = new Map(config.verifierChecks.map((check) => [check.id, check]));
  const byId = new Map<string, CheckResult>();
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
    byId.set(checkId, {
      checkId,
      kind: expected.kind,
      status: status as CheckResult["status"],
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      ...(typeof record.duration_ms === "number" ? { durationMs: record.duration_ms } : {}),
      ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}),
    });
  }
  const checks = config.verifierChecks.map((expected) => byId.get(expected.id) ?? {
    checkId: expected.id,
    kind: expected.kind,
    status: "error" as const,
    detail: "declared verifier check missing from verifier-results.json",
  });
  return { checks, sha256: raw ? sha256(raw) : null };
}

/**
 * Parse the suite verifier's stdout JSON contract:
 *   {"task_id":..,"reward":0|1,"passed":bool,"checks":[{name,passed,detail}]}
 * The last non-empty stdout line carries the JSON. Map each check name to a kind:
 * public_tests->functional, hidden_contract->hidden_test, else test_suite.
 */
function parseSuiteVerifier(stdout: Buffer, exitCode: number): { checks: CheckResult[]; sha256: string | null } {
  const text = stdout.toString("utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let payload: unknown = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      payload = JSON.parse(lines[i]!);
      break;
    } catch {
      /* try earlier line */
    }
  }
  const sha = sha256(stdout);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { checks: [{ checkId: "verifier", kind: "test_suite", status: "error", detail: "suite verifier stdout was not valid JSON" }], sha256: sha };
  }
  const record = payload as { reward?: unknown; passed?: unknown; checks?: unknown };
  if (!Array.isArray(record.checks)) {
    return { checks: [{ checkId: "verifier", kind: "test_suite", status: "error", detail: "suite verifier JSON missing checks[]" }], sha256: sha };
  }
  const checks: CheckResult[] = record.checks.map((value) => {
    const entry = (value ?? {}) as { name?: unknown; passed?: unknown; detail?: unknown };
    const name = typeof entry.name === "string" ? entry.name : "check";
    const kind = inferSuiteCheckKind(name);
    return {
      checkId: name,
      kind,
      status: entry.passed ? "pass" : "fail",
      ...(typeof entry.detail === "string" && entry.detail ? { detail: entry.detail } : {}),
    };
  });
  // If the verifier exited non-zero while claiming a non-empty check set, mark
  // any "pass"-looking absence as error by keeping the exit-code signal.
  const passed = record.passed === true || record.reward === 1;
  if (exitCode !== 0 && checks.length > 0 && checks.every((check) => check.status === "pass")) {
    checks[0] = { ...checks[0]!, status: "error", detail: `suite verifier exited ${exitCode} despite passing checks` };
  }
  if (checks.length === 0) {
    return { checks: [{ checkId: "verifier", kind: "test_suite", status: passed ? "pass" : "error", detail: "suite verifier returned no checks" }], sha256: sha };
  }
  return { checks, sha256: sha };
}

function inferSuiteCheckKind(name: string): string {
  if (name === "public_tests") return "functional";
  if (name === "hidden_contract") return "hidden_test";
  return "test_suite";
}

import { cp } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Build a package-root verifier context excluding solution/validation/seed_repo. */
async function verifierSuiteContext(packageRoot: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-verifier-ctx-"));
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(packageRoot)) {
    if (entry === "solution" || entry === "validation" || entry === "seed_repo") continue;
    await cp(join(packageRoot, entry), join(dir, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  return dir;
}

async function drain(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

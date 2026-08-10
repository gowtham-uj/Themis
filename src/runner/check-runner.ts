/**
 * Deterministic check-runner — executes each rubric Check and records
 * pass/fail/error/skipped with detail. Results feed the judge as pass-rates
 * and criterion grounding (plan/rubric.md §5 + §7).
 *
 * Execution seam: ContainerRuntime.run (never inline podman/docker CLI).
 * Commands always execute in real containers, normally the agent image.
 *
 * Captured command output and secret-scan evidence are persisted verbatim.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Check, Rubric } from "../domain.js";
import type { CheckResult } from "../judge/verdict.js";
import { resolveTaskChecks } from "../judge/check-results.js";
import type { ContainerHandle, ContainerRuntime } from "./runtime.js";

/** Project slice needed by the check-runner. */
export interface CheckProject {
  id: string;
  checkRunners?: Record<string, string> | null;
}

/** Task slice needed by the check-runner. */
export interface CheckTask {
  id?: string;
  checks?: unknown[] | null;
  rubric?: Rubric | unknown;
}

/** Optional persistence surface (both SqliteQueries + MemoryQueries). */
export interface CheckResultStore {
  storeCheckResults?(runId: string, results: CheckResult[]): void;
}

/** Options for {@link runChecks}. */
export interface RunChecksOptions {
  /** Host workspace the agent edited (default: runDir). */
  workspaceDir?: string;
  /** Run id for DB persistence. */
  runId?: string;
  /** Hard wall-clock per check (default 60s). */
  timeoutMs?: number;
  /**
   * Real OCI image for ContainerRuntime.run.
   * Default: `node:22-bookworm-slim`.
   */
  image?: string;
  /** Existing queue container; when present checks run in it via exec. */
  container?: ContainerHandle;
  /** Working directory inside an existing queue container. Default `/workspace`. */
  containerCwd?: string;
  /** When set, also write checks.json under runDir. Default true. */
  writeArtifact?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_IMAGE = "docker.io/library/node:22-bookworm-slim";

/** On-disk artifact name written under the run dir. */
export const CHECKS_ARTIFACT = "checks.json";

/**
 * Execute each Check on the task (rubric.checks or task.checks) and return
 * CheckResult[]. Optionally persists via queries.storeCheckResults and always
 * (by default) writes checks.json under runDir.
 */
export async function runChecks(
  queries: CheckResultStore | null | undefined,
  runtime: ContainerRuntime,
  project: CheckProject,
  task: CheckTask,
  runDir: string,
  opts: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const checks = resolveTaskChecks(task);
  if (checks.length === 0) return [];

  const workspaceDir = resolve(opts.workspaceDir ?? runDir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const image = opts.image ?? DEFAULT_IMAGE;
  const runners = project.checkRunners ?? {};

  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await executeOneCheck(check, {
      runtime,
      runners,
      workspaceDir,
      runDir,
      timeoutMs,
      image,
      container: opts.container,
      containerCwd: opts.containerCwd ?? "/workspace",
    });
    results.push(result);
  }

  // Persist to disk (primary artifact for the judge worker).
  if (opts.writeArtifact !== false) {
    try {
      await writeFile(
        join(runDir, CHECKS_ARTIFACT),
        `${JSON.stringify(results, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // best-effort — results are still returned to the caller
    }
  }

  // Optional DB mirror.
  const runId = opts.runId;
  if (runId && queries && typeof queries.storeCheckResults === "function") {
    try {
      queries.storeCheckResults(runId, results);
    } catch {
      // never break the runner for persistence
    }
  }

  return results;
}

interface ExecCtx {
  runtime: ContainerRuntime;
  runners: Record<string, string>;
  workspaceDir: string;
  runDir: string;
  timeoutMs: number;
  image: string;
  container?: ContainerHandle;
  containerCwd: string;
}

async function executeOneCheck(
  check: Check,
  ctx: ExecCtx,
): Promise<CheckResult> {
  const started = Date.now();
  try {
    switch (check.kind) {
      case "secret_scan":
        return await runSecretScan(check, ctx.runDir, started);
      case "http":
        return await runHttpCheck(check, started);
      case "repro":
        return await runCommandCheck(check, ctx, started, /*repro*/ true);
      case "test_suite":
      case "build":
      case "typecheck":
      case "lint":
      case "perf_bench":
      case "command":
        return await runCommandCheck(check, ctx, started, false);
      default:
        return {
          checkId: check.id,
          kind: check.kind,
          status: "skipped",
          detail: `unsupported check kind: ${String(check.kind)}`,
          durationMs: Date.now() - started,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      checkId: check.id,
      kind: check.kind,
      status: "error",
      detail: message,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Map Check.kind → command string via project.checkRunners; Check.command overrides.
 * Returns null when neither is available (caller marks skipped).
 */
export function resolveCheckCommand(
  check: Check,
  runners: Record<string, string>,
): string | null {
  if (typeof check.command === "string" && check.command.trim().length > 0) {
    return check.command.trim();
  }
  const tmpl = runners[check.kind];
  if (typeof tmpl === "string" && tmpl.trim().length > 0) return tmpl.trim();
  return null;
}

async function runCommandCheck(
  check: Check,
  ctx: ExecCtx,
  started: number,
  isRepro: boolean,
): Promise<CheckResult> {
  const command = resolveCheckCommand(check, ctx.runners);
  if (!command) {
    return {
      checkId: check.id,
      kind: check.kind,
      status: "skipped",
      detail: `no command template for kind "${check.kind}" and no check.command override`,
      durationMs: Date.now() - started,
    };
  }

  const { exitCode, stdout, stderr, timedOut } = await execViaRuntime(
    ctx.runtime,
    command,
    ctx.workspaceDir,
    ctx.timeoutMs,
    ctx.image,
    ctx.container,
    ctx.containerCwd,
  );

  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  const durationMs = Date.now() - started;

  if (timedOut) {
    return {
      checkId: check.id,
      kind: check.kind,
      status: "error",
      detail: `timed out after ${ctx.timeoutMs}ms: ${command}`,
      durationMs,
      exitCode,
    };
  }

  // repro: pass only when exit 0 (and optional expected-output match later).
  // Other command-like checks: exit 0 → pass, else fail.
  if (exitCode === 0) {
    return {
      checkId: check.id,
      kind: check.kind,
      status: "pass",
      detail: isRepro
        ? `repro command exited 0${output ? `: ${truncate(output, 400)}` : ""}`
        : output
          ? truncate(output, 400)
          : `exit 0: ${command}`,
      durationMs,
      exitCode,
    };
  }

  return {
    checkId: check.id,
    kind: check.kind,
    status: "fail",
    detail: `exit ${exitCode}: ${command}${output ? `\n${truncate(output, 400)}` : ""}`,
    durationMs,
    exitCode,
  };
}

/** Execute a shell command in the queue container or a real helper container. */
async function execViaRuntime(
  runtime: ContainerRuntime,
  command: string,
  workspaceDir: string,
  timeoutMs: number,
  image: string,
  container: ContainerHandle | undefined,
  containerCwd: string,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  // Prefer /bin/sh -c so templates like "npm test" work unchanged.
  const argv = ["/bin/sh", "-c", command];

  if (container) {
    const result = await container.exec({
      argv,
      cwd: containerCwd,
      timeoutMs,
      maxOutputBytes: 1024 * 1024,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  const handle = await runtime.run({
    image,
    workspaceDir,
    argv,
    env: {},
    limits: { cpus: 1, pids: 128 },
    timeoutMs,
    network: "allow",
    nonRoot: true,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const collectStdout = (async () => {
    try {
      for await (const c of handle.stdout()) stdoutChunks.push(Buffer.from(c));
    } catch {
      // stream may error after kill
    }
  })();
  const collectStderr = (async () => {
    try {
      for await (const c of handle.stderr()) stderrChunks.push(Buffer.from(c));
    } catch {
      // stream may error after kill
    }
  })();

  try {
    const waitResult = await handle.wait();
    await Promise.all([collectStdout, collectStderr]);
    return {
      exitCode: waitResult.exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      timedOut: waitResult.timedOut,
    };
  } finally {
    try {
      await handle.remove();
    } catch {
      // best-effort
    }
  }
}

/** Scan runDir for secret patterns and report matching source lines. */
async function runSecretScan(
  check: Check,
  runDir: string,
  started: number,
): Promise<CheckResult> {
  const hits: string[] = [];
  try {
    await walkFiles(runDir, async (filePath) => {
      // Skip the checks artifact itself and binary-ish large files.
      if (filePath.endsWith(`/${CHECKS_ARTIFACT}`)) return;
      if (filePath.endsWith(".png") || filePath.endsWith(".jpg")) return;
      let content: string;
      try {
        const st = await stat(filePath);
        if (!st.isFile() || st.size > 1_000_000) return;
        content = await readFile(filePath, "utf8");
      } catch {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!lineLooksLikeSecret(line)) continue;
        const rel = filePath.startsWith(runDir)
          ? filePath.slice(runDir.length).replace(/^\//, "")
          : filePath;
        hits.push(`${rel}:${i + 1}: ${line}`);
        if (hits.length >= 20) return;
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      checkId: check.id,
      kind: check.kind,
      status: "error",
      detail: `secret_scan failed: ${message}`,
      durationMs: Date.now() - started,
    };
  }

  if (hits.length === 0) {
    return {
      checkId: check.id,
      kind: check.kind,
      status: "pass",
      detail: "no secrets detected",
      durationMs: Date.now() - started,
    };
  }

  return {
    checkId: check.id,
    kind: check.kind,
    status: "fail",
    detail: `secret patterns found (${hits.length}):\n${hits.join("\n")}`,
    durationMs: Date.now() - started,
  };
}

const SECRET_SCAN_PATTERNS = [
  /\b(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*[=:]\s*\S+/i,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/,
  /\bgh[opurs]_[A-Za-z0-9]{20,}\b/,
  /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"']{8,}/i,
] as const;

/** True when a line matches a high-signal credential pattern. */
function lineLooksLikeSecret(line: string): boolean {
  return SECRET_SCAN_PATTERNS.some((pattern) => pattern.test(line));
}

async function walkFiles(
  dir: string,
  onFile: (path: string) => Promise<void>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    // Skip noisy / non-artifact directories.
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === "raw" ||
      name === ".next"
    ) {
      continue;
    }
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walkFiles(full, onFile);
    } else if (st.isFile()) {
      await onFile(full);
    }
  }
}

/**
 * HTTP check: fetch url and assert status + optional bodyContains.
 * Uses global fetch (Node 22+). Offline tests inject a localhost capture server.
 */
async function runHttpCheck(
  check: Check,
  started: number,
): Promise<CheckResult> {
  const http = check.http;
  if (!http || typeof http.url !== "string" || !http.url) {
    return {
      checkId: check.id,
      kind: check.kind,
      status: "skipped",
      detail: "http check missing http.url",
      durationMs: Date.now() - started,
    };
  }

  const expectStatus = http.expectStatus ?? 200;
  try {
    const res = await fetch(http.url, {
      method: "GET",
      redirect: "manual",
      // Bound hang time via AbortSignal.
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    const durationMs = Date.now() - started;

    if (res.status !== expectStatus) {
      return {
        checkId: check.id,
        kind: check.kind,
        status: "fail",
        detail: `expected status ${expectStatus}, got ${res.status}`,
        durationMs,
      };
    }
    if (
      typeof http.expectBodyContains === "string" &&
      http.expectBodyContains.length > 0 &&
      !body.includes(http.expectBodyContains)
    ) {
      return {
        checkId: check.id,
        kind: check.kind,
        status: "fail",
        detail: `body missing expected substring: ${http.expectBodyContains}`,
        durationMs,
      };
    }
    return {
      checkId: check.id,
      kind: check.kind,
      status: "pass",
      detail: `status ${res.status} ok`,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      checkId: check.id,
      kind: check.kind,
      status: "error",
      detail: `http fetch failed: ${message}`,
      durationMs: Date.now() - started,
    };
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/**
 * Load previously persisted CheckResult[] from runDir/checks.json.
 * Returns [] when missing or unreadable.
 */
export async function loadCheckResults(
  runDir: string,
): Promise<CheckResult[]> {
  try {
    const raw = await readFile(join(runDir, CHECKS_ARTIFACT), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCheckResult) as CheckResult[];
  } catch {
    return [];
  }
}

function isCheckResult(v: unknown): v is CheckResult {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.checkId === "string" &&
    typeof o.kind === "string" &&
    typeof o.status === "string" &&
    ["pass", "fail", "error", "skipped"].includes(o.status)
  );
}

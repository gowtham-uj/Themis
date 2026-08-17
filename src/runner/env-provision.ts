/**
 * Eval environment provisioning — building the workspace an eval needs before
 * the agent is allowed to touch it.
 *
 * An eval declares its environment with a setup script. Two shapes:
 *
 *  - **greenfield** — the agent starts from nothing (or near it). The script
 *    scaffolds whatever the task needs: package manifests, a failing test,
 *    fixture data.
 *  - **brownfield** — the workspace starts as a real repo at a real ref, and
 *    the script prepares it (install deps, build, seed a database).
 *
 * An eval does NOT bring its own image. The pod image comes from the project /
 * adapter — it is the image the AGENT lives in — and the setup script runs in
 * that same image. That is the point: an environment built in some other image
 * might not be usable by the agent that has to work in it.
 *
 * The critical rule this module enforces: **the setup script runs INSIDE the
 * pod, and its output becomes the git baseline before the agent starts.**
 *
 * Both halves matter:
 *
 *  - *inside the pod*, because a script that runs on the host would install
 *    into the harness rather than the sandbox, and would be a straightforward
 *    arbitrary-code-execution path from eval definitions into the host.
 *  - *baseline before the agent*, because anything present-but-uncommitted at
 *    agent start shows up in the captured diff and gets attributed to the
 *    agent. `npm install` creating 12,000 files must not read as agent work.
 */

import type {
  ContainerHandle,
  ContainerRuntime,
  RunContainerSpec,
} from "./runtime.js";

/** Whether the eval starts from scratch or from an existing codebase. */
export type EnvKind = "greenfield" | "brownfield";

/** How an eval declares the environment it needs. */
export interface EvalEnvSpec {
  kind: EnvKind;
  /**
   * Shell script run inside the pod before the agent starts, with cwd set to
   * the workspace. Runs under `sh -euo pipefail`, so an unchecked failure
   * fails provisioning rather than silently producing a broken environment.
   */
  setupScript?: string;
  /** Seconds the setup script may run before it is killed. */
  setupTimeoutSec?: number;
  /** Env vars available to the setup script (not to the agent). */
  setupEnv?: Record<string, string>;
  /**
   * Whether setup output becomes the git baseline. Default true, which is
   * almost always right: only set false when the eval WANTS the agent to be
   * credited with what setup produced.
   */
  commitBaseline?: boolean;
  /**
   * Shell script run in the pod AFTER the agent finishes and after the diff and
   * traces have been captured, to leave the environment ready for the next
   * eval: stop services this eval started, drop databases it seeded, delete
   * scratch it left behind.
   *
   * Runs even when the agent failed — that is when cleanup matters most. Its
   * failure is recorded but never changes the eval's result: a run that
   * genuinely passed must not be reported as failed because teardown was
   * flaky.
   */
  cleanupScript?: string;
  /** Seconds the cleanup script may run before it is killed. */
  cleanupTimeoutSec?: number;
  /** Post-cleanup assertion; non-zero marks the queue container tainted. */
  cleanupVerifyScript?: string;
  /** Seconds the cleanup verification may run. */
  cleanupVerifyTimeoutSec?: number;
}

/** Result of provisioning, recorded as run provenance. */
export interface ProvisionResult {
  kind: EnvKind;
  ran: boolean;
  exitCode: number | null;
  /** Combined stdout+stderr, truncated — setup logs are diagnostic, not traces. */
  log: string;
  durationMs: number;
  /** Git sha of the baseline commit, when one was made. */
  baselineCommit: string | null;
  /** Populated when provisioning failed; the run must not start. */
  error: string | null;
}

/** Raised when an eval's environment could not be built. */
export class ProvisionError extends Error {
  readonly result: ProvisionResult;
  constructor(message: string, result: ProvisionResult) {
    super(message);
    this.name = "ProvisionError";
    this.result = result;
  }
}

const DEFAULT_SETUP_TIMEOUT_SEC = 600;

/** Printed by the setup wrapper when the image has no git binary. */
const NO_GIT_MARKER = "__agenteval_no_git__";
const MAX_LOG_BYTES = 64 * 1024;

/** Where the workspace is mounted inside the sandbox. */
const WORKSPACE = "/workspace";

/**
 * Parse a loose env spec from stored JSON.
 *
 * Malformed fields are dropped rather than passed through, so a bad eval
 * definition cannot produce a half-configured container.
 */
export function parseEvalEnvSpec(v: unknown): EvalEnvSpec | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;

  const rawKind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  const kind: EnvKind = rawKind === "brownfield" ? "brownfield" : "greenfield";

  const out: EvalEnvSpec = { kind };

  const script = o.setupScript ?? o.setup_script ?? o.setup;
  if (typeof script === "string" && script.trim()) out.setupScript = script;

  const timeout = o.setupTimeoutSec ?? o.setup_timeout_sec;
  const t = typeof timeout === "number" ? timeout : Number(timeout);
  if (Number.isFinite(t) && t > 0) out.setupTimeoutSec = Math.floor(t);

  const env = o.setupEnv ?? o.setup_env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const rec: Record<string, string> = {};
    for (const [k, val] of Object.entries(env as Record<string, unknown>)) {
      if (typeof val === "string") rec[k] = val;
    }
    if (Object.keys(rec).length > 0) out.setupEnv = rec;
  }

  const commit = o.commitBaseline ?? o.commit_baseline;
  if (typeof commit === "boolean") out.commitBaseline = commit;

  const cleanup = o.cleanupScript ?? o.cleanup_script ?? o.cleanup;
  if (typeof cleanup === "string" && cleanup.trim()) out.cleanupScript = cleanup;

  const cleanupTimeout = o.cleanupTimeoutSec ?? o.cleanup_timeout_sec;
  const ct =
    typeof cleanupTimeout === "number" ? cleanupTimeout : Number(cleanupTimeout);
  if (Number.isFinite(ct) && ct > 0) out.cleanupTimeoutSec = Math.floor(ct);

  const cleanupVerify =
    o.cleanupVerifyScript ?? o.cleanup_verify_script ?? o.cleanupVerify;
  if (typeof cleanupVerify === "string" && cleanupVerify.trim()) {
    out.cleanupVerifyScript = cleanupVerify;
  }
  const cleanupVerifyTimeout =
    o.cleanupVerifyTimeoutSec ?? o.cleanup_verify_timeout_sec;
  const cvt =
    typeof cleanupVerifyTimeout === "number"
      ? cleanupVerifyTimeout
      : Number(cleanupVerifyTimeout);
  if (Number.isFinite(cvt) && cvt > 0) {
    out.cleanupVerifyTimeoutSec = Math.floor(cvt);
  }

  return out;
}

/** Cap a log so a runaway `npm install` cannot fill the run directory. */
function truncateLog(s: string): string {
  if (Buffer.byteLength(s) <= MAX_LOG_BYTES) return s;
  const head = s.slice(0, MAX_LOG_BYTES / 2);
  const tail = s.slice(-MAX_LOG_BYTES / 2);
  return `${head}\n… [setup log truncated] …\n${tail}`;
}

/**
 * The script actually executed in the pod.
 *
 * Wrapped rather than run raw so that:
 *  - `set -eu` makes a failing setup step fail provisioning, instead of
 *    handing the agent a half-built environment it will run against;
 *  - cwd is the workspace, so relative paths in an eval mean what they look
 *    like they mean;
 *  - the git baseline is committed by the same shell, immediately after setup,
 *    with no window in which the agent could start against uncommitted files.
 */
export function buildSetupCommand(
  spec: EvalEnvSpec,
  opts: { commitBaseline: boolean },
): string[] {
  const lines = [
    "set -eu",
    `cd ${WORKSPACE}`,
    "",
    "# ---- eval-provided setup ----",
    spec.setupScript ?? "true",
    "",
  ];

  if (opts.commitBaseline) {
    lines.push(
      "# ---- baseline ----",
      "# Everything setup produced is the STARTING POINT, not agent work. It is",
      "# committed here so the captured diff contains only what the agent changed.",
      "#",
      "# git may not exist in the agent's image — a python agent image has no",
      "# reason to ship git. When it is missing the baseline is taken on the HOST",
      "# after this container exits (see takeBaselineOnHost), and this block is a",
      "# no-op rather than a failure.",
      "if command -v git >/dev/null 2>&1; then",
      "  # `rev-parse --git-dir` walks UP, so it can succeed via a parent repo",
      "  # (or /tmp being inside one) while this directory is not a repo at all,",
      "  # and every later git command then fails with 'not in a git directory'.",
      "  # Test THIS directory specifically.",
      "  if [ ! -d .git ]; then git init -q; fi",
      "  # Bind-mounted trees are often owned by another uid; without this git",
      "  # refuses to operate on them ('dubious ownership').",
      "  git config --global --add safe.directory /workspace 2>/dev/null || true",
      '  git config user.email "agenteval@local"',
      '  git config user.name "agenteval"',
      "  git add -A",
      // --allow-empty: a brownfield eval whose setup changed nothing is fine.
      '  git commit -q --allow-empty -m "agenteval: environment baseline" >/dev/null 2>&1 || true',
      "  git rev-parse HEAD",
      "else",
      `  echo "${NO_GIT_MARKER}"`,
      "fi",
    );
  }

  return ["sh", "-c", lines.join("\n")];
}

/**
 * Provision an eval's environment inside the pod.
 *
 * Runs before the agent container. Returns provenance describing what happened;
 * throws {@link ProvisionError} when setup failed, because starting an agent in
 * a broken environment produces a meaningless eval result — worse than no
 * result, since it looks like agent failure.
 */
export async function provisionEnv(
  runtime: ContainerRuntime,
  spec: EvalEnvSpec,
  ctx: {
    image: string;
    workspaceDir: string;
    /** Sandbox policy to apply (same controls as the agent's container). */
    sandbox?: unknown;
    network: RunContainerSpec["network"];
  },
): Promise<ProvisionResult> {
  const started = Date.now();
  const commitBaseline = spec.commitBaseline !== false;

  // Nothing to do, and no baseline needed: an eval with no setup script on a
  // workspace the caller already prepared.
  if (!spec.setupScript && !commitBaseline) {
    return {
      kind: spec.kind,
      ran: false,
      exitCode: null,
      log: "",
      durationMs: 0,
      baselineCommit: null,
      error: null,
    };
  }

  const timeoutMs =
    (spec.setupTimeoutSec ?? DEFAULT_SETUP_TIMEOUT_SEC) * 1000;

  const handle = await runtime.run({
    // Always the agent's image: setup must build an environment the agent can
    // actually use, in the toolchain it actually has.
    image: ctx.image,
    workspaceDir: ctx.workspaceDir,
    argv: buildSetupCommand(spec, { commitBaseline }),
    env: { ...(spec.setupEnv ?? {}) },
    // Setup is allowed real resources: `npm install` is not a light operation.
    limits: { cpus: 2, pids: 512 },
    timeoutMs,
    // Setup usually needs the network (package installs) even when the AGENT
    // will be offline — those are separate decisions.
    network: ctx.network,
    nonRoot: false,
    ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
  });

  let log = "";
  const collect = async (
    stream: AsyncIterable<Buffer>,
  ): Promise<void> => {
    for await (const chunk of stream) log += chunk.toString("utf8");
  };
  const draining = Promise.all([
    collect(handle.stdout()),
    collect(handle.stderr()),
  ]);

  const { exitCode, timedOut } = await handle.wait();
  await draining;
  await handle.remove();

  // The last line of a committing script is the baseline sha — or the marker
  // saying the image had no git.
  const lines = log.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  let baselineCommit =
    commitBaseline && /^[0-9a-f]{40}$/.test(lastLine) ? lastLine : null;
  const needsHostBaseline =
    commitBaseline && lastLine === NO_GIT_MARKER;

  const result: ProvisionResult = {
    kind: spec.kind,
    ran: true,
    exitCode,
    log: truncateLog(log),
    durationMs: Date.now() - started,
    baselineCommit,
    error: null,
  };

  if (timedOut) {
    result.error = `setup script timed out after ${timeoutMs}ms`;
    throw new ProvisionError(result.error, result);
  }
  if (exitCode !== 0) {
    result.error = `setup script failed with exit code ${exitCode}`;
    throw new ProvisionError(result.error, result);
  }

  // The image had no git. Take the baseline on the host instead — the workspace
  // is a bind mount, so the same tree is visible here.
  if (needsHostBaseline) {
    baselineCommit = await takeBaselineOnHost(ctx.workspaceDir);
    result.baselineCommit = baselineCommit;
    // Keep the marker out of the stored log; it is an internal signal.
    result.log = truncateLog(
      log.split("\n").filter((l) => l.trim() !== NO_GIT_MARKER).join("\n"),
    );
  }

  return result;
}

/** Run eval setup through exec in an already-live queue container. */
export async function provisionEnvInContainer(
  handle: ContainerHandle,
  spec: EvalEnvSpec,
  workspaceDir: string,
): Promise<ProvisionResult> {
  const started = Date.now();
  const commitBaseline = spec.commitBaseline !== false;
  if (!spec.setupScript && !commitBaseline) {
    return {
      kind: spec.kind,
      ran: false,
      exitCode: null,
      log: "",
      durationMs: 0,
      baselineCommit: null,
      error: null,
    };
  }
  const timeoutMs = (spec.setupTimeoutSec ?? DEFAULT_SETUP_TIMEOUT_SEC) * 1000;
  const exec = await handle.exec({
    argv: buildSetupCommand(spec, { commitBaseline }),
    cwd: WORKSPACE,
    env: { ...(spec.setupEnv ?? {}) },
    timeoutMs,
    maxOutputBytes: MAX_LOG_BYTES,
  });
  const log = `${exec.stdout}${exec.stderr}`;
  const lines = log.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  let baselineCommit =
    commitBaseline && /^[0-9a-f]{40}$/.test(lastLine) ? lastLine : null;
  const result: ProvisionResult = {
    kind: spec.kind,
    ran: true,
    exitCode: exec.exitCode,
    log: truncateLog(log),
    durationMs: exec.durationMs || Date.now() - started,
    baselineCommit,
    error: null,
  };
  if (exec.timedOut) {
    result.error = `setup script timed out after ${timeoutMs}ms`;
    throw new ProvisionError(result.error, result);
  }
  if (exec.exitCode !== 0) {
    result.error = `setup script failed with exit code ${exec.exitCode}`;
    throw new ProvisionError(result.error, result);
  }
  if (commitBaseline && lastLine === NO_GIT_MARKER) {
    baselineCommit = await takeBaselineOnHost(workspaceDir);
    result.baselineCommit = baselineCommit;
    result.log = truncateLog(
      log.split("\n").filter((line) => line.trim() !== NO_GIT_MARKER).join("\n"),
    );
  }
  return result;
}

/**
 * Commit the provisioned tree as the baseline, on the host.
 *
 * Fallback for eval images that do not ship git. The workspace is a bind mount,
 * so committing here and committing in the pod produce the same result; only
 * the location of the git binary differs. Returns null if git is unavailable
 * here too, in which case the diff will include setup output — degraded, but
 * not a failed run.
 */
async function takeBaselineOnHost(workspaceDir: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const git = (...args: string[]): Promise<{ stdout: string }> =>
    run("git", ["-C", workspaceDir, ...args]);
  try {
    try {
      await git("rev-parse", "--git-dir");
    } catch {
      await git("init", "-q");
    }
    await git("config", "user.email", "agenteval@local");
    await git("config", "user.name", "agenteval");
    await git("add", "-A");
    try {
      await git(
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "agenteval: environment baseline",
      );
    } catch {
      // Nothing to commit is fine.
    }
    const { stdout } = await git("rev-parse", "HEAD");
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Outcome of the post-eval cleanup pass. */
export interface CleanupResult {
  ran: boolean;
  exitCode: number | null;
  log: string;
  durationMs: number;
  /** Set when cleanup failed; the eval's own result is unaffected. */
  error: string | null;
}

const DEFAULT_CLEANUP_TIMEOUT_SEC = 300;

/**
 * Tear down an eval's environment so the next eval starts clean.
 *
 * Runs after the agent AND after the diff/traces are captured — cleanup that
 * ran earlier would delete the evidence archive needs.
 *
 * Never throws. Cleanup is housekeeping: a passing eval must not be reported as
 * failed because teardown was flaky, and a failing eval must still get its
 * teardown attempt. The outcome is recorded so a systematically broken cleanup
 * is visible rather than silent.
 */
export async function cleanupEnv(
  runtime: ContainerRuntime,
  spec: EvalEnvSpec,
  ctx: {
    image: string;
    workspaceDir: string;
    sandbox?: unknown;
    network: RunContainerSpec["network"];
  },
): Promise<CleanupResult> {
  if (!spec.cleanupScript) {
    return { ran: false, exitCode: null, log: "", durationMs: 0, error: null };
  }

  const started = Date.now();
  const timeoutMs =
    (spec.cleanupTimeoutSec ?? DEFAULT_CLEANUP_TIMEOUT_SEC) * 1000;

  try {
    const handle = await runtime.run({
      image: ctx.image,
      workspaceDir: ctx.workspaceDir,
      // No `set -e`: cleanup should attempt every step even if one fails.
      // Stopping a service that already died must not skip dropping the DB.
      argv: ["sh", "-c", `cd ${WORKSPACE}\n${spec.cleanupScript}`],
      env: {},
      limits: { cpus: 2, pids: 512 },
      timeoutMs,
      network: ctx.network,
      nonRoot: false,
      ...(ctx.sandbox ? { sandbox: ctx.sandbox } : {}),
    });

    let log = "";
    const collect = async (stream: AsyncIterable<Buffer>): Promise<void> => {
      for await (const chunk of stream) log += chunk.toString("utf8");
    };
    const draining = Promise.all([
      collect(handle.stdout()),
      collect(handle.stderr()),
    ]);
    const { exitCode, timedOut } = await handle.wait();
    await draining;
    await handle.remove();

    return {
      ran: true,
      exitCode,
      log: truncateLog(log),
      durationMs: Date.now() - started,
      error: timedOut
        ? `cleanup script timed out after ${timeoutMs}ms`
        : exitCode !== 0
          ? `cleanup script exited ${exitCode}`
          : null,
    };
  } catch (err) {
    return {
      ran: true,
      exitCode: null,
      log: "",
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run cleanup in the queue's existing container. */
export async function cleanupEnvInContainer(
  handle: ContainerHandle,
  spec: EvalEnvSpec,
): Promise<CleanupResult> {
  if (!spec.cleanupScript) {
    return { ran: false, exitCode: null, log: "", durationMs: 0, error: null };
  }
  const timeoutMs =
    (spec.cleanupTimeoutSec ?? DEFAULT_CLEANUP_TIMEOUT_SEC) * 1000;
  const started = Date.now();
  try {
    const result = await handle.exec({
      argv: ["sh", "-c", `cd ${WORKSPACE}\n${spec.cleanupScript}`],
      cwd: WORKSPACE,
      timeoutMs,
      maxOutputBytes: MAX_LOG_BYTES,
    });
    return {
      ran: true,
      exitCode: result.exitCode,
      log: truncateLog(`${result.stdout}${result.stderr}`),
      durationMs: result.durationMs || Date.now() - started,
      error: result.timedOut
        ? `cleanup script timed out after ${timeoutMs}ms`
        : result.exitCode !== 0
          ? `cleanup script exited ${result.exitCode}`
          : null,
    };
  } catch (err) {
    return {
      ran: true,
      exitCode: null,
      log: "",
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CleanupVerificationResult {
  ran: boolean;
  exitCode: number | null;
  log: string;
  durationMs: number;
  error: string | null;
}

/** Verify cleanup before a persistent queue container advances to the next eval. */
export async function verifyCleanupInContainer(
  handle: ContainerHandle,
  spec: EvalEnvSpec,
): Promise<CleanupVerificationResult> {
  if (!spec.cleanupVerifyScript) {
    return { ran: false, exitCode: null, log: "", durationMs: 0, error: null };
  }
  const timeoutMs = (spec.cleanupVerifyTimeoutSec ?? 60) * 1000;
  const result = await handle.exec({
    argv: ["sh", "-c", `cd ${WORKSPACE}\n${spec.cleanupVerifyScript}`],
    cwd: WORKSPACE,
    timeoutMs,
    maxOutputBytes: MAX_LOG_BYTES,
  });
  return {
    ran: true,
    exitCode: result.exitCode,
    log: truncateLog(`${result.stdout}${result.stderr}`),
    durationMs: result.durationMs,
    error: result.timedOut
      ? `cleanup verification timed out after ${timeoutMs}ms`
      : result.exitCode !== 0
        ? `cleanup verification exited ${result.exitCode}`
        : null,
  };
}

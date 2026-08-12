/**
 * Eval package ingest and validation for the suite format: flat task.toml,
 * seed_repo workspace, environment/{setup,cleanup,healthcheck}, a separate
 * verifier, and validation material. Legacy canonical packages are still
 * readable/runnable but new evals must use this suite layout.
 */

import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentCategory, RubricAxis, TaskProfile, TaskSpec } from "../domain.js";

export const EVAL_PACKAGE_SCHEMA_VERSION = 1 as const;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

export interface EvalPackageFileUpload {
  encoding?: "utf8" | "base64";
  content: string;
}

export interface EvalPackageUpload {
  files: Record<string, string | EvalPackageFileUpload>;
}

export interface EvalPackageManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface EvalPackageValidation {
  schemaVersion: typeof EVAL_PACKAGE_SCHEMA_VERSION;
  valid: boolean;
  errors: string[];
  warnings: string[];
  taskId: string | null;
  taskVersion: string | null;
  category: string | null;
  language: string | null;
  verifierCheckIds: string[];
  requirementIds: string[];
  protectedPaths: string[];
  agentBuildContext: "environment/";
  verifierBuildContext: "tests/";
}

export interface EvalPackageVerifierCheck {
  id: string;
  kind: string;
}

export interface EvalPackageRuntimeConfig {
  setupPath: string | null;
  cleanupPath: string | null;
  setupTimeoutMs: number;
  cleanupTimeoutMs: number;
  agentTimeoutMs: number;
  verifierCommand: string[];
  verifierTimeoutMs: number;
  buildTimeoutMs: number;
  network: "allow" | "allowlist" | "offline";
  networkAllowlist: string[];
  cpus?: number;
  memoryMiB?: number;
  agentEnv: Record<string, string>;
  verifierChecks: EvalPackageVerifierCheck[];
  verifierCheckIds: string[];
  /** True for suite-format tasks; the agent workspace is /workspace/task. */
  suite?: boolean;
  /** Declared language for suite tasks (drives the apt packages setup.sh installs). */
  language: string | null;
}

export interface MaterializedEvalPackage {
  packagePath: string;
  packageDigest: string;
  manifest: {
    schemaVersion: typeof EVAL_PACKAGE_SCHEMA_VERSION;
    files: EvalPackageManifestFile[];
    totalBytes: number;
  };
  validation: EvalPackageValidation;
  taskSpec: TaskSpec;
  config: Record<string, unknown>;
}

/** Validate, hash, and atomically materialize one canonical eval package. */
export async function materializeEvalPackage(input: {
  upload: EvalPackageUpload;
  destination: string;
}): Promise<MaterializedEvalPackage> {
  const files = decodePackageFiles(input.upload);
  const inspected = inspectEvalPackage(files);
  if (!inspected.validation.valid) {
    throw new Error(`invalid eval package: ${inspected.validation.errors.join("; ")}`);
  }
  const manifestFiles = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({
      path,
      bytes: content.length,
      sha256: sha256(content),
    }));
  const packageDigest = sha256(Buffer.from(manifestFiles.map((file) =>
    `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""), "utf8"));
  const manifest = {
    schemaVersion: EVAL_PACKAGE_SCHEMA_VERSION,
    files: manifestFiles,
    totalBytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
  };

  const destination = resolve(input.destination);
  const tmp = `${destination}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    for (const [path, content] of files) {
      const absolute = resolve(tmp, path);
      if (absolute !== tmp && !absolute.startsWith(`${tmp}${sep}`)) {
        throw new Error(`package path escapes destination: ${path}`);
      }
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
      if (path.endsWith(".sh")) await chmod(absolute, 0o755);
    }
    await writeFile(join(tmp, ".agenteval-package.json"), `${JSON.stringify({
      packageDigest,
      manifest,
      validation: inspected.validation,
    }, null, 2)}\n`, "utf8");
    await rename(tmp, destination);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }

  return {
    packagePath: destination,
    packageDigest,
    manifest,
    validation: inspected.validation,
    taskSpec: inspected.taskSpec,
    config: inspected.config,
  };
}

/** Hash only agent-image environment files, excluding the per-eval repository seed. */
export function evalEnvironmentDigest(manifest: Record<string, unknown>): string {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const material = files
    .filter((entry) => isRecord(entry) && typeof entry.path === "string" &&
      entry.path.startsWith("environment/") && !entry.path.startsWith("environment/repo/"))
    .map((entry) => `${entry.path}\0${String(entry.bytes)}\0${String(entry.sha256)}\n`)
    .sort()
    .join("");
  if (!material) throw new Error("eval package has no agent environment files");
  return sha256(Buffer.from(material, "utf8"));
}

/** Read lifecycle, resource, and verifier settings from parsed task.toml. */
export function evalPackageRuntimeConfig(
  config: Record<string, unknown>,
): EvalPackageRuntimeConfig {
  const lifecycle = table(config.lifecycle);
  const timeouts = table(config.timeouts);
  const resources = table(config.resources);
  const network = table(config.network);
  const verifier = table(config.verifier);
  const agentEnvRaw = table(config.agent_env);
  const agentEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(agentEnvRaw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      agentEnv[key] = String(value);
    }
  }
  const suite = isRecord(config.suite);
  const language = suite
    ? (text((config.suite as { language?: unknown }).language) ?? text((config as { task?: { language?: unknown } }).task?.language))
    : null;
  // Suite tasks run a platform-synthesized lifecycle wrapper that apt-installs
  // the language toolchain (from `language`) and then invokes the author's
  // environment/setup.sh + cleanup.sh. The wrappers are written to
  // /workspace/.agenteval/lifecycle-{setup,cleanup}.sh at eval time. Non-suite
  // (legacy canonical) tasks use the [lifecycle] table when present.
  const setup = suite ? "lifecycle-setup.sh" : text(lifecycle.setup);
  const cleanup = suite ? "lifecycle-cleanup.sh" : text(lifecycle.cleanup);
  const verifierChecks = arrayOfTables(verifier.checks)
    .map((entry) => ({ id: text(entry.id), kind: text(entry.kind) }))
    .filter((entry): entry is EvalPackageVerifierCheck => entry.id !== null && entry.kind !== null);
  return {
    setupPath: setup
      ? (suite ? SUITE_LIFECYCLE_SETUP_PATH : runtimeEnvironmentPath(setup))
      : null,
    cleanupPath: cleanup
      ? (suite ? SUITE_LIFECYCLE_CLEANUP_PATH : runtimeEnvironmentPath(cleanup))
      : null,
    setupTimeoutMs: Math.trunc(Number(suite ? (config.suite as { agent_timeout_seconds?: unknown }).agent_timeout_seconds ?? 300 : lifecycle.setup_timeout_seconds ?? timeouts.build_seconds ?? 300) * 1000),
    cleanupTimeoutMs: Math.trunc(Number(suite ? 300 : lifecycle.cleanup_timeout_seconds ?? 120) * 1000),
    agentTimeoutMs: Math.trunc(Number(timeouts.agent_seconds ?? 120) * 1000),
    verifierCommand: stringArray(verifier.command),
    verifierTimeoutMs: Math.trunc(Number(timeouts.verifier_seconds ?? 300) * 1000),
    buildTimeoutMs: Math.trunc(Number(timeouts.build_seconds ?? 600) * 1000),
    network: (["allow", "allowlist", "offline"].includes(String(network.policy))
      ? String(network.policy)
      : "offline") as EvalPackageRuntimeConfig["network"],
    networkAllowlist: stringArray(network.allowlist),
    ...(positiveNumber(resources.cpu) ? { cpus: Number(resources.cpu) } : {}),
    ...(positiveNumber(resources.ram_mb) ? { memoryMiB: Number(resources.ram_mb) } : {}),
    agentEnv,
    verifierChecks,
    verifierCheckIds: verifierChecks.map((entry) => entry.id),
    suite,
    language,
  };
}

/** Verify the package and load runtime settings from its digest-covered task.toml. */
export async function loadEvalPackageRuntimeConfig(input: {
  packagePath: string;
  packageDigest: string;
  manifest: Record<string, unknown>;
}): Promise<EvalPackageRuntimeConfig> {
  await verifyMaterializedEvalPackage(input);
  const raw = await readFile(join(input.packagePath, "task.toml"), "utf8");
  const parsed = parseToml(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("stored eval package task.toml root must be a table");
  // Suite-format task.toml is flat; wrap the flat keys into runtime tables.
  if (text(parsed.id) !== null && typeof parsed.agent_timeout_seconds === "number") {
    return evalPackageRuntimeConfig(wrapSuiteConfig(parsed));
  }
  return evalPackageRuntimeConfig(parsed);
}

/** Wrap flat suite task.toml keys into the internal runtime-config tables. */
function wrapSuiteConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const taskId = text(flat.id);
  const taskVersion = scalarText(flat.version);
  const name = text(flat.name);
  const primaryCapability = text(flat.primary_capability);
  const language = text(flat.language);
  const agentTimeout = Number(flat.agent_timeout_seconds);
  const verifierTimeout = Number(flat.verifier_timeout_seconds);
  const cpuCores = Number(flat.cpu_cores);
  const memoryMb = Number(flat.memory_mb);
  // Suite agent container network is always `allow` (reaper must reach the
  // model provider); `internet` governs the isolated verifier only.
  const networkPolicy = "allow";
  return {
    suite: { id: taskId, version: taskVersion, name, primary_capability: primaryCapability, language },
    task: { id: taskId, version: taskVersion, name, category: "simple",
      language, tags: [primaryCapability, language].filter((entry): entry is string => Boolean(entry)),
      profile: "bugfix", agent_category: "coding" },
    timeouts: {
      agent_seconds: Math.trunc(agentTimeout),
      verifier_seconds: Math.trunc(verifierTimeout),
      build_seconds: Math.trunc(verifierTimeout * 2 + 300),
    },
    resources: {
      cpu: Math.trunc(cpuCores),
      ram_mb: Math.trunc(memoryMb),
      disk_mb: Math.trunc(Number(flat.disk_mb)),
      gpu: 0,
    },
    network: { policy: networkPolicy, allowlist: [], allow: networkPolicy === "allow" },
    agent_env: {},
    lifecycle: {},
    verifier: {
      separate: true,
      dockerfile: "tests/Dockerfile",
      command: ["/verifier/test.sh"],
      checks: [],
    },
  };
}

/** Verify every stored package file against its immutable manifest and digest. */
export async function verifyMaterializedEvalPackage(input: {
  packagePath: string;
  packageDigest: string;
  manifest: Record<string, unknown>;
}): Promise<void> {
  const rawFiles = input.manifest.files;
  if (!Array.isArray(rawFiles)) throw new Error("eval package manifest is missing files[]");
  const expected = new Map<string, EvalPackageManifestFile>();
  for (const raw of rawFiles) {
    if (!isRecord(raw) || !text(raw.path) || typeof raw.bytes !== "number" || !text(raw.sha256)) {
      throw new Error("eval package manifest contains an invalid file entry");
    }
    expected.set(text(raw.path)!, {
      path: text(raw.path)!,
      bytes: raw.bytes,
      sha256: text(raw.sha256)!,
    });
  }
  const actualPaths = await listPackageFiles(input.packagePath, input.packagePath);
  for (const path of actualPaths) {
    if (path === ".agenteval-package.json") continue;
    if (!expected.has(path)) throw new Error(`unmanifested eval package file: ${path}`);
  }
  for (const file of expected.values()) {
    const absolute = resolve(input.packagePath, file.path);
    if (absolute !== resolve(input.packagePath) && !absolute.startsWith(`${resolve(input.packagePath)}${sep}`)) {
      throw new Error(`eval package manifest path escapes root: ${file.path}`);
    }
    const content = await readFile(absolute).catch(() => null);
    if (!content) throw new Error(`missing eval package file: ${file.path}`);
    if (content.length !== file.bytes || sha256(content) !== file.sha256) {
      throw new Error(`eval package file hash mismatch: ${file.path}`);
    }
  }
  const digest = sha256(Buffer.from([...expected.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""), "utf8"));
  if (digest !== input.packageDigest) throw new Error("eval package digest mismatch");
}

/** Restore a trusted lifecycle script after agent execution before running it. */
export async function restoreEvalLifecycleScript(input: {
  packagePath: string;
  workspaceDir: string;
  containerPath: string;
}): Promise<void> {
  const prefix = "/workspace/.agenteval/environment/";
  if (!input.containerPath.startsWith(prefix)) {
    throw new Error(`invalid lifecycle container path: ${input.containerPath}`);
  }
  const relative = input.containerPath.slice(prefix.length);
  const source = resolve(input.packagePath, "environment", relative);
  const environmentRoot = resolve(input.packagePath, "environment");
  if (!source.startsWith(`${environmentRoot}${sep}`)) {
    throw new Error(`lifecycle script escapes environment/: ${relative}`);
  }
  const target = resolve(input.workspaceDir, ".agenteval", "environment", relative);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true });
  await chmod(target, 0o755);
}

/**
 * Copy only agent-visible package inputs into the host workspace at
 * `workspaceDir/task` (the suite's graded subdirectory). The git baseline is
 * committed at `workspaceDir` so diff capture stays truthful; `solution/`,
 * `tests/`, and `validation/` never reach the agent workspace.
 */
export async function prepareEvalPackageWorkspace(input: {
  packagePath: string;
  packageDigest: string;
  manifest: Record<string, unknown>;
  workspaceDir: string;
  /** When true (suite), stage seed_repo under .agenteval/seed_repo so the
   *  author's setup.sh seeds /workspace/task at eval time (after apt-installing
   *  its language toolchain). When false (legacy), seed directly into task/. */
  suite?: boolean;
}): Promise<void> {
  await verifyMaterializedEvalPackage(input);
  const taskRoot = join(input.workspaceDir, AGENT_TASK_SUBDIR);
  await mkdir(taskRoot, { recursive: true });
  const repo = join(input.packagePath, "seed_repo");
  const entries = await readdir(repo).catch(() => []);
  if (entries.length === 0) throw new Error("eval package seed_repo is empty");
  // Suite: stage seed_repo to .agenteval/seed_repo (sibling of environment/) so
  // the author's setup.sh, which references seed_repo via `dirname $0/..`, can
  // copy it into /workspace/task at eval time. Legacy: seed directly into task/.
  const seedDest = input.suite
    ? join(input.workspaceDir, ".agenteval", "seed_repo")
    : taskRoot;
  await mkdir(seedDest, { recursive: true });
  for (const name of entries) {
    await cp(join(repo, name), join(seedDest, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  // Copy the trusted environment scripts under workspaceDir/.agenteval/environment
  // so cleanup can be restored from the trusted package after agent execution.
  const runtimeDir = join(input.workspaceDir, ".agenteval", "environment");
  await mkdir(runtimeDir, { recursive: true });
  for (const name of await readdir(join(input.packagePath, "environment"))) {
    await cp(join(input.packagePath, "environment", name), join(runtimeDir, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  for (const protectedName of ["solution", "tests", "validation"]) {
    try {
      await lstat(join(seedDest, protectedName));
      throw new Error(`protected eval content leaked into agent workspace: ${protectedName}`);
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
}

/** AGENT_TASK_SUBDIR — where the suite's seed_repo lives inside the workspace. */
export const AGENT_TASK_SUBDIR = "task";

/**
 * The suite-format agent workspace root inside the container. `seed_repo`
 * lands here; the separate verifier grades this path.
 */
export const AGENT_TASK_WORKSPACE = "/workspace/task";

/** In-container path of the platform-synthesized suite setup wrapper. */
export const SUITE_LIFECYCLE_SETUP_PATH = "/workspace/.agenteval/lifecycle-setup.sh";
/** In-container path of the platform-synthesized suite cleanup wrapper. */
export const SUITE_LIFECYCLE_CLEANUP_PATH = "/workspace/.agenteval/lifecycle-cleanup.sh";

/** Map a task.toml `language` value to the apt packages setup.sh must install. */
export function languageToAptPackages(language: string | null): string[] {
  if (!language) return [];
  const lang = language.trim().toLowerCase();
  if (lang === "python" || lang === "python3") return ["python3", "python3-pip", "python3-venv"];
  if (lang === "javascript" || lang === "js" || lang === "node" || lang === "nodejs") return ["nodejs", "npm"];
  if (lang === "c") return ["gcc"];
  if (lang === "cpp" || lang === "c++") return ["g++"];
  if (lang === "bash" || lang === "shell" || lang === "sh") return [];
  return [];
}

/**
 * Write the platform-synthesized suite lifecycle wrappers into the workspace:
 *  - lifecycle-setup.sh: apt-get install the language toolchain, then run the
 *    author's environment/setup.sh (which seeds /workspace/task), then chown
 *    /workspace/task to the non-root agent (uid 10001).
 *  - lifecycle-cleanup.sh: run the author's environment/cleanup.sh (delete
 *    /workspace/task), then apt-get purge + autoremove the toolchain.
 *
 * Both run as root inside the persistent queue container. Runtime-only: the
 * package on disk is left pristine (digest unchanged). Idempotent — safe to
 * re-run before cleanup to restore a trusted copy after agent execution.
 */
export async function synthesizeSuiteLifecycleScripts(input: {
  packagePath: string;
  workspaceDir: string;
  language: string | null;
}): Promise<{ setupPath: string; cleanupPath: string }> {
  const dir = join(input.workspaceDir, ".agenteval");
  await mkdir(dir, { recursive: true });
  const pkgs = languageToAptPackages(input.language).join(" ");
  const installBlock = pkgs
    ? `apt-get update\nif [ -n "${pkgs}" ]; then apt-get install -y --no-install-recommends ${pkgs}; fi`
    : ": # no apt packages for this language";
  const purgeBlock = pkgs
    ? `if [ -n "${pkgs}" ]; then apt-get purge -y ${pkgs} && apt-get autoremove -y; fi`
    : ": # no apt packages to purge";
  const setupHostPath = join(dir, "lifecycle-setup.sh");
  const cleanupHostPath = join(dir, "lifecycle-cleanup.sh");
  await writeFile(setupHostPath, [
    "#!/usr/bin/env bash",
    "# Platform-synthesized suite setup: install the language toolchain for this",
    "# eval, then run the author's setup.sh body (which seeds /workspace/task).",
    "set -euo pipefail",
    installBlock,
    "# Run the author's setup body. cwd=/workspace/.agenteval so its",
    "# `dirname $0/..`/seed_repo reference resolves to the staged copy.",
    "cd /workspace/.agenteval",
    '/workspace/.agenteval/environment/setup.sh "$@"',
    "# setup ran as root; the non-root agent (uid 10001) must own its workspace.",
    "[ -d /workspace/task ] && chown -R 10001:10001 /workspace/task || true",
  ].join("\n") + "\n", "utf8");
  await writeFile(cleanupHostPath, [
    "#!/usr/bin/env bash",
    "# Platform-synthesized suite cleanup: run the author's cleanup.sh, then",
    "# remove the language toolchain this eval installed (best-effort restore).",
    "set -euo pipefail",
    '/workspace/.agenteval/environment/cleanup.sh "$@"',
    purgeBlock,
  ].join("\n") + "\n", "utf8");
  await chmod(setupHostPath, 0o755);
  await chmod(cleanupHostPath, 0o755);
  return { setupPath: SUITE_LIFECYCLE_SETUP_PATH, cleanupPath: SUITE_LIFECYCLE_CLEANUP_PATH };
}

/**
 * Validate a suite-style eval task: flat task.toml, seed_repo workspace,
 * environment/self-contained Dockerfile, tests/verifier.py, solution/,
 * validation/. Builds internal `config` tables from the flat keys.
 */
export function inspectEvalPackage(files: Map<string, Buffer>): {
  validation: EvalPackageValidation;
  taskSpec: TaskSpec;
  config: Record<string, unknown>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const required of [
    "instruction.md",
    "task.toml",
    "README.md",
    "environment/Dockerfile",
    "environment/setup.sh",
    "environment/cleanup.sh",
    "environment/healthcheck.sh",
    "tests/Dockerfile",
    "tests/test.sh",
    "tests/verifier.py",
    "solution/solve.sh",
    "solution/reference.patch",
    "validation/expected.json",
    "validation/known_bad.patch",
  ]) {
    if (!files.has(required)) errors.push(`missing required file ${required}`);
  }
  requirePrefix(files, "seed_repo/", errors);
  requirePrefix(files, "solution/reference_files/", errors);
  requirePrefix(files, "tests/", errors);
  requirePrefix(files, "validation/known_bad/", errors);
  validateNoGeneratedArtifacts(files, errors);

  let flat: Record<string, unknown> = {};
  const taskToml = files.get("task.toml");
  if (taskToml) {
    try {
      const parsed = parseToml(taskToml.toString("utf8")) as unknown;
      if (!isRecord(parsed)) errors.push("task.toml root must be a table");
      else flat = parsed;
    } catch (err) {
      errors.push(`task.toml is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- flat suite keys ----
  const taskId = text(flat.id);
  const taskVersion = scalarText(flat.version);
  const name = text(flat.name);
  const suiteCategory = text(flat.category);
  const primaryCapability = text(flat.primary_capability);
  const language = text(flat.language);
  const difficulty = text(flat.difficulty) ?? "easy";
  const internet = text(flat.internet) ?? "disabled";
  const agentTimeout = Number(flat.agent_timeout_seconds);
  const verifierTimeout = Number(flat.verifier_timeout_seconds);
  const cpuCores = Number(flat.cpu_cores);
  const memoryMb = Number(flat.memory_mb);
  const diskMb = Number(flat.disk_mb);
  const officialReward = text(flat.official_reward) ?? "binary";
  const publicTestCommand = text(flat.public_test_command);

  if (!taskId) errors.push("task.toml id is required");
  if (!taskVersion) errors.push("task.toml version is required");
  if (!name) errors.push("task.toml name is required");
  if (!text(flat.runtime)) errors.push("task.toml runtime is required");
  if (officialReward !== "binary") errors.push("task.toml official_reward must be 'binary'");
  if (!positiveNumber(agentTimeout)) errors.push("task.toml agent_timeout_seconds must be positive");
  if (!positiveNumber(verifierTimeout)) errors.push("task.toml verifier_timeout_seconds must be positive");
  if (!positiveNumber(cpuCores)) errors.push("task.toml cpu_cores must be positive");
  if (!positiveNumber(memoryMb)) errors.push("task.toml memory_mb must be positive");
  if (!positiveNumber(diskMb)) errors.push("task.toml disk_mb must be positive");
  if (!["allow", "allowlist", "offline", "disabled"].includes(String(internet))) {
    errors.push("task.toml internet must be allow|allowlist|offline|disabled");
  }
  // The suite `internet` field describes the TASK's intended network safety and
  // is honored by the isolated verifier (always offline). But the agent
  // container runs the real reaper CLI which must reach its model provider, so
  // the suite agent container is always network `allow` (the verifier is forced
  // offline independently in the verifier runner). `internet` is preserved as
  // informational authoring metadata and to reject invalid values.
  const networkPolicy = "allow";
  if (!publicTestCommand) errors.push("task.toml public_test_command is required");

  // ---- wrap flat keys into the internal config tables the runtime reads ----
  const config: Record<string, unknown> = {
    task: {
      id: taskId,
      version: taskVersion,
      name,
      category: "simple",
      language,
      tags: [primaryCapability, language].filter((entry): entry is string => Boolean(entry)),
      profile: "bugfix",
      agent_category: "coding",
    },
    timeouts: {
      agent_seconds: Math.trunc(agentTimeout),
      verifier_seconds: Math.trunc(verifierTimeout),
      build_seconds: Math.trunc(verifierTimeout * 2 + 300),
    },
    resources: {
      cpu: Math.trunc(cpuCores),
      ram_mb: Math.trunc(memoryMb),
      disk_mb: Math.trunc(diskMb),
      gpu: 0,
    },
    network: { policy: networkPolicy, allowlist: [], allow: networkPolicy === "allow" },
    agent_env: {},
    lifecycle: {},
    verifier: {
      separate: true,
      dockerfile: "tests/Dockerfile",
      command: ["/verifier/test.sh"],
      checks: [],
    },
    // Informational suite metadata surfaced to the validator/API.
    suite: {
      id: taskId,
      version: taskVersion,
      name,
      category: suiteCategory,
      primary_capability: primaryCapability,
      language,
      runtime: text(flat.runtime),
      difficulty,
      official_reward: officialReward,
      internet,
      public_test_command: publicTestCommand,
      agent_timeout_seconds: Math.trunc(agentTimeout),
      verifier_timeout_seconds: Math.trunc(verifierTimeout),
    },
  };

  validateProtectedContentIsolation(files, errors);
  validateJson(files, "validation/expected.json", errors);
  validateDockerfile(files.get("environment/Dockerfile"), "environment/Dockerfile", errors);
  validateDockerfile(files.get("tests/Dockerfile"), "tests/Dockerfile", errors);
  for (const scriptName of ["setup.sh", "cleanup.sh", "healthcheck.sh"]) {
    const script = files.get(`environment/${scriptName}`)?.toString("utf8") ?? "";
    if (!/set\s+-[^\n]*e[^\n]*u[^\n]*o\s+pipefail/.test(script)) {
      errors.push(`environment/${scriptName} must be fail-fast with set -euo pipefail`);
    }
  }
  // The suite Dockerfile must COPY only agent-visible inputs (seed_repo,
  // instruction.md) and never reach solution/tests/validation.
  const envDocker = files.get("environment/Dockerfile")?.toString("utf8") ?? "";
  if (/(solution|tests|validation|verifier\.py|reference)/.test(envDocker)) {
    errors.push("environment/Dockerfile must not copy solution/, tests/, validation/, or grading content");
  }

  const instruction = files.get("instruction.md")?.toString("utf8").trim() ?? "";
  if (!instruction) errors.push("instruction.md must be non-empty");
  else if (instruction.includes("solution/") || instruction.includes("tests/") || instruction.includes("validation/")) {
    errors.push("instruction.md must not reference hidden solution/tests/validation content");
  }

  const criteria: TaskSpec["rubric"]["criteria"] = [{
    id: "A1",
    axis: "A",
    label: `Complete ${name ?? taskId} to the spec in the instruction`,
    weight: 1,
    critical: true,
    appliesTo: "coding",
    anchors: {
      full: "The isolated verifier confirms the expected behavior.",
      partial: "Some verifier checks pass.",
      none: "The verifier does not confirm the expected behavior.",
    },
  }];
  const taskSpec: TaskSpec = {
    id: taskId ?? undefined,
    name: name ?? taskId ?? "invalid-eval",
    prompt: instruction,
    workspace: { source: "empty" },
    rubric: { criteria, profile: "bugfix", version: numericVersion(taskVersion) },
    tags: [primaryCapability, language].filter((entry): entry is string => Boolean(entry)),
    profile: "bugfix",
    agentCategory: "coding",
    categoryName: "simple",
  };

  const validation: EvalPackageValidation = {
    schemaVersion: EVAL_PACKAGE_SCHEMA_VERSION,
    valid: errors.length === 0,
    errors,
    warnings,
    taskId,
    taskVersion,
    category: "simple",
    language: language ?? null,
    verifierCheckIds: [],
    requirementIds: [],
    protectedPaths: ["solution/", "tests/", "validation/"],
    agentBuildContext: "environment/",
    verifierBuildContext: "tests/",
  };
  return { validation, taskSpec, config };
}

/** True when the task uses the suite flat format (id at root, no [task] table). */
export function isSuiteTask(config: Record<string, unknown>): boolean {
  return isRecord(config.suite) && text(config.suite.id) !== null;
}

/** Resolve the agent-visible build context files (exclude solution/tests/validation). */
export function agentBuildContextPaths(files: Map<string, Buffer>): string[] {
  return [...files.keys()].filter((path) =>
    path === "instruction.md" ||
    path.startsWith("environment/") ||
    path.startsWith("seed_repo/") ||
    path === "README.md");
}

/** Decode and path-normalize API package file uploads. */
export function decodePackageFiles(upload: EvalPackageUpload): Map<string, Buffer> {
  if (!upload || !isRecord(upload.files)) throw new Error("eval package requires files object");
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const [rawPath, value] of Object.entries(upload.files)) {
    const path = normalizePackagePath(rawPath);
    if (files.has(path)) throw new Error(`duplicate package path: ${path}`);
    const encoded = typeof value === "string" ? { encoding: "utf8" as const, content: value } : value;
    if (!encoded || typeof encoded.content !== "string") throw new Error(`invalid file content: ${path}`);
    if (encoded.encoding !== undefined && encoded.encoding !== "utf8" && encoded.encoding !== "base64") {
      throw new Error(`invalid encoding for ${path}`);
    }
    const content = Buffer.from(encoded.content, encoded.encoding === "base64" ? "base64" : "utf8");
    totalBytes += content.length;
    if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`eval package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    files.set(path, content);
  }
  return files;
}

function normalizePackagePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe eval package path: ${value}`);
  }
  if (normalized.includes("\0")) throw new Error(`unsafe eval package path: ${value}`);
  return normalized;
}

function requirePrefix(files: Map<string, Buffer>, prefix: string, errors: string[]): void {
  if (![...files.keys()].some((path) => path.startsWith(prefix))) errors.push(`missing required directory content ${prefix}`);
}

function rejectDuplicates(values: string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) errors.push(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function validateNoGeneratedArtifacts(files: Map<string, Buffer>, errors: string[]): void {
  for (const path of files.keys()) {
    if (
      /(^|\/)(\.git|\.hg|\.svn|node_modules|__pycache__|\.pytest_cache|\.mypy_cache)(\/|$)/.test(path) ||
      /(^|\/)(\.DS_Store|Thumbs\.db)$/i.test(path) ||
      /\.(pyc|pyo)$/i.test(path)
    ) {
      errors.push(`eval package contains generated or local-only artifact: ${path}`);
    }
  }
}

function validateProtectedContentIsolation(files: Map<string, Buffer>, errors: string[]): void {
  const protectedHashes = new Set<string>();
  for (const [path, content] of files) {
    if (
      (path.startsWith("solution/") || path.startsWith("tests/") || path.startsWith("validation/")) &&
      content.length > 0
    ) {
      protectedHashes.add(sha256(content));
    }
  }
  // The agent-visible repository ("seed_repo") may not nest or duplicate
  // protected grading content: package-level solution/, validation/, the
  // hidden verifier (tests/verifier.py, tests/Dockerfile), known_bad, expected,
  // or reference material. A public tests/ subdir inside seed_repo is normal
  // agent-visible source and is allowed.
  for (const [path, content] of files) {
    if (!path.startsWith("seed_repo/")) continue;
    const relative = path.slice("seed_repo/".length);
    if (
      /(^|\/)(solution|validation|\.agenteval)(\/|$)/i.test(relative) ||
      /(^|\/)tests\/(oracle|hidden|private)(\/|$)/i.test(relative) ||
      /(^|\/)tests\/(Dockerfile|verifier\.py)(\/|$)/i.test(relative) ||
      /(^|\/)(reference\.patch|solve\.sh|expected\.json|known_bad)(\/|$)/i.test(relative)
    ) {
      errors.push(`protected grading content is nested in the agent repository: ${path}`);
      continue;
    }
    if (content.length > 0 && protectedHashes.has(sha256(content))) {
      errors.push(`agent repository file duplicates protected package content: ${path}`);
    }
  }
}

function validateJson(files: Map<string, Buffer>, path: string, errors: string[]): void {
  const file = files.get(path);
  if (!file) return;
  try {
    JSON.parse(file.toString("utf8"));
  } catch {
    errors.push(`${path} must be valid JSON`);
  }
}

function validateDockerfile(file: Buffer | undefined, path: string, errors: string[]): void {
  if (!file) return;
  const text = file.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const args = match[2]!.trim().split(/\s+/).filter((token) => !token.startsWith("--"));
    const sources = args.slice(0, -1);
    if (
      sources.length === 0 ||
      sources.some((source) =>
        source.startsWith("/") ||
        source === ".." ||
        source.startsWith("../") ||
        /^https?:\/\//i.test(source))
    ) {
      errors.push(`${path} must not copy outside its isolated build context: ${line.trim()}`);
    }
  }
}

function table(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arrayOfTables(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString).map((entry) => entry.trim()).filter(Boolean) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scalarText(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function numericVersion(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.trunc(value));
  const parsed = Number.parseInt(String(value ?? "1"), 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
}

function runtimeEnvironmentPath(path: string): string {
  const normalized = normalizePackagePath(path);
  if (!normalized.startsWith("environment/")) {
    throw new Error(`agent lifecycle script must be under environment/: ${path}`);
  }
  return `/workspace/.agenteval/environment/${normalized.slice("environment/".length)}`;
}

function validProfile(value: string | null): TaskProfile | null {
  return value && ["bugfix", "feature", "refactor", "research", "general", "browser", "etl", "conversational"].includes(value)
    ? value as TaskProfile
    : null;
}

function validAgentCategory(value: string | null): AgentCategory | null {
  return value && ["coding", "research", "general", "browser", "data", "conversational"].includes(value)
    ? value as AgentCategory
    : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

async function listPackageFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`eval package contains unexpected symlink: ${entry.name}`);
    if (entry.isDirectory()) out.push(...(await listPackageFiles(root, absolute)));
    else if (entry.isFile()) out.push(absolute.slice(root.length + 1).split(sep).join("/"));
  }
  return out.sort();
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as { code: unknown }).code === "ENOENT";
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

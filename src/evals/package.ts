/** Canonical Terminal-Bench/Harbor-style eval package ingest and validation. */

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
  const setup = text(lifecycle.setup);
  const cleanup = text(lifecycle.cleanup);
  const verifierChecks = arrayOfTables(verifier.checks)
    .map((entry) => ({ id: text(entry.id), kind: text(entry.kind) }))
    .filter((entry): entry is EvalPackageVerifierCheck => entry.id !== null && entry.kind !== null);
  return {
    setupPath: setup ? runtimeEnvironmentPath(setup) : null,
    cleanupPath: cleanup ? runtimeEnvironmentPath(cleanup) : null,
    setupTimeoutMs: Math.trunc(Number(lifecycle.setup_timeout_seconds ?? timeouts.build_seconds ?? 300) * 1000),
    cleanupTimeoutMs: Math.trunc(Number(lifecycle.cleanup_timeout_seconds ?? 120) * 1000),
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
  return evalPackageRuntimeConfig(parsed);
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

/** Copy only agent-visible package inputs into a fresh workspace. */
export async function prepareEvalPackageWorkspace(input: {
  packagePath: string;
  packageDigest: string;
  manifest: Record<string, unknown>;
  workspaceDir: string;
}): Promise<void> {
  await verifyMaterializedEvalPackage(input);
  const repo = join(input.packagePath, "environment", "repo");
  const entries = await readdir(repo);
  if (entries.length === 0) throw new Error("canonical eval environment/repo is empty");
  for (const name of entries) {
    await cp(join(repo, name), join(input.workspaceDir, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  const runtimeDir = join(input.workspaceDir, ".agenteval", "environment");
  await mkdir(runtimeDir, { recursive: true });
  for (const name of await readdir(join(input.packagePath, "environment"))) {
    if (name === "repo") continue;
    await cp(join(input.packagePath, "environment", name), join(runtimeDir, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  for (const protectedName of ["solution", "validation"]) {
    try {
      await lstat(join(input.workspaceDir, protectedName));
      throw new Error(`protected eval content leaked into agent workspace: ${protectedName}`);
    } catch (err) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
}

/** Validate package structure, task metadata, alignment, and isolation in memory. */
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
    "environment/entrypoint.sh",
    "environment/healthcheck.sh",
    "tests/Dockerfile",
    "tests/test.sh",
    "validation/expected_results.json",
    "validation/flake_report.json",
  ]) {
    if (!files.has(required)) errors.push(`missing required file ${required}`);
  }
  requirePrefix(files, "environment/repo/", errors);
  requirePrefix(files, "solution/", errors);
  requirePrefix(files, "tests/", errors);
  requirePrefix(files, "validation/known_bad_patches/", errors);
  validateNoGeneratedArtifacts(files, errors);
  if (!files.has("solution/solve.sh") && !files.has("solution/reference.patch")) {
    errors.push("solution/ requires solve.sh or reference.patch");
  }

  let config: Record<string, unknown> = {};
  const taskToml = files.get("task.toml");
  if (taskToml) {
    try {
      const parsed = parseToml(taskToml.toString("utf8")) as unknown;
      if (!isRecord(parsed)) errors.push("task.toml root must be a table");
      else config = parsed;
    } catch (err) {
      errors.push(`task.toml is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const task = table(config.task);
  const lifecycle = table(config.lifecycle);
  const timeouts = table(config.timeouts);
  const resources = table(config.resources);
  const network = table(config.network);
  const artifacts = table(config.artifacts);
  const verifier = table(config.verifier);
  const explanations = table(config.explanations);
  const digests = table(config.digests);
  const taskId = text(task.id);
  const taskVersion = scalarText(task.version);
  const category = text(task.category);
  const language = text(task.language);
  if (!taskId) errors.push("task.toml [task].id is required");
  if (!taskVersion) errors.push("task.toml [task].version is required");
  if (!text(task.name)) errors.push("task.toml [task].name is required");
  if (!category) errors.push("task.toml [task].category is required");
  if (!language) errors.push("task.toml [task].language is required");
  if (!stringArray(task.tags).length) errors.push("task.toml [task].tags must be non-empty");
  for (const [section, key] of [
    [timeouts, "agent_seconds"], [timeouts, "verifier_seconds"], [timeouts, "build_seconds"],
    [resources, "cpu"], [resources, "ram_mb"], [resources, "disk_mb"],
  ] as const) {
    if (!positiveNumber(section[key])) errors.push(`task.toml missing positive ${key}`);
  }
  if (typeof resources.gpu !== "number" || !Number.isFinite(resources.gpu) || resources.gpu < 0) {
    errors.push("task.toml [resources].gpu must be a non-negative number");
  }
  if (!text(network.policy) || !["allow", "allowlist", "offline"].includes(String(network.policy))) {
    errors.push("task.toml [network].policy must be allow|allowlist|offline");
  } else if (network.policy === "allowlist" && stringArray(network.allowlist).length === 0) {
    errors.push("task.toml [network].allowlist must be non-empty when policy=allowlist");
  }
  if (!stringArray(artifacts.allowlist).length) errors.push("task.toml [artifacts].allowlist must be non-empty");
  if (verifier.separate !== true) errors.push("task.toml [verifier].separate must be true");
  if (text(verifier.dockerfile) !== "tests/Dockerfile") {
    errors.push("task.toml [verifier].dockerfile must be tests/Dockerfile");
  }
  if (!stringArray(verifier.command).length) errors.push("task.toml [verifier].command must be argv[]");
  for (const lifecycleKey of ["setup", "cleanup"] as const) {
    const scriptPath = text(lifecycle[lifecycleKey]);
    if (!scriptPath) continue;
    let normalized: string;
    try {
      normalized = normalizePackagePath(scriptPath);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!normalized.startsWith("environment/")) {
      errors.push(`[lifecycle].${lifecycleKey} must point under environment/`);
      continue;
    }
    const script = files.get(normalized)?.toString("utf8");
    if (!script) errors.push(`missing lifecycle script ${normalized}`);
    else if (!/set\s+-[^\n]*e[^\n]*u[^\n]*o\s+pipefail/.test(script)) {
      errors.push(`${normalized} must be fail-fast with set -euo pipefail`);
    }
  }
  for (const key of ["difficulty", "reference_solution", "verification"] as const) {
    if (!text(explanations[key])) errors.push(`task.toml [explanations].${key} is required`);
  }
  if (!positiveNumber(explanations.expert_minutes)) {
    errors.push("task.toml [explanations].expert_minutes must be positive");
  }
  for (const key of ["environment", "verifier", "dependencies"] as const) {
    if (!text(digests[key])) errors.push(`task.toml [digests].${key} is required`);
  }

  const requirements = arrayOfTables(config.requirements);
  const verifierChecks = arrayOfTables(verifier.checks);
  const requirementIds = requirements.map((entry) => text(entry.id)).filter(isString);
  const verifierCheckIds = verifierChecks.map((entry) => text(entry.id)).filter(isString);
  if (requirements.length === 0) errors.push("task.toml requires [[requirements]] entries");
  if (verifierChecks.length === 0) errors.push("task.toml [verifier].checks must list verifier checks");
  rejectDuplicates(requirementIds, "requirement id", errors);
  rejectDuplicates(verifierCheckIds, "verifier check id", errors);
  verifierChecks.forEach((check, index) => {
    if (!text(check.id)) errors.push(`verifier.checks[${index}].id is required`);
    if (!text(check.kind)) errors.push(`verifier.checks[${index}].kind is required`);
  });
  const referencedChecks = new Set<string>();
  requirements.forEach((requirement, index) => {
    const id = text(requirement.id);
    const statement = text(requirement.text);
    const checks = stringArray(requirement.checks);
    if (!id) errors.push(`requirements[${index}].id is required`);
    if (!statement) errors.push(`requirements[${index}].text is required`);
    if (!checks.length) errors.push(`requirements[${index}].checks must be non-empty`);
    checks.forEach((check) => referencedChecks.add(check));
  });
  for (const checkId of verifierCheckIds) {
    if (!referencedChecks.has(checkId)) errors.push(`verifier check ${checkId} has no instruction requirement`);
  }
  for (const checkId of referencedChecks) {
    if (!verifierCheckIds.includes(checkId)) errors.push(`instruction requirement references unknown verifier check ${checkId}`);
  }

  const agentEnv = table(config.agent_env);
  for (const key of Object.keys(agentEnv)) {
    if (/solution|answer|oracle|grader|verifier|hidden|test/i.test(key)) {
      errors.push(`agent-visible environment variable name leaks protected grading intent: ${key}`);
    }
  }
  validateProtectedContentIsolation(files, errors);
  validateJson(files, "validation/expected_results.json", errors);
  validateJson(files, "validation/flake_report.json", errors);
  validateDockerfile(files.get("environment/Dockerfile"), "environment/Dockerfile", errors);
  if (
    files.has("environment/Dockerfile") &&
    !/^\s*FROM\s+\$\{?AGENTEVAL_AGENT_IMAGE\}?(?:\s|$)/im.test(
      files.get("environment/Dockerfile")!.toString("utf8"),
    )
  ) {
    errors.push(
      "environment/Dockerfile must inherit from FROM ${AGENTEVAL_AGENT_IMAGE}; the platform injects the selected adapter image without exposing grading content",
    );
  }
  validateDockerfile(files.get("tests/Dockerfile"), "tests/Dockerfile", errors);

  const instruction = files.get("instruction.md")?.toString("utf8").trim() ?? "";
  if (!instruction) errors.push("instruction.md must be non-empty");
  else if (!instruction.includes("/workspace/")) {
    errors.push("instruction.md must identify enforced repository paths under /workspace/");
  }
  const criteria = requirements.map((requirement, index) => {
    const statement = text(requirement.text) ?? `Requirement ${index + 1}`;
    return {
      id: text(requirement.id) ?? `A${index + 1}`,
      axis: "A" as RubricAxis,
      label: statement.slice(0, 120),
      weight: requirements.length > 0 ? 1 / requirements.length : 1,
      critical: requirement.critical !== false,
      appliesTo: "coding" as const,
      anchors: {
        full: `The isolated verifier confirms: ${statement}`,
        partial: `Some but not all verifier checks for this requirement pass: ${statement}`,
        none: `The verifier does not confirm: ${statement}`,
      },
    };
  });
  const profile = validProfile(text(task.profile)) ?? "general";
  const agentCategory = validAgentCategory(text(task.agent_category)) ?? "coding";
  const taskSpec: TaskSpec = {
    id: taskId ?? undefined,
    name: text(task.name) ?? taskId ?? "invalid-eval",
    prompt: instruction,
    workspace: { source: "empty" },
    rubric: { criteria, profile, version: numericVersion(task.version) },
    tags: stringArray(task.tags),
    profile,
    agentCategory,
    ...(category ? { categoryName: category } : {}),
  };

  const validation: EvalPackageValidation = {
    schemaVersion: EVAL_PACKAGE_SCHEMA_VERSION,
    valid: errors.length === 0,
    errors,
    warnings,
    taskId,
    taskVersion,
    category,
    language,
    verifierCheckIds,
    requirementIds,
    protectedPaths: ["solution/", "tests/", "validation/"],
    agentBuildContext: "environment/",
    verifierBuildContext: "tests/",
  };
  return { validation, taskSpec, config };
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
  for (const [path, content] of files) {
    if (!path.startsWith("environment/repo/")) continue;
    const relative = path.slice("environment/repo/".length);
    if (
      /(^|\/)(solution|validation|\.agenteval)(\/|$)/i.test(relative) ||
      /(^|\/)tests\/(oracle|hidden|private)(\/|$)/i.test(relative) ||
      /(^|\/)(reference\.patch|solve\.sh|expected_results\.json|flake_report\.json)(\/|$)/i.test(relative) ||
      /(^|\/)known_bad_patches(\/|$)/i.test(relative)
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

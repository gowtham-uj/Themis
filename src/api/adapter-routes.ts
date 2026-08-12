/** Project-scoped CRUD for one real CLI-agent adapter per project. */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveRuntime } from "../runner/runtime.js";
import { normalizeRepoUrl, prepareWorkspace } from "../runner/workspace.js";

const execFileAsync = promisify(execFile);
import { runAdapterGenerator, GENERATOR_CONTRACT } from "../adapters/generator.js";
import { createDeclarativeAdapter, renderTemplate } from "../adapters/declarative.js";
import type { RunContext } from "../adapters/types.js";
import type {
  CliAdapterEvidenceConfig,
  CliAdapterParserKind,
  CliCommandTemplate,
  CreateProjectAgentAdapterInput,
  DbQueries,
  ProjectAgentAdapter,
  UpdateProjectAgentAdapterInput,
} from "../db/queries.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { readJsonBody, sendJson, type RequestContext, type Router } from "./router.js";

const PARSERS = new Set<CliAdapterParserKind>([
  "canonical-jsonl",
  "pi-jsonl",
  "reapercode-jsonl",
]);

interface AdapterAppCtx {
  queries: DbQueries;
  dataDir: string;
}

function appOf(ctx: RequestContext): AdapterAppCtx {
  return ctx.app as AdapterAppCtx;
}

function requireProject(queries: DbQueries, projectId: string): void {
  const project = queries.getProject(projectId);
  if (!project || project.archived) throw notFound(`project not found: ${projectId}`);
}

function requireAdapter(
  queries: DbQueries,
  projectId: string,
  adapterId: string,
): ProjectAgentAdapter {
  const adapter = queries.getProjectAgentAdapter(adapterId);
  if (!adapter || adapter.projectId !== projectId) {
    throw notFound(`agent adapter not found: ${adapterId}`);
  }
  return adapter;
}

function commandTemplate(
  value: unknown,
  name: string,
  allowEmpty = false,
): CliCommandTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.argv) ||
    (!allowEmpty && raw.argv.length === 0) ||
    !raw.argv.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    if (allowEmpty && Array.isArray(raw.argv) && raw.argv.length === 0) {
      // empty argv placeholder for derived connection_check — ok
    } else {
      throw badRequest(`${name}.argv must be a non-empty string array`);
    }
  }
  const out: CliCommandTemplate = { argv: [...raw.argv] as string[] };
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      throw badRequest(`${name}.env must be a string map`);
    }
    const env: Record<string, string> = {};
    for (const [key, entry] of Object.entries(raw.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string") {
        throw badRequest(`${name}.env must contain valid environment names and string values`);
      }
      env[key] = entry;
    }
    out.env = env;
  }
  if (typeof raw.cwd === "string") out.cwd = raw.cwd;
  if (raw.timeout_ms !== undefined || raw.timeoutMs !== undefined) {
    const timeout = raw.timeout_ms ?? raw.timeoutMs;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
      throw badRequest(`${name}.timeout_ms must be a positive integer`);
    }
    out.timeoutMs = timeout;
  }
  return out;
}

function evidenceConfig(value: unknown): CliAdapterEvidenceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("evidence must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.paths) || !raw.paths.every((path) => typeof path === "string")) {
    throw badRequest("evidence.paths must be a string array");
  }
  const out: CliAdapterEvidenceConfig = { paths: [...raw.paths] as string[] };
  const required = raw.required_paths ?? raw.requiredPaths;
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((path) => typeof path === "string")) {
      throw badRequest("evidence.required_paths must be a string array");
    }
    out.requiredPaths = [...required] as string[];
  }
  return out;
}

function recordOrNull(value: unknown, name: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object or null`);
  }
  return value as Record<string, unknown>;
}

function parserKind(value: unknown): CliAdapterParserKind {
  if (typeof value !== "string" || !PARSERS.has(value as CliAdapterParserKind)) {
    throw badRequest(`parser_kind must be one of ${[...PARSERS].join(", ")}`);
  }
  return value as CliAdapterParserKind;
}

function installType(value: unknown): "source-build" | "npm" {
  if (value === undefined || value === null) return "source-build";
  if (value !== "source-build" && value !== "npm") {
    throw badRequest("install_type must be source-build or npm");
  }
  return value;
}

function queuesReferencingAdapter(queries: DbQueries, adapterId: string) {
  return queries
    .listProjects({ includeArchived: true })
    .flatMap((project) => queries.listEvalQueues(project.id))
    .filter((queue) => queue.sharedAdapterId === adapterId);
}

interface AdapterBuildAppCtx {
  queries: DbQueries;
  dataDir: string;
}

/** Build (or rebuild) an adapter's OCI image from its source_repo + containerfile. */
async function buildAdapter(
  app: AdapterBuildAppCtx,
  projectId: string,
  adapter: ProjectAgentAdapter,
): Promise<{ adapter: ProjectAgentAdapter; build: Record<string, unknown> }> {
  if (!adapter.containerfile) {
    throw badRequest("adapter containerfile is required before build");
  }
  // npm install type: no source repo needed — the Containerfile pulls the
  // package from the npm registry during build. source-build: clone git repo.
  const isNpm = adapter.installType === "npm";
  if (!isNpm && !adapter.sourceRepo) {
    throw badRequest("adapter source_repo is required before build (or set install_type to 'npm')");
  }
  // Cache by source ref/commit: if this adapter already built the exact commit
  // the source ref resolves to, reuse the existing image instead of re-cloning
  // and re-running the expensive npm install/build. Only a NEW commit triggers
  // a rebuild.
  if (!isNpm && adapter.sourceRepo && adapter.builtCommit && adapter.builtImageId) {
    try {
      const resolved = await resolveRefCommit(adapter.sourceRepo, adapter.sourceRef ?? null);
      if (resolved && resolved === adapter.builtCommit) {
        app.queries.updateProjectAgentAdapter(adapter.id, { buildStatus: "ready" });
        return {
          adapter: app.queries.getProjectAgentAdapter(adapter.id)!,
          build: {
            image: adapter.image,
            image_id: adapter.builtImageId,
            commit: adapter.builtCommit,
            duration_ms: 0,
            cached: true,
            log_path: null,
          },
        };
      }
    } catch {
      // fall through to a real build if ref resolution fails
    }
  }

  const sourceDir = join(
    app.dataDir,
    "projects",
    projectId,
    "adapters",
    adapter.id,
    "source",
  );
  const buildDir = join(app.dataDir, "projects", projectId, "adapters", adapter.id);
  const logPath = join(buildDir, "build.log");
  await rm(sourceDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  app.queries.updateProjectAgentAdapter(adapter.id, {
    buildStatus: "building",
    buildLogPath: logPath,
  });
  try {
    let commit: string | null = null;
    if (!isNpm && adapter.sourceRepo) {
      const prepared = await prepareWorkspace(
        {
          source: "git",
          repo: adapter.sourceRepo,
          ...(adapter.sourceRef ? { ref: adapter.sourceRef } : {}),
        },
        { targetDir: sourceDir },
      );
      commit = prepared.commit ?? null;
    } else {
      // npm install: create a minimal context dir with just the Containerfile.
      await mkdir(sourceDir, { recursive: true });
    }
    // Cross-adapter reuse: if another adapter (any project, or shared) already
    // built this exact source_repo + commit and its image still exists in the
    // container backend, record that ready image onto this adapter instead of
    // re-running the expensive `npm ci && npm run build`. This honors "reuse the
    // CLI already built until the source gets a new commit" even for a brand-new
    // adapter row whose built_commit is null on first build.
    if (!isNpm && adapter.sourceRepo && commit) {
      const donor = app.queries.findReadyAdapterForSourceCommit(
        adapter.sourceRepo,
        commit,
      );
      if (
        donor &&
        donor.id !== adapter.id &&
        donor.builtImageId &&
        (await resolveRuntime().imageExists(donor.image))
      ) {
        const updated = app.queries.updateProjectAgentAdapter(adapter.id, {
          buildStatus: "ready",
          builtImageId: donor.builtImageId,
          builtCommit: commit,
          buildLogPath: logPath,
          lastBuiltAt: new Date().toISOString(),
        });
        await writeFile(
          logPath,
          `reused existing image ${donor.image} (id ${donor.builtImageId}) built from commit ${commit} of adapter ${donor.id}\n`,
          "utf8",
        );
        return {
          adapter: updated,
          build: {
            image: donor.image,
            image_id: donor.builtImageId,
            commit,
            duration_ms: 0,
            log_path: logPath,
            reused_image: true,
          },
        };
      }
    }
    const containerfilePath = join(sourceDir, ".agenteval.Containerfile");
    await writeFile(containerfilePath, adapter.containerfile, "utf8");
    const result = await resolveRuntime().buildImage({
      contextDir: sourceDir,
      containerfilePath,
      image: adapter.image,
      timeoutMs: 1_800_000,
    });
    await writeFile(
      logPath,
      `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
      "utf8",
    );
    const updated = app.queries.updateProjectAgentAdapter(adapter.id, {
      buildStatus: "ready",
      builtImageId: result.imageId,
      builtCommit: commit,
      buildLogPath: logPath,
      lastBuiltAt: new Date().toISOString(),
    });
    return {
      adapter: updated,
      build: {
        image: result.image,
        image_id: result.imageId,
        commit,
        duration_ms: result.durationMs,
        log_path: logPath,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFile(logPath, `${message}\n`, "utf8").catch(() => undefined);
    app.queries.updateProjectAgentAdapter(adapter.id, {
      buildStatus: "failed",
      buildLogPath: logPath,
      lastBuiltAt: new Date().toISOString(),
    });
    throw err;
  }
}

/**
 * Resolve the commit a source ref points to WITHOUT a full clone, using a
 * lightweight git query against a local repo path when possible. Returns null
 * (or throws) when the ref cannot be resolved cheaply, signaling the caller to
 * fall back to a real build.
 */
async function resolveRefCommit(repo: string, ref: string | null): Promise<string | null> {
  const normalized = normalizeRepoUrl(repo);
  try {
    const target = ref ? ref.trim() : "HEAD";
    const { stdout } = await execFileAsync(
      "git",
      ["-C", normalized, "rev-parse", "--verify", `${target}^{commit}`],
      { timeout: 15_000 },
    );
    const commit = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** Collect harness credentials available to the project for generator provisioning. */
function collectHarnessCredentials(): Record<string, string> {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "MINIMAX_API_KEY",
    "NEURALWATT_API_KEY",
    "NURALWATT_API_KEY",
    "ANTHROPIC_BASE_URL",
  ];
  const keys: Record<string, string> = {};
  for (const name of names) {
    const v = process.env[name];
    if (v) keys[name] = v;
  }
  if (!keys.ANTHROPIC_API_KEY && keys.ANTHROPIC_AUTH_TOKEN) {
    keys.ANTHROPIC_API_KEY = keys.ANTHROPIC_AUTH_TOKEN;
  }
  return keys;
}

/** Build a synthetic RunContext for the validate/dry-run endpoint. */
function sampleRunContext(adapter: ProjectAgentAdapter): RunContext {
  const apiKeys: Record<string, string> = {};
  for (const name of Object.keys(collectHarnessCredentials())) {
    apiKeys[name] = `<redacted:${name}>`;
  }
  // Provider/model live on the project, not the adapter; use safe placeholders.
  return {
    runId: "sample-run-id",
    project: { id: adapter.projectId },
    task: { prompt: "sample eval prompt", workspace: { source: "empty" } },
    model: "sample-model",
    provider: "sample-provider",
    params: {},
    workspaceDir: "/workspace",
    apiKeys,
    overrides: { env: {} },
  };
}

export function registerAdapterRoutes(router: Router): void {
  router.post("/api/projects/:id/adapters", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const body = await readJsonBody<Record<string, unknown>>(req);
    const agentId = body.agent_id ?? body.agentId;
    if (typeof agentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(agentId)) {
      throw badRequest("agent_id is required and may contain letters, numbers, dot, underscore, or dash");
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw badRequest("name is required");
    }
    if (typeof body.image !== "string" || !body.image.trim()) {
      throw badRequest("image is required");
    }
    const deriveConnectionCheck = Boolean(
      body.connection_check_derived ??
        body.connectionCheckDerived ??
        (body.connection_check === undefined && body.connectionCheck === undefined),
    );
    const input: CreateProjectAgentAdapterInput = {
      agentId,
      name: body.name.trim(),
      image: body.image.trim(),
      command: commandTemplate(body.command, "command"),
      connectionCheck: commandTemplate(
        body.connection_check ?? body.connectionCheck ?? { argv: [] },
        "connection_check",
        deriveConnectionCheck,
      ),
      connectionCheckDerived: deriveConnectionCheck,
      evidence: evidenceConfig(body.evidence),
      parserKind: parserKind(body.parser_kind ?? body.parserKind),
    };
    if (body.description === null || typeof body.description === "string") {
      input.description = body.description as string | null;
    }
    if (typeof body.format_version === "number") input.formatVersion = body.format_version;
    if (body.parser_config !== undefined || body.parserConfig !== undefined) {
      input.parserConfig = recordOrNull(
        body.parser_config ?? body.parserConfig,
        "parser_config",
      );
    }
    if (body.provider_config !== undefined || body.providerConfig !== undefined) {
      input.providerConfig = recordOrNull(
        body.provider_config ?? body.providerConfig,
        "provider_config",
      );
    }
    const sourceRepo = body.source_repo ?? body.sourceRepo;
    if (sourceRepo === null || typeof sourceRepo === "string") input.sourceRepo = sourceRepo;
    const sourceRef = body.source_ref ?? body.sourceRef;
    if (sourceRef === null || typeof sourceRef === "string") input.sourceRef = sourceRef;
    if (body.containerfile === null || typeof body.containerfile === "string") {
      input.containerfile = body.containerfile as string | null;
    }
    if (typeof body.enabled === "boolean") input.enabled = body.enabled;
    if (typeof body.shared === "boolean") input.shared = body.shared;
    input.installType = installType(body.install_type ?? body.installType);
    const configureVal = body.configure;
    if (configureVal === null || (configureVal && typeof configureVal === "object")) {
      input.configure = configureVal === null ? null : commandTemplate(configureVal, "configure");
    }
    const defaultModel = body.default_model ?? body.defaultModel;
    if (typeof defaultModel === "string") input.defaultModel = defaultModel;
    const defaultProvider = body.default_provider ?? body.defaultProvider;
    if (typeof defaultProvider === "string") input.defaultProvider = defaultProvider;

    try {
      const adapter = app.queries.createProjectAgentAdapter(projectId, input);
      app.queries.updateProject(projectId, {
        defaultAgentId: adapter.agentId,
        ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
        ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
      });
      sendJson(res, 201, { adapter });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already has an agent adapter/i.test(message)) throw conflict(message);
      throw err;
    }
  });

  router.get("/api/projects/:id/adapters", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    sendJson(res, 200, {
      adapters: app.queries.listProjectAgentAdapters(projectId, {
        includeDisabled: true,
      }),
    });
  });

  router.get("/api/projects/:id/adapters/:adapterId", (_req, res, ctx) => {
    const app = appOf(ctx);
    requireProject(app.queries, ctx.params.id!);
    sendJson(res, 200, {
      adapter: requireAdapter(app.queries, ctx.params.id!, ctx.params.adapterId!),
    });
  });

  router.patch("/api/projects/:id/adapters/:adapterId", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const existing = requireAdapter(app.queries, projectId, ctx.params.adapterId!);
    if (app.queries.listEvalQueues(projectId).some((queue) => app.queries.getActiveQueueContainer(queue.id))) {
      throw conflict("stop all project queue containers before editing the agent adapter");
    }
    const body = await readJsonBody<Record<string, unknown>>(req);
    const references = queuesReferencingAdapter(app.queries, existing.id);
    const metadataOnly = new Set(["name", "description"]);
    const changesExecutionContract = Object.keys(body).some((key) => !metadataOnly.has(key));
    if (references.length > 0 && changesExecutionContract) {
      throw conflict(
        `adapter is referenced by ${references.length} queue(s); remove those shared_adapter_id references before changing its execution contract`,
      );
    }
    const patch: UpdateProjectAgentAdapterInput = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body.description === null || typeof body.description === "string") {
      patch.description = body.description as string | null;
    }
    if (typeof body.format_version === "number") patch.formatVersion = body.format_version;
    if (typeof body.image === "string" && body.image.trim()) patch.image = body.image.trim();
    if (body.command !== undefined) patch.command = commandTemplate(body.command, "command");
    if (body.connection_check !== undefined || body.connectionCheck !== undefined) {
      const derived = Boolean(
        body.connection_check_derived ?? body.connectionCheckDerived,
      );
      patch.connectionCheck = commandTemplate(
        body.connection_check ?? body.connectionCheck ?? { argv: [] },
        "connection_check",
        derived,
      );
      if (body.connection_check_derived !== undefined || body.connectionCheckDerived !== undefined) {
        patch.connectionCheckDerived = derived;
      }
    }
    if (body.evidence !== undefined) patch.evidence = evidenceConfig(body.evidence);
    if (body.parser_kind !== undefined || body.parserKind !== undefined) {
      patch.parserKind = parserKind(body.parser_kind ?? body.parserKind);
    }
    if (body.parser_config !== undefined || body.parserConfig !== undefined) {
      patch.parserConfig = recordOrNull(
        body.parser_config ?? body.parserConfig,
        "parser_config",
      );
    }
    if (body.provider_config !== undefined || body.providerConfig !== undefined) {
      patch.providerConfig = recordOrNull(
        body.provider_config ?? body.providerConfig,
        "provider_config",
      );
    }
    const sourceRepo = body.source_repo ?? body.sourceRepo;
    if (sourceRepo === null || typeof sourceRepo === "string") patch.sourceRepo = sourceRepo;
    const sourceRef = body.source_ref ?? body.sourceRef;
    if (sourceRef === null || typeof sourceRef === "string") patch.sourceRef = sourceRef;
    if (body.containerfile === null || typeof body.containerfile === "string") {
      patch.containerfile = body.containerfile as string | null;
    }
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.shared === "boolean") patch.shared = body.shared;
    if (body.install_type !== undefined || body.installType !== undefined) {
      patch.installType = installType(body.install_type ?? body.installType);
    }
    if (body.configure !== undefined) {
      patch.configure = body.configure === null
        ? null
        : commandTemplate(body.configure, "configure");
    }
    const buildInputsChanged =
      patch.image !== undefined ||
      patch.sourceRepo !== undefined ||
      patch.sourceRef !== undefined ||
      patch.containerfile !== undefined ||
      patch.installType !== undefined;
    if (buildInputsChanged) {
      patch.buildStatus = "unbuilt";
      patch.builtImageId = null;
      patch.builtCommit = null;
      patch.buildLogPath = null;
      patch.lastBuiltAt = null;
    }
    const defaultModel = body.default_model ?? body.defaultModel;
    if (defaultModel === null || typeof defaultModel === "string") {
      patch.defaultModel = defaultModel as string | null;
    }
    const defaultProvider = body.default_provider ?? body.defaultProvider;
    if (defaultProvider === null || typeof defaultProvider === "string") {
      patch.defaultProvider = defaultProvider as string | null;
    }
    const adapter = app.queries.updateProjectAgentAdapter(existing.id, patch);
    app.queries.updateProject(projectId, {
      defaultAgentId: adapter.agentId,
      ...(patch.defaultModel !== undefined ? { defaultModel: patch.defaultModel } : {}),
      ...(patch.defaultProvider !== undefined
        ? { defaultProvider: patch.defaultProvider }
        : {}),
    });
    sendJson(res, 200, { adapter });
  });

  router.post(
    "/api/projects/:id/adapters/:adapterId/build",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      requireProject(app.queries, projectId);
      const adapter = requireAdapter(app.queries, projectId, ctx.params.adapterId!);
      const references = queuesReferencingAdapter(app.queries, adapter.id);
      if (references.length > 0) {
        throw conflict(
          `adapter is referenced by ${references.length} queue(s); remove those shared_adapter_id references before rebuilding it`,
        );
      }
      if (app.queries.listEvalQueues(projectId).some((queue) => app.queries.getActiveQueueContainer(queue.id))) {
        throw conflict("stop all project queue containers before rebuilding the agent image");
      }
      const result = await buildAdapter(app, projectId, adapter);
      sendJson(res, 200, result);
    },
  );

  // --- Generator: run a user-authored script that emits the adapter contract ---

  router.post(
    "/api/projects/:id/adapters/from-generator",
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      requireProject(app.queries, projectId);
      const body = await readJsonBody<{
        agent_id?: string;
        agentId?: string;
        name?: string;
        generator?: string;
        source_repo?: string;
        sourceRepo?: string;
        source_ref?: string;
        sourceRef?: string;
        default_provider?: string;
        defaultProvider?: string;
        default_model?: string;
        defaultModel?: string;
        install_type?: string;
        installType?: string;
        build?: boolean;
      }>(req);
      const agentId = body.agent_id ?? body.agentId;
      if (typeof agentId !== "string" || !/^[A-Za-z0-9._-]+$/.test(agentId)) {
        throw badRequest("agent_id is required and may contain letters, numbers, dot, underscore, or dash");
      }
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw badRequest("name is required");
      }
      if (typeof body.generator !== "string" || !body.generator.trim()) {
        throw badRequest("generator (bash/JS script) is required");
      }
      const sourceRepoValue = body.source_repo ?? body.sourceRepo;
      if (sourceRepoValue !== undefined && (typeof sourceRepoValue !== "string" || !sourceRepoValue.trim())) {
        throw badRequest("source_repo must be a non-empty string when provided");
      }
      const sourceRepo = typeof sourceRepoValue === "string" ? sourceRepoValue.trim() : null;
      const sourceRef = body.source_ref ?? body.sourceRef ?? null;
      const requestedInstallType = installType(body.install_type ?? body.installType);
      const provider = body.default_provider ?? body.defaultProvider ?? "anthropic";
      const model = body.default_model ?? body.defaultModel ?? "";
      const shouldBuild = body.build !== false; // default: build after create

      const genResult = await runAdapterGenerator({
        projectId,
        agentId,
        generatorScript: body.generator,
        sourceRepo,
        ...(sourceRef ? { sourceRef } : {}),
        provider,
        model,
        credentials: collectHarnessCredentials(),
      });

      // Validate the emitted structure through the same validators as raw POST.
      const emitted = genResult.adapter;
      const emittedAgentId = emitted.agent_id ?? emitted.agentId;
      if (emittedAgentId !== agentId) {
        throw badRequest(`generator agent_id must exactly match requested agent_id ${agentId}`);
      }
      const emittedName = typeof emitted.name === "string" ? emitted.name.trim() : "";
      if (!emittedName) throw badRequest("generator output name is required");
      const emittedImage = typeof emitted.image === "string" ? emitted.image.trim() : "";
      if (!emittedImage) throw badRequest("generator output image is required");
      const emittedInstallType = installType(
        emitted.install_type ?? emitted.installType ?? requestedInstallType,
      );
      const input: CreateProjectAgentAdapterInput = {
        agentId,
        name: emittedName,
        image: emittedImage,
        command: commandTemplate(emitted.command, "command"),
        connectionCheck: commandTemplate(
          emitted.connection_check ?? emitted.connectionCheck ?? { argv: [] },
          "connection_check",
          Boolean(
            emitted.connection_check_derived ??
              emitted.connectionCheckDerived ??
              (emitted.connection_check === undefined && emitted.connectionCheck === undefined),
          ),
        ),
        connectionCheckDerived: Boolean(
          emitted.connection_check_derived ??
            emitted.connectionCheckDerived ??
            (emitted.connection_check === undefined && emitted.connectionCheck === undefined),
        ),
        evidence: evidenceConfig(emitted.evidence),
        parserKind: parserKind(emitted.parser_kind ?? emitted.parserKind),
        generatorScript: body.generator,
        installType: emittedInstallType,
      };
      if (typeof emitted.description === "string") input.description = emitted.description;
      if (typeof emitted.format_version === "number") input.formatVersion = emitted.format_version;
      if (emitted.parser_config !== undefined || emitted.parserConfig !== undefined) {
        input.parserConfig = recordOrNull(
          emitted.parser_config ?? emitted.parserConfig,
          "parser_config",
        );
      }
      if (emitted.provider_config !== undefined || emitted.providerConfig !== undefined) {
        input.providerConfig = recordOrNull(
          emitted.provider_config ?? emitted.providerConfig,
          "provider_config",
        );
      }
      const emittedRepo = emitted.source_repo ?? emitted.sourceRepo;
      if (emittedRepo !== undefined && emittedRepo !== null && (typeof emittedRepo !== "string" || !emittedRepo.trim())) {
        throw badRequest("generator output source_repo must be a non-empty string when provided");
      }
      if (
        sourceRepo &&
        typeof emittedRepo === "string" &&
        emittedRepo.trim() !== sourceRepo
      ) {
        throw badRequest("generator output source_repo must match the repository inspected by the generator");
      }
      const resolvedSourceRepo =
        typeof emittedRepo === "string" ? emittedRepo.trim() : sourceRepo;
      if (emittedInstallType === "source-build" && !resolvedSourceRepo) {
        throw badRequest("source-build generator output requires source_repo");
      }
      input.sourceRepo = resolvedSourceRepo;
      const emittedRef = emitted.source_ref ?? emitted.sourceRef;
      if (emittedRef === null || typeof emittedRef === "string") input.sourceRef = emittedRef;
      else if (sourceRef) input.sourceRef = sourceRef;
      if (typeof emitted.containerfile !== "string" || !emitted.containerfile.trim()) {
        throw badRequest("generator output containerfile is required");
      }
      input.containerfile = emitted.containerfile;
      if (typeof emitted.enabled === "boolean") input.enabled = emitted.enabled;
      if (typeof emitted.shared === "boolean") input.shared = emitted.shared;
      const emittedConfigure = emitted.configure;
      if (emittedConfigure === null || (emittedConfigure && typeof emittedConfigure === "object")) {
        input.configure = emittedConfigure === null ? null : commandTemplate(emittedConfigure, "configure");
      }
      if (typeof (emitted.default_model ?? emitted.defaultModel) === "string") {
        input.defaultModel = (emitted.default_model ?? emitted.defaultModel) as string;
      } else if (model) input.defaultModel = model;
      if (typeof (emitted.default_provider ?? emitted.defaultProvider) === "string") {
        input.defaultProvider = (emitted.default_provider ?? emitted.defaultProvider) as string;
      } else input.defaultProvider = provider;

      const adapter = app.queries.createProjectAgentAdapter(projectId, input);
      app.queries.updateProject(projectId, {
        defaultAgentId: adapter.agentId,
        ...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
        ...(input.defaultProvider ? { defaultProvider: input.defaultProvider } : {}),
      });

      if (shouldBuild) {
        const buildResult = await buildAdapter(app, projectId, adapter);
        sendJson(res, 201, { adapter: buildResult.adapter, build: buildResult.build, generator: { stdout: genResult.stdout.slice(0, 5000), stderr: genResult.stderr.slice(0, 2000) } });
      } else {
        sendJson(res, 201, { adapter, generator: { stdout: genResult.stdout.slice(0, 5000), stderr: genResult.stderr.slice(0, 2000) } });
      }
    },
  );

  // --- Discovery: the generator input/output contract + examples ---

  router.get("/api/adapters/generator-contract", (_req, res, _ctx) => {
    sendJson(res, 200, GENERATOR_CONTRACT);
  });

  // --- Shared adapters: cross-project discovery ---

  router.get("/api/adapters/store", (_req, res, ctx) => {
    const app = appOf(ctx);
    sendJson(res, 200, { adapters: app.queries.listSharedAdapters() });
  });

  // --- Validate / dry-run: render command + connection_check, no execution ---

  router.post(
    "/api/projects/:id/adapters/:adapterId/validate",
    async (_req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      requireProject(app.queries, projectId);
      const adapter = requireAdapter(app.queries, projectId, ctx.params.adapterId!);
      const ctx2 = sampleRunContext(adapter);
      const decAdapter = createDeclarativeAdapter(adapter);
      const command = decAdapter.command(ctx2);
      const connectionCheck = decAdapter.connectionCheck(ctx2);
      const configure = decAdapter.configure?.(ctx2) ?? null;
      sendJson(res, 200, {
        command: {
          argv: command.argv,
          env: command.env,
          ...(command.cwd ? { cwd: command.cwd } : {}),
          ...(command.timeoutMs ? { timeout_ms: command.timeoutMs } : {}),
        },
        connection_check: {
          argv: connectionCheck.command.argv,
          env: connectionCheck.command.env,
          ...(connectionCheck.cwd ? { cwd: connectionCheck.cwd } : {}),
          ...(connectionCheck.timeoutMs ? { timeout_ms: connectionCheck.timeoutMs } : {}),
        },
        configure: configure
          ? {
              argv: configure.command.argv,
              env: configure.command.env,
              ...(configure.cwd ? { cwd: configure.cwd } : {}),
              ...(configure.timeoutMs ? { timeout_ms: configure.timeoutMs } : {}),
            }
          : null,
        image: decAdapter.image(ctx2),
        evidence: decAdapter.evidence(ctx2),
      });
    },
  );

  router.delete("/api/projects/:id/adapters/:adapterId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const existing = requireAdapter(app.queries, projectId, ctx.params.adapterId!);
    const references = queuesReferencingAdapter(app.queries, existing.id);
    if (references.length > 0) {
      throw conflict(
        `adapter is referenced by ${references.length} queue(s); remove those shared_adapter_id references before deleting it`,
      );
    }
    if (app.queries.listEvalQueues(projectId).some((queue) => app.queries.getActiveQueueContainer(queue.id))) {
      throw conflict("stop all project queue containers before deleting the agent adapter");
    }
    app.queries.deleteProjectAgentAdapter(existing.id);
    app.queries.updateProject(projectId, { defaultAgentId: null });
    res.statusCode = 204;
    res.end();
  });
}

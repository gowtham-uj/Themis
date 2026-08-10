/** Project-scoped CRUD for one real CLI-agent adapter per project. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRuntime } from "../runner/runtime.js";
import { prepareWorkspace } from "../runner/workspace.js";
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

function commandTemplate(value: unknown, name: string): CliCommandTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.argv) ||
    raw.argv.length === 0 ||
    !raw.argv.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw badRequest(`${name}.argv must be a non-empty string array`);
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

/** Register project-agent adapter CRUD endpoints. */
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
    const input: CreateProjectAgentAdapterInput = {
      agentId,
      name: body.name.trim(),
      image: body.image.trim(),
      command: commandTemplate(body.command, "command"),
      connectionCheck: commandTemplate(
        body.connection_check ?? body.connectionCheck,
        "connection_check",
      ),
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
    const patch: UpdateProjectAgentAdapterInput = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (body.description === null || typeof body.description === "string") {
      patch.description = body.description as string | null;
    }
    if (typeof body.format_version === "number") patch.formatVersion = body.format_version;
    if (typeof body.image === "string" && body.image.trim()) patch.image = body.image.trim();
    if (body.command !== undefined) patch.command = commandTemplate(body.command, "command");
    if (body.connection_check !== undefined || body.connectionCheck !== undefined) {
      patch.connectionCheck = commandTemplate(
        body.connection_check ?? body.connectionCheck,
        "connection_check",
      );
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
      if (app.queries.listEvalQueues(projectId).some((queue) => app.queries.getActiveQueueContainer(queue.id))) {
        throw conflict("stop all project queue containers before rebuilding the agent image");
      }
      if (!adapter.sourceRepo || !adapter.containerfile) {
        throw badRequest("adapter source_repo and containerfile are required before build");
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
        const prepared = await prepareWorkspace(
          {
            source: "git",
            repo: adapter.sourceRepo,
            ...(adapter.sourceRef ? { ref: adapter.sourceRef } : {}),
          },
          { targetDir: sourceDir },
        );
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
          builtCommit: prepared.commit ?? null,
          buildLogPath: logPath,
          lastBuiltAt: new Date().toISOString(),
        });
        sendJson(res, 200, {
          adapter: updated,
          build: {
            image: result.image,
            image_id: result.imageId,
            commit: prepared.commit ?? null,
            duration_ms: result.durationMs,
            log_path: logPath,
          },
        });
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
    },
  );

  router.delete("/api/projects/:id/adapters/:adapterId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const existing = requireAdapter(app.queries, projectId, ctx.params.adapterId!);
    if (app.queries.listEvalQueues(projectId).some((queue) => app.queries.getActiveQueueContainer(queue.id))) {
      throw conflict("stop all project queue containers before deleting the agent adapter");
    }
    app.queries.deleteProjectAgentAdapter(existing.id);
    app.queries.updateProject(projectId, { defaultAgentId: null });
    res.statusCode = 204;
    res.end();
  });
}

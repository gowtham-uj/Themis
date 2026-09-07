/**
 * Global eval store routes.
 *
 * The store holds canonical eval packages that are not owned by any project.
 * A project copies one into its own eval list; the store copy stays where it is
 * and remains available to every other project.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { DbQueries, Project, StoreEval, Task } from "../db/queries.js";
import {
  decodeEvalArchiveFile,
  detectEvalLayout,
  splitSuiteTasks,
  type EvalArchiveFormat,
} from "../evals/archive.js";
import {
  materializeEvalPackage,
  type EvalPackageUpload,
} from "../evals/package.js";
import { Router, readJsonBody, sendJson, type RequestContext } from "./router.js";
import { badRequest, notFound } from "./errors.js";
import { requireAdminRequest } from "./auth.js";

interface StoreAppCtx {
  queries: DbQueries;
  dataDir: string;
  authEnabled: boolean;
}

function appOf(ctx: RequestContext): StoreAppCtx {
  return ctx.app as StoreAppCtx;
}

/** Serialize one store entry for the HTTP API. */
export function storeEvalJson(e: StoreEval) {
  return {
    id: e.id,
    name: e.name,
    prompt: e.prompt,
    workspace: e.workspace,
    rubric: e.rubric,
    version: e.version,
    rubric_version: e.rubricVersion,
    agent_category: e.agentCategory,
    category_name: e.categoryName,
    profile: e.profile,
    reference_solution: e.referenceSolution,
    checks: e.checks,
    env: e.env,
    tags: e.tags,
    package_digest: e.packageDigest,
    package_manifest: e.packageManifest,
    package_validation: e.packageValidation,
    archived: e.archived,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

function storePackageDir(dataDir: string, id: string): string {
  return join(dataDir, "eval-store", id, "package");
}

/** Read every file of a materialized package back into a path→bytes map. */
async function readPackageFiles(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = absolute.slice(root.length + 1).split(sep).join("/");
      // Written by materializeEvalPackage, not part of the authored package.
      if (rel === ".agenteval-package.json") continue;
      out.set(rel, await readFile(absolute));
    }
  };
  await walk(root);
  return out;
}

function toUpload(files: Map<string, Buffer>): EvalPackageUpload {
  const uploadFiles: EvalPackageUpload["files"] = {};
  for (const [path, content] of files) {
    uploadFiles[path] = { encoding: "base64", content: content.toString("base64") };
  }
  return { files: uploadFiles };
}

/** Validate and materialize one package into the global store. */
async function createStoreEvalFromFiles(
  app: StoreAppCtx,
  files: Map<string, Buffer>,
): Promise<StoreEval> {
  const id = randomUUID();
  const packagePath = storePackageDir(app.dataDir, id);
  const materialized = await materializeEvalPackage({
    upload: toUpload(files),
    destination: packagePath,
  });
  try {
    return app.queries.createStoreEval({
      id,
      spec: materialized.taskSpec,
      packagePath: materialized.packagePath,
      packageDigest: materialized.packageDigest,
      packageManifest: materialized.manifest as unknown as Record<string, unknown>,
      packageValidation: materialized.validation as unknown as Record<string, unknown>,
    });
  } catch (err) {
    await rm(join(packagePath, ".."), { recursive: true, force: true });
    throw err;
  }
}

/** Copy one store package into a project as a normal project eval. */
async function copyStoreEvalToProject(
  app: StoreAppCtx,
  entry: StoreEval,
  project: Project,
): Promise<Task> {
  if (!entry.packagePath) {
    throw badRequest(`store eval ${entry.id} has no materialized package to copy`);
  }
  const files = await readPackageFiles(entry.packagePath).catch(() => {
    throw badRequest(`store eval ${entry.id} package is missing from disk`);
  });
  const id = randomUUID();
  const packagePath = join(app.dataDir, "projects", project.id, "evals", id, "package");
  const materialized = await materializeEvalPackage({
    upload: toUpload(files),
    destination: packagePath,
  });
  try {
    return app.queries.createTask(project.id, materialized.taskSpec, {
      id,
      sourceKind: "eval-store",
      packagePath: materialized.packagePath,
      packageDigest: materialized.packageDigest,
      packageManifest: materialized.manifest as unknown as Record<string, unknown>,
      packageValidation: materialized.validation as unknown as Record<string, unknown>,
    });
  } catch (err) {
    await rm(join(packagePath, ".."), { recursive: true, force: true });
    throw err;
  }
}

async function readBinaryBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > limitBytes) throw badRequest(`request body exceeds ${limitBytes} bytes`);
    chunks.push(bytes);
  }
  if (total === 0) throw badRequest("archive request body is empty");
  return Buffer.concat(chunks);
}

function requireStoreEval(queries: DbQueries, id: string): StoreEval {
  const entry = queries.getStoreEval(id);
  if (!entry || entry.archived) throw notFound(`store eval not found: ${id}`);
  return entry;
}

function requireProject(queries: DbQueries, id: string): Project {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

/** Mount the global eval-store routes. */
export function registerEvalStoreRoutes(router: Router): void {
  router.get("/api/eval-store", (_req, res, ctx) => {
    const app = appOf(ctx);
    const includeArchived =
      ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    const categoryName = ctx.query.category_name;
    const list = app.queries
      .listStoreEvals({ includeArchived })
      .filter((e) => !categoryName || e.categoryName === categoryName);
    sendJson(res, 200, { evals: list.map(storeEvalJson) });
  });

  router.get("/api/eval-store/:id", (_req, res, ctx) => {
    const app = appOf(ctx);
    sendJson(res, 200, storeEvalJson(requireStoreEval(app.queries, ctx.params.id!)));
  });

  router.post("/api/eval-store", async (req, res, ctx) => {
    const app = appOf(ctx);
    // Packages carry Dockerfiles built by the rootful Podman backend, so adding
    // one is a privileged operation exactly like the project-scoped route.
    requireAdminRequest(req, app.queries, app.authEnabled);
    const upload = await readJsonBody<EvalPackageUpload>(req, {
      limitBytes: 70 * 1024 * 1024,
    });
    const files = new Map<string, Buffer>();
    for (const [path, value] of Object.entries(upload.files ?? {})) {
      const encoded = typeof value === "string" ? { encoding: "utf8" as const, content: value } : value;
      files.set(path, Buffer.from(encoded.content, encoded.encoding === "base64" ? "base64" : "utf8"));
    }
    try {
      sendJson(res, 201, storeEvalJson(await createStoreEvalFromFiles(app, files)));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  router.post("/api/eval-store:import-archive", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdminRequest(req, app.queries, app.authEnabled);
    const format = ctx.query.format as EvalArchiveFormat | undefined;
    if (!format || !["zip", "tar", "tar.gz"].includes(format)) {
      throw badRequest("format query parameter must be zip|tar|tar.gz");
    }
    const archive = await readBinaryBody(req, 64 * 1024 * 1024);
    const quarantineDir = join(app.dataDir, "eval-store", "imports");
    const archivePath = join(quarantineDir, `${randomUUID()}.${format.replace(".", "-")}`);
    await mkdir(quarantineDir, { recursive: true });
    await writeFile(archivePath, archive);
    try {
      const decodedUpload = await decodeEvalArchiveFile(archivePath, format);
      const decoded = new Map<string, Buffer>();
      for (const [path, value] of Object.entries(decodedUpload.files)) {
        const encoded = typeof value === "string" ? { encoding: "utf8" as const, content: value } : value;
        decoded.set(path, Buffer.from(encoded.content, encoded.encoding === "base64" ? "base64" : "utf8"));
      }
      if (detectEvalLayout(decoded) === "suite") {
        const created: StoreEval[] = [];
        for (const [, taskFiles] of splitSuiteTasks(decoded)) {
          created.push(await createStoreEvalFromFiles(app, taskFiles));
        }
        sendJson(res, 201, { count: created.length, evals: created.map(storeEvalJson) });
      } else {
        sendJson(res, 201, storeEvalJson(await createStoreEvalFromFiles(app, decoded)));
      }
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    } finally {
      await rm(archivePath, { force: true });
    }
  });

  router.delete("/api/eval-store/:id", (_req, res, ctx) => {
    const app = appOf(ctx);
    const entry = requireStoreEval(app.queries, ctx.params.id!);
    sendJson(res, 200, storeEvalJson(app.queries.archiveStoreEval(entry.id)));
  });

  /** Copy a store package into one project. The store keeps its own copy. */
  router.post("/api/eval-store/:id/copy", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdminRequest(req, app.queries, app.authEnabled);
    const entry = requireStoreEval(app.queries, ctx.params.id!);
    const body = await readJsonBody<{ project_id?: string }>(req)
      .catch(() => ({} as { project_id?: string }));
    const projectId = body.project_id ?? ctx.query.project_id;
    if (!projectId) throw badRequest("project_id is required");
    const project = requireProject(app.queries, projectId);
    try {
      const task = await copyStoreEvalToProject(app, entry, project);
      sendJson(res, 201, { eval_id: task.id, project_id: project.id, name: task.name });
    } catch (err) {
      if (err instanceof Error && "status" in err) throw err;
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  });

  /** Publish an existing project eval into the global store. */
  router.post("/api/projects/:id/evals/:evalId/publish", async (req, res, ctx) => {
    const app = appOf(ctx);
    requireAdminRequest(req, app.queries, app.authEnabled);
    const project = requireProject(app.queries, ctx.params.id!);
    const task = app.queries.getTask(ctx.params.evalId!);
    if (!task || task.projectId !== project.id || task.archived) {
      throw notFound(`eval not found: ${ctx.params.evalId!}`);
    }
    if (!task.packagePath) throw badRequest(`eval ${task.id} has no materialized package`);
    const files = await readPackageFiles(task.packagePath).catch(() => {
      throw badRequest(`eval ${task.id} package is missing from disk`);
    });
    try {
      sendJson(res, 201, storeEvalJson(await createStoreEvalFromFiles(app, files)));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
  });
}

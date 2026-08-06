/**
 * Project-scoped rubric CRUD routes.
 *
 * GET    /api/projects/:id/rubrics
 * POST   /api/projects/:id/rubrics
 * GET    /api/projects/:id/rubrics/:rubricId
 * PUT    /api/projects/:id/rubrics/:rubricId
 * PATCH  /api/projects/:id/rubrics/:rubricId
 * DELETE /api/projects/:id/rubrics/:rubricId   (soft archive)
 *
 * A rubric may also be embedded per-task (`tasks.rubric_json`); these are the
 * project's shared, versioned baselines that many tasks can start from. A
 * semantic rubric edit bumps `rubric_version` — a rename does not — matching
 * the task-rubric rule in plan/rubric.md.
 *
 * Auth is a wrapping concern; these handlers do not check tokens.
 */

import type { Rubric } from "../domain.js";
import type {
  CreateProjectRubricInput,
  DbQueries,
  ProjectRubric,
  UpdateProjectRubricInput,
} from "../db/queries.js";
import { coerceRubric } from "../tasks/coerce-spec.js";
import { validateRubricSpec } from "../tasks/ui-builder.js";
import { badRequest, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type RouteHandler,
  type Router,
} from "./router.js";

/** Minimal AppCtx surface these routes need. */
export interface RubricAppCtx {
  queries: DbQueries;
}

function appOf(ctx: RequestContext): RubricAppCtx {
  return ctx.app as RubricAppCtx;
}

function requireProject(queries: DbQueries, id: string) {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

function requireRubric(
  queries: DbQueries,
  projectId: string,
  rubricId: string,
): ProjectRubric {
  const r = queries.getProjectRubric(rubricId);
  if (!r || r.projectId !== projectId) {
    throw notFound(`rubric not found: ${rubricId}`);
  }
  return r;
}

/** Wire shape (snake_case for the versioned fields, like tasks). */
function rubricJson(r: ProjectRubric): Record<string, unknown> {
  return {
    id: r.id,
    project_id: r.projectId,
    name: r.name,
    description: r.description,
    rubric: r.rubric,
    rubric_version: r.rubricVersion,
    is_default: r.isDefault,
    archived: r.archived,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/**
 * Coerce + validate an inbound rubric body, throwing 400 with the collected
 * validation errors rather than persisting a malformed rubric.
 */
function parseRubric(raw: unknown): Rubric {
  if (!raw || typeof raw !== "object") {
    throw badRequest("rubric is required and must be an object");
  }
  const rubric = coerceRubric(raw);
  const result = validateRubricSpec(rubric);
  if (!result.ok) {
    throw badRequest(`invalid rubric: ${result.errors.join("; ")}`);
  }
  return rubric;
}

interface RubricBody {
  name?: string;
  description?: string | null;
  rubric?: unknown;
  isDefault?: boolean;
  is_default?: boolean;
}

/** Register project-rubric CRUD routes on an existing Router. */
export function registerRubricRoutes(router: Router): void {
  // GET /api/projects/:id/rubrics — list (archived excluded unless asked)
  router.get("/api/projects/:id/rubrics", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);
    const includeArchived =
      ctx.query.include_archived === "1" || ctx.query.include_archived === "true";
    const rubrics = app.queries.listProjectRubrics(projectId, {
      includeArchived,
    });
    sendJson(res, 200, { rubrics: rubrics.map(rubricJson) });
  });

  // POST /api/projects/:id/rubrics — create
  router.post("/api/projects/:id/rubrics", async (req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const body = await readJsonBody<RubricBody>(req);
    if (!body.name || !String(body.name).trim()) {
      throw badRequest("name is required");
    }
    const rubric = parseRubric(body.rubric);

    const input: CreateProjectRubricInput = {
      projectId,
      name: String(body.name).trim(),
      rubric,
    };
    if (body.description !== undefined) input.description = body.description;
    const isDefault = body.isDefault ?? body.is_default;
    if (isDefault !== undefined) input.isDefault = isDefault;

    const created = app.queries.createProjectRubric(input);
    sendJson(res, 201, { rubric: rubricJson(created) });
  });

  // GET /api/projects/:id/rubrics/:rubricId — detail
  router.get("/api/projects/:id/rubrics/:rubricId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const rubric = requireRubric(
      app.queries,
      projectId,
      ctx.params.rubricId!,
    );
    sendJson(res, 200, { rubric: rubricJson(rubric) });
  });

  // PUT / PATCH — update. PUT requires a full rubric; PATCH allows partials.
  const update =
    (requireRubricBody: boolean): RouteHandler =>
    async (req, res, ctx) => {
      const app = appOf(ctx);
      const projectId = ctx.params.id!;
      const rubricId = ctx.params.rubricId!;
      requireProject(app.queries, projectId);
      requireRubric(app.queries, projectId, rubricId);

      const body = await readJsonBody<RubricBody>(req);
      const patch: UpdateProjectRubricInput = {};

      if (requireRubricBody && body.rubric === undefined) {
        throw badRequest("rubric is required for PUT (use PATCH for partial edits)");
      }
      if (body.rubric !== undefined) patch.rubric = parseRubric(body.rubric);
      if (body.name !== undefined) {
        if (!String(body.name).trim()) throw badRequest("name must be non-empty");
        patch.name = String(body.name).trim();
      }
      if (body.description !== undefined) patch.description = body.description;
      const isDefault = body.isDefault ?? body.is_default;
      if (isDefault !== undefined) patch.isDefault = isDefault;

      const updated = app.queries.updateProjectRubric(rubricId, patch);
      sendJson(res, 200, { rubric: rubricJson(updated) });
    };

  router.put("/api/projects/:id/rubrics/:rubricId", update(true));
  router.patch("/api/projects/:id/rubrics/:rubricId", update(false));

  // DELETE /api/projects/:id/rubrics/:rubricId — soft archive
  router.delete("/api/projects/:id/rubrics/:rubricId", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    const rubricId = ctx.params.rubricId!;
    requireProject(app.queries, projectId);
    requireRubric(app.queries, projectId, rubricId);
    app.queries.archiveProjectRubric(rubricId);
    res.statusCode = 204;
    res.end();
  });
}

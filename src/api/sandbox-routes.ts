/**
 * Project sandbox control routes — fine-grained container settings over HTTP.
 *
 * GET    /api/projects/:id/sandbox           → resolved policy + raw stored blob
 * PUT    /api/projects/:id/sandbox           → replace the policy
 * PATCH  /api/projects/:id/sandbox           → merge into the policy
 * DELETE /api/projects/:id/sandbox           → clear (back to defaults)
 * GET    /api/sandbox/presets                → named presets (browser, nested…)
 *
 * The response always includes BOTH the raw blob the project stored and the
 * fully-resolved policy the runtime will actually apply. Those differ whenever
 * a value was dropped as malformed or defaulted, and a caller debugging "why
 * didn't my capability take effect" needs to see the difference.
 *
 * Auth is a wrapping concern; these handlers do not check tokens.
 */

import type { DbQueries } from "../db/queries.js";
import {
  resolveSandboxPolicy,
  SANDBOX_PRESETS,
  sandboxPreset,
  type SandboxPolicy,
} from "../runner/sandbox-policy.js";
import { badRequest, notFound } from "./errors.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type RouteHandler,
  type Router,
} from "./router.js";

/** Minimal AppCtx surface these routes need. */
export interface SandboxAppCtx {
  queries: DbQueries;
}

function appOf(ctx: RequestContext): SandboxAppCtx {
  return ctx.app as SandboxAppCtx;
}

function requireProject(queries: DbQueries, id: string) {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

/** Wire shape: snake_case, with the resolved policy alongside the raw blob. */
function sandboxJson(
  projectId: string,
  stored: Record<string, unknown> | null,
  resolved: SandboxPolicy,
): Record<string, unknown> {
  return {
    project_id: projectId,
    // What the project stored, verbatim — null when it never configured one.
    sandbox: stored,
    // What the runtime will apply, after normalization + defaults. Compare the
    // two to see which submitted values were dropped as malformed.
    resolved: {
      profile: resolved.profile,
      privileged: resolved.privileged,
      cap_add: resolved.capAdd,
      cap_drop: resolved.capDrop,
      mounts: resolved.mounts.map((m) => ({
        source: m.source,
        target: m.target,
        read_only: m.readOnly ?? false,
      })),
      tmpfs: resolved.tmpfs.map((t) => ({
        target: t.target,
        size_mib: t.sizeMiB ?? null,
      })),
      devices: resolved.devices,
      ports: resolved.ports.map((p) => ({
        container_port: p.containerPort,
        host_port: p.hostPort ?? 0,
        protocol: p.protocol ?? "tcp",
        name: p.name ?? null,
      })),
      shm_size_mib: resolved.shmSizeMiB ?? null,
      user: resolved.user ?? null,
      workdir: resolved.workdir ?? null,
      hostname: resolved.hostname ?? null,
      extra_hosts: resolved.extraHosts,
      dns: resolved.dns,
      ulimits: resolved.ulimits,
      seccomp: resolved.seccomp ?? null,
      keep_after_exit: resolved.keepAfterExit,
      init: resolved.init,
      auto_remove: resolved.autoRemove,
    },
  };
}

/** Body → a storable blob, applying a named preset when one is given. */
function coerceSandboxBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("sandbox body must be a JSON object");
  }
  const o = { ...(body as Record<string, unknown>) };

  // `preset` is sugar: expand it, then let explicit fields override it. This is
  // how a caller says "a browser sandbox, but with 2 GiB of shm".
  const presetName = o.preset;
  if (presetName !== undefined) {
    if (typeof presetName !== "string" || !(presetName in SANDBOX_PRESETS)) {
      throw badRequest(
        `unknown preset: ${String(presetName)} (known: ${Object.keys(SANDBOX_PRESETS).join(", ")})`,
      );
    }
    delete o.preset;
    const p = sandboxPreset(presetName);
    const expanded: Record<string, unknown> = {
      profile: p.profile,
      privileged: p.privileged,
      capAdd: p.capAdd,
      capDrop: p.capDrop,
      devices: p.devices,
      init: p.init,
    };
    if (p.shmSizeMiB !== undefined) expanded.shmSizeMiB = p.shmSizeMiB;
    return { ...expanded, ...o };
  }
  return o;
}

/** Register project sandbox routes. */
export function registerSandboxRoutes(router: Router): void {
  // Presets are static; listing them lets a UI offer them without hardcoding.
  router.get("/api/sandbox/presets", (_req, res) => {
    sendJson(res, 200, {
      presets: Object.keys(SANDBOX_PRESETS).map((name) => {
        const p = sandboxPreset(name);
        return {
          name,
          profile: p.profile,
          privileged: p.privileged,
          cap_add: p.capAdd,
          devices: p.devices,
          shm_size_mib: p.shmSizeMiB ?? null,
          init: p.init,
        };
      }),
    });
  });

  router.get("/api/projects/:id/sandbox", (_req, res, ctx) => {
    const app = appOf(ctx);
    const project = requireProject(app.queries, ctx.params.id!);
    sendJson(
      res,
      200,
      sandboxJson(
        project.id,
        project.sandbox,
        resolveSandboxPolicy(project.sandbox),
      ),
    );
  });

  // PUT replaces; PATCH merges. Same handler, one flag — the only difference is
  // whether the existing blob is the base.
  const write = (merge: boolean): RouteHandler => async (req, res, ctx) => {
    const app = appOf(ctx);
    const project = requireProject(app.queries, ctx.params.id!);
    const incoming = coerceSandboxBody(await readJsonBody(req));
    const next = merge ? { ...(project.sandbox ?? {}), ...incoming } : incoming;

    // Resolve before storing so a policy that resolves to nothing usable is
    // rejected loudly here rather than silently ignored at run start.
    const resolved = resolveSandboxPolicy(next);
    const updated = app.queries.updateProject(project.id, { sandbox: next });
    sendJson(res, 200, sandboxJson(updated.id, updated.sandbox, resolved));
  };

  router.put("/api/projects/:id/sandbox", write(false));
  router.patch("/api/projects/:id/sandbox", write(true));

  router.delete("/api/projects/:id/sandbox", (_req, res, ctx) => {
    const app = appOf(ctx);
    const project = requireProject(app.queries, ctx.params.id!);
    const updated = app.queries.updateProject(project.id, { sandbox: null });
    sendJson(
      res,
      200,
      sandboxJson(updated.id, null, resolveSandboxPolicy(null)),
    );
  });
}

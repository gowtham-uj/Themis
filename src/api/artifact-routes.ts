/**
 * Run artifact routes — the serving side of `kind:"artifact"` finding refs.
 *
 * GET /api/runs/:id/artifacts          → JSON list (path, size, sha256, type)
 * GET /api/runs/:id/artifacts/*path    → the file itself, inline
 *
 * A browser or data run produces no diff, so its findings locate on artifacts
 * (screenshots, exported outputs) instead of hunks. Without these routes the
 * ref chips would point at evidence nobody can open.
 *
 * The wildcard path is model-authored, so it goes through
 * `resolveArtifactPath`, which refuses traversal and absolute paths.
 * Auth is a wrapping concern; these handlers do not check tokens.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import type { DbQueries } from "../db/queries.js";
import {
  artifactContentType,
  listArtifacts,
  resolveArtifactPath,
} from "../runner/artifacts.js";
import { runDirPath } from "./run-controller-bridge.js";
import { notFound } from "./errors.js";
import { sendJson, type RequestContext, type Router } from "./router.js";

/** Minimal AppCtx surface these routes need. */
export interface ArtifactAppCtx {
  queries: DbQueries;
  dataDir: string;
}

function appOf(ctx: RequestContext): ArtifactAppCtx {
  return ctx.app as ArtifactAppCtx;
}

function requireRun(queries: DbQueries, id: string) {
  const run = queries.getRun(id);
  if (!run) throw notFound(`run not found: ${id}`);
  return run;
}

/**
 * Stream a file with its content type. Images are served inline so the UI can
 * render a screenshot next to the finding that cites it; everything else gets
 * `nosniff` and an attachment disposition rather than being interpreted.
 */
async function serveArtifact(
  res: ServerResponse,
  absPath: string,
  relPath: string,
): Promise<void> {
  let st;
  try {
    st = await stat(absPath);
  } catch {
    throw notFound(`artifact not found: ${relPath}`);
  }
  if (!st.isFile()) throw notFound(`artifact not found: ${relPath}`);

  const type = artifactContentType(relPath);
  // Only images render inline. Anything else — including agent-written HTML —
  // downloads, so a run cannot serve script into the dashboard's origin.
  const inline = type.startsWith("image/") && type !== "image/svg+xml";
  const filename = relPath.slice(relPath.lastIndexOf("/") + 1);

  res.statusCode = 200;
  res.setHeader("Content-Type", inline ? type : "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${filename.replace(/["\\]/g, "_")}"`,
  );

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

/** Register run-artifact list + fetch routes. */
export function registerArtifactRoutes(router: Router): void {
  router.get("/api/runs/:id/artifacts", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);
    const artifacts = await listArtifacts(
      runDirPath(app.dataDir, run.projectId, run.id),
    );
    sendJson(res, 200, {
      run_id: run.id,
      project_id: run.projectId,
      artifacts: artifacts.map((a) => ({
        path: a.path,
        size_bytes: a.sizeBytes,
        sha256: a.sha256,
        content_type: a.contentType,
        is_image: a.isImage,
        modified_at: a.modifiedAt,
        url: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${a.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      })),
    });
  });

  // The router matches one segment per `:param`, so nested artifact paths get
  // depth-specific patterns rather than a wildcard the router cannot express.
  // Four levels is deeper than any real screenshot layout.
  const depths = [
    "/api/runs/:id/artifacts/:p1",
    "/api/runs/:id/artifacts/:p1/:p2",
    "/api/runs/:id/artifacts/:p1/:p2/:p3",
    "/api/runs/:id/artifacts/:p1/:p2/:p3/:p4",
  ];
  for (const pattern of depths) {
    router.get(pattern, async (_req, res, ctx) => {
      const app = appOf(ctx);
      const run = requireRun(app.queries, ctx.params.id!);
      const rel = ["p1", "p2", "p3", "p4"]
        .map((k) => ctx.params[k])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join("/");
      const runDir = runDirPath(app.dataDir, run.projectId, run.id);
      const abs = resolveArtifactPath(runDir, rel);
      if (!abs) throw notFound(`artifact not found: ${rel}`);
      await serveArtifact(res, abs, rel);
    });
  }
}

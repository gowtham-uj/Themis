/**
 * Tiny zero-dependency HTTP router.
 *
 * Maps `"METHOD /path/with/:params"` → handler(req, res, ctx). Supports path
 * params, query-string parsing, and JSON body reading. Dispatches on method +
 * pattern; returns 404 / 405 when no match.
 *
 * Spec: plan/api.md conventions.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { apiError, handleError, methodNotAllowed } from "./errors.js";

/** Parsed URL pieces available to every handler. */
export interface RequestContext {
  /** Path parameters extracted from `:name` segments. */
  params: Record<string, string>;
  /** Parsed query string (first value wins for duplicate keys). */
  query: Record<string, string>;
  /** Raw path without query (e.g. `/api/projects/abc`). */
  path: string;
  /** Uppercase HTTP method. */
  method: string;
  /**
   * Shared application context (queries, dataDir, liveRuns, …).
   * Typed as unknown at the router layer; handlers cast to AppCtx.
   */
  app: unknown;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
) => void | Promise<void>;

interface CompiledRoute {
  method: string;
  /** Original pattern, e.g. `/api/projects/:id`. */
  pattern: string;
  /** Regex that matches the path and captures named groups. */
  regex: RegExp;
  /** Ordered param names corresponding to capture groups. */
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * Compile a path pattern like `/api/runs/:id/events` into a regex + param list.
 * Static segments must match exactly; `:name` captures one path segment.
 */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const parts = pattern.split("/").map((seg) => {
    if (seg.startsWith(":") && seg.length > 1) {
      paramNames.push(seg.slice(1));
      return "([^/]+)";
    }
    // Escape regex metacharacters in static segments.
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const regex = new RegExp(`^${parts.join("/")}$`);
  return { regex, paramNames };
}

/**
 * Parse a raw query string into a flat key→value map (first value wins).
 */
export function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!search) return out;
  const qs = search.startsWith("?") ? search.slice(1) : search;
  if (!qs) return out;
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    let key: string;
    let val: string;
    if (eq === -1) {
      key = pair;
      val = "";
    } else {
      key = pair.slice(0, eq);
      val = pair.slice(eq + 1);
    }
    try {
      key = decodeURIComponent(key.replace(/\+/g, " "));
      val = decodeURIComponent(val.replace(/\+/g, " "));
    } catch {
      // keep raw on decode failure
    }
    if (!(key in out)) out[key] = val;
  }
  return out;
}

/**
 * Read the full request body as a UTF-8 string (with a size cap).
 */
export async function readBody(
  req: IncomingMessage,
  opts: { limitBytes?: number } = {},
): Promise<string> {
  const limit = opts.limitBytes ?? 2 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      throw Object.assign(new Error(`Request body exceeds ${limit} bytes`), {
        statusCode: 413,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read + parse a JSON request body. Empty body → `{}`.
 * Throws an Error with statusCode 400 on invalid JSON.
 */
export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  opts: { limitBytes?: number } = {},
): Promise<T> {
  const raw = await readBody(req, opts);
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const err = new Error("Invalid JSON body");
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
}

/**
 * Write a JSON response and end it.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(payload);
}

/**
 * Zero-dep router: register routes, then `handle(req, res, appCtx)`.
 */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  /**
   * Register a route. `spec` is `"METHOD /path/:param"` (method optional → GET).
   * Examples: `"GET /api/projects"`, `"POST /api/projects/:id/runs"`.
   */
  on(spec: string, handler: RouteHandler): this {
    const trimmed = spec.trim();
    const space = trimmed.indexOf(" ");
    let method: string;
    let pattern: string;
    if (space === -1) {
      method = "GET";
      pattern = trimmed;
    } else {
      method = trimmed.slice(0, space).toUpperCase();
      pattern = trimmed.slice(space + 1).trim();
    }
    if (!pattern.startsWith("/")) {
      throw new Error(`Route pattern must start with /: ${spec}`);
    }
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handler });
    return this;
  }

  /** Convenience verbs. */
  get(pattern: string, handler: RouteHandler): this {
    return this.on(`GET ${pattern}`, handler);
  }
  post(pattern: string, handler: RouteHandler): this {
    return this.on(`POST ${pattern}`, handler);
  }
  patch(pattern: string, handler: RouteHandler): this {
    return this.on(`PATCH ${pattern}`, handler);
  }
  delete(pattern: string, handler: RouteHandler): this {
    return this.on(`DELETE ${pattern}`, handler);
  }
  put(pattern: string, handler: RouteHandler): this {
    return this.on(`PUT ${pattern}`, handler);
  }

  /**
   * Dispatch an incoming request. Sets 404 / 405 when no match.
   * Handler errors are converted to RFC-7807 via {@link handleError}.
   */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    app: unknown = undefined,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = req.url ?? "/";
    const qIdx = url.indexOf("?");
    const path = qIdx === -1 ? url : url.slice(0, qIdx);
    const query = parseQuery(qIdx === -1 ? "" : url.slice(qIdx));

    // Collect methods that match the path (for 405).
    const pathMatches: CompiledRoute[] = [];
    let matched: CompiledRoute | undefined;
    let params: Record<string, string> = {};

    for (const route of this.routes) {
      const m = path.match(route.regex);
      if (!m) continue;
      pathMatches.push(route);
      if (route.method === method) {
        matched = route;
        params = {};
        try {
          for (let i = 0; i < route.paramNames.length; i++) {
            const name = route.paramNames[i]!;
            params[name] = decodeURIComponent(m[i + 1] ?? "");
          }
        } catch {
          // Malformed percent-encoding in a path segment is a client error, not
          // an internal one.
          apiError(res, 400, {
            title: "Bad Request",
            detail: "malformed URL encoding in path",
            type: "https://agenteval.dev/errors/bad-request",
          });
          return;
        }
        break;
      }
    }

    if (!matched) {
      if (pathMatches.length > 0) {
        const allow = [...new Set(pathMatches.map((r) => r.method))].sort();
        res.setHeader("Allow", allow.join(", "));
        apiError(res, 405, {
          title: "Method Not Allowed",
          detail: `${method} is not allowed for ${path}`,
          type: "https://agenteval.dev/errors/method-not-allowed",
          extensions: { allow },
        });
        return;
      }
      apiError(res, 404, {
        title: "Not Found",
        detail: `No route for ${method} ${path}`,
        type: "https://agenteval.dev/errors/not-found",
      });
      return;
    }

    const ctx: RequestContext = {
      params,
      query,
      path,
      method,
      app,
    };

    try {
      await matched.handler(req, res, ctx);
    } catch (err) {
      // Map body-parse errors with statusCode.
      if (
        err &&
        typeof err === "object" &&
        "statusCode" in err &&
        typeof (err as { statusCode: unknown }).statusCode === "number"
      ) {
        const status = (err as { statusCode: number }).statusCode;
        const detail = err instanceof Error ? err.message : "Request error";
        apiError(res, status, {
          title: status === 400 ? "Bad Request" : status === 413 ? "Payload Too Large" : "Error",
          detail,
        });
        return;
      }
      handleError(res, err);
    }
  }
}

/** Factory. */
export function createRouter(): Router {
  return new Router();
}

// Re-export for convenience / tests.
export { methodNotAllowed };

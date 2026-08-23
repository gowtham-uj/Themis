/**
 * RFC-7807-style problem details for the REST API.
 *
 * Spec: plan/api.md — errors are `{ type, title, status, detail }`.
 */

import type { ServerResponse } from "node:http";

/** RFC-7807 problem detail payload. */
export interface ProblemDetails {
  /** URI identifying the problem type (or a short token). */
  type: string;
  /** Short human-readable summary. */
  title: string;
  /** HTTP status code. */
  status: number;
  /** Human-readable explanation specific to this occurrence. */
  detail: string;
  /** Optional extension members. */
  [key: string]: unknown;
}

export interface ApiErrorInput {
  title: string;
  detail: string;
  /** Defaults to `about:blank` when omitted. */
  type?: string;
  /** Extra extension fields merged into the body. */
  extensions?: Record<string, unknown>;
}

/**
 * Write an RFC-7807 JSON error response and end it.
 * Content-Type is `application/problem+json`.
 */
export function apiError(
  res: ServerResponse,
  status: number,
  input: ApiErrorInput,
): void {
  if (res.headersSent) return;
  const body: ProblemDetails = {
    type: input.type ?? "about:blank",
    title: input.title,
    status,
    detail: input.detail,
    ...(input.extensions ?? {}),
  };
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/problem+json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

/** Thrown from handlers to be converted into an RFC-7807 response. */
export class HttpError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string;
  readonly extensions?: Record<string, unknown>;

  constructor(
    status: number,
    title: string,
    detail: string,
    opts: { type?: string; extensions?: Record<string, unknown> } = {},
  ) {
    super(detail);
    this.name = "HttpError";
    this.status = status;
    this.title = title;
    this.type = opts.type ?? "about:blank";
    this.extensions = opts.extensions;
  }
}

/** Convenience constructors. */
export function notFound(detail: string, type = "https://agenteval.dev/errors/not-found"): HttpError {
  return new HttpError(404, "Not Found", detail, { type });
}

export function badRequest(detail: string, type = "https://agenteval.dev/errors/bad-request"): HttpError {
  return new HttpError(400, "Bad Request", detail, { type });
}

export function conflict(detail: string, type = "https://agenteval.dev/errors/conflict"): HttpError {
  return new HttpError(409, "Conflict", detail, { type });
}

export function methodNotAllowed(
  detail: string,
  allow: string[],
): HttpError {
  return new HttpError(405, "Method Not Allowed", detail, {
    type: "https://agenteval.dev/errors/method-not-allowed",
    extensions: { allow },
  });
}

/**
 * Convert an unknown thrown value into an RFC-7807 response.
 * HttpError → its status/title/detail; everything else → 500.
 */
export function handleError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    apiError(res, err.status, {
      title: err.title,
      detail: err.message,
      type: err.type,
      extensions: err.extensions,
    });
    if (err.status === 405 && err.extensions?.allow) {
      // Allow header is required by HTTP for 405.
      res.setHeader("Allow", (err.extensions.allow as string[]).join(", "));
    }
    return;
  }
  // Log the real error server-side; never echo internal details (paths, SQL,
  // stack traces, secrets) to clients on a 500.
  // eslint-disable-next-line no-console
  console.error(
    "[api] unhandled error:",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  apiError(res, 500, {
    title: "Internal Server Error",
    detail: "Internal Server Error",
    type: "https://agenteval.dev/errors/internal",
  });
}

/**
 * Judgement REST routes (P4c).
 *
 * POST /api/runs/:id/judgements  → queue a judgement (202) + kick off judgeRunner
 * GET  /api/judgements/:id       → verdict + metadata
 * GET  /api/judgements/:id/events → SSE / ndjson of judge.jsonl
 * GET  /api/judgements            → list (filter by run/project/status)
 *
 * Spec: plan/api.md §Judgements, plan/data-model.md, plan/judge.md.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, watch as fsWatch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Verdict } from "../judge/verdict.js";
import {
  judgeEventsPath,
  judgementDir,
  type Judgement,
  type JudgementWithVerdict,
  type DbQueries,
} from "../db/queries.js";
import { readFromSeq } from "../schema/jsonl.js";
import {
  readJsonBody,
  sendJson,
  type RequestContext,
  type Router,
} from "./router.js";
import { badRequest, notFound } from "./errors.js";
import {
  purgeRunArtifacts,
  resolveRetentionPolicy,
} from "../runner/artifact-retention.js";

// ---------------------------------------------------------------------------
// Injectable judge runner (tests inject a fake; production may use worker)
// ---------------------------------------------------------------------------

/**
 * Context handed to a judgeRunner after a judgement row is created.
 * Implementations should write judge.jsonl events and call storeVerdict.
 */
export interface JudgeRunContext {
  judgementId: string;
  runId: string;
  projectId: string;
  judgeModel: string;
  judgeProvider: string;
  judgePrompt?: string;
  systemPromptVersion: string;
  dataDir: string;
  queries: DbQueries;
  /** On-disk judge event stream path. */
  eventsPath: string;
  /** Optional body fields from the create request. */
  body: CreateJudgementBody;
}

export type JudgeRunner = (ctx: JudgeRunContext) => void | Promise<void>;

export interface CreateJudgementBody {
  model?: string;
  provider?: string;
  prompt?: string;
  judge_prompt?: string;
  judgePrompt?: string;
  rubric?: unknown;
  system_prompt_version?: string;
  systemPromptVersion?: string;
}

/**
 * Minimal AppCtx surface the judgement routes need. Kept structural so this
 * module doesn't create a circular import with server.ts; createServer passes
 * its AppCtx which satisfies this.
 */
export interface JudgementAppCtx {
  queries: DbQueries;
  dataDir: string;
  /** In-memory Idempotency-Key → response cache (shared with run creates). */
  idempotency: Map<
    string,
    { status: number; body: unknown; headers?: Record<string, string> }
  >;
  /**
   * Optional injectable judge runner. When omitted, routes mark the judgement
   * queued and leave execution to a later phase / external kick.
   */
  judgeRunner?: JudgeRunner;
  /**
   * Default system prompt version when the request does not specify one.
   * P4b owns the real version string; P4c uses a stable placeholder.
   */
  defaultSystemPromptVersion?: string;
  /** Default judge model / provider when the request omits them. */
  defaultJudgeModel?: string;
  defaultJudgeProvider?: string;
  /**
   * Optional outbound webhook dispatcher (P8c). After a successful judge run
   * that leaves the judgement completed, emits verdict.completed once.
   */
  outboundWebhooks?: {
    dispatchEvent(event: {
      type: string;
      projectId: string;
      resourceId: string;
      data: Record<string, unknown>;
      timestamp: string;
    }): void | Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function judgementJson(j: Judgement) {
  return {
    id: j.id,
    run_id: j.runId,
    project_id: j.projectId,
    judge_model: j.judgeModel,
    judge_provider: j.judgeProvider,
    judge_prompt: j.judgePrompt,
    system_prompt_version: j.systemPromptVersion,
    status: j.status,
    overall_score: j.overallScore,
    verdict: j.verdict,
    report_path: j.reportPath,
    events_path: j.eventsPath,
    verdict_path: j.verdictPath,
    created_at: j.createdAt,
    ended_at: j.endedAt,
  };
}

/**
 * GET /judgements/:id payload: metadata + structured verdict body when present.
 */
function judgementDetailJson(j: JudgementWithVerdict) {
  const meta = judgementJson(j);
  const body = j.verdictBody;
  if (!body) {
    return {
      ...meta,
      overall: null,
      criteria: null,
      findings: null,
      positive_findings: null,
      meta_findings: null,
      diagnostics: null,
      improvements: null,
      observations: null,
      attribution: null,
      verdict_body: null,
    };
  }
  return {
    ...meta,
    // Flat convenience fields matching plan/api.md "verdict (overall, criteria, …)"
    overall: body.overall,
    criteria: body.criteria,
    findings: body.findings,
    positive_findings: body.positiveFindings,
    meta_findings: body.metaFindings,
    diagnostics: body.diagnostics,
    improvements: body.improvements,
    observations: body.observations,
    attribution: body.attribution,
    comparison: body.comparison ?? null,
    // Full body also available under a stable key.
    verdict_body: body,
  };
}

function appOf(ctx: RequestContext): JudgementAppCtx {
  return ctx.app as JudgementAppCtx;
}

/**
 * Apply the project's artifact retention policy to a run whose judgement just
 * finished. Best-effort: reclaiming disk must never fail or delay a judgement,
 * and the verdict itself is already durable by this point.
 */
async function purgeJudgedRunArtifacts(
  app: JudgementAppCtx,
  runId: string,
  projectId: string,
): Promise<void> {
  try {
    const project = app.queries.getProject(projectId);
    const policy = resolveRetentionPolicy(project?.artifactRetention);
    if (policy === "keep") return;

    // Pin evidence cited by ANY completed verdict for this run, not just the
    // newest — an older verdict's finding refs stay live in the findings table.
    const verdicts: unknown[] = [];
    for (const j of app.queries.listJudgements({ runId }).judgements) {
      if (j.status !== "completed") continue;
      const full = app.queries.getJudgement(j.id);
      if (full?.verdictBody) verdicts.push(full.verdictBody);
    }

    await purgeRunArtifacts(
      join(app.dataDir, "projects", projectId, "runs", runId),
      { policy, verdict: verdicts },
    );
  } catch {
    // best-effort — disk reclamation is not worth failing a judgement over
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function requireRun(queries: DbQueries, id: string) {
  const r = queries.getRun(id);
  if (!r) throw notFound(`run not found: ${id}`);
  return r;
}

function requireJudgement(
  queries: DbQueries,
  id: string,
): JudgementWithVerdict {
  const j = queries.getJudgement(id);
  if (!j) throw notFound(`judgement not found: ${id}`);
  return j;
}

const DEFAULT_SYSTEM_PROMPT_VERSION = "v2";
const DEFAULT_JUDGE_MODEL = "claude-opus-4-6";
const DEFAULT_JUDGE_PROVIDER = "anthropic";

// ---------------------------------------------------------------------------
// HTML file serving (report.html)
// ---------------------------------------------------------------------------

/**
 * Sanitize an id/name for use in a Content-Disposition filename.
 * Replaces characters outside [A-Za-z0-9._-] with `_`.
 */
export function sanitizeFilenamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Serve a self-contained HTML file with security headers.
 * Mirrors the raw style of GET /api/runs/:id/diff (no sendHtml helper).
 */
export async function serveHtmlFile(
  res: ServerResponse,
  fullPath: string,
  opts: { download?: boolean; filename?: string } = {},
): Promise<void> {
  const text = await readFile(fullPath, "utf8");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  if (opts.download) {
    const filename = opts.filename ?? "report.html";
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  }
  res.end(text);
}

/** Truthy download query flag: `?download=1` or `?download=true`. */
function isDownloadQuery(query: Record<string, string>): boolean {
  return query.download === "1" || query.download === "true";
}

// ---------------------------------------------------------------------------
// SSE / ndjson for judge.jsonl
// ---------------------------------------------------------------------------

async function streamJudgeEvents(
  req: IncomingMessage,
  res: ServerResponse,
  app: JudgementAppCtx,
  judgement: Judgement,
  since: number,
  mode: "sse" | "ndjson",
): Promise<void> {
  const eventsPath =
    judgement.eventsPath && judgement.eventsPath.length > 0
      ? judgement.eventsPath
      : judgeEventsPath(app.dataDir, judgement.projectId, judgement.id);

  if (mode === "sse") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(`: ok\n\n`);
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
  }

  let lastSeq = since;
  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on("close", onClose);
  res.on("close", onClose);

  const writeEvent = (obj: unknown) => {
    if (closed || res.writableEnded) return;
    if (mode === "sse") {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } else {
      res.write(`${JSON.stringify(obj)}\n`);
    }
    if (obj && typeof obj === "object" && "seq" in obj) {
      const s = (obj as { seq: unknown }).seq;
      if (typeof s === "number" && s > lastSeq) lastSeq = s;
    }
  };

  // Replay existing events.
  try {
    for await (const obj of readFromSeq(eventsPath, lastSeq)) {
      if (closed) break;
      writeEvent(obj);
    }
  } catch {
    // missing file is fine
  }

  const isTerminal = (status: string | null | undefined) =>
    status === "completed" || status === "failed";

  // If already terminal, one more drain then end.
  const fresh = app.queries.getJudgement(judgement.id);
  if (fresh && isTerminal(fresh.status)) {
    try {
      for await (const obj of readFromSeq(eventsPath, lastSeq)) {
        if (closed) break;
        writeEvent(obj);
      }
    } catch {
      // ignore
    }
    if (!closed && !res.writableEnded) res.end();
    req.off("close", onClose);
    res.off("close", onClose);
    return;
  }

  // Live-tail poll (portable; works without real judge process when events
  // are pre-seeded or written by an injected runner).
  const pollMs = 50;
  const maxWaitMs = 120_000;
  const started = Date.now();

  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let watcher: ReturnType<typeof fsWatch> | undefined;

    const cleanup = () => {
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        // ignore
      }
      req.off("close", onClose);
      res.off("close", onClose);
    };

    const tick = async () => {
      if (closed || res.writableEnded) {
        cleanup();
        resolve();
        return;
      }
      try {
        for await (const obj of readFromSeq(eventsPath, lastSeq)) {
          if (closed) break;
          writeEvent(obj);
        }
      } catch {
        // ignore transient
      }

      const j = app.queries.getJudgement(judgement.id);
      const terminal = j ? isTerminal(j.status) : false;

      if (terminal || Date.now() - started > maxWaitMs) {
        try {
          for await (const obj of readFromSeq(eventsPath, lastSeq)) {
            if (closed) break;
            writeEvent(obj);
          }
        } catch {
          // ignore
        }
        if (!closed && !res.writableEnded) res.end();
        cleanup();
        resolve();
      }
    };

    timer = setInterval(() => {
      void tick();
    }, pollMs);
    timer.unref?.();

    try {
      if (existsSync(eventsPath)) {
        watcher = fsWatch(eventsPath, () => {
          void tick();
        });
      } else {
        // Watch the parent dir so we catch file creation.
        const dir = join(eventsPath, "..");
        if (existsSync(dir)) {
          watcher = fsWatch(dir, () => {
            void tick();
          });
        }
      }
    } catch {
      // polling only
    }

    void tick();
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register judgement routes on an existing Router. Called from createServer
 * after the core run/project routes are registered.
 */
export function registerJudgementRoutes(router: Router): void {
  // POST /api/runs/:id/judgements — request a judgement
  router.post("/api/runs/:id/judgements", async (req, res, ctx) => {
    const app = appOf(ctx);
    const run = requireRun(app.queries, ctx.params.id!);

    const idemKey = header(req, "idempotency-key");
    if (idemKey && app.idempotency.has(idemKey)) {
      const cached = app.idempotency.get(idemKey)!;
      sendJson(res, cached.status, cached.body, cached.headers);
      return;
    }

    const body = await readJsonBody<CreateJudgementBody>(req);

    const judgeModel =
      body.model ??
      app.defaultJudgeModel ??
      DEFAULT_JUDGE_MODEL;
    const judgeProvider =
      body.provider ??
      app.defaultJudgeProvider ??
      DEFAULT_JUDGE_PROVIDER;
    const judgePrompt =
      body.prompt ?? body.judge_prompt ?? body.judgePrompt ?? undefined;
    const systemPromptVersion =
      body.system_prompt_version ??
      body.systemPromptVersion ??
      app.defaultSystemPromptVersion ??
      DEFAULT_SYSTEM_PROMPT_VERSION;

    const judgement = app.queries.createJudgement({
      runId: run.id,
      projectId: run.projectId,
      judgeModel,
      judgeProvider,
      judgePrompt,
      systemPromptVersion,
      status: "queued",
    });

    const eventsPath =
      judgement.eventsPath ??
      judgeEventsPath(app.dataDir, judgement.projectId, judgement.id);

    const bodyOut = {
      judgementId: judgement.id,
      judgement_id: judgement.id,
      status: judgement.status,
      location: `/api/judgements/${judgement.id}`,
    };
    const headers = {
      Location: `/api/judgements/${judgement.id}`,
    };

    if (idemKey) {
      app.idempotency.set(idemKey, { status: 202, body: bodyOut, headers });
    }

    sendJson(res, 202, bodyOut, headers);

    // Kick off the judge asynchronously (do not await — 202 already sent).
    if (app.judgeRunner) {
      const runnerCtx: JudgeRunContext = {
        judgementId: judgement.id,
        runId: run.id,
        projectId: run.projectId,
        judgeModel,
        judgeProvider,
        judgePrompt,
        systemPromptVersion,
        dataDir: app.dataDir,
        queries: app.queries,
        eventsPath,
        body,
      };
      void Promise.resolve()
        .then(async () => {
          try {
            app.queries.setJudgementStatus(judgement.id, "running");
          } catch {
            // best-effort
          }
          await app.judgeRunner!(runnerCtx);

          // Artifact retention: the verdict is written, so the run's outputs
          // can go. Default policy `keep` changes nothing; `referenced` keeps
          // only what the verdict's artifact refs cite, so located evidence
          // stays clickable. Never fails the judgement.
          await purgeJudgedRunArtifacts(app, run.id, run.projectId);

          // P8c: emit verdict.completed once if the runner completed the judgement.
          // No-ops when outbound webhooks are off or the judgement is not completed.
          if (app.outboundWebhooks) {
            try {
              const done = app.queries.getJudgement(judgement.id);
              if (done && done.status === "completed") {
                void app.outboundWebhooks.dispatchEvent({
                  type: "verdict.completed",
                  projectId: run.projectId,
                  resourceId: judgement.id,
                  data: {
                    runId: run.id,
                    overallScore: done.overallScore ?? null,
                    verdictVersion: done.systemPromptVersion,
                  },
                  timestamp: done.endedAt ?? new Date().toISOString(),
                });
              }
            } catch {
              // never break the judge path for webhook delivery
            }
          }
        })
        .catch((err) => {
          try {
            app.queries.setJudgementStatus(
              judgement.id,
              "failed",
              new Date().toISOString(),
            );
          } catch {
            // best-effort
          }
          if (process.env.AGENTEVAL_JUDGE_DEBUG) {
            console.error("[judgeRunner] failed:", err);
          }
        });
    }
  });

  // GET /api/judgements — list
  router.get("/api/judgements", (_req, res, ctx) => {
    const app = appOf(ctx);
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
    const result = app.queries.listJudgements({
      projectId: ctx.query.projectId ?? ctx.query.project_id,
      runId: ctx.query.runId ?? ctx.query.run_id,
      status: ctx.query.status,
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: ctx.query.cursor,
    });
    sendJson(res, 200, {
      judgements: result.judgements.map(judgementJson),
      next_cursor: result.nextCursor,
    });
  });

  // GET /api/judgements/:id — verdict + metadata
  router.get("/api/judgements/:id", (_req, res, ctx) => {
    const app = appOf(ctx);
    const j = requireJudgement(app.queries, ctx.params.id!);
    sendJson(res, 200, judgementDetailJson(j));
  });

  // GET /api/judgements/:id/events — SSE / ndjson judge log
  router.get("/api/judgements/:id/events", async (req, res, ctx) => {
    const app = appOf(ctx);
    const j = requireJudgement(app.queries, ctx.params.id!);

    let sinceSeq = -1;
    if (ctx.query.since !== undefined && ctx.query.since !== "") {
      const n = Number(ctx.query.since);
      if (Number.isFinite(n)) {
        // Treat since=0 as "from the beginning" (include seq 0).
        sinceSeq = n === 0 ? -1 : n;
      }
    }

    const accept = header(req, "accept") ?? "";
    const finalMode =
      ctx.query.stream === "ndjson"
        ? "ndjson"
        : accept.includes("ndjson")
          ? "ndjson"
          : "sse";

    await streamJudgeEvents(req, res, app, j, sinceSeq, finalMode);
  });

  // GET /api/judgements/:id/report — serve report.html (P5b)
  router.get("/api/judgements/:id/report", async (_req, res, ctx) => {
    const app = appOf(ctx);
    const j = requireJudgement(app.queries, ctx.params.id!);
    const p = join(
      judgementDir(app.dataDir, j.projectId, j.id),
      "report.html",
    );
    if (!existsSync(p)) {
      throw notFound(`report not available for judgement ${j.id}`);
    }
    await serveHtmlFile(res, p, {
      download: isDownloadQuery(ctx.query),
      filename: `report-judgement-${sanitizeFilenamePart(j.id)}.html`,
    });
  });
}

// Re-export Verdict type for consumers that inject runners.
export type { Verdict };

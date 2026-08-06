/**
 * Findings / issues-log REST routes (P6b-api).
 *
 * GET /api/projects/:id/findings              → issues log (list + filters + pagination)
 * GET /api/projects/:id/findings/:fingerprint → lifecycle detail + k/N recurrence
 *
 * Spec: plan/api.md §Judgements + findings, plan/roadmap.md Phase 6.
 */

import type {
  DbQueries,
  FindingDetail,
  FindingRow,
  OccurrenceRow,
} from "../db/queries.js";
import { sendJson, type RequestContext, type Router } from "./router.js";
import { notFound } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal AppCtx surface needed by findings routes (avoids circular import). */
export interface FindingsAppCtx {
  queries: DbQueries;
  dataDir: string;
}

/** Recurrence summary attached to list + detail responses. */
export interface FindingRecurrence {
  firstSeenRunId?: string;
  lastSeenRunId?: string;
  count: number;
}

/** One row in the project issues log. */
export interface IssueListItem extends FindingRow {
  recurrence: FindingRecurrence;
}

/** Occurrence with decoded refs/fix objects for the client. */
export interface DecodedOccurrence
  extends Omit<OccurrenceRow, "refsJson" | "fixJson"> {
  refs: unknown[];
  fix: unknown | null;
  /** Raw JSON strings kept for debugging / round-trip; clients use refs/fix. */
  refsJson: string;
  fixJson: string | null;
}

/** Per-batch recurrence: k occurrences of this finding out of n runs. */
export interface BatchRecurrence {
  batchId: string;
  k: number;
  n: number;
}

/** GET .../findings/:fingerprint payload. */
export interface IssueDetailResponse {
  finding: FindingRow & { occurrences: DecodedOccurrence[] };
  recurrence: FindingRecurrence;
  kByBatch: BatchRecurrence[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appOf(ctx: RequestContext): FindingsAppCtx {
  return ctx.app as FindingsAppCtx;
}

function requireProject(queries: DbQueries, id: string) {
  const p = queries.getProject(id);
  if (!p || p.archived) throw notFound(`project not found: ${id}`);
  return p;
}

/** Clamp list limit to 1..200 (default 50). */
function clampLimit(raw: string | undefined): number {
  if (raw == null || raw === "") return 50;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.floor(n) || 50));
}

/** Parse cursor as a non-negative integer offset (default 0). */
function parseOffset(cursor: string | undefined): number {
  if (cursor == null || cursor === "") return 0;
  const n = Number(cursor);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Resolve a judgement id → runId, caching lookups to avoid N getJudgement calls.
 */
function resolveRunId(
  queries: DbQueries,
  judgementId: string | null | undefined,
  cache: Map<string, string | undefined>,
): string | undefined {
  if (!judgementId) return undefined;
  if (cache.has(judgementId)) return cache.get(judgementId);
  const j = queries.getJudgement(judgementId);
  const runId = j?.runId;
  cache.set(judgementId, runId);
  return runId;
}

/** Decode occurrence refsJson / fixJson into client-friendly objects. */
function decodeOccurrence(occ: OccurrenceRow): DecodedOccurrence {
  let refs: unknown[] = [];
  try {
    const parsed = JSON.parse(occ.refsJson || "[]");
    refs = Array.isArray(parsed) ? parsed : [];
  } catch {
    refs = [];
  }
  let fix: unknown | null = null;
  if (occ.fixJson != null && occ.fixJson !== "") {
    try {
      fix = JSON.parse(occ.fixJson);
    } catch {
      fix = null;
    }
  }
  return {
    ...occ,
    refs,
    fix,
  };
}

/**
 * Compute k/N per batch for a finding's occurrences.
 * k = # of this finding's occurrences whose run is in the batch;
 * n = total runs in that batch.
 */
export function computeKByBatch(
  queries: DbQueries,
  occurrences: OccurrenceRow[],
): BatchRecurrence[] {
  // batchId → set of occurrence ids (or just count of matching occs)
  const batchToOccCount = new Map<string, number>();
  const runCache = new Map<string, string | undefined>();

  for (const occ of occurrences) {
    let batchId = runCache.get(occ.runId);
    if (batchId === undefined && !runCache.has(occ.runId)) {
      const run = queries.getRun(occ.runId);
      batchId = run?.batchId;
      runCache.set(occ.runId, batchId);
    }
    if (!batchId) continue;
    batchToOccCount.set(batchId, (batchToOccCount.get(batchId) ?? 0) + 1);
  }

  const result: BatchRecurrence[] = [];
  for (const [batchId, k] of batchToOccCount) {
    const n = queries.listRuns({ batchId }).length;
    result.push({ batchId, k, n });
  }
  // Stable order by batchId for determinism.
  result.sort((a, b) => a.batchId.localeCompare(b.batchId));
  return result;
}

function issueListItem(
  row: FindingRow,
  runIdCache: Map<string, string | undefined>,
  queries: DbQueries,
): IssueListItem {
  const firstSeenRunId = resolveRunId(
    queries,
    row.firstSeenJudgement,
    runIdCache,
  );
  const lastSeenRunId = resolveRunId(
    queries,
    row.lastSeenJudgement,
    runIdCache,
  );
  return {
    ...row,
    recurrence: {
      firstSeenRunId,
      lastSeenRunId,
      count: row.occurrenceCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register findings (issues-log) routes on an existing Router.
 * Called from createServer next to registerJudgementRoutes.
 */
export function registerFindingsRoutes(router: Router): void {
  // GET /api/projects/:id/findings — issues log
  router.get("/api/projects/:id/findings", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    const status = ctx.query.status || undefined;
    const category = ctx.query.category || undefined;
    const kind = ctx.query.kind || undefined;
    const taskId =
      ctx.query.task || ctx.query.taskId || ctx.query.task_id || undefined;
    const severity = ctx.query.severity || undefined;
    const limit = clampLimit(ctx.query.limit);
    const offset = parseOffset(ctx.query.cursor);

    let rows = app.queries.listFindings({
      projectId,
      taskId,
      status,
      kind,
      category,
    });

    // Severity is not in ListFindingsFilter — filter client-side.
    if (severity) {
      rows = rows.filter((r) => r.latestSeverity === severity);
    }

    // listFindings already sorts newest-lastSeenAt-first; re-sort for safety.
    rows.sort((a, b) => {
      const ta = a.lastSeenAt ?? "";
      const tb = b.lastSeenAt ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return a.fingerprint.localeCompare(b.fingerprint);
    });

    const page = rows.slice(offset, offset + limit);
    const runIdCache = new Map<string, string | undefined>();
    const findings: IssueListItem[] = page.map((row) =>
      issueListItem(row, runIdCache, app.queries),
    );

    const nextCursor =
      offset + findings.length < rows.length
        ? String(offset + findings.length)
        : null;

    sendJson(res, 200, { findings, nextCursor });
  });

  // GET /api/projects/:id/findings/:fingerprint — lifecycle detail
  router.get("/api/projects/:id/findings/:fingerprint", (_req, res, ctx) => {
    const app = appOf(ctx);
    const projectId = ctx.params.id!;
    requireProject(app.queries, projectId);

    // Fingerprint is a sha256 hex (safe in URLs); still decode for completeness.
    const rawFp = ctx.params.fingerprint ?? "";
    let fingerprint: string;
    try {
      fingerprint = decodeURIComponent(rawFp);
    } catch {
      fingerprint = rawFp;
    }

    const detail: FindingDetail | null = app.queries.getFinding(fingerprint);
    if (!detail || detail.projectId !== projectId) {
      throw notFound(`finding not found: ${fingerprint}`);
    }

    const runIdCache = new Map<string, string | undefined>();
    const firstSeenRunId = resolveRunId(
      app.queries,
      detail.firstSeenJudgement,
      runIdCache,
    );
    const lastSeenRunId = resolveRunId(
      app.queries,
      detail.lastSeenJudgement,
      runIdCache,
    );

    const occurrences = detail.occurrences.map(decodeOccurrence);
    const kByBatch = computeKByBatch(app.queries, detail.occurrences);

    // Strip occurrences from the base row then re-attach decoded ones.
    const {
      occurrences: _rawOccs,
      ...row
    } = detail;

    const body: IssueDetailResponse = {
      finding: {
        ...row,
        occurrences,
      },
      recurrence: {
        firstSeenRunId,
        lastSeenRunId,
        count: detail.occurrenceCount,
      },
      kByBatch,
    };

    sendJson(res, 200, body);
  });
}

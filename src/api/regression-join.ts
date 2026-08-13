// @ts-nocheck
/**
 * Pure-ish join helpers for regression routes (P7b-api).
 *
 * These assemble QueryStore rows + verdict bodies into the plain-data inputs
 * that src/regression/compute.ts consumes. Free of HTTP/route concerns so
 * they are unit-testable without a server.
 *
 * Spec: plan/api.md §Trends + comparison, plan/ui.md §6 / §6c.
 */

import { fingerprintOf } from "../db/findings.js";
import type {
  DbQueries,
  Judgement,
  JudgementWithVerdict,
  Run,
} from "../db/queries.js";
import type { RubricAxis } from "../domain.js";
import type { Verdict } from "../types.js";
export type Finding = Record<string, unknown>;
import {
  batchStats,
  type CriterionScore,
  type Diagnostic,
  type FindingInstance,
  type JudgementPoint,
  type Ref,
  type ReleaseSide,
  type RunCompareSide,
  type TaskReleaseResult,
} from "../regression/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One time-ordered trend input point with extra provenance the route uses to
 * enrich the wire envelope (batchId, createdAt). Compatible with scoreTrend.
 */
export interface TrendJoinPoint {
  taskRunOrder: number;
  judgement: JudgementPoint;
  findings: FindingInstance[];
  batchId: string;
  createdAt: string;
  run: Run;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Coerce a denormalized verdict string to the compute union (or null). */
function normalizeVerdict(
  v: string | null | undefined,
): "pass" | "fail" | "partial" | null {
  if (v === "pass" || v === "fail" || v === "partial") return v;
  return null;
}

/** Resolve criterion id → RubricAxis via the task rubric (default "A"). */
function criterionAxisMap(
  queries: DbQueries,
  taskId: string,
): Map<string, RubricAxis> {
  const map = new Map<string, RubricAxis>();
  const task = queries.getTask(taskId);
  const criteria = task?.rubric?.criteria ?? [];
  for (const c of criteria) {
    if (c?.id) map.set(c.id, c.axis as RubricAxis);
  }
  return map;
}

/**
 * Map a verdict defect Finding → FindingInstance (fingerprinted, task-scoped).
 * occurrenceStatus is always "introduced" for per-verdict snapshots — set-diff
 * math keys on fingerprint, not status.
 */
function findingToInstance(
  finding: Finding,
  taskId: string,
  runId: string,
  judgementId: string,
): FindingInstance {
  const { fingerprint } = fingerprintOf(
    {
      category: finding.category,
      claim: finding.claim,
      refs: finding.refs,
    },
    taskId,
  );
  return {
    fingerprint,
    category: finding.category,
    kind: "defect",
    severity: finding.severity,
    claim: finding.claim,
    // Pass decoded refs through verbatim (already plain objects on the verdict).
    refs: (finding.refs ?? []) as Ref[],
    occurrenceStatus: "introduced",
    runId,
    judgementId,
  };
}

/**
 * Page through listJudgements until exhausted (cap 200 per page).
 * Prefer this over N listJudgements({runId}) calls when loading a project.
 */
function listAllJudgements(
  queries: DbQueries,
  filter: { projectId?: string; runId?: string; status?: string },
): Judgement[] {
  const out: Judgement[] = [];
  let cursor: string | undefined;
  // Hard stop to avoid infinite loops if a backend misbehaves.
  for (let page = 0; page < 1000; page += 1) {
    const result = queries.listJudgements({
      ...filter,
      limit: 200,
      cursor,
    });
    out.push(...result.judgements);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

/**
 * Pick the latest COMPLETED judgement for a run (by createdAt, then id).
 * Returns the full JudgementWithVerdict (verdictBody loaded) or null.
 */
export function latestCompletedJudgement(
  queries: DbQueries,
  runId: string,
): JudgementWithVerdict | null {
  // listJudgements sorts newest-first; take the first completed for this run.
  const listed = queries.listJudgements({
    runId,
    status: "completed",
    limit: 200,
  });
  if (listed.judgements.length === 0) return null;
  // Already newest-first; re-pick defensively by createdAt/id.
  const sorted = [...listed.judgements].sort((a, b) => {
    const ca = a.createdAt ?? "";
    const cb = b.createdAt ?? "";
    if (ca !== cb) return cb.localeCompare(ca);
    return b.id.localeCompare(a.id);
  });
  const top = sorted[0]!;
  return queries.getJudgement(top.id);
}

/**
 * Build a map of runId → latest completed Judgement row for a project,
 * restricted to the given run id set. Uses a single paginated project scan.
 */
function latestCompletedByRun(
  queries: DbQueries,
  projectId: string,
  runIds: Set<string>,
): Map<string, Judgement> {
  const byRun = new Map<string, Judgement>();
  if (runIds.size === 0) return byRun;
  const all = listAllJudgements(queries, {
    projectId,
    status: "completed",
  });
  for (const j of all) {
    if (!runIds.has(j.runId)) continue;
    const prev = byRun.get(j.runId);
    if (!prev) {
      byRun.set(j.runId, j);
      continue;
    }
    const pc = prev.createdAt ?? "";
    const jc = j.createdAt ?? "";
    if (jc > pc || (jc === pc && j.id > prev.id)) {
      byRun.set(j.runId, j);
    }
  }
  return byRun;
}

// ---------------------------------------------------------------------------
// Public join helpers
// ---------------------------------------------------------------------------

/**
 * Map a judgement + run into a RunCompareSide for compareTwoRuns / trend /
 * release aggregation.
 *
 * - criteria: axis joined from getTask(run.taskId).rubric (fallback "A")
 * - findings: defect findings only, fingerprinted via fingerprintOf(f, taskId)
 * - occurrenceStatus: always "introduced" (snapshot; set-diff keys on fingerprint)
 * - diagnostics: pass-through of verdictBody.diagnostics
 * - null verdictBody → empty criteria/findings + empty diagnostics
 */
export function buildRunCompareSide(
  judgement: JudgementWithVerdict,
  run: Run,
  queries: DbQueries,
): RunCompareSide {
  const body: Verdict | null = judgement.verdictBody;
  const axisByCriterion = criterionAxisMap(queries, run.taskId);

  const overallScore =
    judgement.overallScore ?? body?.overall?.score ?? null;
  const verdict = normalizeVerdict(
    judgement.verdict ?? body?.overall?.verdict ?? null,
  );

  const judgementPoint: JudgementPoint = {
    judgementId: judgement.id,
    runId: run.id,
    createdAt: judgement.createdAt ?? "",
    overallScore,
    verdict,
  };

  if (!body) {
    return {
      judgement: judgementPoint,
      criteriaScores: [],
      findings: [],
      diagnostics: {},
    };
  }

  const criteriaScores: CriterionScore[] = (body.criteria ?? []).map((c: any) => ({
    criterion: c.criterion,
    axis: (axisByCriterion.get(c.criterion) ?? "A") as RubricAxis,
    weight: c.weight,
    score: c.score,
  }));

  // Defect findings only (not positiveFindings / metaFindings) for set-diff.
  const findings: FindingInstance[] = (body.findings ?? []).map((f: any) =>
    findingToInstance(f, run.taskId, run.id, judgement.id),
  );

  const diagnostics: Record<string, Diagnostic> = {};
  for (const [key, d] of Object.entries(body.diagnostics ?? {})) {
    if (!d || typeof d !== "object") continue;
    diagnostics[key] = {
      value: Boolean(d.value),
      refs: d.refs as Ref[] | undefined,
      note: d.note,
    };
  }

  return {
    judgement: judgementPoint,
    criteriaScores,
    findings,
    diagnostics,
  };
}

/**
 * Build scoreTrend inputs for the given runs: latest COMPLETED judgement per
 * run, ordered oldest-first by judgement.createdAt (then judgement id).
 * Runs without a completed judgement are skipped.
 */
export function buildTrendPoints(
  runs: Run[],
  queries: DbQueries,
): TrendJoinPoint[] {
  if (runs.length === 0) return [];

  const runIds = new Set(runs.map((r) => r.id));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const projectId = runs[0]!.projectId;

  const latestRows = latestCompletedByRun(queries, projectId, runIds);

  const assembled: Array<{
    run: Run;
    j: JudgementWithVerdict;
    createdAt: string;
  }> = [];

  for (const [runId, row] of latestRows) {
    const run = runById.get(runId);
    if (!run) continue;
    const full = queries.getJudgement(row.id);
    if (!full) continue;
    assembled.push({
      run,
      j: full,
      createdAt: full.createdAt ?? "",
    });
  }

  assembled.sort((a, b) => {
    const c = a.createdAt.localeCompare(b.createdAt);
    if (c !== 0) return c;
    return a.j.id.localeCompare(b.j.id);
  });

  return assembled.map((p, i) => {
    const side = buildRunCompareSide(p.j, p.run, queries);
    return {
      taskRunOrder: i,
      judgement: side.judgement,
      findings: side.findings,
      batchId: p.run.batchId,
      createdAt: p.createdAt,
      run: p.run,
    };
  });
}

/**
 * Aggregate runs belonging to one agent version into a ReleaseSide.
 *
 * Grouping: by taskId. Per task:
 *  - meanOverall / spread / n from batchStats over completed-judgement scores
 *  - perAxis: mean criterion score per axis (axis from task rubric)
 *  - findings: union of defect findings, deduped by fingerprint
 *  - diagnostics: OR-aggregated booleans — true if ANY judgement in the task
 *    had diagnostic.value === true (suite rate counts a task as "exhibited"
 *    if any run of that task did)
 *  - passRate: fraction of completed judgements with verdict === "pass"
 *
 * Tasks with zero completed judgements are omitted.
 */
export function buildReleaseSide(
  version: string,
  runs: Run[],
  queries: DbQueries,
): ReleaseSide {
  const byTask = new Map<string, Run[]>();
  for (const r of runs) {
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }

  const taskResults: TaskReleaseResult[] = [];
  for (const [taskId, taskRuns] of byTask) {
    const agg = aggregateTaskRelease(taskId, taskRuns, queries);
    if (agg) taskResults.push(agg);
  }
  taskResults.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { agentVersion: version, taskResults };
}

/**
 * Aggregate completed judgements of one task into a TaskReleaseResult.
 * Returns null when the task has no completed judgements.
 */
function aggregateTaskRelease(
  taskId: string,
  runs: Run[],
  queries: DbQueries,
): TaskReleaseResult | null {
  const sides: RunCompareSide[] = [];
  const overallScores: number[] = [];
  let passCount = 0;

  for (const run of runs) {
    const j = latestCompletedJudgement(queries, run.id);
    if (!j) continue;
    const side = buildRunCompareSide(j, run, queries);
    sides.push(side);
    if (side.judgement.overallScore !== null) {
      overallScores.push(side.judgement.overallScore);
    }
    if (side.judgement.verdict === "pass") passCount += 1;
  }

  if (sides.length === 0) return null;

  const stats = batchStats(overallScores);

  // Per-axis mean: collect criterion scores by axis across judgements.
  const axisScores = new Map<RubricAxis, number[]>();
  for (const side of sides) {
    for (const c of side.criteriaScores) {
      const arr = axisScores.get(c.axis) ?? [];
      arr.push(c.score);
      axisScores.set(c.axis, arr);
    }
  }
  const perAxis = ([...axisScores.keys()] as RubricAxis[])
    .sort()
    .map((axis) => {
      const scores = axisScores.get(axis) ?? [];
      return { axis, mean: batchStats(scores).mean };
    });

  // Findings union (fingerprint-deduped).
  const findingsByFp = new Map<string, FindingInstance>();
  for (const side of sides) {
    for (const f of side.findings) {
      if (!findingsByFp.has(f.fingerprint)) {
        findingsByFp.set(f.fingerprint, f);
      }
    }
  }

  // Diagnostics: OR across judgements of this task.
  // A key is true if ANY judgement had diagnostic.value === true.
  const diagOr = new Map<string, boolean>();
  for (const side of sides) {
    for (const [key, d] of Object.entries(side.diagnostics)) {
      const prev = diagOr.get(key) ?? false;
      diagOr.set(key, prev || d.value === true);
    }
  }
  const diagnostics: Record<string, boolean> = {};
  for (const [k, v] of diagOr) {
    diagnostics[k] = v;
  }

  return {
    taskId,
    meanOverall: stats.mean,
    spread: stats.spread,
    n: sides.length,
    perAxis,
    findings: [...findingsByFp.values()],
    diagnostics,
    passRate: sides.length > 0 ? passCount / sides.length : 0,
  };
}

/**
 * Partition project runs into a release version.
 * A run belongs to the version if agentCommit === version OR triggerRef === version.
 * Runs with neither matching are excluded from the release.
 */
export function runsForVersion(runs: Run[], version: string): Run[] {
  return runs.filter(
    (r) => r.agentCommit === version || r.triggerRef === version,
  );
}

/**
 * Fold deterministic check results into a Verdict and compute pass-rates.
 *
 * Spec: plan/rubric.md §5 + §7 — checks are tracked separately as pass-rates;
 * a passed check grounds the linked criterion score; a failed check surfaces a
 * finding/flag for the judge to reconcile (never auto-fails a criterion alone).
 */

import type { Check, Rubric } from "../domain.js";
import type {
  CheckResult,
  CriterionVerdict,
  Finding,
  PassRates,
  Verdict,
} from "./verdict.js";

/** Minimum score applied when a criterion is grounded by a passed check. */
export const GROUNDED_PASS_SCORE = 0.9;

/**
 * Aggregate check results into per-kind and overall pass rates.
 * Only `pass` counts as passed; `fail`/`error` count against the total.
 * `skipped` is excluded from both passed and total (not attempted).
 */
export function computePassRates(checkResults: CheckResult[]): PassRates {
  const perKind: Record<string, { passed: number; total: number }> = {};
  let passed = 0;
  let total = 0;

  for (const r of checkResults) {
    if (r.status === "skipped") continue;
    const bucket = perKind[r.kind] ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (r.status === "pass") {
      bucket.passed += 1;
      passed += 1;
    }
    total += 1;
    perKind[r.kind] = bucket;
  }

  const rate = total === 0 ? 0 : passed / total;
  return {
    perKind,
    overall: { passed, total, rate },
  };
}

/**
 * Attach checkResults + passRates to a verdict and reconcile criterion scores
 * with deterministic outcomes:
 *  - passed check matching criterion.checkId → ground score to ≥ {@link GROUNDED_PASS_SCORE}
 *  - failed/error check → surface a finding (do NOT auto-lower the score; judge decides)
 *
 * Returns a new Verdict object; does not mutate the input.
 */
export function foldCheckResultsIntoVerdict(
  verdict: Verdict,
  checkResults: CheckResult[],
  rubric?: Rubric | unknown,
): Verdict {
  const passRates = computePassRates(checkResults);
  const byId = new Map(checkResults.map((r) => [r.checkId, r]));

  // Map criterion id → checkId from the rubric when available.
  const criterionCheckIds = extractCriterionCheckIds(rubric);

  const findings = [...verdict.findings];
  const criteria: CriterionVerdict[] = verdict.criteria.map((c) => {
    const checkId = criterionCheckIds.get(c.criterion);
    if (!checkId) return c;
    const result = byId.get(checkId);
    if (!result) return c;

    if (result.status === "pass") {
      // Ground: raise to GROUNDED_PASS_SCORE when the judged score is lower.
      const grounded = Math.max(c.score, GROUNDED_PASS_SCORE);
      if (grounded === c.score) {
        return {
          ...c,
          feedback: ensureGroundNote(c.feedback, checkId, "pass"),
        };
      }
      return {
        ...c,
        score: grounded,
        feedback: ensureGroundNote(
          c.feedback,
          checkId,
          "pass",
          `score grounded to ${grounded.toFixed(2)} by check ${checkId}`,
        ),
        evidence: [
          ...c.evidence,
          `[check:${checkId}] pass${result.detail ? ` — ${result.detail}` : ""}`,
        ],
      };
    }

    if (result.status === "fail" || result.status === "error") {
      // Surface a finding; do not auto-fail / auto-lower the score.
      const findingId = `check_${result.status}:${checkId}`;
      if (!findings.some((f) => f.id === findingId)) {
        const finding: Finding = {
          id: findingId,
          category:
            result.status === "error" ? "check_error" : "check_failed",
          severity: "major",
          confidence: 1,
          criterion: c.criterion,
          claim: `Deterministic check "${checkId}" (${result.kind}) ${result.status}${
            result.detail ? `: ${truncate(result.detail, 200)}` : ""
          }`,
          refs: [
            // Synthetic trace ref so the finding has ≥1 structured ref.
            // The check is harness-owned, not a run event; seqs [0,0] mark it as such.
            { kind: "trace", runId: "checks", seqs: [0, 0] },
          ],
          fix: {
            direction: `Investigate and resolve the failing ${result.kind} check (${checkId})`,
          },
        };
        findings.push(finding);
      }
      const findingIds = c.findingIds.includes(findingId)
        ? c.findingIds
        : [...c.findingIds, findingId];
      return {
        ...c,
        findingIds,
        feedback: ensureGroundNote(
          c.feedback,
          checkId,
          result.status,
          `check ${result.status} — judge should reconcile`,
        ),
        evidence: [
          ...c.evidence,
          `[check:${checkId}] ${result.status}${
            result.detail ? ` — ${truncate(result.detail, 120)}` : ""
          }`,
        ],
      };
    }

    return c;
  });

  // Also surface findings for failed checks that no criterion references.
  for (const r of checkResults) {
    if (r.status !== "fail" && r.status !== "error") continue;
    const findingId = `check_${r.status}:${r.checkId}`;
    if (findings.some((f) => f.id === findingId)) continue;
    // Only add orphan findings if no criterion already covers them above.
    const linked = [...criterionCheckIds.entries()].some(
      ([, cid]) => cid === r.checkId,
    );
    if (linked) continue;
    findings.push({
      id: findingId,
      category: r.status === "error" ? "check_error" : "check_failed",
      severity: "major",
      confidence: 1,
      claim: `Deterministic check "${r.checkId}" (${r.kind}) ${r.status}${
        r.detail ? `: ${truncate(r.detail, 200)}` : ""
      }`,
      refs: [{ kind: "trace", runId: "checks", seqs: [0, 0] }],
      fix: {
        direction: `Investigate and resolve the failing ${r.kind} check (${r.checkId})`,
      },
    });
  }

  return {
    ...verdict,
    criteria,
    findings,
    checkResults: [...checkResults],
    passRates,
  };
}

function extractCriterionCheckIds(
  rubric: Rubric | unknown | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!rubric || typeof rubric !== "object") return out;
  const criteria = (rubric as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria)) return out;
  for (const c of criteria) {
    if (!c || typeof c !== "object") continue;
    const id = (c as { id?: unknown }).id;
    const checkId = (c as { checkId?: unknown }).checkId;
    if (typeof id === "string" && typeof checkId === "string" && checkId) {
      out.set(id, checkId);
    }
  }
  return out;
}

function ensureGroundNote(
  feedback: string,
  checkId: string,
  status: string,
  extra?: string,
): string {
  const tag = `[check:${checkId}:${status}]`;
  if (feedback.includes(tag)) return feedback;
  const suffix = extra ? ` ${extra}` : "";
  return `${feedback} ${tag}${suffix}`.trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Resolve the Check[] list from a task/rubric pair (task.checks wins). */
export function resolveTaskChecks(task: {
  checks?: unknown[] | null;
  rubric?: Rubric | unknown;
}): Check[] {
  const fromTask = coerceChecks(task.checks);
  if (fromTask.length > 0) return fromTask;
  if (task.rubric && typeof task.rubric === "object") {
    return coerceChecks((task.rubric as Rubric).checks);
  }
  return [];
}

function coerceChecks(raw: unknown): Check[] {
  if (!Array.isArray(raw)) return [];
  const out: Check[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.kind !== "string") continue;
    const check: Check = {
      id: o.id,
      kind: o.kind as Check["kind"],
    };
    if (typeof o.command === "string") check.command = o.command;
    if (typeof o.description === "string") check.description = o.description;
    if (o.http && typeof o.http === "object") {
      const h = o.http as Record<string, unknown>;
      if (typeof h.url === "string") {
        check.http = {
          url: h.url,
          ...(typeof h.expectStatus === "number"
            ? { expectStatus: h.expectStatus }
            : {}),
          ...(typeof h.expectBodyContains === "string"
            ? { expectBodyContains: h.expectBodyContains }
            : {}),
        };
      }
    }
    out.push(check);
  }
  return out;
}

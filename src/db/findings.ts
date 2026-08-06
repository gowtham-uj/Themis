/**
 * Findings fingerprinting + ingest state machine (P6a).
 *
 * Pure canonicalization (fingerprintOf / normalizeClaim) is side-effect free so
 * unit tests can exercise it without a DB. ingestFindings drives the
 * introduced / persisted / resolved / regressed dance against a thin store
 * interface implemented by SqliteQueries + MemoryQueries.
 *
 * Spec: plan/data-model.md (findings / finding_occurrences + fingerprint
 * canonicalization), plan/roadmap.md Phase 6. Fingerprint contract is exact —
 * wrong canonicalization = silent recurrence-detection failure.
 */

import { createHash } from "node:crypto";
import type {
  Finding,
  MetaFinding,
  Ref,
  Verdict,
} from "../judge/verdict.js";

// ---------------------------------------------------------------------------
// Row types (shared by the query layer)
// ---------------------------------------------------------------------------

/** "defect" from findings[]; "positive" from positiveFindings[]; "meta" from metaFindings[]. */
export type FindingKind = "defect" | "positive" | "meta";

/** Lifecycle of a de-duplicated findings row (issues log). */
export type FindingLifecycleStatus =
  | "open"
  | "resolved"
  | "regressed"
  | "wontfix";

/** Per-judgement instance status relative to prior history. */
export type OccurrenceStatus = "introduced" | "persisted" | "resolved";

/** De-duplicated finding row (findings table). */
export interface FindingRow {
  fingerprint: string;
  taskId: string;
  projectId: string;
  category: string;
  kind: FindingKind;
  claim: string;
  latestSeverity: string | null;
  latestConfidence: number | null;
  firstSeenJudgement: string | null;
  lastSeenJudgement: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  occurrenceCount: number;
  resolvedAt: string | null;
  status: FindingLifecycleStatus | string;
}

/** One instance emitted by a judgement (finding_occurrences table). */
export interface OccurrenceRow {
  id: string;
  findingFingerprint: string;
  judgementId: string;
  runId: string;
  severity: string;
  confidence: number;
  claim: string;
  criterion: string | null;
  refsJson: string;
  fixJson: string | null;
  status: OccurrenceStatus | string;
  createdAt: string;
}

/** Finding row plus its occurrence history (newest-first optional). */
export interface FindingDetail extends FindingRow {
  occurrences: OccurrenceRow[];
}

/** Platform-filled recurrence annotation (Finding.recurring). */
export interface RecurrenceInfo {
  firstSeenRun: string;
  lastSeenRun: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Pure fingerprinting
// ---------------------------------------------------------------------------

/**
 * Normalize claim text for claim-based fingerprints:
 * trim, lower-case, collapse whitespace runs, strip trailing ".", ";", ":".
 */
export function normalizeClaim(claim: string): string {
  let s = claim.trim().toLowerCase().replace(/\s+/g, " ");
  // Repeatedly strip trailing whitespace then trailing punctuation runs ("x. ;" → "x").
  s = s.replace(/(\s+[.;:]+)+\s*$/g, "");
  s = s.replace(/[.;:\s]+$/g, "");
  return s;
}

/**
 * Normalize a path for stable diff-ref keys: strip leading "./", use "/".
 */
function normalizeFilePath(file: string): string {
  let f = file.replace(/\\/g, "/");
  while (f.startsWith("./")) f = f.slice(2);
  return f;
}

/**
 * Choose the most stable identifying location for a finding, in precedence:
 *  1. FIRST diff ref  → file@hunk  (survives reformatting of surrounding code)
 *  2. FIRST tool ref  → tool:<toolCallId>
 *  3. else (trace-only / no refs / meta) → claim:<normalizeClaim(claim)>
 *
 * Never throws on an unexpected ref shape — falls through to claim-based.
 */
export function canonicalLocationOf(
  finding: { claim: string; refs?: readonly Ref[] | unknown[] },
): string {
  const refs = Array.isArray(finding.refs) ? finding.refs : [];

  for (const raw of refs) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.kind === "diff" && typeof r.file === "string" && typeof r.hunk === "number") {
      return `${normalizeFilePath(r.file)}@${r.hunk}`;
    }
  }
  for (const raw of refs) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.kind === "tool" && typeof r.toolCallId === "string") {
      return `tool:${r.toolCallId}`;
    }
  }
  // Branch 3 — claim-based fallback (trace-only, meta, edge cases).
  return `claim:${normalizeClaim(finding.claim ?? "")}`;
}

/**
 * Compute the durable dedup key for a finding.
 * fingerprint = sha256(taskId? ":" category ":" canonicalLocation) as hex — task-scoped:
 * "same defect recurring across runs of the SAME task" ⇒ same fingerprint, while the
 * same category+location under a DIFFERENT task is a distinct finding (the cross-task PK
 * must not collide — silent drops in the issues log defeat the platform's purpose).
 * Deterministic: same inputs ⇒ same fingerprint.
 */
export function fingerprintOf(
  finding: { category: string; claim: string; refs?: readonly Ref[] | unknown[] },
  taskId?: string,
): { fingerprint: string; canonicalLocation: string } {
  const canonicalLocation = canonicalLocationOf(finding);
  const material =
    taskId !== undefined
      ? `${taskId}:${finding.category}:${canonicalLocation}`
      : `${finding.category}:${canonicalLocation}`;
  const fingerprint = createHash("sha256").update(material, "utf8").digest("hex");
  return { fingerprint, canonicalLocation };
}

// ---------------------------------------------------------------------------
// Ingest store interface (implemented by SqliteQueries / MemoryQueries)
// ---------------------------------------------------------------------------

/**
 * Minimal write/read surface the pure ingest state machine needs.
 * Backends implement this; fingerprint pure helpers stay DB-free.
 */
export interface FindingsIngestStore {
  /** Lookup a findings row for this task + fingerprint (null if absent). */
  findFindingForTask(taskId: string, fingerprint: string): FindingRow | null;
  /** Insert a brand-new findings row. */
  insertFinding(row: FindingRow): void;
  /** Patch an existing findings row (by fingerprint PK). */
  updateFinding(
    fingerprint: string,
    patch: Partial<
      Pick<
        FindingRow,
        | "claim"
        | "latestSeverity"
        | "latestConfidence"
        | "lastSeenJudgement"
        | "lastSeenAt"
        | "occurrenceCount"
        | "resolvedAt"
        | "status"
        | "firstSeenJudgement"
        | "firstSeenAt"
      >
    >,
  ): void;
  /** Insert one occurrence instance. */
  insertOccurrence(row: OccurrenceRow): void;
  /** All findings for a task (for resolved-detection). */
  listFindingsForTask(taskId: string): FindingRow[];
  /** Resolve a judgement id → its run id (for recurring.firstSeenRun). */
  getJudgementRunId(judgementId: string): string | null;
  now(): string;
  newId(): string;
}

export interface IngestContext {
  judgementId: string;
  runId: string;
  projectId: string;
  taskId: string;
  verdict: Verdict;
}

export interface IngestResult {
  /**
   * Recurrence annotations keyed by the verdict finding's `id` (defect /
   * positive / meta). Populated when this occurrence status is "persisted".
   * storeVerdict uses this to rewrite verdict.json with Finding.recurring.
   */
  recurringByFindingId: Record<string, RecurrenceInfo>;
  /** Fingerprints ingested in this judgement (for resolved detection). */
  ingestedFingerprints: string[];
  /** Fingerprints newly marked resolved. */
  resolvedFingerprints: string[];
}

/** Internal shape we iterate over during ingest. */
interface IngestItem {
  /** Verdict-local id (Finding.id / MetaFinding.id). */
  id: string;
  kind: FindingKind;
  category: string;
  claim: string;
  severity: string | null;
  confidence: number | null;
  criterion: string | null;
  refs: Ref[] | unknown[];
  fix: Finding["fix"] | undefined;
}

function collectItems(verdict: Verdict): IngestItem[] {
  const items: IngestItem[] = [];
  for (const f of verdict.findings ?? []) {
    items.push({
      id: f.id,
      kind: "defect",
      category: f.category,
      claim: f.claim,
      severity: f.severity,
      confidence: f.confidence,
      criterion: f.criterion ?? null,
      refs: f.refs ?? [],
      fix: f.fix,
    });
  }
  for (const f of verdict.positiveFindings ?? []) {
    items.push({
      id: f.id,
      kind: "positive",
      category: f.category,
      claim: f.claim,
      severity: f.severity,
      confidence: f.confidence,
      criterion: f.criterion ?? null,
      refs: f.refs ?? [],
      fix: f.fix,
    });
  }
  for (const m of verdict.metaFindings ?? []) {
    items.push({
      id: m.id,
      kind: "meta",
      category: m.category,
      claim: m.claim,
      // MetaFindings have no severity/confidence; store neutral placeholders
      // so occurrence NOT NULL columns stay valid.
      severity: "nit",
      confidence: 1,
      criterion: null,
      // Meta always fingerprints via claim (branch 3) — empty refs.
      refs: [],
      fix: undefined,
    });
  }
  return items;
}

/**
 * Ingest all findings / positiveFindings / metaFindings from a verdict into
 * the findings + finding_occurrences tables, applying the recurrence state
 * machine:
 *  - new fingerprint for the task → insert findings (open), occurrence "introduced"
 *  - existing → bump occurrenceCount, occurrence "persisted"; if was resolved → regressed
 *  - after ingest, open defect/positive findings not in this verdict → "resolved"
 * Meta findings are never auto-resolved.
 *
 * Returns recurrence annotations so the caller can rewrite verdict.json.
 */
export function ingestFindings(
  store: FindingsIngestStore,
  ctx: IngestContext,
): IngestResult {
  const { judgementId, runId, projectId, taskId, verdict } = ctx;
  const now = store.now();
  const recurringByFindingId: Record<string, RecurrenceInfo> = {};
  const ingestedFingerprints: string[] = [];
  const seenThisJudgement = new Set<string>();

  for (const item of collectItems(verdict)) {
    const { fingerprint } = fingerprintOf(
      {
        category: item.category,
        claim: item.claim,
        refs: item.refs as Ref[],
      },
      taskId,
    );
    ingestedFingerprints.push(fingerprint);
    seenThisJudgement.add(fingerprint);

    const existing = store.findFindingForTask(taskId, fingerprint);
    let occurrenceStatus: OccurrenceStatus;
    let occurrenceCount: number;
    let firstSeenJudgement: string;
    let firstSeenRun: string;

    if (!existing) {
      // Brand-new defect for this task.
      occurrenceStatus = "introduced";
      occurrenceCount = 1;
      firstSeenJudgement = judgementId;
      firstSeenRun = runId;
      store.insertFinding({
        fingerprint,
        taskId,
        projectId,
        category: item.category,
        kind: item.kind,
        claim: item.claim,
        latestSeverity: item.severity,
        latestConfidence: item.confidence,
        firstSeenJudgement,
        lastSeenJudgement: judgementId,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
        resolvedAt: null,
        status: "open",
      });
    } else {
      // Recurrence.
      occurrenceStatus = "persisted";
      occurrenceCount = (existing.occurrenceCount ?? 1) + 1;
      firstSeenJudgement = existing.firstSeenJudgement ?? judgementId;
      firstSeenRun =
        store.getJudgementRunId(firstSeenJudgement) ?? runId;

      let nextStatus = existing.status;
      let resolvedAt: string | null = existing.resolvedAt;
      if (existing.status === "resolved") {
        nextStatus = "regressed";
        resolvedAt = null;
      }
      // open stays open; regressed stays regressed; wontfix left alone.

      store.updateFinding(fingerprint, {
        claim: item.claim,
        latestSeverity: item.severity,
        latestConfidence: item.confidence,
        lastSeenJudgement: judgementId,
        lastSeenAt: now,
        occurrenceCount,
        status: nextStatus,
        resolvedAt,
      });

      recurringByFindingId[item.id] = {
        firstSeenRun,
        lastSeenRun: runId,
        count: occurrenceCount,
      };
    }

    store.insertOccurrence({
      id: store.newId(),
      findingFingerprint: fingerprint,
      judgementId,
      runId,
      severity: item.severity ?? "nit",
      confidence: item.confidence ?? 1,
      claim: item.claim,
      criterion: item.criterion,
      refsJson: JSON.stringify(item.refs ?? []),
      fixJson: item.fix != null ? JSON.stringify(item.fix) : null,
      status: occurrenceStatus,
      createdAt: now,
    });
  }

  // RESOLVED detection — defect + positive only; meta persists until rubric changes.
  const resolvedFingerprints: string[] = [];
  const prior = store.listFindingsForTask(taskId);
  for (const row of prior) {
    if (row.kind === "meta") continue;
    if (seenThisJudgement.has(row.fingerprint)) continue;
    // Only auto-resolve currently-open findings not present in this verdict.
    if (row.status !== "open") continue;
    // lastSeenJudgement should be a prior judgement (not J); if somehow it is J
    // already, skip (shouldn't happen since we just set lastSeen on ingested).
    if (row.lastSeenJudgement === judgementId) continue;
    store.updateFinding(row.fingerprint, {
      status: "resolved",
      resolvedAt: now,
    });
    resolvedFingerprints.push(row.fingerprint);
  }

  return { recurringByFindingId, ingestedFingerprints, resolvedFingerprints };
}

/**
 * Apply recurrence annotations onto a verdict copy (mutates findings /
 * positiveFindings / metaFindings in place on the returned object). Used by
 * storeVerdict to rewrite verdict.json after ingest so the report/API see
 * Finding.recurring. Single-threaded SQLite + same event loop — no race.
 */
export function applyRecurrenceToVerdict(
  verdict: Verdict,
  recurringByFindingId: Record<string, RecurrenceInfo>,
): Verdict {
  const keys = Object.keys(recurringByFindingId);
  if (keys.length === 0) return verdict;

  const patchList = <T extends Finding | MetaFinding>(list: T[]): T[] =>
    list.map((f) => {
      const rec = recurringByFindingId[f.id];
      if (!rec) return f;
      // MetaFinding has no recurring field in the type — only Finding does.
      // We still annotate defect + positive; meta rarely recurses by fingerprint
      // of claim, and the platform field is on Finding. Skip non-Finding.
      if (!("refs" in f)) return f;
      return { ...f, recurring: rec };
    });

  return {
    ...verdict,
    findings: patchList(verdict.findings ?? []),
    positiveFindings: patchList(verdict.positiveFindings ?? []),
    // metaFindings intentionally unchanged (no recurring field on MetaFinding)
    metaFindings: verdict.metaFindings ?? [],
  };
}

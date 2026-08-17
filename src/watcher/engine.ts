/**
 * Per-project agent-commit queue watcher engine.
 *
 * A watcher belongs to a project and exactly one eval queue; the watcher's repo
 * must equal that queue's source adapter's source repo. On an inbound commit it
 * resolves the ref to a full SHA, deduplicates (watcher + SHA), and records a
 * durable pending FIFO watcher_event. If the queue has no active generation, the
 * event's commit is launched as an immutable generation override immediately;
 * otherwise it stays pending. When a generation closes, the oldest pending event
 * for that queue is auto-launched next and FIFO continues across generations with
 * no intermediate commit dropped.
 *
 * No HTTP, no disk I/O except via injected QueryStore; SHA resolution goes
 * through the injected Resolver seam (real git ls-remote / host API).
 */

import type {
  QueryStore,
  WatcherRule,
  WatcherEvent,
} from "../db/queries.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Resolve a repo ref/commit to a concrete full SHA.
 * Real impl uses git ls-remote / host API; tests inject a canned double.
 */
export interface RefResolver {
  resolveRef(
    repo: string,
    ref: string,
  ): Promise<{ sha: string; imageTag?: string }>;
}

/**
 * Resolve a repo ref (tag/branch/sha) to a commit sha (+ optional image tag).
 * Real impl uses git ls-remote / host API; tests inject a canned double.
 * Retained for backward compatibility with server/tests; production watcher
 * handling uses {@link WatcherSeams}.
 */
export interface RefResolver {
  resolveRef(
    repo: string,
    ref: string,
  ): Promise<{ sha: string; imageTag?: string }>;
}

/**
 * The set of seams a watcher event handler needs. Both resolution and launching
 * are injectable so pure unit tests never touch git or the container backend.
 */
export interface WatcherSeams {
  resolveSha(
    repo: string,
    ref: string,
  ): Promise<{ sha: string }>;
  hasActiveGeneration(queueId: string): boolean;
  launch(queueId: string, commit: string): Promise<{ launched: boolean; batchId?: string }>;
}

// ---------------------------------------------------------------------------
// Repo + ref normalization (kept from the original engine)
// ---------------------------------------------------------------------------

/**
 * Normalize a repo identifier to lowercase "owner/name" when possible.
 * Tolerates full urls, trailing .git, and bare owner/name.
 */
export function normalizeRepo(repo: string): string {
  let s = repo.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^git@[^:]+:/, "");
  s = s.replace(/^[^/]+\/(?=[^/]+\/[^/]+)/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const owner = parts[parts.length - 2]!;
    let name = parts[parts.length - 1]!;
    name = name.replace(/\.git$/, "");
    return `${owner}/${name}`;
  }
  return s.replace(/\.git$/, "");
}

/** True when ruleRepo and eventRepo refer to the same repository. */
export function repoMatches(ruleRepo: string, eventRepo: string): boolean {
  return normalizeRepo(ruleRepo) === normalizeRepo(eventRepo);
}

/** Direct repo-identity equality check (used by the signed hook repo validation). */
export function isSameRepo(a: string, b: string): boolean {
  return repoMatches(a, b);
}

/**
 * Tiny glob matcher supporting `*` (any run) and `?` (single char).
 * Anchored full-string match. Null/empty pattern matches any.
 */
export function globMatch(pattern: string | null | undefined, value: string | null | undefined): boolean {
  if (pattern == null || pattern === "") return true;
  if (value == null) return false;
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`).test(value);
}

// ---------------------------------------------------------------------------
// Commit handler
// ---------------------------------------------------------------------------

/**
 * Handle an inbound commit for a queue watcher.
 *
 * 1. The rule must own exactly the target queue and the commit repo must equal
 *    the queue adapter's source repo (validated by the caller via `validateRepo`).
 * 2. Resolve the ref/commit to a full SHA.
 * 3. Dedupe: if this watcher+SHA is already a queued/launched/pending/launching
 *    event, record a `deduped` event and stop.
 * 4. Otherwise enqueue a durable pending event with a per-queue FIFO seq.
 * 5. If the queue has no active generation, launch it with the commit as an
 *    immutable generation override (does NOT mutate queue.agentCommit).
 *
 * Returns the resulting event status per rule (single-rule path by design).
 */
export async function handleWatcherCommit(input: {
  queries: QueryStore;
  seams: WatcherSeams;
  rule: WatcherRule;
  queueId: string;
  ref?: string;
  /** Repo the commit arrived from (must equal the queue's source repo). */
  eventRepo?: string;
}): Promise<{ status: string; event: WatcherEvent }> {
  const { queries, seams, rule, queueId, ref, eventRepo } = input;

  const queue = queries.getEvalQueue(queueId);
  if (!queue || queue.projectId !== rule.projectId) {
    throw new Error("watcher rule queue is missing or not project-scoped");
  }
  if (eventRepo && !repoMatches(rule.repo, eventRepo)) {
    throw new Error(
      `webhook repo ${eventRepo} does not match watcher repo ${rule.repo}`,
    );
  }

  const targetRef = ref ?? rule.ref ?? "HEAD";
  const resolved = await seams.resolveSha(rule.repo, targetRef);
  const sha = resolved.sha;

  // Dedup: this watcher has already queued/launched/pending this exact SHA.
  const already = queries.listWatcherEvents(rule.projectId, { ruleId: rule.id })
    .some(
      (e) =>
        e.resolvedSha === sha &&
        ["pending", "launching", "launched"].includes(e.status),
    );
  if (already) {
    const ev = queries.recordWatcherEvent({
      ruleId: rule.id,
      projectId: rule.projectId,
      queueId,
      trigger: rule.trigger,
      ref: targetRef,
      resolvedSha: sha,
      status: "deduped",
    });
    return { status: "deduped", event: ev };
  }

  // Durable pending FIFO event.
  const fifoSeq = queries.nextWatcherFifoSeq(queueId);
  const pending = queries.recordWatcherEvent({
    ruleId: rule.id,
    projectId: rule.projectId,
    queueId,
    trigger: rule.trigger,
    ref: targetRef,
    resolvedSha: sha,
    status: "pending",
    fifoSeq,
  });

  // Launch immediately when no generation is active. If an active generation
  // exists, the pending event is auto-launched when it closes (FIFO).
  if (!seams.hasActiveGeneration(queueId)) {
    queries.markWatcherEventLaunching(pending.id);
    const result = await seams.launch(queueId, sha);
    if (result.launched && result.batchId) {
      const launched = queries.markWatcherEventLaunched(pending.id, result.batchId, sha);
      return { status: "launched", event: launched };
    }
    // Launch did not start (e.g. no enabled evals): revert to durable pending so
    // the event is not dropped from the FIFO and can auto-launch later.
    const reverted = queries.markWatcherEventPending(pending.id);
    return { status: "pending", event: reverted };
  }

  return { status: "pending", event: pending };
}

/**
 * Pick the next pending event for a queue. Returns null when none.
 * Used by the generation-closure hook to continue the FIFO automatically.
 */
export function nextPendingForQueue(
  queries: QueryStore,
  queueId: string,
): WatcherEvent | null {
  return queries.nextPendingWatcherEvent(queueId);
}

// ---------------------------------------------------------------------------
// Ref/semver matching helpers (kept as pure functions; no run creation)
// ---------------------------------------------------------------------------

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Coerce a ref/tag to a semver (strips leading "v"). Returns null if not semver. */
export function parseSemver(refOrTag: string): Semver | null {
  let s = refOrTag.trim();
  if (s.startsWith("v") || s.startsWith("V")) s = s.slice(1);
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) {
    const m2 = /^(\d+)\.(\d+)$/.exec(s);
    if (!m2) return null;
    return { major: Number(m2[1]), minor: Number(m2[2]), patch: 0 };
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

interface SemverClause {
  op: ">=" | ">" | "<=" | "<" | "=" | "~";
  ver: Semver;
}

function parseClause(raw: string): SemverClause | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(>=|>|<=|<|=|~)\s*(.+)$/.exec(s);
  if (m) {
    const op = m[1] as SemverClause["op"];
    const ver = parseSemver(m[2]!.trim());
    if (!ver) return null;
    return { op, ver };
  }
  const ver = parseSemver(s);
  if (!ver) return null;
  return { op: "=", ver };
}

function satisfiesClause(v: Semver, c: SemverClause): boolean {
  const d = cmpSemver(v, c.ver);
  switch (c.op) {
    case ">=":
      return d >= 0;
    case ">":
      return d > 0;
    case "<=":
      return d <= 0;
    case "<":
      return d < 0;
    case "=":
      return d === 0;
    case "~":
      if (v.major !== c.ver.major) return false;
      if (v.minor !== c.ver.minor) return false;
      return v.patch >= c.ver.patch;
    default:
      return false;
  }
}

/**
 * Apply a whitespace-separated semver filter ("\>=2.0.0 <3.0.0", "=2.3.0", "~2.1").
 * No filter → true. Non-semver ref + filter present → false. ALL clauses satisfied.
 */
export function applySemverFilter(
  refOrTag: string,
  semverFilter?: string | null,
): boolean {
  if (semverFilter == null || semverFilter.trim() === "") return true;
  const ver = parseSemver(refOrTag);
  if (!ver) return false;
  const clauses = semverFilter
    .trim()
    .split(/\s+/)
    .map(parseClause)
    .filter((c): c is SemverClause => c != null);
  if (clauses.length === 0) return true;
  return clauses.every((c) => satisfiesClause(ver, c));
}

/**
 * Uniqueness key for "already enqueued this ref for this rule".
 * Format: ruleId:ref:sha. Retained for API compatibility.
 */
export function computeDedupKey(
  ruleId: string,
  ref: string | null,
  sha: string | null,
): string {
  return `${ruleId}:${ref ?? ""}:${sha ?? ""}`;
}

interface MatchableRule {
  id: string;
  projectId: string;
  queueId: string | null;
  role: string;
  repo: string;
  trigger: string;
  ref: string | null;
  semverFilter: string | null;
  webhookSecret: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** rule.ref is a glob (e.g. "v*") or exact branch; null = match any. */
export function refMatches(
  ruleRef: string | null | undefined,
  eventRef: string | null | undefined,
): boolean {
  return globMatch(ruleRef, eventRef);
}

/**
 * Match enabled rules against an inbound event: enabled + repo (normalized).
 * Trigger/ref/semver gating is handled by the caller. Deterministic by createdAt.
 */
export function matchRules(
  rules: Array<Partial<MatchableRule>>,
  event: {
    trigger: string;
    ref?: string;
    repo: string;
  },
): Array<Partial<MatchableRule>> {
  const matched = rules.filter(
    (r) =>
      r.enabled &&
      r.repo !== undefined &&
      repoMatches(r.repo, event.repo) &&
      r.trigger === event.trigger &&
      refMatches(r.ref, event.ref),
  );
  return matched.sort((a, b) =>
    (a.createdAt ?? "") < (b.createdAt ?? "")
      ? -1
      : (a.createdAt ?? "") > (b.createdAt ?? "")
        ? 1
        : 0,
  );
}

/**
 * For each matched rule, decide matched vs ignored(semver). Pure; no run creation.
 */
export function shouldEnqueue(
  rules: Array<Partial<MatchableRule> & { id: string }>,
  event: { ref?: string },
  semverFn: (
    refOrTag: string,
    semverFilter?: string | null,
  ) => boolean = applySemverFilter,
): Array<{ rule: { id: string }; status: "matched" | "ignored" }> {
  return rules.map((rule) => {
    if (rule.semverFilter) {
      const ref = event.ref ?? "";
      if (!semverFn(ref, rule.semverFilter)) {
        return { rule: { id: rule.id }, status: "ignored" as const };
      }
    }
    return { rule: { id: rule.id }, status: "matched" as const };
  });
}

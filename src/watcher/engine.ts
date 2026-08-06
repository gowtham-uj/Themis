/**
 * Watcher engine (P8a) — pure-ish match / semver / dedup / handle flow.
 *
 * No HTTP, no disk I/O except via injected QueryStore. No real git network:
 * ref resolution goes through the RefResolver seam (test double in tests;
 * real git ls-remote / host API lands in P8b/c).
 *
 * Spec: plan/watcher.md (rules, triggers, dedup, semver, provenance).
 */

import type {
  QueryStore,
  WatcherAction,
  WatcherEventStatus,
  WatcherRole,
  WatcherRule,
} from "../db/queries.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * Resolve a repo ref (tag/branch/sha) to a commit sha (+ optional image tag).
 * Real impl uses git ls-remote / host API; tests inject a canned double.
 */
export interface RefResolver {
  resolveRef(
    repo: string,
    ref: string,
  ): Promise<{ sha: string; imageTag?: string }>;
}

/** Inbound event shape for matching + handling. */
export interface WatcherInboundEvent {
  projectId: string;
  trigger: string;
  ref?: string;
  role: WatcherRole;
  repo: string;
  /** Optional agentId override when enqueueing; else project.defaultAgentId. */
  agentId?: string;
  model?: string;
  provider?: string;
}

export interface HandleWatcherEventResult {
  results: Array<{
    ruleId: string;
    status: WatcherEventStatus | string;
    batchIds?: string[];
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Repo + ref matching
// ---------------------------------------------------------------------------

/**
 * Normalize a repo identifier to lowercase "owner/name" when possible.
 * Tolerates full urls, trailing .git, and bare owner/name.
 */
export function normalizeRepo(repo: string): string {
  let s = repo.trim().toLowerCase();
  // strip protocol + host
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^git@[^:]+:/, "");
  // drop host path prefix (github.com/, gitlab.com/, ...)
  s = s.replace(/^[^/]+\/(?=[^/]+\/[^/]+)/, "");
  // after host strip, may still have github.com/owner/name
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2) {
    // Prefer last two segments when path is host/owner/name
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

/**
 * Tiny glob matcher supporting `*` (any run) and `?` (single char).
 * Anchored full-string match. Null/empty pattern matches any.
 */
export function globMatch(pattern: string | null | undefined, value: string | null | undefined): boolean {
  if (pattern == null || pattern === "") return true;
  if (value == null) return false;
  // Escape regex specials except * and ?
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`).test(value);
}

/** rule.ref is a glob (e.g. "v*") or exact branch; null = match any. */
export function refMatches(
  ruleRef: string | null | undefined,
  eventRef: string | null | undefined,
): boolean {
  return globMatch(ruleRef, eventRef);
}

/**
 * Match enabled rules against an inbound event.
 * Filters: enabled, role, repo (normalized), trigger, ref glob.
 * Deterministic: stable sort by createdAt ascending.
 */
export function matchRules(
  rules: WatcherRule[],
  event: {
    trigger: string;
    ref?: string;
    role: WatcherRole;
    repo: string;
  },
): WatcherRule[] {
  const matched = rules.filter(
    (r) =>
      r.enabled &&
      r.role === event.role &&
      repoMatches(r.repo, event.repo) &&
      r.trigger === event.trigger &&
      refMatches(r.ref, event.ref),
  );
  return matched.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Semver filter
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
  // take core major.minor.patch (ignore pre-release / build for clause matching)
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) {
    // also accept major.minor
    const m2 = /^(\d+)\.(\d+)$/.exec(s);
    if (!m2) return null;
    return {
      major: Number(m2[1]),
      minor: Number(m2[2]),
      patch: 0,
    };
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
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
  // bare version => exact =
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
      // ~2.1 => >=2.1.0 <2.2.0 (compatible within minor)
      // ~2.1.3 => >=2.1.3 <2.2.0
      if (v.major !== c.ver.major) return false;
      if (v.minor !== c.ver.minor) return false;
      return v.patch >= c.ver.patch;
    default:
      return false;
  }
}

/**
 * Apply a whitespace-separated semver filter ("\>=2.0.0 <3.0.0", "=2.3.0", "~2.1").
 * No filter → true. Non-semver ref + filter present → false.
 * ALL clauses must be satisfied.
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

// ---------------------------------------------------------------------------
// Dedup + shouldEnqueue
// ---------------------------------------------------------------------------

/**
 * Uniqueness key for "already enqueued this ref for this rule".
 * Format: ruleId:ref:sha
 */
export function computeDedupKey(
  ruleId: string,
  ref: string | null,
  sha: string | null,
): string {
  return `${ruleId}:${ref ?? ""}:${sha ?? ""}`;
}

/**
 * For each matched rule, decide matched vs ignored(semver).
 * Dedup is a DB check at enqueue time (handleWatcherEvent), not here.
 */
export function shouldEnqueue(
  rules: WatcherRule[],
  event: { ref?: string },
  semverFn: (
    refOrTag: string,
    semverFilter?: string | null,
  ) => boolean = applySemverFilter,
): Array<{ rule: WatcherRule; status: "matched" | "ignored" }> {
  return rules.map((rule) => {
    if (rule.semverFilter) {
      const ref = event.ref ?? "";
      if (!semverFn(ref, rule.semverFilter)) {
        return { rule, status: "ignored" as const };
      }
    }
    return { rule, status: "matched" as const };
  });
}

// ---------------------------------------------------------------------------
// handleWatcherEvent — higher-level enqueue flow
// ---------------------------------------------------------------------------

function mergeAdapterOverrides(
  action: WatcherAction,
  imageTag?: string,
): Record<string, unknown> | undefined {
  const base = action.adapterOverrides ? { ...action.adapterOverrides } : {};
  if (imageTag) {
    base.imageTag = imageTag;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * Match rules → semver gate → resolve ref → dedup → createBatch/createRun
 * per action task set → record watcher_events.
 *
 * Errors are caught per-rule (one failing rule does not abort others).
 * Does NOT call startRun — creates batches/runs in "queued" state only.
 */
export async function handleWatcherEvent(
  queries: QueryStore,
  resolver: RefResolver,
  event: WatcherInboundEvent,
): Promise<HandleWatcherEventResult> {
  const rules = queries.listWatcherRules(event.projectId, {
    includeDisabled: false,
  });
  const matched = matchRules(rules, {
    trigger: event.trigger,
    ref: event.ref,
    role: event.role,
    repo: event.repo,
  });
  const decisions = shouldEnqueue(matched, { ref: event.ref });
  const results: HandleWatcherEventResult["results"] = [];

  const project = queries.getProject(event.projectId);
  const defaultAgentId =
    event.agentId ?? project?.defaultAgentId ?? null;

  for (const { rule, status } of decisions) {
    if (status === "ignored") {
      queries.recordWatcherEvent({
        ruleId: rule.id,
        projectId: event.projectId,
        trigger: event.trigger,
        ref: event.ref ?? null,
        status: "ignored",
      });
      results.push({ ruleId: rule.id, status: "ignored" });
      continue;
    }

    try {
      const ref = event.ref ?? rule.ref ?? "HEAD";
      const resolved = await resolver.resolveRef(rule.repo, ref);
      const sha = resolved.sha;
      const imageTag = resolved.imageTag ?? (event.ref || undefined);

      // Dedup: already enqueued this rule+ref+sha?
      const prior = queries.listWatcherEvents(event.projectId, {
        ruleId: rule.id,
      });
      const already = prior.some(
        (e) =>
          e.status === "enqueued" &&
          (e.ref ?? null) === (event.ref ?? null) &&
          (e.resolvedSha ?? null) === sha,
      );
      if (already) {
        queries.recordWatcherEvent({
          ruleId: rule.id,
          projectId: event.projectId,
          trigger: event.trigger,
          ref: event.ref ?? null,
          resolvedSha: sha,
          status: "deduped",
        });
        results.push({ ruleId: rule.id, status: "deduped" });
        continue;
      }

      // Resolve agent + model + provider defaults.
      const agentId = defaultAgentId;
      if (!agentId) {
        throw new Error(
          `no agentId for watcher rule ${rule.id} (set project.defaultAgentId or pass agentId)`,
        );
      }
      const agent = queries.getAgent(agentId);
      const model =
        event.model ??
        project?.defaultModel ??
        agent?.defaultModel ??
        "unknown";
      const provider =
        event.provider ??
        project?.defaultProvider ??
        agent?.defaultProvider ??
        "unknown";
      const repeats = rule.action.repeats ?? 1;
      // Image pin goes on batch/run agentImage (createBatch has no adapterOverrides column).
      // mergeAdapterOverrides is available for queue-path callers / P8b.
      const agentImage = imageTag ?? undefined;

      // Resolve task set from action.
      let tasks = queries.listTasks(event.projectId);
      if (rule.action.enqueue === "subset") {
        const tags = rule.action.taskTags ?? [];
        if (tags.length > 0) {
          const want = new Set(tags);
          tasks = tasks.filter((t) =>
            (t.tags ?? []).some((tag) => want.has(tag)),
          );
        }
      }
      if (tasks.length === 0) {
        throw new Error(
          `watcher rule ${rule.id}: no tasks to enqueue (enqueue=${rule.action.enqueue})`,
        );
      }

      const batchIds: string[] = [];
      for (const task of tasks) {
        const batch = queries.createBatch({
          taskId: task.id,
          projectId: event.projectId,
          agentId,
          model,
          provider,
          params: {},
          repeats,
          trigger: event.trigger,
          triggerRef: event.ref,
          agentImage,
          agentCommit: sha,
        });
        batchIds.push(batch.id);
        for (let i = 0; i < repeats; i++) {
          queries.createRun({
            batchId: batch.id,
            taskId: task.id,
            projectId: event.projectId,
            agentId,
            model,
            provider,
            repeatIndex: i,
            status: "queued",
            trigger: event.trigger,
            triggerRef: event.ref,
            triggerRuleId: rule.id,
            agentImage,
            agentCommit: sha,
          });
        }
      }

      // Record one enqueued event; first batch id for the FK column.
      queries.recordWatcherEvent({
        ruleId: rule.id,
        projectId: event.projectId,
        trigger: event.trigger,
        ref: event.ref ?? null,
        resolvedSha: sha,
        status: "enqueued",
        batchId: batchIds[0] ?? null,
      });
      results.push({
        ruleId: rule.id,
        status: "enqueued",
        batchIds,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      queries.recordWatcherEvent({
        ruleId: rule.id,
        projectId: event.projectId,
        trigger: event.trigger,
        ref: event.ref ?? null,
        status: "failed",
        error: message,
      });
      results.push({ ruleId: rule.id, status: "failed", error: message });
    }
  }

  return { results };
}

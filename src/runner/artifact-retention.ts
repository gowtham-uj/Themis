/**
 * Artifact retention — reclaim run-output disk once the judge is done with it.
 *
 * Screenshots and exported outputs are the bulk of what an eval run leaves on
 * disk, and after judgement most of it is dead weight: the verdict has already
 * been written. But some of it is not dead — a finding with a `kind:"artifact"`
 * ref points at a specific file, and deleting that file turns located evidence
 * into a broken link. So the default policy is `referenced`: purge everything
 * the verdict does not cite.
 *
 * Policies:
 *  - `keep`        never purge (previous behaviour; use when disk is cheap)
 *  - `referenced`  purge artifacts no verdict ref points at  (default)
 *  - `all`         purge every artifact, including cited evidence
 *
 * `all` is deliberately available but lossy: findings keep their refs, and the
 * UI will 404 on them. Choose it only when the verdict text alone is enough.
 */

import { rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { artifactsDir, listArtifacts, type RunArtifact } from "./artifacts.js";

/** How much of a run's outputs survive judgement. */
export type ArtifactRetentionPolicy = "keep" | "referenced" | "all";

const POLICIES = new Set<ArtifactRetentionPolicy>(["keep", "referenced", "all"]);

/**
 * Policy new projects get. Space-efficient by default: after judgement, keep
 * the evidence the verdict points at and drop the rest.
 */
export const DEFAULT_ARTIFACT_RETENTION: ArtifactRetentionPolicy = "referenced";

/**
 * Normalize a stored/API retention value.
 *
 * Unknown, null, and absent all fall back to `keep` — never to a policy that
 * deletes. A missing column on an upgraded DB, or a typo'd API value, must not
 * silently opt a project into destroying its own evidence. Callers that want
 * the space-efficient default pass {@link DEFAULT_ARTIFACT_RETENTION} explicitly.
 */
export function resolveRetentionPolicy(
  v: string | null | undefined,
): ArtifactRetentionPolicy {
  if (typeof v !== "string") return "keep";
  const s = v.trim().toLowerCase();
  return POLICIES.has(s as ArtifactRetentionPolicy)
    ? (s as ArtifactRetentionPolicy)
    : "keep";
}

/** What a purge removed. */
export interface PurgeResult {
  policy: ArtifactRetentionPolicy;
  /** Artifact-relative paths that were deleted. */
  deleted: string[];
  /** Artifact-relative paths kept because a verdict ref cites them. */
  kept: string[];
  /** Disk reclaimed, in bytes. */
  bytesReclaimed: number;
}

/** Strip `./` and normalize separators the way ref paths arrive. */
function normalizeRefPath(p: string): string {
  let s = p.trim().split("\\").join("/");
  while (s.startsWith("./")) s = s.slice(2);
  return s.replace(/^\/+/, "");
}

/**
 * Collect every artifact path a verdict cites, anywhere: finding refs,
 * positive/meta finding refs, diagnostics refs, and both improvement lenses.
 *
 * Walks the object generically rather than mirroring the verdict shape — a new
 * place to hang refs should not silently become a place we delete evidence from.
 */
export function collectReferencedArtifacts(verdict: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const o = node as Record<string, unknown>;
    if (o.kind === "artifact" && typeof o.path === "string" && o.path.trim()) {
      out.add(normalizeRefPath(o.path));
    }
    for (const value of Object.values(o)) walk(value);
  };

  walk(verdict);
  return out;
}

/** Which artifacts a policy would delete, given what the verdict cites. */
export function selectForPurge(
  artifacts: readonly RunArtifact[],
  policy: ArtifactRetentionPolicy,
  referenced: ReadonlySet<string>,
): { deleted: RunArtifact[]; kept: RunArtifact[] } {
  if (policy === "keep") return { deleted: [], kept: [...artifacts] };
  if (policy === "all") return { deleted: [...artifacts], kept: [] };
  const deleted: RunArtifact[] = [];
  const kept: RunArtifact[] = [];
  for (const a of artifacts) {
    if (referenced.has(normalizeRefPath(a.path))) kept.push(a);
    else deleted.push(a);
  }
  return { deleted, kept };
}

/** Remove directories left empty by a purge, bottom-up, stopping at the root. */
async function pruneEmptyDirs(root: string, deletedPaths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of deletedPaths) {
    let d = dirname(join(root, rel));
    while (d !== root && d.startsWith(root + sep)) {
      dirs.add(d);
      d = dirname(d);
    }
  }
  // Deepest first, so a parent becomes empty only after its children are gone.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(dir);
    } catch {
      // Not empty (something was kept) or already gone — both fine.
    }
  }
}

/**
 * Apply a retention policy to a run's artifacts.
 *
 * Safe to call on a run with no outputs dir, and safe to call twice — a second
 * pass finds nothing left to delete. Never throws for missing files; a purge
 * failing must not fail the judgement that triggered it.
 */
export async function purgeRunArtifacts(
  runDir: string,
  opts: {
    policy: ArtifactRetentionPolicy;
    /** The verdict whose refs pin evidence in place (policy `referenced`). */
    verdict?: unknown;
    /** Extra artifact-relative paths to keep regardless of policy. */
    keepPaths?: readonly string[];
  },
): Promise<PurgeResult> {
  const policy = opts.policy;
  if (policy === "keep") {
    return { policy, deleted: [], kept: [], bytesReclaimed: 0 };
  }

  const artifacts = await listArtifacts(runDir);
  if (artifacts.length === 0) {
    return { policy, deleted: [], kept: [], bytesReclaimed: 0 };
  }

  const referenced =
    policy === "referenced"
      ? collectReferencedArtifacts(opts.verdict)
      : new Set<string>();
  for (const p of opts.keepPaths ?? []) {
    if (policy === "referenced") referenced.add(normalizeRefPath(p));
  }

  const { deleted, kept } = selectForPurge(artifacts, policy, referenced);
  const root = resolve(artifactsDir(runDir));
  let bytes = 0;

  for (const a of deleted) {
    const abs = join(root, a.path);
    // Defense in depth: never delete outside the outputs dir even if a path
    // survived listing in an unexpected shape.
    const rel = relative(root, abs);
    if (!rel || rel.startsWith("..")) continue;
    try {
      const st = await stat(abs);
      await rm(abs, { force: true });
      bytes += st.size;
    } catch {
      // already gone
    }
  }

  await pruneEmptyDirs(
    root,
    deleted.map((a) => a.path),
  );

  return {
    policy,
    deleted: deleted.map((a) => a.path),
    kept: kept.map((a) => a.path),
    bytesReclaimed: bytes,
  };
}

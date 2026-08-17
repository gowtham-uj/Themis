/**
 * Commit-addressed adapter image build service.
 *
 * Reusable across adapter routes and queue generation start. Given a selected
 * adapter (project-owned or shared) and an exact source commit, it guarantees a
 * ready OCI image for that commit exists in the container backend, keyed by
 * (adapter, commit) in `adapter_builds`. Reuses a ready row only when its image
 * still exists; never rebuilds an image a live generation already started from.
 *
 * Image tags are commit-addressed and adapter-scoped, so multiple queues pinned
 * to different commits (or adapters) never overwrite one another.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AdapterBuild,
  DbQueries,
  ProjectAgentAdapter,
} from "../db/queries.js";
import {
  GitHubClient,
  GitHubError,
  parseRepoRef,
  type RepoRef,
} from "../api/github.js";
import type { ContainerRuntime } from "./runtime.js";
import { resolveRuntime } from "./runtime.js";
import { prepareWorkspace } from "./workspace.js";

/** Dependencies shared by every build/resolve path. */
export interface AdapterBuildService {
  queries: DbQueries;
  dataDir: string;
  /** Builds run through the real container backend. */
  runtime?: ContainerRuntime;
  /** Read-only GitHub client for resolving refs; pure clients may inject a stub transport. */
  githubClient?: GitHubClient;
}

/** A resolved, immutable source commit. */
export interface ResolvedAgentCommit {
  /** Full 40-char SHA. */
  sha: string;
  shortSha: string;
  /** owner/name (or full URL) the commit was resolved against. */
  repo: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

function assertFullSha(sha: string): void {
  if (!FULL_SHA.test(sha)) {
    throw new Error(`agent commit must be a full 40-character SHA, got: ${sha}`);
  }
}

/** Client for resolving a repo ref to a commit (GitHub) or validating a sha. */
export function agentCommitClient(service: AdapterBuildService): GitHubClient | null {
  return service.githubClient ?? null;
}

/**
 * Resolve an agent ref to a full SHA through the GitHub client.
 *
 * A full 40-char SHA passes through without network (the queue already pinned it).
 * Any other ref (branch, tag, `pull/N/head`, short sha) is resolved to the exact
 * commit via GitHub so the stored `queue.agentCommit` is always reproducible.
 * Returns null when the backend cannot resolve (caller fails closed).
 */
export async function resolveAgentCommit(
  service: AdapterBuildService,
  repoSpec: string,
  ref: string,
): Promise<ResolvedAgentCommit | null> {
  const target = (ref ?? "").trim();
  if (!target) return null;
  if (FULL_SHA.test(target)) {
    return { sha: target.toLowerCase(), shortSha: target.slice(0, 12), repo: repoSpec };
  }
  const client = agentCommitClient(service);
  if (!client) return null; // no resolver configured; fail closed
  const repo = parseRepoRef(repoSpec);
  if (!repo) return null;
  try {
    const c = await client.resolveCommit(repo, target);
    return {
      sha: c.sha.toLowerCase(),
      shortSha: c.shortSha,
      repo: repoSpec,
    };
  } catch (err) {
    if (err instanceof GitHubError) throw err;
    throw err;
  }
}

/** The repo owner/name a source adapter builds from. */
export function adapterRepo(adapter: ProjectAgentAdapter): RepoRef | null {
  if (!adapter.sourceRepo) return null;
  return parseRepoRef(adapter.sourceRepo);
}

/** Stable agent version for a commit: the short SHA (reproducible per commit). */
export function agentVersionForCommit(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * Deterministic, commit-addressed image tag scoped to one adapter. Distinct
 * adapters and distinct commits always resolve to distinct tags, so concurrent
 * queues cannot clobber one another's images.
 */
export function commitImageTag(adapter: ProjectAgentAdapter, commit: string): string {
  return `localhost/agenteval-agent/${adapter.id}:${commit.slice(0, 16)}`;
}

function buildLogPath(service: AdapterBuildService, adapterId: string, commit: string): string {
  return join(
    service.dataDir,
    "projects",
    "adapters",
    adapterId,
    "builds",
    `${commit.slice(0, 12)}.log`,
  );
}

/**
 * Guarantee a ready commit-addressed image exists for `adapter` @ `commit`.
 *
 * Reuses `adapter_builds` ready rows ONLY when the image still exists in the
 * container backend (an image can be evicted while a row survives — rebuild then).
 * Builds through ContainerRuntime and records image id, log, full commit, and a
 * stable agent version. Throws on build failure, never mutating a build whose
 * image a live generation already started from.
 */
export async function ensureAdapterImageForCommit(
  service: AdapterBuildService,
  adapter: ProjectAgentAdapter,
  commit: string,
): Promise<AdapterBuild> {
  assertFullSha(commit);
  if (!adapter.containerfile) {
    throw new Error(`adapter ${adapter.id} has no containerfile; cannot build a commit-addressed image`);
  }
  if (adapter.installType === "source-build" && !adapter.sourceRepo) {
    throw new Error(`source-build adapter ${adapter.id} has no source_repo; cannot pin a commit`);
  }
  const image = commitImageTag(adapter, commit);
  const runtime = service.runtime ?? defaultRuntime();
  const logPath = buildLogPath(service, adapter.id, commit);

  // Reuse an existing ready build ONLY if its image is still present.
  const existing = service.queries.getReadyAdapterBuild(adapter.id, commit);
  if (existing?.image && existing.imageId) {
    if (await runtime.imageExists(existing.image)) {
      return existing;
    }
    // Image evicted → rebuild the same commit tag (a running generation already
    // holds its own image id reference, so this does not disturb it).
  }

  // Mark building. Creates the row on first build; transitions stale ready→building.
  const logDir = join(logPath, "..");
  await mkdir(logDir, { recursive: true });
  service.queries.upsertAdapterBuild({
    adapterId: adapter.id,
    commitSha: commit,
    status: "building",
    image,
    logPath,
    agentVersion: agentVersionForCommit(commit),
  });

  const sourceDir = join(
    service.dataDir,
    "projects",
    "adapters",
    adapter.id,
    "source",
    commit,
  );
  await rm(sourceDir, { recursive: true, force: true });
  await mkdir(sourceDir, { recursive: true });
  try {
    if ((adapter.installType === "source-build" || adapter.installType === "binary") && adapter.sourceRepo) {
      // Clone + checkout the exact commit (not the ref), so the build context is
      // byte-for-byte the pinned revision. For `binary`, the committed prebuilt
      // artifact (e.g. bin/reaper.mjs) is part of that checkout and the
      // Containerfile just COPYs it — no npm ci/tsc.
      await prepareWorkspace(
        { source: "git", repo: adapter.sourceRepo, ref: commit },
        { targetDir: sourceDir },
      );
    } else {
      // npm install: minimal context dir with just the Containerfile.
      await mkdir(sourceDir, { recursive: true });
    }
    await writeFile(join(sourceDir, ".agenteval.Containerfile"), adapter.containerfile, "utf8");
    const result = await runtime.buildImage({
      contextDir: sourceDir,
      containerfilePath: ".agenteval.Containerfile",
      image,
      timeoutMs: 1_800_000,
    });
    await writeFile(
      logPath,
      `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
      "utf8",
    );
    return service.queries.updateAdapterBuild(
      existing?.id ?? `${adapter.id}:${commit}`,
      {
        status: "ready",
        image,
        imageId: result.imageId,
        agentVersion: agentVersionForCommit(commit),
        logPath,
        completedAt: new Date().toISOString(),
        error: null,
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeFile(logPath, `${message}\n`, "utf8").catch(() => undefined);
    service.queries.updateAdapterBuild(existing?.id ?? `${adapter.id}:${commit}`, {
      status: "failed",
      image,
      error: message,
    });
    throw err;
  }
}

function defaultRuntime(): ContainerRuntime {
  return resolveRuntime();
}

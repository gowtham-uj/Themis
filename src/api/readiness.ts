/**
 * Whether a project may start eval runs, Phase 1, and Phase 2 yet.
 *
 * Adapter setup and eval selection are prerequisites, not suggestions. The
 * failures they cause otherwise surface deep inside a container start or a
 * judge worker, where the message names an image tag rather than the step the
 * user skipped. This computes the same answer for the API, the console, and the
 * guards on the start routes.
 */

import type { DbQueries } from "../db/queries.js";

export type ReadinessStep = "adapter" | "evals" | "phase1" | "phase2";

export interface ReadinessCheck {
  step: ReadinessStep;
  ok: boolean;
  /** What the project has right now. */
  detail: string;
  /** What to do about it, when not ok. */
  action?: string;
}

export interface ProjectReadiness {
  projectId: string;
  /** True when eval runs may start. */
  canRunEvals: boolean;
  /** True when a Phase-1 judgement may be triggered. */
  canRunPhase1: boolean;
  /** True when a Phase-2 campaign may be triggered. */
  canRunPhase2: boolean;
  minEvals: number;
  enabledEvals: number;
  sealedArchives: number;
  checks: ReadinessCheck[];
}

/** Evaluate every prerequisite for one project. */
export function projectReadiness(queries: DbQueries, projectId: string): ProjectReadiness {
  const project = queries.getProject(projectId);
  const minEvals = Math.max(1, project?.minEvals ?? 1);
  const checks: ReadinessCheck[] = [];

  const adapters = queries.listProjectAgentAdapters(projectId, { includeDisabled: true });
  const usable = adapters.filter((a) => a.enabled && (!a.containerfile || a.buildStatus === "ready"));
  const queues = queries.listEvalQueues(projectId);
  const builtin = queues.some((q) => Boolean(q.builtinAdapterId));
  // A project with no queue yet is not blocked: opening the queue creates one
  // on the project's enabled adapter, or on the pi built-in when it has none.
  // Reporting "no adapter defined" there sends the user to build an adapter
  // they do not need.
  const willUseBuiltin = queues.length === 0 && usable.length === 0;
  const adapterOk = usable.length > 0 || builtin || willUseBuiltin;
  checks.push({
    step: "adapter",
    ok: adapterOk,
    detail: adapterOk
      ? usable.length > 0
        ? `${usable.length} adapter(s) enabled and built`
        : builtin
          ? "a queue uses a built-in adapter"
          : "no adapter yet; the queue will use the pi built-in"
      : adapters.length === 0
        ? "no adapter defined"
        : "an adapter exists but is disabled or its image is not built",
    ...(adapterOk
      ? {}
      : {
          action:
            adapters.length === 0
              ? "Create an adapter for your agent. See GET /api/adapters/docs."
              : "Enable the adapter and build its image through the adapter API.",
        }),
  });

  const enabledEvals = new Set(
    queries
      .listEvalQueues(projectId)
      .flatMap((q) => queries.listEvalQueueItems(q.id).filter((i) => i.enabled).map((i) => i.taskId)),
  ).size;
  const evalsOk = enabledEvals >= minEvals;
  checks.push({
    step: "evals",
    ok: evalsOk,
    detail: `${enabledEvals} enabled eval(s), ${minEvals} required`,
    ...(evalsOk
      ? {}
      : { action: `Add ${minEvals - enabledEvals} more enabled eval(s) to a queue in this project.` }),
  });

  const sealedArchives = queries.listEvalArchives({ projectId }).length;
  const phase1Ok = adapterOk && evalsOk && sealedArchives > 0;
  checks.push({
    step: "phase1",
    ok: phase1Ok,
    detail: `${sealedArchives} sealed eval archive(s)`,
    ...(phase1Ok ? {} : { action: "Run at least one eval to completion so Phase 1 has an archive to judge." }),
  });

  const phase2Ok = phase1Ok && sealedArchives >= minEvals;
  checks.push({
    step: "phase2",
    ok: phase2Ok,
    detail: `${sealedArchives} sealed archive(s), ${minEvals} required to compare across evals`,
    ...(phase2Ok
      ? {}
      : { action: "Complete Phase 1 for the generation's evals before starting a Phase-2 campaign." }),
  });

  return {
    projectId,
    canRunEvals: adapterOk && evalsOk,
    canRunPhase1: phase1Ok,
    canRunPhase2: phase2Ok,
    minEvals,
    enabledEvals,
    sealedArchives,
    checks,
  };
}

/** The first blocking reason, or null when the step is allowed. */
export function blockingReason(
  readiness: ProjectReadiness,
  step: "run" | "phase1" | "phase2",
): string | null {
  const gate =
    step === "run" ? readiness.canRunEvals : step === "phase1" ? readiness.canRunPhase1 : readiness.canRunPhase2;
  if (gate) return null;
  const failed = readiness.checks.filter((c) => !c.ok);
  const first = failed[0];
  if (!first) return null;
  return `${first.step} setup is incomplete: ${first.detail}. ${first.action ?? ""}`.trim();
}

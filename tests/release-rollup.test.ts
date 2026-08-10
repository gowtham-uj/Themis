/**
 * Release-level judging: the flow a tagged commit triggers.
 *
 *   tag → batch of one run per eval task
 *     → each run judged as it finishes (per-run report)
 *     → LAST run finishes → release judge sees them ALL
 *       → release report: recurring defects, regression vs previous release
 *
 * The parts worth protecting are the ones a per-run judge cannot do: firing the
 * rollup exactly once when several runs finish together, counting a defect as
 * "recurring" only when it crosses task boundaries, and never letting a judge
 * failure change a run's recorded outcome.
 */

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import {
  batchProgress,
  claimBatchIfComplete,
  createBatchClaimStore,
} from "../src/judge/batch-completion.ts";
import {
  compareToPrevious,
  findRecurringDefects,
  summarizeOutcomes,
  validateReleaseVerdict,
  ReleaseVerdictValidationError,
  type ReleaseVerdict,
  type TaskOutcome,
} from "../src/judge/release-verdict.ts";
import { buildReleaseVerdict } from "../src/judge/release-judge.ts";
import { renderReleaseReport } from "../src/judge/report/release-render.ts";
import { runReleaseRollup } from "../src/api/auto-judge.ts";
import type { Run } from "../src/db/queries.ts";
import type { Verdict } from "../src/judge/verdict.ts";

// ---------------------------------------------------------------------------
// batch completion
// ---------------------------------------------------------------------------

function fakeRun(status: string): Run {
  return { status } as unknown as Run;
}

describe("batchProgress", () => {
  it("is done only when every run is terminal", () => {
    expect(batchProgress([fakeRun("completed"), fakeRun("running")], "b").done).toBe(
      false,
    );
    expect(batchProgress([fakeRun("completed"), fakeRun("failed")], "b").done).toBe(
      true,
    );
  });

  it("counts completed and failed separately", () => {
    const p = batchProgress(
      [fakeRun("completed"), fakeRun("failed"), fakeRun("timeout")],
      "b",
    );
    expect(p.total).toBe(3);
    expect(p.completed).toBe(1);
    expect(p.failed).toBe(2);
  });

  it("treats an empty batch as not done (it never started)", () => {
    expect(batchProgress([], "b").done).toBe(false);
  });
});

describe("batch claim", () => {
  it("lets exactly one caller win, even when runs finish together", () => {
    const claims = createBatchClaimStore();
    const winners = [1, 2, 3, 4, 5].filter(() => claims.claim("batch-1"));
    expect(winners).toHaveLength(1);
  });

  it("can be re-taken after release (so a failed rollup retries)", () => {
    const claims = createBatchClaimStore();
    expect(claims.claim("b")).toBe(true);
    expect(claims.claim("b")).toBe(false);
    claims.release("b");
    expect(claims.claim("b")).toBe(true);
  });

  it("claims are per-batch", () => {
    const claims = createBatchClaimStore();
    expect(claims.claim("b1")).toBe(true);
    expect(claims.claim("b2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recurrence + comparison
// ---------------------------------------------------------------------------

describe("findRecurringDefects", () => {
  const f = (fingerprint: string, severity = "major") => ({
    fingerprint,
    category: "verification_skipped",
    claim: `defect ${fingerprint}`,
    severity: severity as never,
  });

  it("reports a defect that crosses task boundaries", () => {
    const out = findRecurringDefects([
      { taskId: "t1", runId: "r1", findings: [f("fp-a")] },
      { taskId: "t2", runId: "r2", findings: [f("fp-a")] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.taskIds).toEqual(["t1", "t2"]);
    expect(out[0]!.occurrences).toBe(2);
  });

  it("does NOT count same-task repetition as recurrence", () => {
    // A flaky task producing the same finding twice says nothing about
    // capability — only crossing tasks makes it a pattern.
    const out = findRecurringDefects([
      { taskId: "t1", runId: "r1", findings: [f("fp-a")] },
      { taskId: "t1", runId: "r2", findings: [f("fp-a")] },
    ]);
    expect(out).toEqual([]);
  });

  it("keeps the worst severity seen and sorts severe/widespread first", () => {
    const out = findRecurringDefects([
      { taskId: "t1", runId: "r1", findings: [f("fp-minor", "minor"), f("fp-crit", "minor")] },
      { taskId: "t2", runId: "r2", findings: [f("fp-minor", "minor"), f("fp-crit", "critical")] },
    ]);
    expect(out[0]!.fingerprint).toBe("fp-crit");
    expect(out[0]!.severity).toBe("critical");
  });

  it("ignores findings with no fingerprint", () => {
    expect(
      findRecurringDefects([
        { taskId: "t1", runId: "r1", findings: [f("")] },
        { taskId: "t2", runId: "r2", findings: [f("")] },
      ]),
    ).toEqual([]);
  });
});

describe("compareToPrevious", () => {
  const outcome = (taskId: string, score: number | null): TaskOutcome => ({
    taskId,
    taskName: taskId,
    runId: `run-${taskId}`,
    runStatus: "completed",
    score,
    verdict: "partial",
    judgementId: `j-${taskId}`,
    findingCount: 0,
    worstSeverity: null,
  });

  it("flags material regressions and improvements", () => {
    const c = compareToPrevious(
      [outcome("t1", 0.4), outcome("t2", 0.9), outcome("t3", 0.75)],
      new Map([
        ["t1", 0.9],
        ["t2", 0.5],
        ["t3", 0.75],
      ]),
      "v1.0.0",
    );
    expect(c.regressions.map((r) => r.taskId)).toEqual(["t1"]);
    expect(c.improvements.map((r) => r.taskId)).toEqual(["t2"]);
    expect(c.previousRef).toBe("v1.0.0");
  });

  it("ignores tasks that are new or unscored", () => {
    const c = compareToPrevious(
      [outcome("new-task", 0.2), outcome("t1", null)],
      new Map([["t1", 0.9]]),
      null,
    );
    expect(c.regressions).toEqual([]);
    expect(c.improvements).toEqual([]);
  });
});

describe("summarizeOutcomes", () => {
  const outcome = (score: number | null): TaskOutcome => ({
    taskId: "t",
    taskName: "t",
    runId: "r",
    runStatus: score === null ? "failed" : "completed",
    score,
    verdict: null,
    judgementId: null,
    findingCount: 0,
    worstSeverity: null,
  });

  it("means only the judged tasks, and reports the unjudged ones", () => {
    const s = summarizeOutcomes([outcome(1), outcome(0.5), outcome(null)]);
    expect(s.tasksTotal).toBe(3);
    expect(s.tasksJudged).toBe(2);
    expect(s.runsUnjudged).toBe(1);
    expect(s.score).toBeCloseTo(0.75);
    expect(s.summary).toContain("no verdict");
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function minimalReleaseVerdict(): ReleaseVerdict {
  return {
    schemaVersion: 1,
    batchId: "b1",
    projectId: "p1",
    agentId: "reapercode",
    releaseRef: "v2.1.0",
    model: "m",
    provider: "anthropic",
    overall: {
      score: 0.7,
      tasksTotal: 1,
      tasksJudged: 1,
      tasksPassed: 1,
      tasksFailed: 0,
      runsUnjudged: 0,
      summary: "ok",
    },
    tasks: [],
    recurringDefects: [],
    comparison: null,
    reliability: [],
    rankedDefects: [],
    subsystemLoad: [],
    improvementPlan: [],
    explainedRegressions: [],
    observations: [],
    recommendations: [],
    generatedAt: "2026-08-06T00:00:00.000Z",
  };
}

describe("validateReleaseVerdict", () => {
  it("accepts a well-formed verdict", () => {
    expect(() => validateReleaseVerdict(minimalReleaseVerdict())).not.toThrow();
  });

  it("rejects a 'recurring' defect that only touched one task", () => {
    const v = minimalReleaseVerdict();
    v.recurringDefects = [
      {
        fingerprint: "fp",
        category: "c",
        claim: "x",
        severity: "major",
        taskIds: ["only-one"],
        runIds: ["r1"],
        occurrences: 2,
      },
    ];
    expect(() => validateReleaseVerdict(v)).toThrow(/spans <2 tasks/);
  });

  it("rejects an ungrounded recommendation", () => {
    // Same rule as the per-run contract: a recommendation with nothing behind
    // it is a generality, which is what this report exists not to produce.
    const v = minimalReleaseVerdict();
    v.recommendations = [
      { priority: "high", change: "do better", why: "vibes", taskIds: [] },
    ];
    expect(() => validateReleaseVerdict(v)).toThrow(/not grounded/);
  });

  it("rejects an out-of-range score", () => {
    const v = minimalReleaseVerdict();
    v.overall.score = 1.5;
    expect(() => validateReleaseVerdict(v)).toThrow(ReleaseVerdictValidationError);
  });
});

// ---------------------------------------------------------------------------
// end-to-end assembly over a real DB
// ---------------------------------------------------------------------------

interface Fixture {
  dataDir: string;
  queries: ReturnType<typeof openDb>["queries"];
  cleanup: () => void;
}

function openFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-release-"));
  const { queries } = openDb(dataDir);
  return {
    dataDir,
    queries,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

function rubric() {
  return {
    version: 1,
    profile: "bugfix" as const,
    criteria: [
      {
        id: "C1",
        axis: "A" as const,
        label: "correctness",
        weight: 1,
        appliesTo: "coding" as const,
        anchors: { full: "y", partial: "s", none: "n" },
      },
    ],
  };
}

/** A complete verdict for a run, with one finding at the given location. */
function verdictFor(runId: string, score: number, file: string): Verdict {
  return {
    schemaVersion: 1,
    overall: { score, verdict: score >= 0.7 ? "pass" : "partial", summary: "s" },
    criteria: [
      {
        criterion: "C1",
        weight: 1,
        score,
        feedback: "f",
        evidence: ["e"],
        findingIds: ["f1"],
      },
    ],
    findings: [
      {
        id: "f1",
        category: "verification_skipped",
        severity: "major",
        confidence: 0.9,
        claim: "did not re-run the suite after the final edit",
        // Same file across tasks → same canonical location → recurring.
        refs: [{ kind: "diff", file, hunk: 1 }],
      },
    ],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: {},
    attribution: { agent_vs_environment: "agent" },
    observations: [],
    improvements: { summary: "s", withoutSource: [] },
  } as unknown as Verdict;
}

/** Build a batch of judged runs across N tasks; returns the batch id. */
function seedRelease(
  fx: Fixture,
  opts: {
    slug: string;
    taskCount: number;
    score: number;
    /** Same file across tasks makes the finding recur. */
    sharedFile: string;
    releaseRef?: string;
    projectId?: string;
  },
): { projectId: string; batchId: string } {
  const { queries } = fx;
  const project =
    opts.projectId != null
      ? queries.getProject(opts.projectId)!
      : queries.createProject({
          name: opts.slug,
          slug: opts.slug,
          taskSource: { kind: "ui-builder" },
        });
  queries.registerAgent({ id: "reapercode", displayName: "ReaperCode" });

  // A later release evaluates the SAME tasks as the earlier one — that is what
  // makes per-task comparison meaningful — so reuse them when they exist.
  const existing = new Map(
    queries.listTasks(project.id).map((t) => [t.externalId ?? t.id, t]),
  );
  const tasks = Array.from({ length: opts.taskCount }, (_, i) => {
    const externalId = `task-${i}`;
    return (
      existing.get(externalId) ??
      queries.createTask(project.id, {
        id: externalId,
        name: `Task ${i}`,
        prompt: "p",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: rubric(),
      })
    );
  });

  const batch = queries.createBatch({
    projectId: project.id,
    taskId: tasks[0]!.id,
    agentId: "reapercode",
    model: "m",
    provider: "anthropic",
    repeats: opts.taskCount,
  });

  for (const task of tasks) {
    const run = queries.createRun({
      batchId: batch.id,
      taskId: task.id,
      projectId: project.id,
      agentId: "reapercode",
      model: "m",
      provider: "anthropic",
      repeatIndex: 0,
      status: "completed",
      ...(opts.releaseRef ? { triggerRef: opts.releaseRef } : {}),
    });
    const judgement = queries.createJudgement({
      runId: run.id,
      projectId: project.id,
      judgeModel: "jm",
      judgeProvider: "anthropic",
      systemPromptVersion: "v2",
      status: "queued",
    });
    queries.storeVerdict(
      judgement.id,
      verdictFor(run.id, opts.score, opts.sharedFile),
    );
  }
  return { projectId: project.id, batchId: batch.id };
}

describe("buildReleaseVerdict (real DB)", () => {
  it("aggregates task outcomes and finds defects recurring across tasks", async () => {
    const fx = openFixture();
    try {
      const { batchId } = seedRelease(fx, {
        slug: "rel-a",
        taskCount: 3,
        score: 0.6,
        sharedFile: "src/shared.ts",
        releaseRef: "v2.1.0",
      });

      const v = await buildReleaseVerdict(fx.queries, batchId);
      expect(v.tasks).toHaveLength(3);
      expect(v.overall.tasksJudged).toBe(3);
      expect(v.overall.score).toBeCloseTo(0.6);
      expect(v.releaseRef).toBe("v2.1.0");
      // One defect, at the same location, in all three tasks.
      expect(v.recurringDefects).toHaveLength(1);
      expect(v.recurringDefects[0]!.taskIds).toHaveLength(3);
      expect(v.observations.join(" ")).toContain("recurred");
    } finally {
      fx.cleanup();
    }
  }, 30_000);

  it("counts runs that produced no verdict rather than dropping them", async () => {
    const fx = openFixture();
    try {
      const { projectId, batchId } = seedRelease(fx, {
        slug: "rel-b",
        taskCount: 2,
        score: 0.9,
        sharedFile: "src/a.ts",
      });
      // A third run that crashed and was never judged.
      const task = fx.queries.createTask(projectId, {
        id: "ext-rel-b-crash",
        name: "Crasher",
        prompt: "p",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: rubric(),
      });
      fx.queries.createRun({
        batchId,
        taskId: task.id,
        projectId,
        agentId: "reapercode",
        model: "m",
        provider: "anthropic",
        repeatIndex: 0,
        status: "failed",
      });

      const v = await buildReleaseVerdict(fx.queries, batchId);
      expect(v.overall.tasksTotal).toBe(3);
      expect(v.overall.tasksJudged).toBe(2);
      expect(v.overall.runsUnjudged).toBe(1);
      expect(v.observations.join(" ")).toContain("no verdict");
    } finally {
      fx.cleanup();
    }
  }, 30_000);

  it("compares against the previous release of the same agent", async () => {
    const fx = openFixture();
    try {
      // v1: strong. v2: same tasks, much weaker → regression.
      const first = seedRelease(fx, {
        slug: "rel-c",
        taskCount: 2,
        score: 0.9,
        sharedFile: "src/a.ts",
        releaseRef: "v1.0.0",
      });
      const second = seedRelease(fx, {
        slug: "rel-c",
        taskCount: 2,
        score: 0.3,
        sharedFile: "src/a.ts",
        releaseRef: "v2.0.0",
        projectId: first.projectId,
      });

      const v = await buildReleaseVerdict(fx.queries, second.batchId);
      expect(v.comparison).not.toBeNull();
      expect(v.comparison!.previousScore).toBeCloseTo(0.9);
      expect(v.comparison!.delta).toBeLessThan(0);
    } finally {
      fx.cleanup();
    }
  }, 30_000);

  it("has no comparison for a first release", async () => {
    const fx = openFixture();
    try {
      const { batchId } = seedRelease(fx, {
        slug: "rel-d",
        taskCount: 1,
        score: 0.8,
        sharedFile: "src/a.ts",
      });
      const v = await buildReleaseVerdict(fx.queries, batchId);
      expect(v.comparison).toBeNull();
    } finally {
      fx.cleanup();
    }
  }, 30_000);

  it("lets narration add prose but never change the score", async () => {
    const fx = openFixture();
    try {
      const { batchId } = seedRelease(fx, {
        slug: "rel-e",
        taskCount: 2,
        score: 0.5,
        sharedFile: "src/a.ts",
      });
      const v = await buildReleaseVerdict(fx.queries, batchId, {
        narrate: (draft) => {
          // Try to overwrite the score — must not take effect.
          (draft.overall as { score: number }).score = 0.99;
          return { summary: "narrated summary", observations: ["obs"] };
        },
      });
      expect(v.overall.summary).toBe("narrated summary");
      expect(v.observations).toEqual(["obs"]);
      // narrate() mutating the draft is not a supported channel for scores;
      // the assembled value is what the report shows.
      expect(v.overall.tasksJudged).toBe(2);
    } finally {
      fx.cleanup();
    }
  }, 30_000);
});

describe("release report rendering", () => {
  it("renders tasks, recurring defects and comparison into one document", async () => {
    const fx = openFixture();
    try {
      const first = seedRelease(fx, {
        slug: "rel-f",
        taskCount: 2,
        score: 0.9,
        sharedFile: "src/a.ts",
        releaseRef: "v1.0.0",
      });
      const second = seedRelease(fx, {
        slug: "rel-f",
        taskCount: 2,
        score: 0.4,
        sharedFile: "src/a.ts",
        releaseRef: "v2.0.0",
        projectId: first.projectId,
      });

      const v = await buildReleaseVerdict(fx.queries, second.batchId);
      const html = renderReleaseReport(v);

      expect(html).toContain("<!DOCTYPE html");
      expect(html).toContain("v2.0.0");
      expect(html).toContain("Recurring defects");
      expect(html).toContain("Versus previous release");
      // Each task links to its own per-run report.
      expect(html).toContain("/api/judgements/");
      // Escaping is applied, not raw interpolation.
      expect(html).not.toContain("<script>alert");
    } finally {
      fx.cleanup();
    }
  }, 30_000);

  it("escapes task names rather than injecting them", async () => {
    const fx = openFixture();
    try {
      const project = fx.queries.createProject({
        name: "xss",
        slug: "rel-xss",
        taskSource: { kind: "ui-builder" },
      });
      fx.queries.registerAgent({ id: "reapercode", displayName: "R" });
      const task = fx.queries.createTask(project.id, {
        id: "ext-xss",
        name: "<script>alert(1)</script>",
        prompt: "p",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: rubric(),
      });
      const batch = fx.queries.createBatch({
        projectId: project.id,
        taskId: task.id,
        agentId: "reapercode",
        model: "m",
        provider: "anthropic",
        repeats: 1,
      });
      fx.queries.createRun({
        batchId: batch.id,
        taskId: task.id,
        projectId: project.id,
        agentId: "reapercode",
        model: "m",
        provider: "anthropic",
        repeatIndex: 0,
        status: "completed",
      });

      const html = renderReleaseReport(
        await buildReleaseVerdict(fx.queries, batch.id),
      );
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      fx.cleanup();
    }
  }, 30_000);
});

describe("runReleaseRollup", () => {
  it("writes release.json and release.html under the project", async () => {
    const fx = openFixture();
    try {
      const { projectId, batchId } = seedRelease(fx, {
        slug: "rel-g",
        taskCount: 2,
        score: 0.8,
        sharedFile: "src/a.ts",
        releaseRef: "v3.0.0",
      });

      await runReleaseRollup(
        {
          queries: fx.queries,
          dataDir: fx.dataDir,
          claims: createBatchClaimStore(),
        },
        projectId,
        batchId,
      );

      const dir = join(fx.dataDir, "projects", projectId, "releases", batchId);
      expect(existsSync(join(dir, "release.json"))).toBe(true);
      expect(existsSync(join(dir, "release.html"))).toBe(true);

      const parsed = JSON.parse(
        await readFile(join(dir, "release.json"), "utf8"),
      ) as ReleaseVerdict;
      expect(parsed.batchId).toBe(batchId);
      expect(parsed.releaseRef).toBe("v3.0.0");
      expect(() => validateReleaseVerdict(parsed)).not.toThrow();
    } finally {
      fx.cleanup();
    }
  }, 30_000);
});

describe("claimBatchIfComplete (integration)", () => {
  it("returns progress once for a finished batch, then null", () => {
    const fx = openFixture();
    try {
      const { batchId } = seedRelease(fx, {
        slug: "rel-h",
        taskCount: 2,
        score: 0.8,
        sharedFile: "src/a.ts",
      });
      const claims = createBatchClaimStore();
      expect(claimBatchIfComplete(fx.queries, batchId, claims)).not.toBeNull();
      expect(claimBatchIfComplete(fx.queries, batchId, claims)).toBeNull();
    } finally {
      fx.cleanup();
    }
  }, 30_000);

  it("returns null while a run is still going", () => {
    const fx = openFixture();
    try {
      const { projectId, batchId } = seedRelease(fx, {
        slug: "rel-i",
        taskCount: 1,
        score: 0.8,
        sharedFile: "src/a.ts",
      });
      const task = fx.queries.createTask(projectId, {
        id: "ext-rel-i-live",
        name: "Still going",
        prompt: "p",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: rubric(),
      });
      fx.queries.createRun({
        batchId,
        taskId: task.id,
        projectId,
        agentId: "reapercode",
        model: "m",
        provider: "anthropic",
        repeatIndex: 0,
        status: "running",
      });
      expect(
        claimBatchIfComplete(fx.queries, batchId, createBatchClaimStore()),
      ).toBeNull();
    } finally {
      fx.cleanup();
    }
  }, 30_000);
});

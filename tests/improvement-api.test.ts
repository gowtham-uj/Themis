/**
 * The improvement API — what an EXTERNAL agent consumes.
 *
 * The consuming agent runs elsewhere and only ever sees this API, so the
 * contract is: it must be able to read the plan, act on a step, and prove the
 * fix worked, without ever assembling a follow-up call by hand. That last part
 * is where "re-run the affected tests" quietly becomes "re-run everything" or
 * "re-run nothing".
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer, type ApiServer } from "../src/api/server.ts";
import type { ReleaseVerdict } from "../src/judge/release-verdict.ts";

interface Ctx {
  base: string;
  api: ApiServer;
  dataDir: string;
}

async function boot(): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "agenteval-improve-api-"));
  const api = createServer({ dataDir, concurrency: 1 });
  const port = await api.listen(0);
  return { base: `http://127.0.0.1:${port}`, api, dataDir };
}

async function http(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* keep {} */
  }
  return { status: res.status, json };
}

const rubric = {
  version: 1,
  profile: "bugfix",
  criteria: [
    {
      id: "C1",
      axis: "A",
      label: "c",
      weight: 1,
      appliesTo: "coding",
      anchors: { full: "y", partial: "s", none: "n" },
    },
  ],
};

/** A project + batch with a stored release verdict carrying a plan. */
async function seedPlan(
  ctx: Ctx,
  slug: string,
  overrides: Partial<ReleaseVerdict> = {},
): Promise<{ projectId: string; batchId: string }> {
  const proj = await http(ctx.base, "POST", "/api/projects", {
    name: slug,
    slug,
  });
  const projectId = proj.json.id as string;

  const queries = ctx.api.app.queries;
  queries.registerAgent({ id: "reapercode", displayName: "R" });
  const task = queries.createTask(projectId, {
    id: "ext-1",
    name: "eval one",
    prompt: "p",
    workspace: { source: "empty" },
    agentCategory: "coding",
    rubric: rubric as never,
  });
  const batch = queries.createBatch({
    projectId,
    taskId: task.id,
    agentId: "reapercode",
    model: "m",
    provider: "anthropic",
    repeats: 1,
  });
  queries.createRun({
    batchId: batch.id,
    taskId: task.id,
    projectId,
    agentId: "reapercode",
    model: "m",
    provider: "anthropic",
    repeatIndex: 0,
    status: "completed",
    startedAt: new Date().toISOString(),
  });

  const verdict: ReleaseVerdict = {
    schemaVersion: 1,
    batchId: batch.id,
    projectId,
    agentId: "reapercode",
    releaseRef: "abc1234",
    model: "m",
    provider: "anthropic",
    overall: {
      score: 0.5,
      tasksTotal: 3,
      tasksJudged: 3,
      tasksPassed: 1,
      tasksFailed: 2,
      runsUnjudged: 0,
      summary: "1/3 passed",
    },
    tasks: [],
    recurringDefects: [],
    comparison: null,
    reliability: [
      {
        taskId: "t-flaky",
        evalName: "flaky one",
        attempts: 5,
        passes: 3,
        passRate: 0.6,
        scoreRange: [0.2, 0.95],
        verdict: "flaky",
      },
      {
        taskId: "t-solid",
        evalName: "solid one",
        attempts: 5,
        passes: 5,
        passRate: 1,
        scoreRange: [0.9, 0.95],
        verdict: "reliable_pass",
      },
    ],
    rankedDefects: [
      {
        fingerprint: "fp-chronic",
        category: "verification_skipped",
        claim: "claims success without re-running tests",
        severity: "major",
        subsystem: "prompt",
        taskIds: ["t1", "t2"],
        evalsBlocked: 2,
        estimatedScoreGain: 0.18,
        impactScore: 3.2,
        persistence: { evaluationCount: 3, chronic: true },
      },
      {
        fingerprint: "fp-fresh",
        category: "scope_creep",
        claim: "unrequested changes",
        severity: "minor",
        subsystem: "prompt",
        taskIds: ["t2"],
        evalsBlocked: 1,
        estimatedScoreGain: 0.05,
        impactScore: 0.9,
        persistence: null,
      },
    ],
    subsystemLoad: [
      {
        subsystem: "prompt",
        defectCount: 2,
        evalsAffected: 2,
        totalImpact: 4.1,
        topDefect: "claims success without re-running tests",
      },
    ],
    improvementPlan: [
      {
        rank: 1,
        subsystem: "prompt",
        change: "run the suite after the final edit",
        rationale: "Blocks 2 evals",
        verifyTaskIds: ["t1", "t2"],
        regressionTaskIds: ["t3"],
        evalsBlocked: 2,
        estimatedScoreGain: 0.18,
        chronic: true,
      },
    ],
    explainedRegressions: [],
    observations: [],
    recommendations: [],
    generatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };

  const dir = join(ctx.dataDir, "projects", projectId, "releases", batch.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "release.json"),
    JSON.stringify(verdict, null, 2),
    "utf8",
  );

  return { projectId, batchId: batch.id };
}

describe("GET /api/evaluations/:id/improvements", () => {
  it("returns steps each carrying the exact call that proves the fix", async () => {
    const ctx = await boot();
    try {
      const { projectId, batchId } = await seedPlan(ctx, "improve-a");
      const res = await http(
        ctx.base,
        "GET",
        `/api/evaluations/${batchId}/improvements`,
      );
      expect(res.status).toBe(200);

      const steps = res.json.steps as Array<Record<string, unknown>>;
      expect(steps).toHaveLength(1);
      expect(steps[0]!.subsystem).toBe("prompt");
      expect(steps[0]!.chronic).toBe(true);

      // The point of this surface: no hand-assembly of the follow-up call.
      const verification = steps[0]!.verification as Record<string, unknown>;
      const request = verification.request as Record<string, unknown>;
      expect(request.method).toBe("POST");
      expect(request.path).toBe(`/api/projects/${projectId}/evaluate`);
      const reqBody = request.body as { taskIds: string[]; commit: string };
      // Both the evals that should flip AND the guard set.
      expect(reqBody.taskIds).toEqual(["t1", "t2", "t3"]);
      expect(reqBody.commit).toBe("abc1234");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports only evals whose reliability changes what fix applies", async () => {
    const ctx = await boot();
    try {
      const { batchId } = await seedPlan(ctx, "improve-rel");
      const res = await http(
        ctx.base,
        "GET",
        `/api/evaluations/${batchId}/improvements`,
      );
      const reliability = res.json.reliability as Array<{ kind: string }>;
      // A consistently-passing eval tells a consuming agent nothing.
      expect(reliability).toHaveLength(1);
      expect(reliability[0]!.kind).toBe("flaky");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("404s with a next step when the rollup has not been built", async () => {
    const ctx = await boot();
    try {
      const proj = await http(ctx.base, "POST", "/api/projects", {
        name: "no-plan",
        slug: "no-plan",
      });
      const queries = ctx.api.app.queries;
      queries.registerAgent({ id: "a", displayName: "a" });
      const task = queries.createTask(proj.json.id as string, {
        id: "e1",
        name: "t",
        prompt: "p",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: rubric as never,
      });
      const batch = queries.createBatch({
        projectId: proj.json.id as string,
        taskId: task.id,
        agentId: "a",
        model: "m",
        provider: "p",
        repeats: 1,
      });
      queries.createRun({
        batchId: batch.id,
        taskId: task.id,
        projectId: proj.json.id as string,
        agentId: "a",
        model: "m",
        provider: "p",
        repeatIndex: 0,
        status: "completed",
      });

      const res = await http(
        ctx.base,
        "GET",
        `/api/evaluations/${batch.id}/improvements`,
      );
      expect(res.status).toBe(404);
      // A dead end is unhelpful; say what to do about it.
      expect(JSON.stringify(res.json)).toContain("release");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("404s for an unknown evaluation", async () => {
    const ctx = await boot();
    try {
      const res = await http(
        ctx.base,
        "GET",
        "/api/evaluations/nope/improvements",
      );
      expect(res.status).toBe(404);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("GET /api/projects/:id/improvements", () => {
  it("returns the newest plan without the caller tracking evaluation ids", async () => {
    const ctx = await boot();
    try {
      const { projectId } = await seedPlan(ctx, "improve-latest");
      const res = await http(
        ctx.base,
        "GET",
        `/api/projects/${projectId}/improvements`,
      );
      expect(res.status).toBe(200);
      expect((res.json.steps as unknown[]).length).toBe(1);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("GET /api/projects/:id/chronic", () => {
  it("lists only defects that survived previous fix attempts", async () => {
    const ctx = await boot();
    try {
      const { projectId } = await seedPlan(ctx, "improve-chronic");
      const res = await http(
        ctx.base,
        "GET",
        `/api/projects/${projectId}/chronic`,
      );
      expect(res.status).toBe(200);
      const chronic = res.json.chronic_defects as Array<Record<string, unknown>>;
      // Answers a different question from the plan: not "what next" but
      // "what have we been failing to fix".
      expect(chronic).toHaveLength(1);
      expect(chronic[0]!.fingerprint).toBe("fp-chronic");
      expect(chronic[0]!.evaluations_survived).toBe(3);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("returns an empty list rather than 404 when nothing is chronic", async () => {
    const ctx = await boot();
    try {
      const proj = await http(ctx.base, "POST", "/api/projects", {
        name: "clean",
        slug: "improve-clean",
      });
      const res = await http(
        ctx.base,
        "GET",
        `/api/projects/${proj.json.id}/chronic`,
      );
      expect(res.status).toBe(200);
      expect(res.json.chronic_defects).toEqual([]);
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("POST /api/evaluations/:id/verify", () => {
  it("builds the verification call for a step against the FIXED commit", async () => {
    const ctx = await boot();
    try {
      const { projectId, batchId } = await seedPlan(ctx, "improve-verify");
      const res = await http(
        ctx.base,
        "POST",
        `/api/evaluations/${batchId}/verify`,
        { step: 1, commit: "fix9999" },
      );
      expect(res.status).toBe(200);
      const next = res.json.next as { body: { commit: string; taskIds: string[] } };
      // Verifying against the ORIGINAL commit would re-measure the defect
      // rather than the fix.
      expect(next.body.commit).toBe("fix9999");
      expect(next.body.taskIds).toEqual(["t1", "t2", "t3"]);
      const criterion = res.json.success_criterion as {
        must_start_passing: string[];
        must_keep_passing: string[];
      };
      expect(criterion.must_start_passing).toEqual(["t1", "t2"]);
      expect(criterion.must_keep_passing).toEqual(["t3"]);
      expect(String((res.json.next as { path: string }).path)).toContain(
        projectId,
      );
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires the commit carrying the fix", async () => {
    const ctx = await boot();
    try {
      const { batchId } = await seedPlan(ctx, "improve-verify-nocommit");
      const res = await http(
        ctx.base,
        "POST",
        `/api/evaluations/${batchId}/verify`,
        { step: 1 },
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("fix");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a step that does not exist", async () => {
    const ctx = await boot();
    try {
      const { batchId } = await seedPlan(ctx, "improve-verify-badstep");
      const res = await http(
        ctx.base,
        "POST",
        `/api/evaluations/${batchId}/verify`,
        { step: 99, commit: "abc" },
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain("99");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// the all-in-one report
// ---------------------------------------------------------------------------

describe("GET /api/evaluations/:id/report — the single output", () => {
  it("serves one document carrying everything, in both forms", async () => {
    const ctx = await boot();
    try {
      const { batchId } = await seedPlan(ctx, "one-report");

      // JSON: what a consuming agent reads.
      const json = await http(
        ctx.base,
        "GET",
        `/api/evaluations/${batchId}/report?format=json`,
      );
      expect(json.status).toBe(200);
      // Everything in one object — no follow-up fetches.
      for (const key of [
        "improvementPlan",
        "subsystemLoad",
        "reliability",
        "rankedDefects",
        "recurringDefects",
        "explainedRegressions",
        "evals",
        "summary",
      ]) {
        expect(json.json).toHaveProperty(key);
      }
      // Each eval carries its own full record.
      const evals = json.json.evals as Array<Record<string, unknown>>;
      expect(evals.length).toBeGreaterThan(0);
      for (const key of ["prompt", "trace", "findings", "artifacts", "status"]) {
        expect(evals[0]!).toHaveProperty(key);
      }

      // HTML: what a person reads — and it embeds the same object, so the two
      // cannot drift apart.
      const html = await fetch(
        `${ctx.base}/api/evaluations/${batchId}/report`,
      );
      expect(html.status).toBe(200);
      const text = await html.text();
      expect(text).toContain("<!DOCTYPE html");
      expect(text).toContain('id="eval-report-data"');
      expect(text).toContain("What to change");
      expect(text).toContain("Every eval, in full");
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("builds the report live when the rollup has not run yet", async () => {
    // A consumer must never be blocked on an artifact that only exists as a
    // side effect of something else having happened first.
    const ctx = await boot();
    try {
      const proj = await http(ctx.base, "POST", "/api/projects", {
        name: "live",
        slug: "one-report-live",
      });
      const projectId = proj.json.id as string;
      const queries = ctx.api.app.queries;
      queries.registerAgent({ id: "a", displayName: "a" });
      const task = queries.createTask(projectId, {
        id: "e1",
        name: "eval one",
        prompt: "do the thing",
        workspace: { source: "empty" },
        agentCategory: "coding",
        rubric: rubric as never,
      });
      const batch = queries.createBatch({
        projectId,
        taskId: task.id,
        agentId: "a",
        model: "m",
        provider: "p",
        repeats: 1,
      });
      queries.createRun({
        batchId: batch.id,
        taskId: task.id,
        projectId,
        agentId: "a",
        model: "m",
        provider: "p",
        repeatIndex: 0,
        status: "completed",
      });

      const res = await http(
        ctx.base,
        "GET",
        `/api/evaluations/${batch.id}/report?format=json`,
      );
      expect(res.status).toBe(200);
      expect((res.json.evals as unknown[]).length).toBe(1);
      expect((res.json.evals as Array<{ prompt: string }>)[0]!.prompt).toBe(
        "do the thing",
      );
    } finally {
      await ctx.api.close();
      rmSync(ctx.dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

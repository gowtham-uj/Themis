/**
 * P6a — fingerprinting + findings ingest + recurrence state machine.
 *
 * Exercises pure fingerprint helpers and the full ingest state machine against
 * a REAL on-disk SQLite DB via openDb(tempDir). No mocks.
 *
 * Spec: plan/data-model.md (findings / finding_occurrences + fingerprint
 * canonicalization); plan/roadmap.md Phase 6.
 *
 * Recurrence path chosen: rewrite verdict.json inside storeVerdict AFTER ingest
 * (same call, single-threaded SQLite) so Finding.recurring is populated for
 * report/API consumers. Also exposed via getFinding + findings tables.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Rubric, TaskSpec } from "../src/domain.ts";
import {
  openDb,
  type OpenDbResult,
  type QueryStore,
} from "../src/db/index.ts";
import {
  fingerprintOf,
  normalizeClaim,
  canonicalLocationOf,
} from "../src/db/findings.ts";
import {
  VERDICT_SCHEMA_VERSION,
  type Finding,
  type MetaFinding,
  type Verdict,
} from "../src/judge/verdict.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenteval-findings-"));
  tempDirs.push(dir);
  return dir;
}

function sampleRubric(): Rubric {
  return {
    version: 1,
    profile: "bugfix",
    criteria: [
      {
        id: "A1",
        axis: "A",
        label: "correctness",
        weight: 1,
        appliesTo: "coding",
        anchors: {
          full: "fully correct",
          partial: "partially correct",
          none: "incorrect",
        },
      },
    ],
  };
}

function sampleTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "ext-task-1",
    name: "Fix the bug",
    prompt: "Please fix the off-by-one error",
    workspace: { source: "empty" },
    rubric: sampleRubric(),
    profile: "bugfix",
    agentCategory: "coding",
    tags: ["smoke"],
    ...overrides,
  };
}

function defectFinding(
  id: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id,
    category: "test_gaming",
    severity: "major",
    confidence: 0.9,
    claim: "agent deleted the failing test",
    refs: [{ kind: "diff", file: "src/auth.ts", hunk: 2 }],
    ...overrides,
  };
}

function baseVerdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    overall: { score: 0.4, verdict: "partial", summary: "partial" },
    criteria: [
      {
        criterion: "A1",
        weight: 1,
        feedback: "reason",
        score: 0.4,
        evidence: ["e"],
        findingIds: [],
      },
    ],
    findings: [],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: { looping: { value: false, note: "none" } },
    attribution: { agent_vs_environment: "agent" },
    observations: [],
    improvements: { summary: "ok", withoutSource: [] },
    ...overrides,
  };
}

interface Fixture {
  queries: QueryStore;
  dataDir: string;
  backend: OpenDbResult["backend"];
  projectId: string;
  taskId: string;
  agentId: string;
}

function seedProject(dataDir: string): Fixture {
  const opened = openDb(dataDir);
  const { queries } = opened;
  const project = queries.createProject({ name: "P", slug: `p-${Date.now()}` });
  const agent = queries.registerAgent({
    id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    displayName: "Test Agent",
  });
  const task = queries.createTask(project.id, sampleTask());
  return {
    queries,
    dataDir,
    backend: opened.backend,
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
  };
}

/** Create a completed run + queued judgement for a task; return ids. */
function newRunAndJudgement(
  fx: Fixture,
  opts: { runId?: string; judgementId?: string } = {},
): { runId: string; judgementId: string } {
  const batch = fx.queries.createBatch({
    taskId: fx.taskId,
    projectId: fx.projectId,
    agentId: fx.agentId,
    model: "test-model",
    provider: "test",
    repeats: 1,
  });
  const run = fx.queries.createRun({
    id: opts.runId,
    batchId: batch.id,
    taskId: fx.taskId,
    projectId: fx.projectId,
    agentId: fx.agentId,
    model: "test-model",
    provider: "test",
    repeatIndex: 0,
    status: "completed",
  });
  const j = fx.queries.createJudgement({
    id: opts.judgementId,
    runId: run.id,
    projectId: fx.projectId,
    judgeModel: "judge-model",
    judgeProvider: "test",
    systemPromptVersion: "v1",
    status: "running",
  });
  return { runId: run.id, judgementId: j.id };
}

// ---------------------------------------------------------------------------
// Pure fingerprint helpers
// ---------------------------------------------------------------------------

describe("fingerprintOf + normalizeClaim (pure)", () => {
  it("is deterministic: same finding → same fingerprint", () => {
    const f: Finding = defectFinding("f1");
    const a = fingerprintOf(f);
    const b = fingerprintOf(f);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.canonicalLocation).toBe(b.canonicalLocation);
    // Manual sha256 check of the material.
    const expected = createHash("sha256")
      .update(`${f.category}:${a.canonicalLocation}`, "utf8")
      .digest("hex");
    expect(a.fingerprint).toBe(expected);
  });

  it("different category → different fingerprint (same location)", () => {
    const a = fingerprintOf(
      defectFinding("f1", { category: "test_gaming" }),
    );
    const b = fingerprintOf(
      defectFinding("f1", { category: "verification_skipped" }),
    );
    expect(a.canonicalLocation).toBe(b.canonicalLocation);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("diff ref takes precedence over tool ref over claim", () => {
    const withAll: Finding = {
      id: "f1",
      category: "test_gaming",
      severity: "major",
      confidence: 0.9,
      claim: "agent deleted the failing test",
      refs: [
        { kind: "trace", runId: "r1", seqs: [1, 2] },
        { kind: "tool", toolCallId: "tc-99" },
        { kind: "diff", file: "./src/auth.ts", hunk: 2 },
      ],
    };
    const diffLoc = fingerprintOf(withAll);
    expect(diffLoc.canonicalLocation).toBe("src/auth.ts@2");

    const toolOnly: Finding = {
      ...withAll,
      refs: [
        { kind: "trace", runId: "r1", seqs: [1, 2] },
        { kind: "tool", toolCallId: "tc-99" },
      ],
    };
    const toolLoc = fingerprintOf(toolOnly);
    expect(toolLoc.canonicalLocation).toBe("tool:tc-99");

    const claimOnly: Finding = {
      ...withAll,
      refs: [{ kind: "trace", runId: "r1", seqs: [1, 2] }],
    };
    const claimLoc = fingerprintOf(claimOnly);
    expect(claimLoc.canonicalLocation).toBe(
      `claim:${normalizeClaim(withAll.claim)}`,
    );

    // All three produce distinct fingerprints.
    expect(new Set([diffLoc.fingerprint, toolLoc.fingerprint, claimLoc.fingerprint]).size).toBe(3);
  });

  it("normalizeClaim collapses whitespace, case, trailing punctuation", () => {
    expect(normalizeClaim("  Hello   World.  ")).toBe("hello world");
    expect(normalizeClaim("FOO;")).toBe("foo");
    expect(normalizeClaim("bar:")).toBe("bar");
    expect(normalizeClaim("  a\t\nb  ")).toBe("a b");
    expect(normalizeClaim("keep.inner.dots.")).toBe("keep.inner.dots");
    // Regression: punctuation with trailing whitespace before it ("x. ; ") must
    // strip to the inner text, not leave a trapped trailing space.
    expect(normalizeClaim("Foo bar.  ; ")).toBe("foo bar");
    expect(normalizeClaim("skipped tests.")).toBe("skipped tests");
    expect(normalizeClaim("skipped tests. ")).toBe("skipped tests");
  });

  // Regression: fingerprints are TASK-SCOPED. The same category + canonical
  // location under TWO DIFFERENT tasks is a distinct finding (the global PK
  // must not collide + silently drop one task's issue from the log).
  it("fingerprint is task-scoped: same finding, two tasks → two fingerprints", () => {
    const f = defectFinding("f1");
    const a = fingerprintOf(f, "task-A");
    const b = fingerprintOf(f, "task-B");
    expect(a.canonicalLocation).toBe(b.canonicalLocation);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(fingerprintOf(f, "task-A").fingerprint).toBe(a.fingerprint); // deterministic
    // Without taskId the fingerprint differs from the task-scoped one.
    expect(fingerprintOf(f).fingerprint).not.toBe(a.fingerprint);
  });

  it("strips leading ./ and normalizes path separators for diff refs", () => {
    expect(
      canonicalLocationOf({
        claim: "x",
        refs: [{ kind: "diff", file: ".\\src\\auth.ts", hunk: 3 }],
      }),
    ).toBe("src/auth.ts@3");
  });
});

// ---------------------------------------------------------------------------
// Ingest state machine against real SQLite
// ---------------------------------------------------------------------------

describe("findings ingest state machine (real DB)", () => {
  it("opens against sqlite (or documents memory fallback)", async () => {
    const dataDir = await tempDataDir();
    const fx = seedProject(dataDir);
    // Prefer sqlite; memory is acceptable but the contract is "real on-disk SQLite".
    // eslint-disable-next-line no-console
    console.log(`[findings.test] backend=${fx.backend}`);
    expect(["sqlite", "memory"]).toContain(fx.backend);
  });

  it("two judgements of same task with identical finding → 1 row, count=2, statuses introduced/persisted", async () => {
    const fx = seedProject(await tempDataDir());
    const finding = defectFinding("f1");
    const v1 = baseVerdict({
      findings: [finding],
      criteria: [
        {
          criterion: "A1",
          weight: 1,
          feedback: "r",
          score: 0.4,
          evidence: [],
          findingIds: ["f1"],
        },
      ],
    });
    const v2 = baseVerdict({
      findings: [{ ...finding, id: "f1b", confidence: 0.95 }],
      criteria: [
        {
          criterion: "A1",
          weight: 1,
          feedback: "r",
          score: 0.4,
          evidence: [],
          findingIds: ["f1b"],
        },
      ],
    });

    const j1 = newRunAndJudgement(fx, { runId: "run-1", judgementId: "j-1" });
    fx.queries.storeVerdict(j1.judgementId, v1);

    const { fingerprint } = fingerprintOf(finding, fx.taskId);
    let rows = fx.queries.listFindings({ taskId: fx.taskId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fingerprint).toBe(fingerprint);
    expect(rows[0]!.occurrenceCount).toBe(1);
    expect(rows[0]!.status).toBe("open");
    expect(rows[0]!.kind).toBe("defect");

    let occ = fx.queries.listOccurrences(fingerprint);
    expect(occ).toHaveLength(1);
    expect(occ[0]!.status).toBe("introduced");
    expect(occ[0]!.judgementId).toBe(j1.judgementId);

    const j2 = newRunAndJudgement(fx, { runId: "run-2", judgementId: "j-2" });
    fx.queries.storeVerdict(j2.judgementId, v2);

    rows = fx.queries.listFindings({ taskId: fx.taskId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
    expect(rows[0]!.lastSeenJudgement).toBe(j2.judgementId);
    expect(rows[0]!.firstSeenJudgement).toBe(j1.judgementId);
    expect(rows[0]!.latestConfidence).toBe(0.95);
    expect(rows[0]!.status).toBe("open");

    occ = fx.queries.listOccurrences(fingerprint);
    expect(occ).toHaveLength(2);
    const byJ = Object.fromEntries(occ.map((o) => [o.judgementId, o]));
    expect(byJ[j1.judgementId]!.status).toBe("introduced");
    expect(byJ[j2.judgementId]!.status).toBe("persisted");
  });

  it("brand-new finding in 2nd judgement is introduced", async () => {
    const fx = seedProject(await tempDataDir());
    const f1 = defectFinding("f1");
    const f2 = defectFinding("f2", {
      category: "verification_skipped",
      claim: "suite never ran",
      refs: [{ kind: "diff", file: "src/main.ts", hunk: 1 }],
    });

    const j1 = newRunAndJudgement(fx);
    fx.queries.storeVerdict(
      j1.judgementId,
      baseVerdict({
        findings: [f1],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["f1"],
          },
        ],
      }),
    );

    const j2 = newRunAndJudgement(fx);
    fx.queries.storeVerdict(
      j2.judgementId,
      baseVerdict({
        findings: [f1, f2],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.3,
            evidence: [],
            findingIds: ["f1", "f2"],
          },
        ],
      }),
    );

    const rows = fx.queries.listFindings({ taskId: fx.taskId });
    expect(rows).toHaveLength(2);
    const fp2 = fingerprintOf(f2, fx.taskId).fingerprint;
    const r2 = rows.find((r) => r.fingerprint === fp2)!;
    expect(r2.occurrenceCount).toBe(1);
    expect(r2.status).toBe("open");
    const occ2 = fx.queries.listOccurrences(fp2);
    expect(occ2).toHaveLength(1);
    expect(occ2[0]!.status).toBe("introduced");
  });

  it("finding present in 1st but absent in 2nd → open→resolved (defect only)", async () => {
    const fx = seedProject(await tempDataDir());
    const f1 = defectFinding("f1");
    const j1 = newRunAndJudgement(fx);
    fx.queries.storeVerdict(
      j1.judgementId,
      baseVerdict({
        findings: [f1],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["f1"],
          },
        ],
      }),
    );

    const j2 = newRunAndJudgement(fx);
    // Empty findings — f1 should resolve.
    fx.queries.storeVerdict(j2.judgementId, baseVerdict());

    const fp = fingerprintOf(f1, fx.taskId).fingerprint;
    const row = fx.queries.getFinding(fp);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("resolved");
    expect(row!.resolvedAt).toBeTruthy();
    // occurrenceCount stays at 1 (no new occurrence written for the resolved mark).
    expect(row!.occurrenceCount).toBe(1);
  });

  it("resolved finding reappearing in 3rd judgement → regressed, count++, resolvedAt cleared", async () => {
    const fx = seedProject(await tempDataDir());
    const f1 = defectFinding("f1");
    const fp = fingerprintOf(f1, fx.taskId).fingerprint;

    const j1 = newRunAndJudgement(fx, { runId: "run-a" });
    fx.queries.storeVerdict(
      j1.judgementId,
      baseVerdict({
        findings: [f1],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["f1"],
          },
        ],
      }),
    );

    const j2 = newRunAndJudgement(fx, { runId: "run-b" });
    fx.queries.storeVerdict(j2.judgementId, baseVerdict()); // resolves f1

    let row = fx.queries.getFinding(fp)!;
    expect(row.status).toBe("resolved");
    expect(row.resolvedAt).toBeTruthy();

    const j3 = newRunAndJudgement(fx, { runId: "run-c" });
    fx.queries.storeVerdict(
      j3.judgementId,
      baseVerdict({
        findings: [{ ...f1, id: "f1-again" }],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.3,
            evidence: [],
            findingIds: ["f1-again"],
          },
        ],
      }),
    );

    row = fx.queries.getFinding(fp)!;
    expect(row.status).toBe("regressed");
    expect(row.resolvedAt).toBeNull();
    expect(row.occurrenceCount).toBe(2);
    expect(row.lastSeenJudgement).toBe(j3.judgementId);

    const occ = fx.queries.listOccurrences(fp);
    const last = occ.find((o) => o.judgementId === j3.judgementId)!;
    expect(last.status).toBe("persisted");
  });

  it("positiveFindings + metaFindings ingested with correct kinds; meta NOT auto-resolved", async () => {
    const fx = seedProject(await tempDataDir());
    const pos: Finding = {
      id: "p1",
      category: "good_verification",
      severity: "nit",
      confidence: 0.8,
      claim: "agent ran the full suite",
      refs: [{ kind: "trace", runId: "r1", seqs: [10, 20] }],
    };
    const meta: MetaFinding = {
      id: "m1",
      category: "prompt_ambiguous",
      claim: "task prompt does not define success criteria",
    };

    const j1 = newRunAndJudgement(fx);
    fx.queries.storeVerdict(
      j1.judgementId,
      baseVerdict({
        positiveFindings: [pos],
        metaFindings: [meta],
      }),
    );

    const rows = fx.queries.listFindings({ projectId: fx.projectId });
    expect(rows).toHaveLength(2);
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["positive", "meta"]));

    const posFp = fingerprintOf(pos, fx.taskId).fingerprint;
    const metaFp = fingerprintOf({
      category: meta.category,
      claim: meta.claim,
      refs: [],
    }, fx.taskId).fingerprint;

    // 2nd judgement with neither → positive resolves; meta stays open.
    const j2 = newRunAndJudgement(fx);
    fx.queries.storeVerdict(j2.judgementId, baseVerdict());

    const posRow = fx.queries.getFinding(posFp)!;
    expect(posRow.status).toBe("resolved");

    const metaRow = fx.queries.getFinding(metaFp)!;
    expect(metaRow.status).toBe("open");
    expect(metaRow.resolvedAt).toBeNull();
    expect(metaRow.kind).toBe("meta");
  });

  it("storeVerdict hook: 2 findings → listFindings returns 2; error isolation keeps verdict", async () => {
    const fx = seedProject(await tempDataDir());
    const f1 = defectFinding("f1");
    const f2 = defectFinding("f2", {
      category: "root_cause_missed",
      claim: "fixed the symptom not the cause",
      refs: [{ kind: "diff", file: "src/db.ts", hunk: 5 }],
    });

    const j1 = newRunAndJudgement(fx);
    const stored = fx.queries.storeVerdict(
      j1.judgementId,
      baseVerdict({
        findings: [f1, f2],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.2,
            evidence: [],
            findingIds: ["f1", "f2"],
          },
        ],
      }),
    );

    expect(stored.status).toBe("completed");
    expect(stored.verdictBody).not.toBeNull();
    const listed = fx.queries.listFindings({ projectId: fx.projectId });
    expect(listed).toHaveLength(2);

    // Error isolation: force ingest to throw by deleting the run's taskId path.
    // We simulate by calling storeVerdict on a judgement whose run was never
    // created properly — create a judgement with a fake runId that has no run.
    // createJudgement requires an existing run in sqlite (FK). Instead, monkey
    // with asFindingsStore by forcing ingestFindings to throw via a broken
    // verdict that still writes scores: wrap by temporarily replacing method.
    const j2 = newRunAndJudgement(fx);
    const original = fx.queries.ingestFindings.bind(fx.queries);
    let threw = false;
    fx.queries.ingestFindings = () => {
      threw = true;
      throw new Error("forced ingest failure");
    };
    try {
      const stillOk = fx.queries.storeVerdict(
        j2.judgementId,
        baseVerdict({ overall: { score: 0.99, verdict: "pass", summary: "ok" } }),
      );
      expect(threw).toBe(true);
      expect(stillOk.status).toBe("completed");
      expect(stillOk.overallScore).toBe(0.99);
      // verdict.json must exist and be readable.
      const reloaded = fx.queries.getJudgement(j2.judgementId);
      expect(reloaded?.verdictBody?.overall.score).toBe(0.99);
    } finally {
      fx.queries.ingestFindings = original;
    }
  });

  it("recurrence: after 2nd persisted occurrence, getFinding has count=2 and verdict.json has recurring", async () => {
    const fx = seedProject(await tempDataDir());
    const f1 = defectFinding("f1");
    const fp = fingerprintOf(f1, fx.taskId).fingerprint;

    const j1 = newRunAndJudgement(fx, { runId: "run-first" });
    fx.queries.storeVerdict(
      j1.judgementId,
      baseVerdict({
        findings: [f1],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["f1"],
          },
        ],
      }),
    );

    // First occurrence has no recurring annotation.
    const body1 = fx.queries.getJudgement(j1.judgementId)?.verdictBody;
    expect(body1?.findings[0]?.recurring).toBeUndefined();

    const j2 = newRunAndJudgement(fx, { runId: "run-second" });
    fx.queries.storeVerdict(
      j2.judgementId,
      baseVerdict({
        findings: [{ ...f1, id: "f1-again" }],
        criteria: [
          {
            criterion: "A1",
            weight: 1,
            feedback: "r",
            score: 0.4,
            evidence: [],
            findingIds: ["f1-again"],
          },
        ],
      }),
    );

    const detail = fx.queries.getFinding(fp)!;
    expect(detail.occurrenceCount).toBe(2);
    expect(detail.occurrences).toHaveLength(2);

    // Path chosen: rewrite verdict.json with recurring inside storeVerdict.
    const body2 = fx.queries.getJudgement(j2.judgementId)?.verdictBody;
    expect(body2?.findings[0]?.recurring).toEqual({
      firstSeenRun: "run-first",
      lastSeenRun: "run-second",
      count: 2,
    });

    // Also verify the on-disk file itself.
    const jRow = fx.queries.getJudgement(j2.judgementId)!;
    expect(jRow.verdictPath).toBeTruthy();
    const disk = JSON.parse(
      await readFile(jRow.verdictPath!, "utf8"),
    ) as Verdict;
    expect(disk.findings[0]?.recurring?.count).toBe(2);
  });

  // Regression (orchestrator QC): same finding ingested under TWO DIFFERENT tasks
  // of one project must NOT collide on the global fingerprint PK — each task gets
  // its own findings row; neither is silently dropped. The verifier's only flagged
  // finding was that the spec-sketched formula excluded taskId, causing a silent
  // drop. Task-scoped fingerprints fix this.
  it("cross-task: identical finding under two tasks yields two rows, no silent drop", async () => {
    const fx = seedProject(await tempDataDir());
    // Create a second task in the same project (distinct external id so it
    // doesn't collide on tasks.project_id,external_id).
    const task2 = fx.queries.createTask(fx.projectId, sampleTask({ id: "ext-task-2" }));

    const f = defectFinding("f1");
    const v = baseVerdict({
      findings: [f],
      criteria: [{ criterion: "A1", weight: 1, feedback: "r", score: 0.4, evidence: [], findingIds: ["f1"] }],
    });

    const j1 = newRunAndJudgement(fx, { runId: "run-t1", judgementId: "j-t1" });
    fx.queries.storeVerdict(j1.judgementId, v);

    // Second judgement under a different task. Reuse the project's agent; build a
    // run for task2.
    const batch2 = fx.queries.createBatch({
      taskId: task2.id, projectId: fx.projectId, agentId: fx.agentId,
      model: "test-model", provider: "test", repeats: 1,
    });
    fx.queries.createRun({
      id: "run-t2", batchId: batch2.id, taskId: task2.id, projectId: fx.projectId,
      agentId: fx.agentId, model: "test-model", provider: "test", repeatIndex: 0,
      status: "completed", startedAt: "2026-08-06T00:00:00Z", triggeredBy: "manual",
    });
    const j2 = fx.queries.createJudgement({
      runId: "run-t2", projectId: fx.projectId, judgeModel: "fake",
      judgeProvider: "fake", systemPromptVersion: "v2", status: "queued",
    });
    fx.queries.storeVerdict(j2.id, v);

    const all = fx.queries.listFindings({ projectId: fx.projectId });
    expect(all).toHaveLength(2);
    const t1Rows = all.filter((r) => r.taskId === fx.taskId);
    const t2Rows = all.filter((r) => r.taskId === task2.id);
    expect(t1Rows).toHaveLength(1);
    expect(t2Rows).toHaveLength(1); // NOT silently dropped
    expect(t1Rows[0]!.fingerprint).not.toBe(t2Rows[0]!.fingerprint);
    expect(t1Rows[0]!.occurrenceCount).toBe(1);
    expect(t2Rows[0]!.occurrenceCount).toBe(1);
  });
});

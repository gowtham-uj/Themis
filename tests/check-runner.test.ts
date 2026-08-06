/**
 * P9 deterministic check-runner + check-results folding (plan/rubric.md §5 + §7).
 *
 * The build shipped check-runner.ts + check-results.ts untested (verifier
 * flagged the gap). This pins:
 *  - runChecks execs each Check via ContainerRuntime (NEVER inline docker),
 *    exit 0→pass / nonzero→fail, unknown kind→skipped, timeout→error.
 *  - runChecks persists checks.json (loadCheckResults round-trips) + DB mirror
 *    via storeCheckResults when present (best-effort, never throws).
 *  - secret_scan REDACTS the secret value (never echoes ANTHROPIC_AUTH_TOKEN=...).
 *  - computePassRates: pass / (pass+fail+error); skipped excluded; per-kind.
 *  - foldCheckResultsIntoVerdict: passed check grounds score ≥0.9; failed check
 *    surfaces a finding (does NOT auto-lower the score); orphan failed checks
 *    surface findings; verdict.checkResults + passRates attached; input not
 *    mutated; criterion.checkId linkage via the rubric.
 *
 * The runtime seam is a canned test-double implementing ContainerRuntime so the
 * container-exec path is verifiable without docker (CLAUDE.md constraint).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKS_ARTIFACT,
  runChecks,
  loadCheckResults,
  type CheckProject,
} from "../src/runner/check-runner.ts";
import {
  computePassRates,
  foldCheckResultsIntoVerdict,
  GROUNDED_PASS_SCORE,
  resolveTaskChecks,
} from "../src/judge/check-results.ts";
import type {
  ContainerHandle,
  ContainerRuntime,
  RunContainerSpec,
} from "../src/runner/runtime.ts";
import type { Check, Rubric } from "../src/domain.ts";
import type { CheckResult, Verdict, CriterionVerdict } from "../src/judge/verdict.ts";

// ---------------------------------------------------------------------------
// Canned ContainerRuntime: records the command, returns a configured exit code
// + stdout/stderr stream. The check-runner resolves the command template into
// argv ["/bin/sh","-c",<command>], so we key on argv[2].
// ---------------------------------------------------------------------------

interface CannedOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

class CannedRuntime implements ContainerRuntime {
  readonly calls: RunContainerSpec[] = [];
  private readonly byCommand: Map<string, CannedOutcome>;
  private defaultOutcome: CannedOutcome;
  readonly defaultRun = Promise.resolve({ exitCode: 0, timedOut: false });

  constructor(opts: Record<string, CannedOutcome> = {}, defaultOutcome: CannedOutcome = { exitCode: 0 }) {
    this.byCommand = new Map(Object.entries(opts));
    this.defaultOutcome = defaultOutcome;
  }

  run(spec: RunContainerSpec): Promise<ContainerHandle> {
    this.calls.push(spec);
    const command = spec.argv[2] ?? "";
    const outcome = this.byCommand.get(command) ?? this.defaultOutcome;
    return Promise.resolve(new CannedHandle(spec, outcome));
  }
}

class CannedHandle implements ContainerHandle {
  readonly id = "canned";
  readonly image: string;
  private readonly out: CannedOutcome;
  private stdoutBuf: Buffer;
  private stderrBuf: Buffer;

  constructor(spec: RunContainerSpec, outcome: CannedOutcome) {
    this.image = spec.image;
    this.out = outcome;
    this.stdoutBuf = Buffer.from(outcome.stdout ?? "");
    this.stderrBuf = Buffer.from(outcome.stderr ?? "");
  }

  pause(): Promise<void> { return Promise.resolve(); }
  resume(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  stdout(): AsyncIterable<Buffer> { return bufferIterable(this.stdoutBuf); }
  stderr(): AsyncIterable<Buffer> { return bufferIterable(this.stderrBuf); }
  wait(): Promise<{ exitCode: number; timedOut: boolean }> {
    return Promise.resolve({ exitCode: this.out.exitCode, timedOut: !!this.out.timedOut });
  }
  remove(): Promise<void> { return Promise.resolve(); }
}

async function* bufferIterable(buf: Buffer): AsyncIterable<Buffer> {
  if (buf.length > 0) yield buf;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "agenteval-checks-"));
}

function check(id: string, kind: Check["kind"], command?: string): Check {
  const c: Check = { id, kind };
  if (command !== undefined) c.command = command;
  return c;
}

function project(checkRunners?: Record<string, string>): CheckProject {
  return { id: "p1", checkRunners: checkRunners ?? null };
}

function makeVerdict(criterionId: string, score: number): Verdict {
  const cv: CriterionVerdict = {
    criterion: criterionId,
    weight: 1,
    feedback: "original feedback",
    score,
    evidence: [],
    findingIds: [],
  };
  return {
    schemaVersion: 1 as never,
    overall: { score, verdict: "partial", summary: "s" },
    criteria: [cv],
    findings: [],
    positiveFindings: [],
    metaFindings: [],
    diagnostics: {},
    attribution: { agent_vs_environment: "agent" },
    observations: [],
    improvements: { withoutSource: "x", withSource: null },
  } as unknown as Verdict;
}

// ---------------------------------------------------------------------------
// runChecks
// ---------------------------------------------------------------------------

describe("runChecks", () => {
  it("exit 0 → pass, exit 1 → fail, via ContainerRuntime (never inline docker)", async () => {
    const dir = tmpRunDir();
    try {
      const runtime = new CannedRuntime({
        "npm test": { exitCode: 0, stdout: "all good" },
        "tsc --noEmit": { exitCode: 1, stderr: "type error" },
      });
      const task = {
        rubric: {
          version: 1,
          profile: "bugfix",
          criteria: [],
          checks: [
            check("tests", "test_suite", "npm test"),
            check("types", "typecheck", "tsc --noEmit"),
          ],
        },
      };
      const results = await runChecks(null, runtime, project(), task, dir);
      expect(results).toHaveLength(2);
      const tests = results.find((r) => r.checkId === "tests")!;
      const types = results.find((r) => r.checkId === "types")!;
      expect(tests.status).toBe("pass");
      expect(tests.exitCode).toBe(0);
      expect(tests.detail).toMatch(/good/);
      expect(types.status).toBe("fail");
      expect(types.exitCode).toBe(1);
      expect(types.detail).toMatch(/exit 1/);
      // Runtime was the exec seam — argv[2] is the resolved command.
      expect(runtime.calls.every((c) => c.argv[0] === "/bin/sh")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("timeout → error status + timedOut detail", async () => {
    const dir = tmpRunDir();
    try {
      const runtime = new CannedRuntime(
        { "sleep 60": { exitCode: 124, timedOut: true } },
      );
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [check("t", "command", "sleep 60")],
        },
      };
      const results = await runChecks(null, runtime, project(), task, dir, {
        timeoutMs: 50,
      });
      expect(results[0]!.status).toBe("error");
      expect(results[0]!.detail).toMatch(/timed out/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("check with no command + no runner template → skipped", async () => {
    const dir = tmpRunDir();
    try {
      const runtime = new CannedRuntime({}, { exitCode: 0 });
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [check("nocommand", "lint")], // no command, no runners
        },
      };
      const results = await runChecks(null, runtime, project(), task, dir);
      expect(results[0]!.status).toBe("skipped");
      expect(results[0]!.detail).toMatch(/no command template/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project.checkRunners templates the command (check.command overrides)", async () => {
    const dir = tmpRunDir();
    try {
      const runtime = new CannedRuntime({
        "vitest run": { exitCode: 0 }, // from runner template
        "my-check": { exitCode: 0 }, // from override
      });
      const runners = { test_suite: "vitest run", lint: "eslint ." };
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [
            check("fromTemplate", "test_suite"), // uses runners[test_suite]
            check("overridden", "lint", "my-check"), // command wins
          ],
        },
      };
      await runChecks(null, runtime, project(runners), task, dir);
      const commands = runtime.calls.map((c) => c.argv[2]);
      expect(commands).toContain("vitest run");
      expect(commands).toContain("my-check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("task with no checks → runChecks no-ops (returns [])", async () => {
    const dir = tmpRunDir();
    try {
      const runtime = new CannedRuntime({}, { exitCode: 0 });
      const results = await runChecks(null, runtime, project(), { rubric: { version: 1, profile: "bugfix", criteria: [] } }, dir);
      expect(results).toEqual([]);
      expect(runtime.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes checks.json + loadCheckResults round-trips", async () => {
    const dir = tmpRunDir();
    try {
      const runtime = new CannedRuntime({ "npm test": { exitCode: 0 } });
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [check("t", "test_suite", "npm test")],
        },
      };
      const results = await runChecks(null, runtime, project(), task, dir);
      const loaded = await loadCheckResults(dir);
      expect(loaded).toEqual(results);
      // Artifacts under runDir — checks.json present.
      const fs = await import("node:fs/promises");
      const stat = await fs.stat(join(dir, CHECKS_ARTIFACT));
      expect(stat.isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists via queries.storeCheckResults when present (best-effort)", async () => {
    const dir = tmpRunDir();
    try {
      let storedRunId: string | null = null;
      let storedResults: CheckResult[] | null = null;
      const store = {
        storeCheckResults(runId: string, results: CheckResult[]) {
          storedRunId = runId;
          storedResults = results;
        },
      };
      const runtime = new CannedRuntime({ "npm test": { exitCode: 0 } });
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [check("t", "test_suite", "npm test")],
        },
      };
      await runChecks(store, runtime, project(), task, dir, { runId: "run-123" });
      expect(storedRunId).toBe("run-123");
      expect(storedResults).toHaveLength(1);
      expect(storedResults![0]!.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("secret_scan REDACTS the secret value — never echoes ANTHROPIC_AUTH_TOKEN=...", async () => {
    const dir = tmpRunDir();
    try {
      // Secret leaked into the workspace output.
      writeFileSync(
        join(dir, "leak.env"),
        "ANTHROPIC_AUTH_TOKEN=sk-ant-supersecretvalue123\nOTHER=ok\n",
      );
      const runtime = new CannedRuntime({}, { exitCode: 0 }); // not used for secret_scan
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [check("secrets", "secret_scan")],
        },
      };
      const results = await runChecks(null, runtime, project(), task, dir);
      const secret = results[0]!;
      expect(secret.status).toBe("fail");
      // The detail MUST contain the file:line but NEVER the plaintext token.
      expect(secret.detail).toMatch(/leak\.env:1/);
      expect(secret.detail).not.toMatch(/sk-ant-supersecretvalue123/);
      expect(secret.detail).not.toMatch(/ANTHROPIC_AUTH_TOKEN=sk-ant/);
      expect(secret.detail).toMatch(/redact|ANTHROPIC_AUTH_TOKEN/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("secret_scan passes when workspace is clean", async () => {
    const dir = tmpRunDir();
    try {
      writeFileSync(join(dir, "clean.txt"), "just normal code\n");
      const runtime = new CannedRuntime({}, { exitCode: 0 });
      const task = {
        rubric: {
          version: 1, profile: "bugfix", criteria: [],
          checks: [check("secrets", "secret_scan")],
        },
      };
      const results = await runChecks(null, runtime, project(), task, dir);
      expect(results[0]!.status).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// computePassRates
// ---------------------------------------------------------------------------

describe("computePassRates", () => {
  const results = (specs: Array<[string, Check["kind"], CheckResult["status"]]>): CheckResult[] =>
    specs.map(([id, kind, status]) => ({ checkId: id, kind, status }));

  it("counts pass / (pass+fail+error); skipped excluded", () => {
    const rates = computePassRates(
      results([
        ["a", "test_suite", "pass"],
        ["b", "test_suite", "fail"],
        ["c", "lint", "error"],
        ["d", "lint", "skipped"],
      ]),
    );
    expect(rates.overall).toEqual({ passed: 1, total: 3, rate: 1 / 3 });
  });

  it("per-kind buckets isolate kinds", () => {
    const rates = computePassRates(
      results([
        ["a", "test_suite", "pass"],
        ["b", "test_suite", "pass"],
        ["c", "lint", "fail"],
      ]),
    );
    expect(rates.perKind["test_suite"]).toEqual({ passed: 2, total: 2 });
    expect(rates.perKind["lint"]).toEqual({ passed: 0, total: 1 });
  });

  it("empty → rate 0, no perKind entries", () => {
    const rates = computePassRates([]);
    expect(rates.overall).toEqual({ passed: 0, total: 0, rate: 0 });
    expect(Object.keys(rates.perKind)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// foldCheckResultsIntoVerdict
// ---------------------------------------------------------------------------

describe("foldCheckResultsIntoVerdict", () => {
  it("passed check grounds the linked criterion score to ≥ GROUNDED_PASS_SCORE", () => {
    const verdict = makeVerdict("C1", 0.4);
    const rubric = {
      version: 1, profile: "bugfix",
      criteria: [{ id: "C1", checkId: "chk1" }],
      checks: [],
    } as unknown as Rubric;
    const folded = foldCheckResultsIntoVerdict(
      verdict,
      [{ checkId: "chk1", kind: "test_suite", status: "pass" }],
      rubric,
    );
    const cv = folded.criteria[0]!;
    expect(cv.score).toBeGreaterThanOrEqual(GROUNDED_PASS_SCORE);
    expect(cv.feedback).toMatch(/\[check:chk1:pass\]/);
    expect(cv.evidence.some((e) => e.includes("[check:chk1]"))).toBe(true);
  });

  it("grounded score does not lower an already-high score", () => {
    const verdict = makeVerdict("C1", 0.99);
    const rubric = {
      version: 1, profile: "bugfix",
      criteria: [{ id: "C1", checkId: "chk1" }], checks: [],
    } as unknown as Rubric;
    const folded = foldCheckResultsIntoVerdict(
      verdict,
      [{ checkId: "chk1", kind: "test_suite", status: "pass" }],
      rubric,
    );
    expect(folded.criteria[0]!.score).toBe(0.99);
  });

  it("failed check surfaces a finding but does NOT auto-lower the criterion score", () => {
    const verdict = makeVerdict("C1", 0.7);
    const rubric = {
      version: 1, profile: "bugfix",
      criteria: [{ id: "C1", checkId: "chk1" }], checks: [],
    } as unknown as Rubric;
    const folded = foldCheckResultsIntoVerdict(
      verdict,
      [{ checkId: "chk1", kind: "lint", status: "fail", detail: "unused var" }],
      rubric,
    );
    // Score unchanged — judge reconciles, not the check-runner.
    expect(folded.criteria[0]!.score).toBe(0.7);
    const finding = folded.findings.find((f) => f.id === "check_fail:chk1");
    expect(finding).toBeDefined();
    expect(finding!.category).toBe("check_failed");
    expect(finding!.severity).toBe("major");
    expect(finding!.refs.length).toBeGreaterThan(0); // ≥1 structured ref
    expect(folded.criteria[0]!.findingIds).toContain("check_fail:chk1");
  });

  it("orphan failed check (no criterion linkage) still surfaces a finding", () => {
    const verdict = makeVerdict("C1", 0.5);
    const folded = foldCheckResultsIntoVerdict(
      verdict,
      [{ checkId: "orphan", kind: "build", status: "error" }],
      undefined, // no rubric → no linkage
    );
    expect(folded.findings.find((f) => f.id === "check_error:orphan")).toBeDefined();
  });

  it("attaches checkResults + passRates without clobbering verdict fields", () => {
    const verdict = makeVerdict("C1", 0.5);
    const folded = foldCheckResultsIntoVerdict(
      verdict,
      [{ checkId: "x", kind: "test_suite", status: "pass" }],
    );
    expect(folded.checkResults).toHaveLength(1);
    expect(folded.passRates?.overall.rate).toBe(1);
    // Untouched fields survive.
    expect(folded.overall).toBe(verdict.overall);
    expect(folded.attribution).toBe(verdict.attribution);
  });

  it("does not mutate the input verdict", () => {
    const verdict = makeVerdict("C1", 0.5);
    const originalScore = verdict.criteria[0]!.score;
    const originalFindingsLen = verdict.findings.length;
    const rubric = {
      version: 1, profile: "bugfix",
      criteria: [{ id: "C1", checkId: "chk1" }], checks: [],
    } as unknown as Rubric;
    foldCheckResultsIntoVerdict(
      verdict,
      [{ checkId: "chk1", kind: "lint", status: "fail" }],
      rubric,
    );
    expect(verdict.criteria[0]!.score).toBe(originalScore);
    expect(verdict.findings).toHaveLength(originalFindingsLen);
  });

  it("checkId linkage uses rubric.criteria[].checkId (not task.checks)", () => {
    const verdict = makeVerdict("C1", 0.5);
    const rubric = {
      version: 1, profile: "bugfix",
      criteria: [{ id: "C1", checkId: "linked" }], checks: [],
    } as unknown as Rubric;
    const folded = foldCheckResultsIntoVerdict(
      verdict,
      [
        { checkId: "linked", kind: "test_suite", status: "pass" },
        { checkId: "unlinked", kind: "lint", status: "fail" },
      ],
      rubric,
    );
    expect(folded.criteria[0]!.score).toBeGreaterThanOrEqual(GROUNDED_PASS_SCORE);
    expect(folded.findings.find((f) => f.id === "check_fail:unlinked")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolveTaskChecks
// ---------------------------------------------------------------------------

describe("resolveTaskChecks", () => {
  it("task.checks wins over rubric.checks", () => {
    const checks = resolveTaskChecks({
      checks: [{ id: "tc", kind: "lint" }],
      rubric: { version: 1, profile: "bugfix", criteria: [], checks: [{ id: "rc", kind: "build" }] },
    });
    expect(checks.map((c) => c.id)).toEqual(["tc"]);
  });

  it("falls back to rubric.checks when task.checks absent", () => {
    const checks = resolveTaskChecks({
      rubric: { version: 1, profile: "bugfix", criteria: [], checks: [{ id: "rc", kind: "build" }] },
    });
    expect(checks.map((c) => c.id)).toEqual(["rc"]);
  });

  it("empty when neither present", () => {
    expect(resolveTaskChecks({})).toEqual([]);
  });

  it("drops malformed check entries (missing id/kind)", () => {
    const checks = resolveTaskChecks({
      checks: [
        { id: "ok", kind: "lint" },
        { id: "noKind" }, // malformed
        { kind: "noId" }, // malformed
        { id: "ok2", kind: "build" },
      ],
    });
    expect(checks.map((c) => c.id).sort()).toEqual(["ok", "ok2"]);
  });
});

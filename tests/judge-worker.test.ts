/**
 * Judge worker tests — offline via FakeJudgeProvider.
 *
 * Covers: happy path (validated verdict + judge.jsonl), no-source lens gate,
 * bad-verdict rejection (no invalid verdict.json), extractJsonObject robustness,
 * and fixture self-validation.
 */
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeJudgeProvider } from "../src/judge/fake-provider.ts";
import {
  assembleJudgeSystemPrompt,
  assembleJudgeUserPrompt,
  JUDGE_SYSTEM_PROMPT_VERSION,
} from "../src/judge/prompt.ts";
import { extractJsonObject } from "../src/judge/provider.ts";
import { judgeRun } from "../src/judge/worker.ts";
import {
  validateVerdict,
  type Verdict,
} from "../src/judge/verdict.ts";
import { readJsonl } from "../src/schema/jsonl.ts";

const FIXTURE = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "fixtures/verdict-sample.json",
);

const SAMPLE_RUBRIC = {
  profile: "bugfix" as const,
  version: 1,
  criteria: [
    {
      id: "A1",
      axis: "A" as const,
      label: "Outcome",
      weight: 0.5,
      critical: true,
      appliesTo: "coding" as const,
      anchors: {
        full: "fully fixed",
        partial: "partially fixed",
        none: "not fixed",
      },
    },
    {
      id: "D1",
      axis: "D" as const,
      label: "Verification",
      weight: 0.5,
      appliesTo: "both" as const,
      anchors: {
        full: "ran suite",
        partial: "partial verify",
        none: "no verify",
      },
    },
  ],
};

async function seedRunDir(
  root: string,
  opts: { projectId?: string; runId?: string; withDiff?: boolean } = {},
): Promise<{ runDir: string; dataDir: string; projectId: string; runId: string }> {
  const projectId = opts.projectId ?? "proj-test";
  const runId = opts.runId ?? "run-sample-001";
  const dataDir = root;
  const runDir = join(dataDir, "projects", projectId, "runs", runId);
  await mkdir(runDir, { recursive: true });

  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify(
      {
        runId,
        agent: "pi",
        model: "test-model",
        provider: "anthropic",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );

  const events = [
    {
      v: 1,
      runId,
      seq: 0,
      ts: "2026-01-01T00:00:00.000Z",
      type: "run.start",
      agent: "pi",
      model: "test-model",
      provider: "anthropic",
      workspace: { source: "empty" },
      params: {},
    },
    {
      v: 1,
      runId,
      seq: 1,
      ts: "2026-01-01T00:00:01.000Z",
      type: "message",
      turn: 1,
      mode: "full",
      text: "I will fix the auth bug.",
    },
    {
      v: 1,
      runId,
      seq: 2,
      ts: "2026-01-01T00:00:02.000Z",
      type: "tool.call",
      turn: 1,
      id: "call_read_auth_1",
      name: "read",
      args: { path: "src/auth.ts" },
    },
    {
      v: 1,
      runId,
      seq: 3,
      ts: "2026-01-01T00:00:03.000Z",
      type: "message",
      turn: 1,
      mode: "full",
      text: "tests pass",
    },
    {
      v: 1,
      runId,
      seq: 4,
      ts: "2026-01-01T00:00:04.000Z",
      type: "run.end",
      status: "completed",
      durationMs: 4000,
    },
  ];
  await writeFile(
    join(runDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );

  if (opts.withDiff !== false) {
    await writeFile(
      join(runDir, "diff.patch"),
      `diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,7 +10,7 @@\n-  if (token.length < 8) return 401;\n+  if (token.length <= 8) return 401;\n`,
      "utf8",
    );
  }

  return { runDir, dataDir, projectId, runId };
}

describe("verdict-sample fixture", () => {
  it("passes validateVerdict with hasSourceArtifacts:true", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const v = JSON.parse(raw) as Verdict;
    expect(() => validateVerdict(v, { hasSourceArtifacts: true })).not.toThrow();
    expect(v.findings.length).toBeGreaterThanOrEqual(2);
    expect(v.improvements.withSource).toBeDefined();
    expect(v.improvements.withoutSource.length).toBeGreaterThan(0);
  });
});

describe("extractJsonObject", () => {
  it("parses bare JSON", () => {
    const obj = { a: 1 };
    expect(JSON.parse(extractJsonObject(JSON.stringify(obj)))).toEqual(obj);
  });

  it("strips ```json fences and surrounding prose", () => {
    const inner = { schemaVersion: 1, overall: { score: 0.5 } };
    const text = `Here is the verdict:\n\n\`\`\`json\n${JSON.stringify(inner, null, 2)}\n\`\`\`\n\nDone.`;
    const extracted = extractJsonObject(text);
    expect(JSON.parse(extracted)).toEqual(inner);
  });

  it("finds a balanced object amid trailing prose without fences", () => {
    const inner = { x: true, nested: { y: 2 } };
    const text = `prefix noise ${JSON.stringify(inner)} trailing words`;
    expect(JSON.parse(extractJsonObject(text))).toEqual(inner);
  });
});

describe("assembleJudgeSystemPrompt", () => {
  it("exports a version pin and includes lens gate + task slots", () => {
    expect(JUDGE_SYSTEM_PROMPT_VERSION).toBeTruthy();
    const sys = assembleJudgeSystemPrompt({
      taskPrompt: "Fix the login bug",
      rubric: SAMPLE_RUBRIC,
      agentCategory: "coding",
      runMetadata: { runId: "r1", status: "completed" },
      eventsPreview: "{totalEvents:1}",
      hasSourceArtifacts: true,
    });
    expect(sys).toContain("Fix the login bug");
    expect(sys).toContain("SOURCE ARTIFACTS ARE PRESENT");
    expect(sys).toContain(JUDGE_SYSTEM_PROMPT_VERSION);

    const noSrc = assembleJudgeSystemPrompt({
      taskPrompt: "Summarize the paper",
      rubric: SAMPLE_RUBRIC,
      agentCategory: "research",
      runMetadata: {},
      eventsPreview: "{}",
      hasSourceArtifacts: false,
    });
    expect(noSrc).toContain("OMIT the improvements.withSource");

    const user = assembleJudgeUserPrompt({
      taskPrompt: "Fix the login bug",
      rubric: SAMPLE_RUBRIC,
      runMetadata: {},
      eventsPreview: "{}",
      hasSourceArtifacts: true,
    });
    expect(user).toMatch(/STEP 1 JSON verdict/i);
  });
});

describe("judgeRun (FakeJudgeProvider)", () => {
  it("happy path: writes validated verdict.json + judge.jsonl, status completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-happy-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root);

    const result = await judgeRun({
      runDir,
      dataDir,
      projectId,
      task: {
        prompt: "Fix the empty-token auth bug and verify with tests",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "coding",
      },
      judgeModel: "fake-judge-model",
      hasSourceArtifacts: true,
      provider: new FakeJudgeProvider({ fixturePath: FIXTURE }),
    });

    expect(result.status).toBe("completed");
    expect(result.verdictPath).toBeTruthy();
    expect(result.verdict).toBeDefined();

    const written = JSON.parse(await readFile(result.verdictPath!, "utf8"));
    expect(() =>
      validateVerdict(written, { hasSourceArtifacts: true }),
    ).not.toThrow();
    expect(written.schemaVersion).toBe(1);
    expect(written.improvements.withSource).toBeDefined();

    // Live judge log has events (thinking / message / run boundaries).
    const events: unknown[] = [];
    for await (const e of readJsonl(result.eventsPath)) events.push(e);
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("run.start");
    expect(types).toContain("thinking");
    expect(types).toContain("run.end");
  });

  it("no-source path: accepts verdict without withSource", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-nosrc-ok-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root, {
      withDiff: false,
    });

    const provider = new FakeJudgeProvider({
      fixturePath: FIXTURE,
      verdictOverride: (base) => {
        const v = structuredClone(base) as Verdict;
        delete v.improvements.withSource;
        // strip any diff refs from findings for a cleaner no-source sample
        return v;
      },
    });

    const result = await judgeRun({
      runDir,
      dataDir,
      projectId,
      task: {
        prompt: "Answer the research question",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "research",
      },
      judgeModel: "fake",
      hasSourceArtifacts: false,
      provider,
    });

    expect(result.status).toBe("completed");
    expect(result.verdictPath).toBeTruthy();
    const written = JSON.parse(await readFile(result.verdictPath!, "utf8"));
    expect(written.improvements.withSource).toBeUndefined();
    expect(() =>
      validateVerdict(written, { hasSourceArtifacts: false }),
    ).not.toThrow();
  });

  it("KEY GATE: withSource while hasSourceArtifacts:false → failed, no verdict.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-nosrc-bad-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root, {
      withDiff: false,
    });

    // Fixture includes withSource — disobedient when hasSourceArtifacts is false.
    const provider = new FakeJudgeProvider({ fixturePath: FIXTURE });

    const result = await judgeRun({
      runDir,
      dataDir,
      projectId,
      task: {
        prompt: "Research task",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "research",
      },
      judgeModel: "fake",
      hasSourceArtifacts: false,
      provider,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/withSource|source artifacts/i);
    expect(result.verdictPath).toBeUndefined();

    // verdict.json must NOT exist
    let verdictExists = true;
    try {
      await access(join(result.judgementDir, "verdict.json"));
    } catch {
      verdictExists = false;
    }
    expect(verdictExists).toBe(false);

    // judge.jsonl records the validation error
    const events: Array<{ type: string; message?: string }> = [];
    for await (const e of readJsonl(result.eventsPath)) {
      events.push(e as { type: string; message?: string });
    }
    const errEv = events.find((e) => e.type === "error");
    expect(errEv).toBeDefined();
    expect(errEv!.message).toMatch(/validation failed/i);
  });

  it("rejects finding missing refs — no verdict.json, status failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-bad-refs-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root);

    const provider = new FakeJudgeProvider({
      fixturePath: FIXTURE,
      verdictOverride: (base) => {
        const v = structuredClone(base) as Verdict;
        v.findings[0]!.refs = [];
        return v;
      },
    });

    const result = await judgeRun({
      runDir,
      dataDir,
      projectId,
      task: {
        prompt: "Fix auth",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "coding",
      },
      judgeModel: "fake",
      hasSourceArtifacts: true,
      provider,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/≥1 ref|drop it|ref/i);

    let verdictExists = true;
    try {
      await access(join(result.judgementDir, "verdict.json"));
    } catch {
      verdictExists = false;
    }
    expect(verdictExists).toBe(false);
  });

  it("rejects bare-boolean diagnostics — no verdict.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-bare-bool-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root);

    const provider = new FakeJudgeProvider({
      fixturePath: FIXTURE,
      verdictOverride: (base) => {
        const v = structuredClone(base) as Record<string, unknown>;
        v.diagnostics = { looping: true };
        return v;
      },
    });

    const result = await judgeRun({
      runDir,
      dataDir,
      projectId,
      task: {
        prompt: "Fix auth",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "coding",
      },
      judgeModel: "fake",
      hasSourceArtifacts: true,
      provider,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/must be \{value|diagnostic/i);

    let verdictExists = true;
    try {
      await access(join(result.judgementDir, "verdict.json"));
    } catch {
      verdictExists = false;
    }
    expect(verdictExists).toBe(false);
  });

  it("provider fence-wrap: FakeJudgeProvider + wrapInFences still parses", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-fence-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root);

    const result = await judgeRun({
      runDir,
      dataDir,
      projectId,
      task: {
        prompt: "Fix auth",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "coding",
      },
      judgeModel: "fake",
      hasSourceArtifacts: true,
      provider: new FakeJudgeProvider({
        fixturePath: FIXTURE,
        wrapInFences: true,
      }),
    });

    expect(result.status).toBe("completed");
    expect(result.verdictPath).toBeTruthy();
    const written = JSON.parse(await readFile(result.verdictPath!, "utf8"));
    expect(() =>
      validateVerdict(written, { hasSourceArtifacts: true }),
    ).not.toThrow();
  });
});

describe("what the judge is shown (regressions from a real run)", () => {
  it("includes the diff in the user prompt", async () => {
    // The judge was told source artifacts existed and then never shown them,
    // so a real code change read as "the agent did nothing" — confidently the
    // opposite of the truth. Found by running the real judge for the first
    // time against a run that HAD edited a file.
    const { assembleJudgeUserPrompt } = await import("../src/judge/prompt.ts");
    const prompt = assembleJudgeUserPrompt({
      taskPrompt: "fix it",
      rubric: { version: 1, profile: "bugfix", criteria: [] },
      runMetadata: {},
      eventsPreview: "{}",
      hasSourceArtifacts: true,
      diff: "diff --git a/src/range.js b/src/range.js\n-  i < end\n+  i <= end\n",
    });
    expect(prompt).toContain("i <= end");
    expect(prompt).toContain("what the agent actually changed");
  });

  it("says so explicitly when the diff is empty", async () => {
    // "No diff section" and "an empty diff" mean different things; silence
    // invites the judge to assume the former.
    const { assembleJudgeUserPrompt } = await import("../src/judge/prompt.ts");
    const prompt = assembleJudgeUserPrompt({
      taskPrompt: "fix it",
      rubric: { version: 1, profile: "bugfix", criteria: [] },
      runMetadata: {},
      eventsPreview: "{}",
      hasSourceArtifacts: true,
    });
    expect(prompt).toContain("changed no tracked files");
  });

  it("gives the judge the COMPLETE ordered action timeline", async () => {
    // first/last windows hid the middle of the run — where the work happens.
    // Without ordering the judge cannot tell verified work from unverified.
    const { buildEventsPreview } = await import("../src/judge/worker.ts");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "agenteval-preview-"));
    try {
      const events = [
        { seq: 0, type: "run.start" },
        ...Array.from({ length: 12 }, (_, i) => ({
          seq: i + 1,
          type: i % 2 === 0 ? "tool.call" : "tool.result",
          name: i < 6 ? "read_file" : "edit_file",
          isError: false,
        })),
        { seq: 13, type: "tool.call", name: "bash", args: { command: "npm test" } },
        { seq: 14, type: "run.end", status: "completed" },
      ];
      writeFileSync(
        join(dir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n"),
        "utf8",
      );

      const preview = await buildEventsPreview(dir, 5);
      const parsed = JSON.parse(preview) as { actionTimeline: string[] };
      // Every action, not just the ends.
      expect(parsed.actionTimeline.length).toBeGreaterThan(10);
      // And in order, so "did the test run come after the last edit?" is answerable.
      const lastEdit = parsed.actionTimeline.findLastIndex((l) => l.includes("edit_file"));
      const lastTest = parsed.actionTimeline.findLastIndex((l) => l.includes("bash"));
      expect(lastTest).toBeGreaterThan(lastEdit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

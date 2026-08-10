/**
 * Judge prompt + verdict-validation tests (pure; no model).
 *
 * The behavioral judgeRun path now drives a real PI SDK agent with a configured
 * provider/model — it is exercised by the real-model E2E, not offline. These
 * tests cover the pure contract that path relies on: the versioned prompt
 * assembly, the events preview, JSON extraction, and validateVerdict's gates.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleJudgeSystemPrompt,
  assembleJudgeUserPrompt,
  JUDGE_SYSTEM_PROMPT_VERSION,
} from "../src/judge/prompt.ts";
import { buildEventsPreview } from "../src/judge/worker.ts";
import {
  extractJsonObject,
  validateVerdict,
  type Verdict,
} from "../src/judge/verdict.ts";

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
        full: "fully correct",
        partial: "partially correct",
        none: "incorrect",
      },
    },
  ],
};

describe("verdict-sample fixture", () => {
  it("passes validateVerdict with hasSourceArtifacts:true", () => {
    const raw = readFileSync(FIXTURE, "utf8");
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

describe("validateVerdict gates (pure, no model)", () => {
  it("accepts the sample verdict under the source lens", () => {
    const v = JSON.parse(readFileSync(FIXTURE, "utf8")) as Verdict;
    expect(() => validateVerdict(v, { hasSourceArtifacts: true })).not.toThrow();
  });

  it("rejects withSource when hasSourceArtifacts is false", () => {
    const v = JSON.parse(readFileSync(FIXTURE, "utf8")) as Verdict;
    expect(() => validateVerdict(v, { hasSourceArtifacts: false })).toThrow(
      /withSource|source artifacts/i,
    );
  });

  it("rejects a finding with no refs", () => {
    const v = JSON.parse(readFileSync(FIXTURE, "utf8")) as Verdict;
    const cloned = structuredClone(v) as Verdict;
    cloned.findings[0]!.refs = [];
    expect(() => validateVerdict(cloned, { hasSourceArtifacts: true })).toThrow(
      /≥1 ref|drop it|ref/i,
    );
  });
});

describe("what the judge is shown (regressions from a real run)", () => {
  it("includes the diff in the user prompt", () => {
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

  it("says so explicitly when the diff is empty", () => {
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
      expect(parsed.actionTimeline.length).toBeGreaterThan(10);
      const lastEdit = parsed.actionTimeline.findLastIndex((l) => l.includes("edit_file"));
      const lastTest = parsed.actionTimeline.findLastIndex((l) => l.includes("bash"));
      expect(lastTest).toBeGreaterThan(lastEdit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

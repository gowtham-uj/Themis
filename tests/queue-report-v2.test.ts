import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderQueueReport } from "../src/judge/queue-report.ts";
import type {
  EvalJudgementNarrative,
  QueueImprovementStep,
  QueueWideAnalysis,
} from "../src/judge/queue-schema.ts";
import type { Verdict } from "../src/judge/verdict.ts";

const runId = "run-sample-001";
const traceRef = { kind: "trace" as const, runId, seqs: [1, 2] as [number, number] };
const verdict = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/verdict-sample.json"), "utf8"),
) as Verdict;

const narrative: EvalJudgementNarrative = {
  schemaVersion: 1,
  headline: "Outcome <script>alert(1)</script>",
  judgement: "The agent made a partial, evidence-linked repair.",
  executionAnalysis: [{ stage: "Inspect", judgement: "Read before editing.", refs: [traceRef] }],
  strengths: [{ text: "Localized the primary defect.", refs: [traceRef] }],
  concerns: [{
    severity: "major",
    text: "Skipped final verification.",
    refs: [traceRef],
    implication: "The completion claim is unsupported.",
    ownerClass: "agent",
    findingIds: ["verification_skipped:no-suite-run"],
  }],
  evidenceBoundaries: [{ status: "observed", text: "No test event exists.", refs: [traceRef] }],
  handoff: {
    preserve: [{ text: "Keep read-before-edit behavior.", refs: [traceRef], ownerClass: "agent" }],
    change: [{ text: "Require a final test run.", refs: [traceRef], ownerClass: "agent" }],
    investigate: [{ text: "Inspect archive integrity.", refs: [traceRef], ownerClass: "platform" }],
  },
};

function step(owner: "agent" | "platform" | "judge" | "eval", rank: number): QueueImprovementStep {
  return {
    id: `${owner}-step`,
    rank,
    class: owner,
    priority: owner === "platform" ? 0 : 1,
    confidence: 0.9,
    defectIds: ["d1"],
    subsystem: `${owner}-subsystem`,
    problem: `${owner} problem`,
    evidence: [traceRef],
    target: { kind: "code", paths: [`src/${owner}.ts`] },
    change: `${owner} change`,
    acceptanceCriteria: [`${owner} criterion`],
    tests: [{ name: `${owner} test`, kind: "integration", expected: "passes" }],
    verifyTaskIds: ["eval-1"],
    regressionTaskIds: ["eval-1"],
    dependencies: [],
    nonGoals: [`do not change ${owner} API`],
    preventive: false,
    status: "ready",
  };
}

const queue: QueueWideAnalysis = {
  schemaVersion: 2,
  summary: "Queue summary",
  themes: [{ text: "Verification is inconsistent.", refs: [traceRef] }],
  reliability: { assessment: "Evidence is sufficient.", evidence: [traceRef] },
  rankedDefects: [{
    id: "d1",
    type: "observed",
    rank: 1,
    title: "Verification gap",
    category: "verification",
    severity: "major",
    runIds: [runId],
    description: "The run ended without tests.",
    evidence: [traceRef],
    verification: ["Run the suite."],
  }],
  subsystemAttribution: [{
    subsystem: "completion policy",
    runIds: [runId],
    explanation: "The agent claimed success too early.",
    evidence: [traceRef],
  }],
  regressions: [],
  improvementPlan: [step("eval", 4), step("judge", 3), step("platform", 1), step("agent", 2)],
};

describe("queue analysis v2 report", () => {
  it("renders narrative-first sections, complete owner backlogs, and escaped content", () => {
    const html = renderQueueReport({
      projectName: "Project",
      queueName: "Queue",
      batchId: "batch-1",
      analysisId: "analysis-1",
      model: "deepseek-v4-flash",
      provider: "nuralwatt",
      createdAt: "2026-08-11T00:00:00.000Z",
      queue,
      evals: [{ runId, taskName: "Auth task", verdict, narrative }],
    });

    expect(html).toContain("Outcome &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");

    const ordered = [
      "Narrative",
      "Execution timeline",
      "Strengths",
      "Concerns",
      "Criteria",
      "Located findings",
      "Handoff",
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(html.indexOf(ordered[index - 1]!)).toBeLessThan(html.indexOf(ordered[index]!));
    }

    const owners = ["agent backlog", "platform backlog", "judge backlog", "eval backlog"];
    for (let index = 1; index < owners.length; index += 1) {
      expect(html.indexOf(owners[index - 1]!)).toBeLessThan(html.indexOf(owners[index]!));
    }
    expect(html).toContain("Subsystem attribution");
    expect(html).toContain("completion policy");
    expect(html).toContain("Regressions");
    expect(html).toContain("Acceptance criteria");
    expect(html).toContain("Verify tasks");
    expect(html).toContain("Regression tasks");
    expect(html).toContain("code:src/platform.ts");
    expect(html).toContain("do not change eval API");
  });
});

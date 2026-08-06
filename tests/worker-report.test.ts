/**
 * P5b-worker: judgeRun writes report.html after a successful verdict.
 * Offline via FakeJudgeProvider; does not disturb existing judge-worker cases.
 */
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeJudgeProvider } from "../src/judge/fake-provider.ts";
import { judgeRun } from "../src/judge/worker.ts";
import type { Verdict } from "../src/judge/verdict.ts";

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
  const projectId = opts.projectId ?? "proj-report";
  const runId = opts.runId ?? "run-report-001";
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
        durationMs: 4000,
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
      `diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n`,
      "utf8",
    );
  }

  return { runDir, dataDir, projectId, runId };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("judgeRun report.html (P5b-worker)", () => {
  it("happy path: writes report.html + sets result.reportPath", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-report-happy-"));
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
    expect(result.reportPath).toBeTruthy();
    const reportPath = join(result.judgementDir, "report.html");
    expect(result.reportPath).toBe(reportPath);
    expect(await pathExists(reportPath)).toBe(true);

    const html = await readFile(reportPath, "utf8");
    expect(html.length).toBeGreaterThan(0);
    expect(html.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("@agenteval-report");
  });

  it("failed verdict path: no report.html, reportPath undefined", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-report-fail-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root, {
      withDiff: false,
    });

    // Fixture includes withSource — disobedient when hasSourceArtifacts is false.
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
      provider: new FakeJudgeProvider({ fixturePath: FIXTURE }),
    });

    expect(result.status).toBe("failed");
    expect(result.reportPath).toBeUndefined();
    expect(await pathExists(join(result.judgementDir, "report.html"))).toBe(
      false,
    );
    expect(await pathExists(join(result.judgementDir, "verdict.json"))).toBe(
      false,
    );
  });

  it("re-judge into same judgement dir overwrites report.html (no stale append)", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-report-idem-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root);
    const judgementId = "jid-report-idem-001";

    const input = {
      runDir,
      dataDir,
      projectId,
      judgementId,
      task: {
        prompt: "Fix auth",
        rubric: SAMPLE_RUBRIC,
        agentCategory: "coding" as const,
      },
      judgeModel: "fake",
      hasSourceArtifacts: true,
      provider: new FakeJudgeProvider({ fixturePath: FIXTURE }),
    };

    const first = await judgeRun(input);
    expect(first.status).toBe("completed");
    const reportPath = join(first.judgementDir, "report.html");
    const firstHtml = await readFile(reportPath, "utf8");
    expect(firstHtml.toLowerCase().startsWith("<!doctype html>")).toBe(true);

    // Second run overwrites (writeFile, not append).
    const second = await judgeRun(input);
    expect(second.status).toBe("completed");
    expect(second.judgementDir).toBe(first.judgementDir);
    expect(second.reportPath).toBe(reportPath);

    const secondHtml = await readFile(reportPath, "utf8");
    expect(secondHtml.toLowerCase().startsWith("<!doctype html>")).toBe(true);
    // File is a single valid document, not two concatenated doctype docs.
    const doctypeCount = (secondHtml.match(/<!doctype html>/gi) ?? []).length;
    expect(doctypeCount).toBe(1);
    // Still non-empty and structurally the same shape as a fresh render.
    expect(secondHtml).toContain("@agenteval-report");
    expect(secondHtml).toContain("</html>");
  });

  it("report respects hasSourceArtifacts:false — no-source note, no withSource section", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-report-nosrc-"));
    const { runDir, dataDir, projectId } = await seedRunDir(root, {
      withDiff: false,
    });

    const provider = new FakeJudgeProvider({
      fixturePath: FIXTURE,
      verdictOverride: (base) => {
        const v = structuredClone(base) as Verdict;
        delete v.improvements.withSource;
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
    expect(result.reportPath).toBeTruthy();
    const html = await readFile(result.reportPath!, "utf8");
    expect(html).toContain(
      "no source-level recommendations (run has no source artifacts)",
    );
    // withSource lens section should be the absent note, not a populated withSource list.
    expect(html).toContain('data-lens="withSource-absent"');
    expect(html).not.toContain('data-lens="withSource"');
  });
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verificationAfterMutationGate } from "../src/judge/verification-gate.ts";
import { analyzeEvidenceIntegrity } from "../src/runner/evidence-integrity.ts";
import { deriveRunMetrics } from "../src/runner/metrics.ts";
import type { CanonicalEvent } from "../src/schema/events.ts";

function event(overrides: Omit<CanonicalEvent, "v" | "runId" | "ts">): CanonicalEvent {
  return {
    v: 1,
    runId: "run-1",
    ts: "2026-08-11T00:00:00.000Z",
    ...overrides,
  } as CanonicalEvent;
}

const canonicalEvents: CanonicalEvent[] = [
  event({ seq: 0, type: "run.start", agent: "reapercode", model: "deepseek-v4-flash", provider: "nuralwatt", workspace: { source: "empty" }, params: {} }),
  event({ seq: 1, type: "tool.call", turn: 1, id: "edit-1", name: "write", args: { path: "src/a.ts" } }),
  event({ seq: 2, type: "tool.call", turn: 1, id: "test-1", name: "bash", args: { command: "npm test" } }),
  event({ seq: 3, type: "message", turn: 1, mode: "full", text: "done" }),
  event({ seq: 4, type: "message", turn: 1, mode: "full", text: "done" }),
  event({ seq: 5, type: "run.end", status: "completed", durationMs: 1000 }),
];

describe("platform-owned run metrics", () => {
  it("derives mutation, verification, duplicate-message, and terminal facts", () => {
    const metrics = deriveRunMetrics(canonicalEvents);
    expect(metrics).toMatchObject({
      schemaVersion: 1,
      eventCount: 6,
      toolCallCount: 2,
      messageCount: 2,
      duplicateFullMessageCount: 1,
      mutationCount: 1,
      verificationCount: 1,
      lastMutationSeq: 1,
      lastVerificationSeq: 2,
      verificationAfterLastMutation: true,
      verifiedCompletion: true,
      terminalStatus: "completed",
    });
    expect(verificationAfterMutationGate("run-1", metrics)).toMatchObject({
      status: "verified",
      refs: [{ kind: "trace", runId: "run-1", seqs: [1, 2] }],
    });
  });

  it("keeps ambiguous post-mutation behavior unknown rather than inventing failure", () => {
    const metrics = deriveRunMetrics([
      canonicalEvents[0]!,
      canonicalEvents[1]!,
      event({ seq: 2, type: "tool.call", turn: 1, id: "x", name: "bash", args: { command: "custom-tool --do-work" } }),
      canonicalEvents[5]!,
    ]);
    expect(verificationAfterMutationGate("run-1", metrics).status).toBe("unknown");
  });
});

describe("retained evidence integrity", () => {
  it("preserves malformed raw evidence and marks it unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-integrity-"));
    const retained = join(root, "retained", "agent", ".agenteval");
    await mkdir(retained, { recursive: true });
    const path = join(retained, "reaper-result.json");
    const raw = `Agent prose before JSON.\n{"status":"completed"}\n`;
    await writeFile(path, raw, "utf8");
    try {
      const report = await analyzeEvidenceIntegrity({
        runId: "run-1",
        retainedDir: join(root, "retained"),
        metrics: deriveRunMetrics(canonicalEvents),
      });
      expect(report.safeForScoring).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "invalid", scoringSafe: false }),
      ]));
      expect(await readFile(path, "utf8")).toBe(raw);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects empty tool ids and contradictory native trajectory metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenteval-integrity-"));
    const retained = join(root, "retained", "agent", ".reaper", "runs", "x");
    await mkdir(retained, { recursive: true });
    await writeFile(join(retained, "reaper-result.json"), JSON.stringify({ toolResults: [{ id: "", name: "bash" }] }), "utf8");
    await writeFile(join(retained, "trajectory-metrics.json"), JSON.stringify({ edited_file_count: 0, verification_attempts: 0, verified_completion: true }), "utf8");
    try {
      const report = await analyzeEvidenceIntegrity({
        runId: "run-1",
        retainedDir: join(root, "retained"),
        metrics: deriveRunMetrics(canonicalEvents),
      });
      expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
        "reaper-result.json:empty-tool-identifiers",
        "trajectory-metrics:verification-count",
      ]));
      expect(report.checks.some((check) => check.status === "contradictory")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

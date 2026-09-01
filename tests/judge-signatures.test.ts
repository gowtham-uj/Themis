/**
 * Phase-1 finding signatures — the controlled vocabulary Phase-2 groups by.
 * A deterministic classifier keeps the labels from depending on LLM consistency.
 */
import { describe, expect, it } from "vitest";

import {
  FINDING_SIGNATURES,
  classifySignatures,
  isKnownSignature,
} from "../src/judge/validity/signatures.ts";

describe("finding signatures", () => {
  it("classifies the self-context ingestion pattern", () => {
    const sigs = classifySignatures(
      "grep_search over /workspace/task returned the agent's own .reaper live session log",
    );
    expect(sigs).toContain("TOOL_SEARCH_SELF_CONTEXT");
  });

  it("classifies the waived-counterexample reasoning failure", () => {
    const sigs = classifySignatures(
      "The agent found a counterexample to its own resolver and proceeded anyway.",
    );
    expect(sigs).toContain("COUNTEREXAMPLE_IGNORED");
  });

  it("classifies a harness setup failure as a platform signature", () => {
    const sigs = classifySignatures(
      "setup failed with refusing non-empty target; the agent never executed",
    );
    expect(sigs).toContain("INFRA_SETUP_FAILURE");
  });

  it("does not treat a .reaper-only workspace mention as self-context search", () => {
    const sigs = classifySignatures(
      "The final blocker attributed 'workspace contains only .reaper' to a list_directory call; the observation came from bash ls -la.",
    );
    expect(sigs).not.toContain("TOOL_SEARCH_SELF_CONTEXT");
  });

  it("does not treat 'malformed tool calls' as an edge-verification gap", () => {
    const sigs = classifySignatures(
      "Three parse-dropped or malformed tool calls (missing required args, path_escape on absolute path) wasted turns",
    );
    expect(sigs).not.toContain("INSUFFICIENT_EDGE_VERIFICATION");
  });

  it("does not treat 'any interpreter' as INTERPRETER_ASSUMPTION; npm-test skip is VERIFICATION_GAP", () => {
    const sigs = classifySignatures(
      "The agent never invoked npm, node, or any interpreter (test_attempts 0). The task commanded npm test.",
    );
    expect(sigs).not.toContain("INTERPRETER_ASSUMPTION");
    expect(sigs).toContain("VERIFICATION_GAP");
  });

  it("falls back to UNCLASSIFIED rather than inventing a label", () => {
    expect(classifySignatures("something entirely unrelated to any known pattern")).toEqual([
      "UNCLASSIFIED",
    ]);
  });

  it("only accepts signatures from the frozen vocabulary", () => {
    expect(isKnownSignature("TOOL_RESULT_OVERSIZED")).toBe(true);
    expect(isKnownSignature("MADE_UP_LABEL")).toBe(false);
    expect(new Set(FINDING_SIGNATURES).size).toBe(FINDING_SIGNATURES.length);
  });
});

/* ---------------------- stable evidence ID grammar --------------------- */

describe("stable evidence IDs", () => {
  it("parses trace/artifact/source/metric refs and rejects malformed ones", async () => {
    const { parseRef } = await import("../src/judge/quality/tier-a-structural.ts");

    expect(parseRef("trace:run-abc:seq:27")).toMatchObject({
      kind: "trace",
      runId: "run-abc",
      seq: 27,
    });
    expect(parseRef("artifact:eval_lifecycle_logs/run-metrics.json#/tokens_used")).toMatchObject({
      kind: "artifact",
      path: "eval_lifecycle_logs/run-metrics.json",
      pointer: "/tokens_used",
    });
    expect(parseRef("source:resolve.py#symbol=resolve")).toMatchObject({
      kind: "source",
      path: "resolve.py",
      symbol: "resolve",
    });
    expect(parseRef("metric:tokens_used")).toMatchObject({
      kind: "metric",
      metric: "tokens_used",
    });

    // Malformed forms must not parse.
    expect(parseRef("trace:run-abc:seq:")).toBeNull();
    expect(parseRef("artifact:foo.json#no-leading-slash")).toBeNull();
    expect(parseRef("source:foo.py#resolve")).toBeNull();
    expect(parseRef("metric:")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { deriveRunMetrics } from "../src/runner/metrics.ts";

const seq = (n: number, e: Record<string, unknown>) => ({ seq: n, ...e });

describe("run metrics — heredoc verification is not a mutation", () => {
  it("does not count a heredoc probe's comparison operators as mutations", () => {
    const metrics = deriveRunMetrics([
      seq(1, { type: "message", text: "start", mode: "full", turn: 1 }),
      seq(2, { type: "tool.call", name: "write_file", args: { path: "breaker.py" } }),
      seq(3, {
        type: "tool.call",
        name: "bash",
        args: {
          cmd: `python3 - <<'EOF'\nfrom breaker import CircuitBreaker\nc = 1000\nassert c >= 0\nb = CircuitBreaker(2, 1000)\nassert b.state == "closed"\nprint("ok")\nEOF`,
        },
      }),
      seq(4, { type: "tool.result", id: "3", output: "ok" }),
      seq(5, { type: "run.end", status: "completed", durationMs: 100 }),
    ] as never);

    // One real mutation: the write_file. The heredoc bash is verification, not a
    // second mutation (its `>=` / `==` comparisons are not shell redirects).
    expect(metrics.mutationCount).toBe(1);
  });

  it("still counts a genuine shell redirect as a mutation", () => {
    const metrics = deriveRunMetrics([
      seq(1, { type: "message", text: "start", mode: "full", turn: 1 }),
      seq(2, { type: "exec", argv: ["bash", "-c", "echo 'x' > out.txt"] }),
      seq(3, { type: "run.end", status: "completed", durationMs: 100 }),
    ] as never);
    expect(metrics.mutationCount).toBe(1);
  });
});

describe("run metrics — tested-agent usage", () => {
  it("counts model requests and splits input/output tokens from usage events", () => {
    const metrics = deriveRunMetrics([
      { v: 1, runId: "r", seq: 1, ts: "t", type: "usage", inputTokens: 100, outputTokens: 20 },
      { v: 1, runId: "r", seq: 2, ts: "t", type: "usage", inputTokens: 50, outputTokens: 10, reasoningTokens: 5 },
      { v: 1, runId: "r", seq: 3, ts: "t", type: "run.end", status: "completed", durationMs: 10 },
    ] as never);
    expect(metrics.measurements.model_requests?.value).toBe(2);
    expect(metrics.measurements.input_tokens?.value).toBe(150);
    expect(metrics.measurements.output_tokens?.value).toBe(30);
    expect(metrics.measurements.tokens_used?.value).toBe(185);
    expect(metrics.measurements.model_requests?.provenance).toBe("exact");
  });

  it("prefers run.end.usageTotal for token totals and still counts usage events as requests", () => {
    const metrics = deriveRunMetrics([
      { v: 1, runId: "r", seq: 1, ts: "t", type: "usage", inputTokens: 1, outputTokens: 1 },
      { v: 1, runId: "r", seq: 2, ts: "t", type: "usage", inputTokens: 1, outputTokens: 1 },
      {
        v: 1, runId: "r", seq: 3, ts: "t", type: "run.end", status: "completed", durationMs: 10,
        usageTotal: { inputTokens: 400, outputTokens: 80, reasoningTokens: 20, totalTokens: 500 },
      },
    ] as never);
    expect(metrics.measurements.model_requests?.value).toBe(2);
    expect(metrics.measurements.input_tokens?.value).toBe(400);
    expect(metrics.measurements.output_tokens?.value).toBe(80);
    expect(metrics.measurements.tokens_used?.value).toBe(500);
  });
});

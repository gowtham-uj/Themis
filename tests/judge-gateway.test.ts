/**
 * WP-6 gateway tests — fake fetch transport; never needs a real key.
 */
import { describe, expect, it } from "vitest";

import {
  GatewayError,
  MemoryProviderOperationLedger,
  ModelGateway,
  ReasoningStarvedError,
  chatJsonObject,
  loadGatewayConfig,
} from "../src/judge/gateway/index.ts";

function gatewayWithFetch(fetchImpl: typeof fetch): ModelGateway {
  const cfg = loadGatewayConfig({
    OPENAI_BASE_URL: "https://example.test/v1",
    OPENAI_API_KEY: "test-key-not-real",
    AGENTEVAL_DEFAULT_MODEL: "deepseek-v4-flash",
    THEMIS_REASONING_EFFORT: "max",
    THEMIS_MAX_TOKENS_FLOOR: "2048",
  });
  return new ModelGateway(cfg, new MemoryProviderOperationLedger());
}

describe("loadGatewayConfig", () => {
  it("fails closed without base URL or key", () => {
    expect(() => loadGatewayConfig({})).toThrow(GatewayError);
    expect(() => loadGatewayConfig({ OPENAI_BASE_URL: "https://x" })).toThrow(/API_KEY/);
  });
});

describe("ModelGateway.chat", () => {
  it("creates a ledger row before calling fetch and marks succeeded", async () => {
    let calls = 0;
    const ledger = new MemoryProviderOperationLedger();
    const cfg = loadGatewayConfig({
      OPENAI_BASE_URL: "https://example.test/v1",
      OPENAI_API_KEY: "test-key-not-real",
    });
    const gw = new ModelGateway(cfg, ledger);
    const result = await gw.chat({
      attemptId: "att_1",
      node: "minos",
      metricOrRole: "ruling",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok", reasoning_content: "scratch" }, finish_reason: "stop" }],
            usage: { completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    expect(calls).toBe(1);
    expect(result.content).toBe("ok");
    const op = await ledger.get(result.operationId);
    expect(op?.state).toBe("succeeded");
    expect(op?.authoritative).toBe(true);
    expect(op?.reasoningContent).toBe("scratch");
  });

  it("throws ReasoningStarvedError when length finish with empty content", async () => {
    const gw = gatewayWithFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "", reasoning_content: "…".repeat(100) }, finish_reason: "length" }],
          usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 20 } },
        }),
        { status: 200 },
      ),
    );
    await expect(
      gw.chat({
        attemptId: "att_2",
        node: "clerk",
        metricOrRole: "pack",
        messages: [{ role: "user", content: "x" }],
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [
                { message: { content: "", reasoning_content: "thinking" }, finish_reason: "length" },
              ],
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toBeInstanceOf(ReasoningStarvedError);
  });

  it("enforces max_tokens floor in the request body", async () => {
    let body: any;
    const gw = gatewayWithFetch(fetch);
    await gw.chat({
      attemptId: "att_3",
      node: "node2",
      metricOrRole: "metric",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 20, // below floor
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
  });
});

describe("chatJsonObject", () => {
  it("repairs once then returns valid JSON", async () => {
    let calls = 0;
    const gw = gatewayWithFetch(fetch);
    const { value, repaired } = await chatJsonObject(gw, {
      attemptId: "att_4",
      node: "minos",
      metricOrRole: "json",
      messages: [{ role: "user", content: "return {a:1}" }],
      validate: (v) =>
        typeof v === "object" && v !== null && "a" in (v as object) ? null : "missing a",
      fetchImpl: (async () => {
        calls += 1;
        const content = calls === 1 ? '{"b":2}' : '{"a":1}';
        return new Response(
          JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(repaired).toBe(true);
    expect(value).toEqual({ a: 1 });
    expect(calls).toBe(2);
  });
});

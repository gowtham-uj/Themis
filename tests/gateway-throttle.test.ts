/**
 * Real throttle behavior: a fake OpenAI-compatible endpoint returns 429 / 402 /
 * quota errors, and the gateway must classify them as rate_limit / quota —
 * throwing ProviderThrottledError (retry-exempt) rather than a generic http
 * error that would burn a retry attempt.
 */
import { describe, expect, it } from "vitest";

import {
  ModelGateway,
  ProviderThrottledError,
  GatewayError,
  type ChatRequest,
} from "../src/judge/gateway/client.ts";
import { loadGatewayConfig } from "../src/judge/gateway/config.ts";

function gatewayReturning(status: number, body: unknown): ModelGateway {
  return new ModelGateway(
    loadGatewayConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://example.invalid/v1",
      THEMIS_REASONING_EFFORT: "low",
    }),
  );
}

function cannedFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function basic(): ChatRequest {
  return {
    attemptId: "att",
    node: "node2",
    metricOrRole: "m",
    messages: [{ role: "user", content: "hi" }],
  };
}

describe("gateway throttle classification", () => {
  it("429 without quota wording -> ProviderThrottledError(rate_limit)", async () => {
    const gw = gatewayReturning(429, { error: { message: "Too many requests" } });
    await expect(gw.chat({ ...basic(), fetchImpl: cannedFetch(429, { error: { message: "Too many requests" } }) })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderThrottledError && e.throttleKind === "rate_limit" && e.isRetryExempt,
    );
  });

  it("429 with quota wording -> ProviderThrottledError(quota)", async () => {
    const gw = gatewayReturning(429, { error: { message: "Insufficient quota" } });
    await expect(gw.chat({ ...basic(), fetchImpl: cannedFetch(429, { error: { message: "Insufficient quota. Balance exceeded." } }) })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ProviderThrottledError && e.throttleKind === "quota" && e.isRetryExempt,
    );
  });

  it("402 billing error -> quota", async () => {
    const gw = gatewayReturning(402, { error: { message: "Billing quota exceeded" } });
    await expect(gw.chat({ ...basic(), fetchImpl: cannedFetch(402, { error: { message: "Billing quota exceeded" } }) })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderThrottledError && e.throttleKind === "quota",
    );
  });

  it("500 server error -> generic GatewayError (NOT retry-exempt)", async () => {
    const gw = gatewayReturning(500, { error: { message: "boom" } });
    await expect(gw.chat({ ...basic(), fetchImpl: cannedFetch(500, { error: { message: "boom" } }) })).rejects.toSatisfy(
      (e: unknown) => e instanceof GatewayError && !e.isRetryExempt,
    );
  });
});

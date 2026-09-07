/**
 * Unified per-stage model config: resolution order, API compatibility type,
 * the never-store-a-secret rule, and the live health probe.
 */

import { describe, expect, it } from "vitest";
import {
  MODEL_STAGES,
  ModelConfigError,
  parseStoredStageConfig,
  resolveModelConfig,
  resolveWebSearchCredential,
  viewModelConfig,
} from "../src/config/model-config.js";
import { checkModelHealth } from "../src/config/model-health.js";

// Synthetic credential-shaped strings. Never a real key.
const FAKE_KEY = "sk-test-0000000000000000000000000000";
const FAKE_KEY_2 = "sk-test-1111111111111111111111111111";

describe("resolveModelConfig", () => {
  it("gives each stage its own endpoint", () => {
    const env = {
      AGENTEVAL_EVAL_BASE_URL: "https://eval.example/v1",
      AGENTEVAL_EVAL_API_KEY: FAKE_KEY,
      AGENTEVAL_PHASE1_BASE_URL: "https://p1.example/v1",
      AGENTEVAL_PHASE1_API_KEY: FAKE_KEY_2,
      AGENTEVAL_PHASE2_BASE_URL: "https://p2.example/v1",
      AGENTEVAL_PHASE2_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv;
    expect(resolveModelConfig("eval", { env, stored: {} }).baseUrl).toBe("https://eval.example/v1");
    expect(resolveModelConfig("phase1", { env, stored: {} }).baseUrl).toBe("https://p1.example/v1");
    expect(resolveModelConfig("phase2", { env, stored: {} }).baseUrl).toBe("https://p2.example/v1");
    expect(resolveModelConfig("phase1", { env, stored: {} }).apiKey).toBe(FAKE_KEY_2);
  });

  it("defaults to openai compatibility and reads the anthropic type", () => {
    const env = {
      AGENTEVAL_PHASE1_BASE_URL: "https://p1.example",
      AGENTEVAL_PHASE1_API_KEY: FAKE_KEY,
      AGENTEVAL_PHASE2_API_TYPE: "anthropic-compatible",
      AGENTEVAL_PHASE2_BASE_URL: "https://p2.example",
      AGENTEVAL_PHASE2_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv;
    expect(resolveModelConfig("phase1", { env, stored: {} }).apiType).toBe("openai");
    expect(resolveModelConfig("phase2", { env, stored: {} }).apiType).toBe("anthropic");
  });

  it("rejects an unknown compatibility type", () => {
    const env = { AGENTEVAL_EVAL_API_TYPE: "grpc" } as NodeJS.ProcessEnv;
    expect(() => resolveModelConfig("eval", { env, stored: {} })).toThrow(ModelConfigError);
  });

  it("falls back to the legacy shared vars for the declared type", () => {
    const env = {
      OPENAI_BASE_URL: "https://legacy.example/v1",
      DEEPSEEK_API_KEY: FAKE_KEY,
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      ANTHROPIC_API_KEY: FAKE_KEY_2,
      AGENTEVAL_PHASE2_API_TYPE: "anthropic",
    } as NodeJS.ProcessEnv;
    const p1 = resolveModelConfig("phase1", { env, stored: {} });
    expect(p1.baseUrl).toBe("https://legacy.example/v1");
    expect(p1.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    const p2 = resolveModelConfig("phase2", { env, stored: {} });
    expect(p2.baseUrl).toBe("https://anthropic.example");
    expect(p2.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("lets stored config win over env, and reads the key from the named var", () => {
    const env = {
      AGENTEVAL_PHASE1_BASE_URL: "https://from-env.example",
      MY_CUSTOM_KEY: FAKE_KEY_2,
    } as NodeJS.ProcessEnv;
    const cfg = resolveModelConfig("phase1", {
      env,
      stored: { phase1: { baseUrl: "https://from-stored.example/", apiKeyEnv: "MY_CUSTOM_KEY", model: "m-1" } },
    });
    expect(cfg.baseUrl).toBe("https://from-stored.example");
    expect(cfg.apiKey).toBe(FAKE_KEY_2);
    expect(cfg.apiKeyEnv).toBe("MY_CUSTOM_KEY");
    expect(cfg.model).toBe("m-1");
  });

  it("names the missing field when a stage cannot reach a model", () => {
    expect(() => resolveModelConfig("eval", { env: {}, stored: {} })).toThrow(/no base URL/);
    expect(() =>
      resolveModelConfig("eval", { env: { AGENTEVAL_EVAL_BASE_URL: "https://x.example" }, stored: {} }),
    ).toThrow(/no API key/);
  });

  it("resolves a project-named Serper variable without storing its value", () => {
    const env = { PROJECT_SEARCH_KEY: FAKE_KEY } as NodeJS.ProcessEnv;
    const web = resolveWebSearchCredential("phase1", {
      env,
      stored: { phase1: { webSearchApiKeyEnv: "PROJECT_SEARCH_KEY" } },
    });
    expect(web).toEqual({ apiKey: FAKE_KEY, apiKeyEnv: "PROJECT_SEARCH_KEY" });
  });
});

describe("viewModelConfig", () => {
  it("never returns the key and reports why a stage is unusable", () => {
    const view = viewModelConfig("eval", { env: {}, stored: {} });
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
    expect(view.apiKeyPresent).toBe(false);
    expect(view.error).toMatch(/no base URL/);
    expect(view.envVars.baseUrl).toBe("AGENTEVAL_EVAL_BASE_URL");
  });

  it("reports a healthy stage with the key variable named, not its value", () => {
    const env = {
      AGENTEVAL_PHASE2_BASE_URL: "https://p2.example",
      AGENTEVAL_PHASE2_API_KEY: FAKE_KEY,
    } as NodeJS.ProcessEnv;
    const view = viewModelConfig("phase2", { env, stored: {} });
    expect(view.apiKeyPresent).toBe(true);
    expect(view.apiKeyEnv).toBe("AGENTEVAL_PHASE2_API_KEY");
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY);
  });

  it("covers all three stages", () => {
    expect([...MODEL_STAGES]).toEqual(["eval", "phase1", "phase2"]);
  });
});

describe("parseStoredStageConfig", () => {
  it("refuses to store a key value", () => {
    expect(() => parseStoredStageConfig({ apiKey: FAKE_KEY }, "phase1")).toThrow(/never stored/);
    expect(() => parseStoredStageConfig({ webSearchApiKeyEnv: FAKE_KEY }, "phase1")).toThrow(/environment variable name/);
  });

  it("normalizes and drops blank fields", () => {
    const out = parseStoredStageConfig(
      { baseUrl: "https://x.example///", webSearchApiKeyEnv: " SEARCH_KEY ", model: "  m  ", reasoningEffort: "", apiType: "openai_compatible" },
      "eval",
    );
    expect(out).toEqual({ baseUrl: "https://x.example", webSearchApiKeyEnv: "SEARCH_KEY", model: "m", apiType: "openai" });
  });
});

describe("checkModelHealth", () => {
  const okEnv = {
    AGENTEVAL_PHASE1_BASE_URL: "https://p1.example/v1",
    AGENTEVAL_PHASE1_API_KEY: FAKE_KEY,
    AGENTEVAL_PHASE1_MODEL: "m-1",
  } as NodeJS.ProcessEnv;

  it("reports config failure without any request", async () => {
    let called = false;
    const r = await checkModelHealth("eval", {
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe("config");
  });

  it("passes on an OpenAI-compatible reply", async () => {
    const r = await checkModelHealth("phase1", {
      env: okEnv,
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://p1.example/v1/chat/completions");
        expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("OK");
    expect(r.apiType).toBe("openai");
  });

  it("uses the Messages API and x-api-key for an anthropic-compatible stage", async () => {
    const r = await checkModelHealth("phase2", {
      env: {
        AGENTEVAL_PHASE2_API_TYPE: "anthropic",
        AGENTEVAL_PHASE2_BASE_URL: "https://p2.example",
        AGENTEVAL_PHASE2_API_KEY: FAKE_KEY,
      } as NodeJS.ProcessEnv,
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://p2.example/v1/messages");
        const h = init.headers as Record<string, string>;
        expect(h["x-api-key"]).toBe(FAKE_KEY);
        expect(h["anthropic-version"]).toBe("2023-06-01");
        return new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("OK");
  });

  it("classifies a rejected key as auth, not a generic HTTP error", async () => {
    const r = await checkModelHealth("phase1", {
      env: okEnv,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })) as typeof fetch,
    });
    expect(r.errorKind).toBe("auth");
    expect(r.error).toBe("invalid api key");
  });

  it("classifies a refused connection as transport", async () => {
    const r = await checkModelHealth("phase1", {
      env: okEnv,
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(r.errorKind).toBe("transport");
    expect(r.status).toBeNull();
  });

  it("blames the compatibility type when a 200 carries no content", async () => {
    const r = await checkModelHealth("phase1", {
      env: okEnv,
      fetchImpl: (async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })) as typeof fetch,
    });
    expect(r.errorKind).toBe("response");
    expect(r.error).toMatch(/API compatibility type is wrong/);
  });
});

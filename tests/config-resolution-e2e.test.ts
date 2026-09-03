/**
 * End-to-end config resolution: does what the console saves actually reach the
 * three things that spend money?
 *
 * The question this answers is narrow and specific. An operator sets a base
 * URL, model, and key variable on a project's settings page. Three separate
 * consumers then run: the eval agent inside its Podman container, the Phase-1
 * courtroom (nodes 0-3 over the gateway, plus the PI court), and the Phase-2
 * campaign board. Each one resolves its own config through a different code
 * path. A bug in any one of them is invisible until a run quietly bills the
 * wrong endpoint, so every consumer is asserted here rather than trusting that
 * they all call the same resolver.
 *
 * These are deliberately not model calls. Resolution is a pure function of
 * stored config plus environment, so it is checked directly. The live half at
 * the bottom does open a socket to the configured provider, and an
 * "Insufficient Balance" from it is a PASS: reaching the operator's endpoint
 * and being refused by it proves the config arrived. Only a wrong host, a
 * wrong model, or a missing credential is a failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  mergeStoredModelConfig,
  parseStoredModelConfig,
  resolveModelConfig,
  setStoredModelConfig,
  type StoredModelConfig,
} from "../src/config/model-config.ts";
import { loadGatewayConfig } from "../src/judge/gateway/config.ts";
import { ModelGateway } from "../src/judge/gateway/client.ts";
import { piConnectionFor } from "../src/judge/pi/runtime.ts";
import { collectAgentEnvForTest } from "../src/runner/queue-worker.ts";

/** Synthetic stand-ins. Nothing here is a real endpoint or credential. */
const GLOBAL_ENV = {
  AGENTEVAL_EVAL_BASE_URL: "https://global-eval.invalid/v1",
  AGENTEVAL_EVAL_API_KEY: "synthetic-global-eval-key",
  AGENTEVAL_PHASE1_BASE_URL: "https://global-phase1.invalid/v1",
  AGENTEVAL_PHASE1_API_KEY: "synthetic-global-phase1-key",
  AGENTEVAL_PHASE2_BASE_URL: "https://global-phase2.invalid/v1",
  AGENTEVAL_PHASE2_API_KEY: "synthetic-global-phase2-key",
} as NodeJS.ProcessEnv;

/** What an operator would type into the project settings page. */
const PROJECT_SETTINGS = {
  eval: { baseUrl: "https://project-eval.invalid/v1", model: "project-eval-model" },
  phase1: { baseUrl: "https://project-phase1.invalid/v1", model: "project-phase1-model" },
  phase2: { baseUrl: "https://project-phase2.invalid/v1", model: "project-phase2-model" },
};

function projectConfig(): StoredModelConfig {
  return parseStoredModelConfig(PROJECT_SETTINGS);
}

describe("config resolution: project overrides reach every stage", () => {
  it("keeps the three stages independent instead of collapsing them", () => {
    const stored = mergeStoredModelConfig(projectConfig(), {});
    const evalCfg = resolveModelConfig("eval", { env: GLOBAL_ENV, stored });
    const p1 = resolveModelConfig("phase1", { env: GLOBAL_ENV, stored });
    const p2 = resolveModelConfig("phase2", { env: GLOBAL_ENV, stored });

    expect(evalCfg.baseUrl).toBe("https://project-eval.invalid/v1");
    expect(p1.baseUrl).toBe("https://project-phase1.invalid/v1");
    expect(p2.baseUrl).toBe("https://project-phase2.invalid/v1");
    expect(new Set([evalCfg.model, p1.model, p2.model]).size).toBe(3);
  });

  it("layers a project field over the global one and inherits the rest", () => {
    // Only phase1's base URL is overridden. The key must still resolve from
    // the global env, or a partial override would break a working stage.
    const stored = mergeStoredModelConfig(
      parseStoredModelConfig({ phase1: { baseUrl: "https://only-this.invalid/v1" } }),
      parseStoredModelConfig({ phase1: { model: "inherited-model" } }),
    );
    const cfg = resolveModelConfig("phase1", { env: GLOBAL_ENV, stored });
    expect(cfg.baseUrl).toBe("https://only-this.invalid/v1");
    expect(cfg.model).toBe("inherited-model");
    expect(cfg.apiKey).toBe("synthetic-global-phase1-key");
  });
});

describe("consumer 1: the eval agent container", () => {
  it("carries the project's eval endpoint into the agent environment", () => {
    // The agent harness reads the conventional OPENAI_* pair, so the resolved
    // eval stage has to land there. If it does not, the agent silently uses
    // whatever ambient key the server process happens to hold.
    setStoredModelConfig({});
    const env = collectAgentEnvForTest(PROJECT_SETTINGS, {
      ...GLOBAL_ENV,
      OPENAI_BASE_URL: "https://ambient-should-lose.invalid/v1",
      OPENAI_API_KEY: "synthetic-ambient-key",
    });
    expect(env.OPENAI_BASE_URL).toBe("https://project-eval.invalid/v1");
    expect(env.OPENAI_API_KEY).toBe("synthetic-global-eval-key");
  });

  it("uses the Anthropic variable pair when the stage is anthropic-compatible", () => {
    setStoredModelConfig({});
    const env = collectAgentEnvForTest(
      { eval: { apiType: "anthropic", baseUrl: "https://anthropic-style.invalid" } },
      { ...GLOBAL_ENV, ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://anthropic-style.invalid");
    expect(env.OPENAI_BASE_URL).not.toBe("https://anthropic-style.invalid");
  });
});

describe("consumer 2: the Phase-1 courtroom", () => {
  it("gives nodes 0-3 and the PI court the same endpoint", () => {
    // These are two independent resolution paths for one stage. They drifted
    // once already: the gateway ignored project overrides while the PI court
    // honored them, so half the courtroom ran on a different endpoint.
    const project = projectConfig();
    const gateway = loadGatewayConfig(GLOBAL_ENV, "phase1", project);
    const court = piConnectionFor("phase1", GLOBAL_ENV, project);

    expect(gateway.baseUrl).toBe("https://project-phase1.invalid/v1");
    expect(gateway.baseUrl).toBe(court.baseUrl);
    expect(gateway.model).toBe(court.model);
  });

  it("does not leak the eval or phase2 endpoint into phase1", () => {
    const gateway = loadGatewayConfig(GLOBAL_ENV, "phase1", projectConfig());
    expect(gateway.baseUrl).not.toContain("eval");
    expect(gateway.baseUrl).not.toContain("phase2");
  });
});

describe("consumer 3: the Phase-2 campaign", () => {
  it("resolves the phase2 stage, not the phase1 default", () => {
    // ModelGateway.fromEnv defaults to phase1. The Phase-2 wiring has to pass
    // its stage explicitly or a separately configured Phase-2 endpoint is
    // ignored and the campaign bills Phase-1's provider.
    const analyst = loadGatewayConfig(GLOBAL_ENV, "phase2", projectConfig());
    const board = piConnectionFor("phase2", GLOBAL_ENV, projectConfig());

    expect(analyst.baseUrl).toBe("https://project-phase2.invalid/v1");
    expect(analyst.baseUrl).toBe(board.baseUrl);
    expect(analyst.model).toBe("project-phase2-model");
  });

  it("keeps a phase2-only override from moving phase1", () => {
    const only2 = parseStoredModelConfig({ phase2: { baseUrl: "https://p2-only.invalid/v1" } });
    expect(loadGatewayConfig(GLOBAL_ENV, "phase2", only2).baseUrl).toBe("https://p2-only.invalid/v1");
    expect(loadGatewayConfig(GLOBAL_ENV, "phase1", only2).baseUrl).toBe("https://global-phase1.invalid/v1");
  });
});

// ---------------------------------------------------------------------------
// Live half: does the resolved config actually reach the operator's provider?
// ---------------------------------------------------------------------------

function loadSecretEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const SECRETS = loadSecretEnv("/work/agenteval/data/secrets/deepseek.env");
const LIVE = Boolean(SECRETS.OPENAI_API_KEY && SECRETS.OPENAI_BASE_URL);

describe.runIf(LIVE)("live: the configured provider is the one contacted", () => {
  it("reaches the operator's endpoint through project config", async () => {
    // The project names the real endpoint while the environment points
    // somewhere else, so only a working override can reach the provider.
    const project = parseStoredModelConfig({
      phase1: { baseUrl: SECRETS.OPENAI_BASE_URL, model: SECRETS.AGENTEVAL_DEFAULT_MODEL || "deepseek-v4-flash" },
    });
    const env = {
      AGENTEVAL_PHASE1_BASE_URL: "https://never-contacted.invalid/v1",
      AGENTEVAL_PHASE1_API_KEY: SECRETS.OPENAI_API_KEY,
    } as NodeJS.ProcessEnv;

    const cfg = loadGatewayConfig(env, "phase1", project);
    expect(cfg.baseUrl).toBe(SECRETS.OPENAI_BASE_URL!.replace(/\/+$/, ""));

    const gateway = new ModelGateway(cfg);
    let outcome = "";
    try {
      await gateway.chat({
        attemptId: "att_config_probe",
        node: "config-probe",
        metricOrRole: "probe",
        maxTokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });
      outcome = "answered";
    } catch (err) {
      outcome = err instanceof Error ? err.message : String(err);
    }

    // A refusal from the operator's provider (balance, quota, auth) proves the
    // request arrived there. A DNS or connection error against the .invalid
    // host would mean the override never applied.
    expect(outcome).not.toMatch(/never-contacted\.invalid|ENOTFOUND|EAI_AGAIN/);
    // eslint-disable-next-line no-console
    console.log(`[live] ${cfg.baseUrl} model=${cfg.model} -> ${outcome.slice(0, 120)}`);
  }, 120_000);
});

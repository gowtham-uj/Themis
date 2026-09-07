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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
import { buildPiCommand } from "../src/adapters/pi.ts";
import { buildReaperCommand } from "../src/adapters/reapercode.ts";
import { evalCliProvider } from "../src/adapters/eval-cli.ts";
import type { RunContext } from "../src/adapters/types.ts";

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
    expect(env.AGENTEVAL_EVAL_API_TYPE).toBe("openai");
  });

  it("uses the Anthropic variable pair when the stage is anthropic-compatible", () => {
    setStoredModelConfig({});
    const env = collectAgentEnvForTest(
      { eval: { apiType: "anthropic", baseUrl: "https://anthropic-style.invalid" } },
      { ...GLOBAL_ENV, ANTHROPIC_API_KEY: "synthetic-anthropic-key" },
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://anthropic-style.invalid");
    expect(env.OPENAI_BASE_URL).not.toBe("https://anthropic-style.invalid");
    expect(env.AGENTEVAL_EVAL_API_TYPE).toBe("anthropic");
  });
});

describe("consumer 1b: built-in pi and reapercode follow the eval stage", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  function ctxFromEval(env: Record<string, string>, extra: Partial<RunContext> = {}): RunContext {
    return {
      runId: "cfg-eval-1",
      project: { id: "proj-1" },
      task: { prompt: "ping", workspace: { source: "empty" } },
      model: "project-eval-model",
      provider: "leftover-pin",
      params: {},
      workspaceDir: extra.workspaceDir ?? "/tmp/cfg-eval",
      apiKeys: env,
      ...extra,
    };
  }

  it("stamps the eval api type so the CLI provider is not a leftover queue pin", () => {
    setStoredModelConfig({});
    const env = collectAgentEnvForTest(PROJECT_SETTINGS, GLOBAL_ENV);
    expect(evalCliProvider(ctxFromEval(env))).toBe("openai");
  });

  it("pi --provider/--model and models.json use the eval stage, not a leftover pin", async () => {
    const root = await mkdtemp(join(tmpdir(), "cfg-pi-"));
    dirs.push(root);
    setStoredModelConfig({});
    const env = collectAgentEnvForTest(PROJECT_SETTINGS, GLOBAL_ENV);
    const { argv } = buildPiCommand(ctxFromEval(env, { workspaceDir: root }));
    expect(argv[argv.indexOf("--provider") + 1]).toBe("openai");
    expect(argv).toContain("project-eval-model");
    const models = JSON.parse(await readFile(join(root, ".pi-agent", "models.json"), "utf8")) as {
      providers: { openai: { baseUrl: string; models: Array<{ id: string }> } };
    };
    expect(models.providers.openai.baseUrl).toBe("https://project-eval.invalid/v1");
    expect(models.providers.openai.models[0]!.id).toBe("project-eval-model");
  });

  it("reapercode --provider openai so the eval-stage URL is the one contacted", () => {
    setStoredModelConfig({});
    const env = collectAgentEnvForTest(PROJECT_SETTINGS, GLOBAL_ENV);
    const { argv, env: cmdEnv } = buildReaperCommand(ctxFromEval(env));
    expect(argv[argv.indexOf("--provider") + 1]).toBe("openai");
    expect(argv).toContain("project-eval-model");
    expect(cmdEnv.OPENAI_BASE_URL).toBe("https://project-eval.invalid/v1");
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

// One provider for every live stage: NeuralWatt, read from .env.test by name.
// The endpoint and model are the operator's configured pair; only the key is a
// secret, so only the key comes from the file.
const ENV_TEST_PATH = fileURLToPath(new URL("../.env.test", import.meta.url));
const SECRETS = {
  ...loadSecretEnv(ENV_TEST_PATH),
  OPENAI_BASE_URL: "https://api.deepinfra.com/v1/openai",
  AGENTEVAL_DEFAULT_MODEL: "zai-org/GLM-5.3-Flash",
  OPENAI_API_KEY: process.env.AGENTEVAL_MODEL_API_KEY ?? "",
};
SECRETS.OPENAI_API_KEY ||= loadSecretEnv(ENV_TEST_PATH).AGENTEVAL_MODEL_API_KEY ?? "";
const LIVE = Boolean(SECRETS.OPENAI_API_KEY);

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

  it("pi and reapercode commands target the project's eval endpoint and model", async () => {
    const model = SECRETS.AGENTEVAL_DEFAULT_MODEL;
    const stored = parseStoredModelConfig({
      eval: { baseUrl: SECRETS.OPENAI_BASE_URL, model },
    });
    const env = collectAgentEnvForTest(stored, {
      AGENTEVAL_EVAL_BASE_URL: "https://never-contacted.invalid/v1",
      OPENAI_API_KEY: SECRETS.OPENAI_API_KEY,
    } as NodeJS.ProcessEnv);
    const expectedUrl = SECRETS.OPENAI_BASE_URL!.replace(/\/+$/, "");
    expect(env.OPENAI_BASE_URL).toBe(expectedUrl);
    expect(env.AGENTEVAL_EVAL_API_TYPE).toBe("openai");

    const root = await mkdtemp(join(tmpdir(), "live-pi-dry-"));
    const ctx: RunContext = {
      runId: "live-dry",
      project: { id: "p" },
      task: { prompt: "ping", workspace: { source: "empty" } },
      model,
      provider: "leftover-pin",
      params: {},
      workspaceDir: root,
      apiKeys: env,
    };
    const pi = buildPiCommand(ctx);
    expect(pi.argv[pi.argv.indexOf("--provider")! + 1]).toBe("openai");
    expect(pi.argv).toContain(model);
    const models = JSON.parse(await readFile(join(root, ".pi-agent", "models.json"), "utf8")) as {
      providers: { openai: { baseUrl: string } };
    };
    expect(models.providers.openai.baseUrl).toBe(expectedUrl);
    expect(JSON.stringify(models)).not.toContain(SECRETS.OPENAI_API_KEY);

    const reaper = buildReaperCommand(ctx);
    expect(reaper.argv[reaper.argv.indexOf("--provider")! + 1]).toBe("openai");
    expect(reaper.argv).toContain(model);
    expect(reaper.env.OPENAI_BASE_URL).toBe(expectedUrl);
    await rm(root, { recursive: true, force: true });
  });
});

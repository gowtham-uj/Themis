/**
 * Gateway configuration, resolved through the unified per-stage model config.
 * Base URL / key / model are never hardcoded as production secrets.
 */

import { resolveModelConfig, type ModelStage } from "../../config/model-config.js";
import { GatewayError } from "./errors.js";

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Default reasoning effort for Themis calls. */
  reasoningEffort: string;
  /** Floor on max_tokens so reasoning cannot consume the entire budget. */
  maxTokensFloor: number;
  timeoutMs: number;
}

/**
 * Load one stage's OpenAI-compatible gateway config.
 *
 * Defaults to the Phase-1 stage because every existing caller is a Phase-1
 * path. Phase 2 passes "phase2" so the two can point at different endpoints.
 */
export function loadGatewayConfig(
  env: NodeJS.ProcessEnv = process.env,
  stage: ModelStage = "phase1",
): GatewayConfig {
  let cfg;
  try {
    cfg = resolveModelConfig(stage, { env });
  } catch (err) {
    throw new GatewayError(err instanceof Error ? err.message : String(err), "config");
  }
  if (cfg.apiType !== "openai") {
    throw new GatewayError(
      `the ${stage} model is configured as ${cfg.apiType}-compatible, but the judge gateway speaks OpenAI Chat Completions`,
      "config",
    );
  }
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    reasoningEffort: cfg.reasoningEffort,
    maxTokensFloor: cfg.maxTokensFloor,
    timeoutMs: cfg.timeoutMs,
  };
}

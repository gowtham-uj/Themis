/**
 * Gateway configuration from the environment only.
 * Base URL / key / model are never hardcoded as production secrets.
 */

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

/** Load OpenAI-compatible gateway config from env. */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const baseUrl = (env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || "";
  if (!baseUrl) {
    throw new GatewayError(
      "OPENAI_BASE_URL (or DEEPSEEK_BASE_URL) is required for the judge model gateway",
      "config",
    );
  }
  if (!apiKey) {
    throw new GatewayError(
      "OPENAI_API_KEY (or DEEPSEEK_API_KEY) is required for the judge model gateway",
      "config",
    );
  }
  const floor = Number(env.THEMIS_MAX_TOKENS_FLOOR ?? 2048);
  return {
    baseUrl,
    apiKey,
    model: env.AGENTEVAL_DEFAULT_MODEL || env.THEMIS_MODEL || "deepseek-v4-flash",
    reasoningEffort: env.THEMIS_REASONING_EFFORT || "max",
    maxTokensFloor: Number.isFinite(floor) && floor > 0 ? floor : 2048,
    timeoutMs: Number(env.THEMIS_GATEWAY_TIMEOUT_MS ?? 300_000) || 300_000,
  };
}

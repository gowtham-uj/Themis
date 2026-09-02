/**
 * Live health check for one model stage.
 *
 * Config presence is not health. The existing /api/judge/health only reports
 * whether env vars parse, which passes happily against a dead endpoint, a
 * revoked key, or a model id the provider does not serve. This sends a real
 * minimal completion and reports what came back.
 */

import { resolveModelConfig, ModelConfigError, type ModelStage, type ModelStageConfig } from "./model-config.js";

export interface ModelHealthResult {
  stage: ModelStage;
  ok: boolean;
  /** API compatibility type used for the probe. */
  apiType: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  /** Round-trip time for the probe request. */
  latencyMs: number | null;
  /** HTTP status, when the request reached the endpoint. */
  status: number | null;
  /** What the model replied, truncated. Present only on success. */
  reply: string | null;
  /** Failure cause: config, transport, auth, http, or response. */
  errorKind: "config" | "transport" | "auth" | "http" | "response" | null;
  error: string | null;
}

const PROBE = "Reply with exactly OK.";
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Send one small completion to a stage's configured endpoint. Never throws:
 * every failure is reported as a typed result so the console can render it.
 */
export async function checkModelHealth(
  stage: ModelStage,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<ModelHealthResult> {
  let cfg: ModelStageConfig;
  try {
    cfg = resolveModelConfig(stage, { env: opts.env });
  } catch (err) {
    return {
      stage,
      ok: false,
      apiType: "openai",
      baseUrl: "",
      model: "",
      latencyMs: null,
      status: null,
      reply: null,
      errorKind: "config",
      error: err instanceof ModelConfigError ? err.message : String(err),
    };
  }

  const base: Omit<ModelHealthResult, "ok" | "latencyMs" | "status" | "reply" | "errorKind" | "error"> = {
    stage,
    apiType: cfg.apiType,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const anthropic = cfg.apiType === "anthropic";
  const url = anthropic ? `${cfg.baseUrl}/v1/messages` : `${cfg.baseUrl}/chat/completions`;
  const headers: Record<string, string> = anthropic
    ? { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
    : { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` };
  const body = anthropic
    ? { model: cfg.model, max_tokens: 16, messages: [{ role: "user", content: PROBE }] }
    : { model: cfg.model, max_tokens: 16, messages: [{ role: "user", content: PROBE }] };

  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - started,
      status: null,
      reply: null,
      errorKind: "transport",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const latencyMs = Date.now() - started;
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      ...base,
      ok: false,
      latencyMs,
      status: response.status,
      reply: null,
      errorKind: "response",
      error: "endpoint returned a non-JSON body",
    };
  }

  if (!response.ok) {
    const message = errorMessage(raw) ?? `HTTP ${response.status}`;
    return {
      ...base,
      ok: false,
      latencyMs,
      status: response.status,
      reply: null,
      errorKind: response.status === 401 || response.status === 403 ? "auth" : "http",
      error: message,
    };
  }

  const reply = anthropic ? anthropicText(raw) : openaiText(raw);
  if (reply === null) {
    return {
      ...base,
      ok: false,
      latencyMs,
      status: response.status,
      reply: null,
      errorKind: "response",
      error: `endpoint replied 200 with no message content, which usually means the ${cfg.apiType} API compatibility type is wrong for this URL`,
    };
  }

  return {
    ...base,
    ok: true,
    latencyMs,
    status: response.status,
    reply: reply.slice(0, 200),
    errorKind: null,
    error: null,
  };
}

function errorMessage(raw: unknown): string | null {
  const err = (raw as { error?: { message?: unknown } } | null)?.error;
  return typeof err?.message === "string" ? err.message : null;
}

function openaiText(raw: unknown): string | null {
  const choice = (raw as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : null;
}

function anthropicText(raw: unknown): string | null {
  const blocks = (raw as { content?: { type?: string; text?: unknown }[] } | null)?.content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks.find((b) => b?.type === "text")?.text;
  return typeof text === "string" ? text : null;
}

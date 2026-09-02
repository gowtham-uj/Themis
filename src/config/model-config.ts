/**
 * Unified model provider configuration.
 *
 * Three stages each get their own independent provider config, so an operator
 * can run evals against one endpoint and judge them with another:
 *
 *   eval    the model the agent under test runs against
 *   phase1  the Phase-1 courtroom (nodes 0-4, kratos/logos/minos/remedy)
 *   phase2  the Phase-2 campaign orchestrator and its four subagents
 *
 * Every stage declares its API compatibility type, so a caller knows whether
 * the endpoint speaks OpenAI Chat Completions or Anthropic Messages without
 * guessing from the provider name.
 *
 * Resolution order per field, first hit wins:
 *
 *   1. stored config (settings table, editable from the console)
 *   2. the stage's own env var, e.g. AGENTEVAL_PHASE1_BASE_URL
 *   3. the legacy shared env var, e.g. OPENAI_BASE_URL
 *   4. a built-in default
 *
 * API keys are the exception and are never stored. The stored config names an
 * environment variable; the value is read from the process environment at use
 * time. That keeps credentials out of the database, out of API responses, and
 * out of anything this process writes to disk.
 */

/** API compatibility type: which wire format the endpoint speaks. */
export type ModelApiType = "openai" | "anthropic";

/** The three independently configured model stages. */
export type ModelStage = "eval" | "phase1" | "phase2";

export const MODEL_STAGES: readonly ModelStage[] = ["eval", "phase1", "phase2"];

/** One stage's fully resolved provider config. */
export interface ModelStageConfig {
  stage: ModelStage;
  apiType: ModelApiType;
  /** Endpoint root with any trailing slashes removed. */
  baseUrl: string;
  /** Resolved secret. Never serialize this. */
  apiKey: string;
  /** Environment variable the key was read from, for display and diagnostics. */
  apiKeyEnv: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  /** Floor on max_tokens so reasoning cannot consume the whole output budget. */
  maxTokensFloor: number;
}

/**
 * The editable half of a stage config. Absent fields fall through to env.
 * There is deliberately no apiKey field: only the variable name is stored.
 */
export interface StoredStageConfig {
  apiType?: ModelApiType;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export type StoredModelConfig = Partial<Record<ModelStage, StoredStageConfig>>;

/** Raised when a stage has no usable endpoint or credential. */
export class ModelConfigError extends Error {
  constructor(
    message: string,
    readonly stage: ModelStage,
    readonly field: "baseUrl" | "apiKey" | "apiType",
  ) {
    super(message);
    this.name = "ModelConfigError";
  }
}

const ENV_PREFIX: Record<ModelStage, string> = {
  eval: "AGENTEVAL_EVAL",
  phase1: "AGENTEVAL_PHASE1",
  phase2: "AGENTEVAL_PHASE2",
};

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_EFFORT = "max";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_TOKENS_FLOOR = 2048;

/**
 * Key env vars tried in order when a stage names none. Kept in one place so
 * the eval, Phase-1, and Phase-2 paths cannot drift apart the way the three
 * hand-rolled fallback chains they replace did.
 */
const LEGACY_KEY_ENVS: Record<ModelApiType, readonly string[]> = {
  openai: ["OPENAI_API_KEY", "DEEPSEEK_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
};

const LEGACY_BASE_URL_ENVS: Record<ModelApiType, readonly string[]> = {
  openai: ["OPENAI_BASE_URL", "DEEPSEEK_BASE_URL"],
  anthropic: ["ANTHROPIC_BASE_URL"],
};

// Process-level stored config. The server loads it from the settings table at
// startup and replaces it when the console saves, so worker paths with no
// QueryStore in scope still resolve what the operator configured.
let storedConfig: StoredModelConfig = {};

/** Install the stored config for this process. */
export function setStoredModelConfig(config: StoredModelConfig): void {
  storedConfig = config ?? {};
}

/** Read back the stored config. Contains no secrets. */
export function getStoredModelConfig(): StoredModelConfig {
  return storedConfig;
}

function parseApiType(value: string | undefined, stage: ModelStage): ModelApiType | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "openai" || v === "openai-compatible" || v === "openai_compatible") return "openai";
  if (v === "anthropic" || v === "anthropic-compatible" || v === "anthropic_compatible") return "anthropic";
  throw new ModelConfigError(
    `unknown API compatibility type "${value}" for stage ${stage}; expected "openai" or "anthropic"`,
    stage,
    "apiType",
  );
}

function firstEnv(env: NodeJS.ProcessEnv, names: readonly string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name];
    if (value) return { name, value };
  }
  return null;
}

function positiveInt(value: string | number | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve one stage's provider config. Throws ModelConfigError when the stage
 * has no base URL or no credential, since both are required to reach a model.
 */
export function resolveModelConfig(
  stage: ModelStage,
  opts: { env?: NodeJS.ProcessEnv; stored?: StoredModelConfig } = {},
): ModelStageConfig {
  const env = opts.env ?? process.env;
  const stored = (opts.stored ?? storedConfig)[stage] ?? {};
  const p = ENV_PREFIX[stage];

  const apiType =
    stored.apiType ??
    parseApiType(env[`${p}_API_TYPE`], stage) ??
    "openai";

  const baseUrl = (
    stored.baseUrl ||
    env[`${p}_BASE_URL`] ||
    firstEnv(env, LEGACY_BASE_URL_ENVS[apiType])?.value ||
    ""
  ).replace(/\/+$/, "");
  if (!baseUrl) {
    throw new ModelConfigError(
      `no base URL for the ${stage} model. Set ${p}_BASE_URL or configure it in the console.`,
      stage,
      "baseUrl",
    );
  }

  // Direct key env var wins, then the named variable, then the legacy chain.
  let apiKey = env[`${p}_API_KEY`] ?? "";
  let apiKeyEnv = apiKey ? `${p}_API_KEY` : "";
  if (!apiKey) {
    const named = stored.apiKeyEnv || env[`${p}_API_KEY_ENV`];
    if (named) {
      apiKey = env[named] ?? "";
      apiKeyEnv = named;
    }
  }
  if (!apiKey) {
    const legacy = firstEnv(env, LEGACY_KEY_ENVS[apiType]);
    if (legacy) {
      apiKey = legacy.value;
      apiKeyEnv = legacy.name;
    }
  }
  if (!apiKey) {
    throw new ModelConfigError(
      `no API key for the ${stage} model. Set ${p}_API_KEY, or name the variable holding it with ${p}_API_KEY_ENV.`,
      stage,
      "apiKey",
    );
  }

  return {
    stage,
    apiType,
    baseUrl,
    apiKey,
    apiKeyEnv,
    model:
      stored.model ||
      env[`${p}_MODEL`] ||
      env.AGENTEVAL_DEFAULT_MODEL ||
      env.THEMIS_MODEL ||
      DEFAULT_MODEL,
    reasoningEffort:
      stored.reasoningEffort ||
      env[`${p}_REASONING_EFFORT`] ||
      env.THEMIS_REASONING_EFFORT ||
      DEFAULT_EFFORT,
    timeoutMs: positiveInt(
      stored.timeoutMs ?? env[`${p}_TIMEOUT_MS`] ?? env.THEMIS_GATEWAY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    maxTokensFloor: positiveInt(env.THEMIS_MAX_TOKENS_FLOOR, DEFAULT_TOKENS_FLOOR),
  };
}

/** One stage as the console sees it. Carries no secret value. */
export interface ModelStageView {
  stage: ModelStage;
  apiType: ModelApiType;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  /** Variable the key comes from, or null when nothing resolved. */
  apiKeyEnv: string | null;
  apiKeyPresent: boolean;
  /** Env var names this stage reads, so the console can show the setup. */
  envVars: {
    apiType: string;
    baseUrl: string;
    apiKey: string;
    apiKeyEnv: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: string;
  };
  /** Why the stage cannot reach a model, when it cannot. */
  error: string | null;
}

/** Describe one stage for the console. Never includes the key itself. */
export function viewModelConfig(
  stage: ModelStage,
  opts: { env?: NodeJS.ProcessEnv; stored?: StoredModelConfig } = {},
): ModelStageView {
  const env = opts.env ?? process.env;
  const stored = (opts.stored ?? storedConfig)[stage] ?? {};
  const p = ENV_PREFIX[stage];
  const envVars = {
    apiType: `${p}_API_TYPE`,
    baseUrl: `${p}_BASE_URL`,
    apiKey: `${p}_API_KEY`,
    apiKeyEnv: `${p}_API_KEY_ENV`,
    model: `${p}_MODEL`,
    reasoningEffort: `${p}_REASONING_EFFORT`,
    timeoutMs: `${p}_TIMEOUT_MS`,
  };
  try {
    const cfg = resolveModelConfig(stage, opts);
    return {
      stage,
      apiType: cfg.apiType,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      reasoningEffort: cfg.reasoningEffort,
      timeoutMs: cfg.timeoutMs,
      apiKeyEnv: cfg.apiKeyEnv || null,
      apiKeyPresent: true,
      envVars,
      error: null,
    };
  } catch (err) {
    let apiType: ModelApiType = "openai";
    try {
      apiType = stored.apiType ?? parseApiType(env[envVars.apiType], stage) ?? "openai";
    } catch {
      // An unparseable type is already the reported error.
    }
    return {
      stage,
      apiType,
      baseUrl: (stored.baseUrl || env[envVars.baseUrl] || firstEnv(env, LEGACY_BASE_URL_ENVS[apiType])?.value || "").replace(/\/+$/, ""),
      model: stored.model || env[envVars.model] || env.AGENTEVAL_DEFAULT_MODEL || DEFAULT_MODEL,
      reasoningEffort: stored.reasoningEffort || env[envVars.reasoningEffort] || DEFAULT_EFFORT,
      timeoutMs: positiveInt(stored.timeoutMs ?? env[envVars.timeoutMs], DEFAULT_TIMEOUT_MS),
      apiKeyEnv: stored.apiKeyEnv || env[envVars.apiKeyEnv] || null,
      apiKeyPresent: false,
      envVars,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Validate and normalize a console-supplied stage patch. */
export function parseStoredStageConfig(body: unknown, stage: ModelStage): StoredStageConfig {
  if (body === null || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: StoredStageConfig = {};

  if (b.apiType !== undefined && b.apiType !== null && b.apiType !== "") {
    const f = parseApiType(String(b.apiType), stage);
    if (f) out.apiType = f;
  }
  for (const field of ["baseUrl", "apiKeyEnv", "model", "reasoningEffort"] as const) {
    const v = b[field];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) out[field] = field === "baseUrl" ? s.replace(/\/+$/, "") : s;
  }
  if (b.timeoutMs !== undefined && b.timeoutMs !== null && b.timeoutMs !== "") {
    out.timeoutMs = positiveInt(b.timeoutMs as string | number, DEFAULT_TIMEOUT_MS);
  }

  // An apiKey in the body is a mistake worth failing loudly on: secrets belong
  // in the environment, and this value would otherwise land in the database.
  if ("apiKey" in b && b.apiKey) {
    throw new ModelConfigError(
      `API key values are never stored. Set the key in the environment and name the variable with apiKeyEnv.`,
      stage,
      "apiKey",
    );
  }
  return out;
}

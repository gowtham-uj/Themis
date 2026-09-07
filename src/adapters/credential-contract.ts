/**
 * The credential contract between an adapter author and the platform.
 *
 * An adapter declares which environment variable names it wants its CLI to see
 * and which harness credential should fill each one:
 *
 *   provider_config.credentialEnv[<provider> | "default"][AGENT_VAR] = HARNESS_NAME
 *
 * The platform then supplies HARNESS_NAME from one of two places, in this order:
 *
 *   1. the project's `eval` stage config, which stamps the configured endpoint
 *      and key into the conventional variables for its API type
 *   2. the process environment, for the harness names listed below
 *
 * This module is the single list of harness names. It used to exist three
 * times over (the runner's harvest, the validate endpoint's sample context, and
 * the model config's legacy fallbacks), and those copies had already drifted:
 * the validate endpoint was missing four names the runner supplies, so a dry
 * run reported variables as absent that a real run would have set.
 *
 * Values never appear here, and no value is ever stored. The stored config
 * names a variable; the value is read from the process environment at use time.
 */

import { MODEL_STAGES, type ModelApiType } from "../config/model-config.js";

/** What a harness credential name is for, shown to adapter authors. */
export interface HarnessCredential {
  name: string;
  /** Which wire format this belongs to, or null for provider-specific keys. */
  apiType: ModelApiType | null;
  /** True when the eval stage config can populate it. */
  stageManaged: boolean;
  description: string;
}

/**
 * Every name the platform can hand an adapter.
 *
 * `stageManaged` entries are the ones a project's eval stage config fills in,
 * so an adapter mapping those follows whatever the console is set to. The rest
 * pass through from the server process environment only.
 */
export const HARNESS_CREDENTIALS: readonly HarnessCredential[] = [
  {
    name: "OPENAI_BASE_URL",
    apiType: "openai",
    stageManaged: true,
    description: "Endpoint root for an OpenAI Chat Completions compatible provider.",
  },
  {
    name: "OPENAI_API_KEY",
    apiType: "openai",
    stageManaged: true,
    description: "Key for an OpenAI-compatible provider.",
  },
  {
    name: "ANTHROPIC_BASE_URL",
    apiType: "anthropic",
    stageManaged: true,
    description: "Endpoint root for an Anthropic Messages compatible provider.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    apiType: "anthropic",
    stageManaged: true,
    description: "Key for an Anthropic-compatible provider.",
  },
  {
    name: "ANTHROPIC_AUTH_TOKEN",
    apiType: "anthropic",
    stageManaged: true,
    description: "Alternate Anthropic credential. Mirrors ANTHROPIC_API_KEY when only one is set.",
  },
  {
    name: "DEEPSEEK_API_KEY",
    apiType: "openai",
    stageManaged: false,
    description: "DeepSeek key, passed through from the server environment.",
  },
  {
    name: "OPENAI_CODEX_ACCESS_TOKEN",
    apiType: null,
    stageManaged: false,
    description: "Codex CLI access token.",
  },
  {
    name: "MINIMAX_API_KEY",
    apiType: null,
    stageManaged: false,
    description: "MiniMax key.",
  },
  {
    name: "AGENTEVAL_MODEL_API_KEY",
    apiType: null,
    stageManaged: false,
    description:
      "Endpoint-neutral key variable. Point a stage's API key variable at this name when one key serves every stage.",
  },
];

/** Just the names, for harvesting and membership checks. */
export const HARNESS_CREDENTIAL_NAMES: readonly string[] = HARNESS_CREDENTIALS.map((c) => c.name);

/** The variables the eval stage config writes, by API type. */
export function stageManagedNames(apiType: ModelApiType): string[] {
  return HARNESS_CREDENTIALS.filter((c) => c.stageManaged && c.apiType === apiType).map(
    (c) => c.name,
  );
}

/** True when the platform can supply this harness credential name. */
export function isKnownHarnessCredential(name: string): boolean {
  return HARNESS_CREDENTIAL_NAMES.includes(name);
}

/** One problem found in an adapter's credentialEnv declaration. */
export interface CredentialEnvProblem {
  provider: string;
  agentVar: string;
  harnessName: string;
  message: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Check a `provider_config.credentialEnv` block against the contract.
 *
 * A source name the platform never supplies produced no variable at all, with
 * no error anywhere: the adapter simply ran unauthenticated and failed later
 * inside the container with a generic "no real model response". Surfacing it at
 * adapter-write time is the whole point of this function.
 */
export function validateCredentialEnv(providerConfig: unknown): CredentialEnvProblem[] {
  const problems: CredentialEnvProblem[] = [];
  if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
    return problems;
  }
  const credentialEnv = (providerConfig as Record<string, unknown>).credentialEnv;
  if (!credentialEnv || typeof credentialEnv !== "object" || Array.isArray(credentialEnv)) {
    return problems;
  }
  for (const [provider, bucket] of Object.entries(credentialEnv as Record<string, unknown>)) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
      problems.push({
        provider,
        agentVar: "",
        harnessName: "",
        message: `credentialEnv.${provider} must be an object of { AGENT_VAR: HARNESS_NAME }`,
      });
      continue;
    }
    for (const [agentVar, harnessName] of Object.entries(bucket as Record<string, unknown>)) {
      if (!ENV_NAME.test(agentVar)) {
        problems.push({
          provider,
          agentVar,
          harnessName: String(harnessName),
          message: `"${agentVar}" is not a valid environment variable name`,
        });
        continue;
      }
      if (typeof harnessName !== "string") {
        problems.push({
          provider,
          agentVar,
          harnessName: String(harnessName),
          message: `credentialEnv.${provider}.${agentVar} must name a harness credential as a string`,
        });
        continue;
      }
      if (!isKnownHarnessCredential(harnessName)) {
        problems.push({
          provider,
          agentVar,
          harnessName,
          message:
            `the platform never supplies "${harnessName}", so ${agentVar} would be unset at runtime. ` +
            `Available: ${HARNESS_CREDENTIAL_NAMES.join(", ")}`,
        });
      }
    }
  }
  return problems;
}

/** The contract as the generator and docs endpoints publish it. */
export function credentialContractDoc(): Record<string, unknown> {
  return {
    shape: "provider_config.credentialEnv[<provider> | 'default'][AGENT_VAR] = HARNESS_NAME",
    provider_lookup:
      "The bucket named by the queue's provider is used when present, otherwise 'default'. " +
      "Buckets do not merge: a provider bucket replaces 'default' entirely.",
    stages: MODEL_STAGES,
    note:
      "Variables marked stage_managed are filled from the project's eval stage config " +
      "(API type, base URL, key env name, model). Map those and the adapter follows whatever " +
      "the console is set to. The rest pass through from the server environment only.",
    credentials: HARNESS_CREDENTIALS.map((c) => ({
      name: c.name,
      api_type: c.apiType,
      stage_managed: c.stageManaged,
      description: c.description,
    })),
  };
}

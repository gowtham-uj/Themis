/**
 * CLI provider id for built-in pi and ReaperCode.
 *
 * Both CLIs have a provider flag that selects which env pair they read.
 * `openai` reads OPENAI_BASE_URL / OPENAI_API_KEY; `anthropic` reads the
 * Anthropic pair. The eval stage overlay writes exactly one of those pairs
 * and stamps AGENTEVAL_EVAL_API_TYPE so this function does not guess from
 * leftover queue pins (a previous default of `nuralwatt` would otherwise
 * send Reaper at a hardcoded host and ignore the project's URL).
 *
 * Model id is not chosen here. It stays `ctx.model`, which the queue copies
 * from the same eval stage when the operator has not pinned a different one.
 */
import type { RunContext } from "./types.js";

export function evalCliProvider(ctx: RunContext): string {
  const apiType = ctx.apiKeys.AGENTEVAL_EVAL_API_TYPE;
  if (apiType === "openai" || apiType === "anthropic") return apiType;
  return ctx.provider;
}

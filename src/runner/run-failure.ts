/**
 * Classify why an eval run failed by scanning the recorded error and the raw
 * agent output for well-known provider/model failure signatures. The goal is a
 * documented, human-readable reason (esp. provider/token exhaustion) rather
 * than a generic "failed" that leaves operators guessing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface RunFailureClassification {
  /** Stable, machine-readable failure category (e.g. "provider_quota"). */
  category: string;
  /** One crisp sentence an operator reads to understand the failure. */
  reason: string;
}

interface Signature {
  category: string;
  reason: string;
  /** Case-insensitive substrings to match (searched in error + raw output). */
  patterns: string[];
}

const SIGNATURES: Signature[] = [
  {
    category: "provider_quota_exhausted",
    reason: "Provider/model quota or credits exhausted (billing limit hit); the model could not be invoked.",
    patterns: [
      "payment required",
      "402",
      "payment_required",
      "insufficient_quota",
      "not enough credits",
      "billing",
      "quota exceeded",
      "out of quota",
      "insufficient balance",
      "account balance",
    ],
  },
  {
    category: "provider_rate_limited",
    reason: "Provider rate limited the request (429/too many requests); transient — retry may succeed.",
    patterns: [
      "rate limit",
      "too many requests",
      "429",
      "rate_limit_exceeded",
      "requests_per_minute",
      "retry after",
    ],
  },
  {
    category: "context_length_exceeded",
    reason: "The model context window was exceeded; the conversation grew too large for the provider.",
    patterns: [
      "context length",
      "context_length_exceeded",
      "maximum context length",
      "token limit",
      "max_tokens",
      "context window exceeded",
      "prompt is too long",
      "input is too long",
      "400 context_length",
    ],
  },
  {
    category: "model_unavailable",
    reason: "The requested model/provider is unavailable, unconfigured, or returned an auth/not-found error.",
    patterns: [
      "model not found",
      "model_not_found",
      "invalid api key",
      "unauthorized",
      "401",
      "authentication",
      "invalid_api_key",
      "model does not support",
      "not registered",
      "unknown model",
      "model unavailable",
      "503",
    ],
  },
];

/**
 * Scan `error` and the runDir's raw agent output for a known provider/model
 * failure signature. Returns the best classification or a generic fallback
 * (only when the run actually failed).
 */
export async function classifyRunFailure(input: {
  runDir: string;
  error: string | null;
}): Promise<RunFailureClassification | null> {
  const { error, runDir } = input;
  // Compose the text to scan: the recorded error plus raw agent stdout/stderr.
  const parts: string[] = [];
  if (error) parts.push(error);
  for (const name of ["raw-stdout.log", "raw-stderr.log"]) {
    const content = await readFile(join(runDir, name), "utf8").catch(() => "");
    if (content) parts.push(content);
    // Cap scan reads so a huge trace does not blow memory.
    if (content) parts[parts.length - 1] = content.slice(0, 4 * 1024 * 1024);
  }
  const haystack = parts.join("\n");

  // Provider/token-exhaustion signatures take priority in order.
  for (const sig of SIGNATURES) {
    if (sig.patterns.some((p) => haystack.toLowerCase().includes(p.toLowerCase()))) {
      return { category: sig.category, reason: sig.reason };
    }
  }
  return null;
}

/** Typed gateway failures — never treat budget starvation as an empty answer. */

export type GatewayErrorCode =
  | "config"
  | "http"
  | "transport"
  | "reasoning_starved"
  | "schema"
  | "ledger"
  | "rate_limit"
  | "quota";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: GatewayErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  /** Quota/rate-limit errors must NOT burn a retry attempt. */
  get isRetryExempt(): boolean {
    return this.code === "rate_limit" || this.code === "quota";
  }
}

/**
 * Provider returned 429 or an explicit quota-exhausted signal. The queue
 * pauses with `provider_quota` / `provider_rate_limit` rather than failing.
 */
export class ProviderThrottledError extends GatewayError {
  constructor(message: string, readonly throttleKind: "rate_limit" | "quota", status: number) {
    super(message, throttleKind, status);
    this.name = "ProviderThrottledError";
  }
}

/** Model spent max_tokens on reasoning and emitted no content. */
export class ReasoningStarvedError extends GatewayError {
  constructor(message = "finish_reason=length with empty content (reasoning starved the budget)") {
    super(message, "reasoning_starved");
    this.name = "ReasoningStarvedError";
  }
}

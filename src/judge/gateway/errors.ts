/** Typed gateway failures — never treat budget starvation as an empty answer. */

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | "config"
      | "http"
      | "transport"
      | "reasoning_starved"
      | "schema"
      | "ledger",
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Model spent max_tokens on reasoning and emitted no content. */
export class ReasoningStarvedError extends GatewayError {
  constructor(message = "finish_reason=length with empty content (reasoning starved the budget)") {
    super(message, "reasoning_starved");
    this.name = "ReasoningStarvedError";
  }
}

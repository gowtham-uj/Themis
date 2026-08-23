/**
 * Sole OpenAI-compatible chat client for Themis judge roles.
 * Ledger row is created before the request leaves the process.
 */

import { createHash } from "node:crypto";

import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import { GatewayError, ReasoningStarvedError } from "./errors.js";
import {
  MemoryProviderOperationLedger,
  type ProviderOperationLedger,
} from "./ledger.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  /** Assistant messages carrying tool_calls (OpenAI-compatible wire shape). */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  attemptId: string;
  node: string;
  metricOrRole: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  reasoningEffort?: string;
  responseFormat?: "json_object" | null;
  temperature?: number;
  round?: number | null;
  roundExecutionId?: string | null;
  assignmentId?: string | null;
  tools?: ChatTool[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface ChatResult {
  operationId: string;
  content: string;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
  model: string;
  toolCalls: ChatToolCall[];
  raw: unknown;
}

function digestRequest(model: string, messages: ChatMessage[]): string {
  const payload = JSON.stringify({ model, messages });
  return createHash("sha256").update(payload).digest("hex");
}

export class ModelGateway {
  constructor(
    private readonly config: GatewayConfig,
    private readonly ledger: ProviderOperationLedger = new MemoryProviderOperationLedger(),
  ) {}

  /** Construct from process env. */
  static fromEnv(
    env?: NodeJS.ProcessEnv,
    ledger?: ProviderOperationLedger,
  ): ModelGateway {
    return new ModelGateway(loadGatewayConfig(env), ledger);
  }

  /** Chat completion with ledgered provider operation. */
  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? this.config.model;
    const effort = req.reasoningEffort ?? this.config.reasoningEffort;
    // Reasoning effort scales the effective floor: `max` reasoning can consume
    // thousands of tokens before any content, so a small cap starves the answer
    // (WP-6: reasoning budget is a correctness issue, not a tuning knob).
    const effortFloor = effort === "max" ? 8192 : this.config.maxTokensFloor;
    const maxTokens = Math.max(req.maxTokens ?? effortFloor, effortFloor);
    const digest = digestRequest(model, req.messages);

    const op = await this.ledger.create({
      attemptId: req.attemptId,
      node: req.node,
      metricOrRole: req.metricOrRole,
      round: req.round ?? null,
      roundExecutionId: req.roundExecutionId ?? null,
      assignmentId: req.assignmentId ?? null,
      canonicalRequestDigest: digest,
      provider: "openai-compatible",
      model,
    });

    const started = await this.ledger.transition(op.id, "not_started", "in_flight");
    if (!started) {
      throw new GatewayError("failed to mark provider operation in_flight", "ledger");
    }

    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      max_tokens: maxTokens,
      temperature: req.temperature ?? 0.2,
      reasoning_effort: effort,
    };
    if (req.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? "auto";
    }

    const fetchImpl = req.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      await this.ledger.transition(op.id, "in_flight", "unknown", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new GatewayError(
        `transport failure: ${err instanceof Error ? err.message : String(err)}`,
        "transport",
      );
    }

    let raw: any;
    try {
      raw = await response.json();
    } catch (err) {
      await this.ledger.transition(op.id, "in_flight", "unknown", {
        error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw new GatewayError("provider returned non-JSON body", "http");
    }

    if (!response.ok) {
      const msg = typeof raw?.error?.message === "string" ? raw.error.message : `HTTP ${response.status}`;
      await this.ledger.transition(op.id, "in_flight", "failed", { error: msg });
      throw new GatewayError(msg, "http");
    }

    const choice = raw?.choices?.[0] ?? {};
    const message = choice?.message ?? {};
    const content = typeof message.content === "string" ? message.content : "";
    const reasoning =
      typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : typeof message.reasoning === "string"
          ? message.reasoning
          : null;
    const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
    const usage = (raw?.usage as Record<string, unknown> | undefined) ?? null;

    const toolCallsRaw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ChatToolCall[] = toolCallsRaw
      .filter((t: any) => t && typeof t.id === "string" && t.function?.name)
      .map((t: any) => ({
        id: String(t.id),
        type: "function" as const,
        function: {
          name: String(t.function.name),
          arguments: String(t.function.arguments ?? "{}"),
        },
      }));

    if (
      (finishReason === "length" || finishReason === "max_tokens") &&
      content.trim() === "" &&
      toolCalls.length === 0
    ) {
      await this.ledger.transition(op.id, "in_flight", "failed", {
        error: "reasoning_starved",
        reasoningContent: reasoning,
        usage,
        authoritative: true,
      });
      throw new ReasoningStarvedError();
    }

    await this.ledger.transition(op.id, "in_flight", "succeeded", {
      usage,
      reasoningContent: reasoning,
      authoritative: true,
    });

    return {
      operationId: op.id,
      content,
      finishReason,
      usage,
      model,
      toolCalls,
      raw,
    };
  }
}

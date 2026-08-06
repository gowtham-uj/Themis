/**
 * Judge LLM provider seam + Anthropic Messages implementation.
 *
 * Injectable so offline tests use FakeJudgeProvider; production uses
 * AnthropicJudgeProvider (raw HTTP via fetch; ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_BASE_URL). NEVER logs request secrets.
 *
 * Spec: plan/judge.md, plan/roadmap.md Phase 4.
 */

import type { CanonicalEvent } from "../schema/events.js";
import { SCHEMA_VERSION } from "../schema/events.js";

/** Request payload for a single judge call. */
export interface JudgeRequest {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  provider: string;
  maxTokens?: number;
  /** Run id used when synthesizing canonical judge-log events. */
  judgementId?: string;
}

/** Result of a judge call — raw verdict text + events for the live judge log. */
export interface JudgeProviderResult {
  /** Raw model text expected to contain (or be) the verdict JSON. */
  verdictJson: string;
  /** Canonical events capturing the judge's own reasoning (thinking, etc.). */
  rawEvents: CanonicalEvent[];
}

/**
 * Swappable judge backend. Implementations must never log secrets (API keys,
 * Authorization headers, ANTHROPIC_AUTH_TOKEN values).
 */
export interface JudgeProvider {
  judge(req: JudgeRequest): Promise<JudgeProviderResult>;
}

/**
 * Extract a JSON object from model text that may include prose and/or fenced
 * ```json blocks. Prefers the first fenced JSON block; falls back to the first
 * balanced `{...}` object in the text.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty model response; cannot extract JSON verdict");
  }

  // Prefer fenced ```json ... ``` (or bare ```) blocks.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{") || inner.startsWith("[")) {
      // Validate it parses; if not, fall through to brace scan.
      try {
        JSON.parse(inner);
        return inner;
      } catch {
        // continue
      }
    }
  }

  // If the whole response is already JSON, accept it.
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // fall through to balanced scan (may have trailing prose)
    }
  }

  // Scan for the first balanced top-level object.
  const start = trimmed.indexOf("{");
  if (start < 0) {
    throw new Error("no JSON object found in model response");
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        JSON.parse(candidate); // throw if invalid
        return candidate;
      }
    }
  }
  throw new Error("unbalanced JSON object in model response");
}

/** Options for AnthropicJudgeProvider. */
export interface AnthropicJudgeProviderOptions {
  /** Override base URL (default: ANTHROPIC_BASE_URL or https://api.anthropic.com). */
  baseUrl?: string;
  /** Override auth token (default: ANTHROPIC_AUTH_TOKEN || ANTHROPIC_API_KEY). */
  authToken?: string;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Anthropic API version header. */
  apiVersion?: string;
}

/**
 * Anthropic Messages API judge provider (raw HTTP).
 * Uses ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) and optional ANTHROPIC_BASE_URL.
 * Never logs secrets.
 */
export class AnthropicJudgeProvider implements JudgeProvider {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;

  constructor(opts: AnthropicJudgeProviderOptions = {}) {
    const token =
      opts.authToken ??
      process.env.ANTHROPIC_AUTH_TOKEN ??
      process.env.ANTHROPIC_API_KEY ??
      "";
    if (!token) {
      throw new Error(
        "AnthropicJudgeProvider: set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY",
      );
    }
    this.authToken = token;
    this.baseUrl = (
      opts.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com"
    ).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiVersion = opts.apiVersion ?? "2023-06-01";
  }

  async judge(req: JudgeRequest): Promise<JudgeProviderResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const maxTokens = req.maxTokens ?? 8192;
    const body = {
      model: req.model,
      max_tokens: maxTokens,
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userPrompt }],
    };

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.authToken,
        "anthropic-version": this.apiVersion,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Do not include request headers / token in the error message.
      const errText = await res.text().catch(() => "");
      const safe = errText.slice(0, 400).replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, "[REDACTED]");
      throw new Error(
        `AnthropicJudgeProvider: HTTP ${res.status} from Messages API${safe ? `: ${safe}` : ""}`,
      );
    }

    const payload = (await res.json()) as AnthropicMessagesResponse;
    const { text, thinkingTexts } = flattenContent(payload);
    const verdictJson = extractJsonObject(text);
    const runId = req.judgementId ?? "judge";
    const rawEvents = thinkingToEvents(thinkingTexts, runId, text);

    return { verdictJson, rawEvents };
  }
}

interface AnthropicMessagesResponse {
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
  }>;
  // Some gateways may put text at top-level.
  text?: string;
}

function flattenContent(payload: AnthropicMessagesResponse): {
  text: string;
  thinkingTexts: string[];
} {
  const thinkingTexts: string[] = [];
  const textParts: string[] = [];
  if (Array.isArray(payload.content)) {
    for (const block of payload.content) {
      if (block?.type === "thinking" && typeof block.thinking === "string") {
        thinkingTexts.push(block.thinking);
      } else if (block?.type === "thinking" && typeof block.text === "string") {
        thinkingTexts.push(block.text);
      } else if (typeof block?.text === "string") {
        textParts.push(block.text);
      } else if (typeof block?.thinking === "string") {
        thinkingTexts.push(block.thinking);
      }
    }
  }
  if (textParts.length === 0 && typeof payload.text === "string") {
    textParts.push(payload.text);
  }
  return { text: textParts.join("\n"), thinkingTexts };
}

function thinkingToEvents(
  thinkingTexts: string[],
  runId: string,
  fullText: string,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let seq = 0;
  const ts = new Date().toISOString();
  for (const t of thinkingTexts) {
    if (!t) continue;
    events.push({
      v: SCHEMA_VERSION,
      runId,
      seq: seq++,
      ts,
      type: "thinking",
      turn: 1,
      mode: "full",
      text: t,
    });
  }
  // Always capture a message event with the assistant text so the live log has
  // something even when the model produced no thinking blocks.
  if (fullText) {
    events.push({
      v: SCHEMA_VERSION,
      runId,
      seq: seq++,
      ts,
      type: "message",
      turn: 1,
      mode: "full",
      text: fullText.length > 4000 ? fullText.slice(0, 4000) + "…" : fullText,
    });
  }
  return events;
}

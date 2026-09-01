/**
 * Tool-using agent loop for Phase-2 roles that are specified as agentic
 * (investigator, researcher, designer, reviewer). Deterministic nodes
 * (campaign manager, pattern analyzer) do not use this.
 */
import type {ChatMessage, ChatResult, ChatTool, ChatToolCall, ModelGateway} from "../gateway/client.js";

export interface AgentToolResult {
  text: string;
  /** When set, the loop stops and returns this value. */
  done?: unknown;
}

export interface AgentLoopInput<T> {
  gateway: ModelGateway;
  attemptId: string;
  node: string;
  role: string;
  system: string;
  user: string;
  tools: ChatTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<AgentToolResult>;
  maxTurns?: number;
  providerWebSearch?: boolean;
  parseFinal: (content: string) => T;
}

export async function runPhase2AgentLoop<T>(input: AgentLoopInput<T>): Promise<T> {
  const tools = [...input.tools];
  if (input.providerWebSearch && !tools.some((t) => t.type === "web_search" || (t.type === "function" && t.function.name === "web_search"))) {
    tools.push({ type: "web_search" });
  }
  const messages: ChatMessage[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  const maxTurns = input.maxTurns ?? 16;
  let lastContent = "";
  for (let turn = 0; turn < maxTurns; turn++) {
    const result: ChatResult = await input.gateway.chat({
      attemptId: input.attemptId,
      node: input.node,
      metricOrRole: `${input.role}:turn${turn}`,
      messages,
      tools: tools.length ? tools : undefined,
      toolChoice: tools.length ? "auto" : "none",
      maxTokens: 8192,
    });
    lastContent = result.content ?? "";
    if (!result.toolCalls.length) {
      return input.parseFinal(lastContent);
    }
    messages.push({
      role: "assistant",
      content: lastContent,
      tool_calls: result.toolCalls,
    });
    for (const tc of result.toolCalls) {
      const args = parseArgs(tc);
      let out: AgentToolResult;
      try {
        if (tc.function.name === "web_search") {
          out = { text: await providerSearch(input.gateway, input.attemptId, String(args.query ?? "")) };
        } else {
          out = await input.execute(tc.function.name, args);
        }
      } catch (e) {
        out = { text: `ERROR: ${e instanceof Error ? e.message : String(e)}` };
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: out.text.slice(0, 24_000),
      });
      if (out.done !== undefined) return out.done as T;
    }
  }
  return input.parseFinal(lastContent);
}

function parseArgs(tc: ChatToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(tc.function.arguments || "{}");
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Use the same model provider's built-in web search — never a side endpoint. */
export async function providerSearch(gateway: ModelGateway, attemptId: string, query: string): Promise<string> {
  if (!query.trim()) return "DENIED: empty query";
  const result = await gateway.chat({
    attemptId,
    node: "phase2",
    metricOrRole: "provider_web_search",
    messages: [
      { role: "system", content: "Use web search. Return a concise brief of what you found, with source URLs. If search is unavailable, say so." },
      { role: "user", content: query },
    ],
    tools: [{
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    }],
    toolChoice: "auto",
    maxTokens: 4096,
  });
  if (result.content.trim()) return result.content.slice(0, 16_000);
  if (result.toolCalls.length) {
    return `provider returned ${result.toolCalls.length} search tool call(s) without text; treat as no snippets`;
  }
  return "DENIED: provider web search returned empty content";
}

export function fnTool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ChatTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

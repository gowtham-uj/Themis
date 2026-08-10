/**
 * pi adapter — maps `pi --mode json` stdout JSONL → canonical events.
 *
 * No pi changes required. Mapping table: plan/event-schema.md § "Mapping: pi → canonical".
 * Reference: /work/_inspect/pi packages (AgentSessionEvent + SessionHeader).
 *
 * Local runs (Dockerless): {@link runPi} spawns `pi --mode json -p` as a child process,
 * streams stdout JSONL, and yields a complete canonical stream including run.start/run.end.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type {
  CanonicalEvent,
  RunStatus,
  StopReason,
  Usage,
} from "../schema/events.js";
import { linesFromStream, parseJsonlLine } from "../schema/jsonl.js";
import type {
  Adapter,
  AdapterCommand,
  AgentStreams,
  RunContext,
} from "./types.js";

const DEFAULT_IMAGE = "agenteval/pi:latest";

export interface PiParseOptions {
  maxToolOutputChars?: number;
}

const DEFAULT_MAX_TOOL_OUTPUT = 64_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncateOutput(
  output: unknown,
  maxChars: number,
): { output: unknown; truncated: boolean } {
  if (typeof output === "string") {
    if (output.length <= maxChars) return { output, truncated: false };
    return {
      output: `${output.slice(0, maxChars)}\n…[truncated ${output.length - maxChars} chars]`,
      truncated: true,
    };
  }
  try {
    const s = JSON.stringify(output);
    if (s.length <= maxChars) return { output, truncated: false };
    return {
      output: `${s.slice(0, maxChars)}…[truncated]`,
      truncated: true,
    };
  } catch {
    return { output: String(output), truncated: false };
  }
}

function extractTextFromMessage(message: unknown): string {
  const msg = asRecord(message);
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}

function extractThinkingFromMessage(message: unknown): {
  text: string;
  signature?: string;
} {
  const msg = asRecord(message);
  if (!msg) return { text: "" };
  const content = msg.content;
  if (!Array.isArray(content)) return { text: "" };
  const parts: string[] = [];
  let signature: string | undefined;
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (
      (b.type === "thinking" || b.type === "reasoning") &&
      typeof b.thinking === "string"
    ) {
      parts.push(b.thinking);
      if (typeof b.thinkingSignature === "string") {
        signature = b.thinkingSignature;
      }
    } else if (b.type === "thinking" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return signature !== undefined ? { text: parts.join(""), signature } : { text: parts.join("") };
}

function mapUsage(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const inputTokens =
    asNumber(u.input) ??
    asNumber(u.inputTokens) ??
    asNumber(u.input_tokens) ??
    0;
  const outputTokens =
    asNumber(u.output) ??
    asNumber(u.outputTokens) ??
    asNumber(u.output_tokens) ??
    0;
  const usage: Usage = { inputTokens, outputTokens };
  const reasoning =
    asNumber(u.reasoningTokens) ??
    asNumber(u.reasoning_tokens) ??
    asNumber(u.reasoning);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  const cacheRead =
    asNumber(u.cacheRead) ??
    asNumber(u.cacheReadTokens) ??
    asNumber(u.cache_read_tokens);
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  const cacheWrite =
    asNumber(u.cacheWrite) ??
    asNumber(u.cacheWriteTokens) ??
    asNumber(u.cache_write_tokens);
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  const total = asNumber(u.totalTokens) ?? asNumber(u.total_tokens);
  if (total !== undefined) usage.totalTokens = total;
  const costRaw = asRecord(u.cost);
  if (costRaw) {
    const cost: NonNullable<Usage["cost"]> = {};
    const ci = asNumber(costRaw.input);
    if (ci !== undefined) cost.input = ci;
    const co = asNumber(costRaw.output);
    if (co !== undefined) cost.output = co;
    const ct = asNumber(costRaw.total);
    if (ct !== undefined) cost.total = ct;
    usage.cost = cost;
  }
  return usage;
}

function mapStopReason(raw: unknown): StopReason | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw) {
    case "stop":
    case "end_turn":
    case "end-turn":
      return "stop";
    case "toolUse":
    case "tool_use":
    case "tool-calls":
    case "tool_calls":
      return "toolUse";
    case "length":
    case "max_tokens":
      return "length";
    case "error":
      return "error";
    case "aborted":
    case "cancelled":
      return "aborted";
    default:
      return undefined;
  }
}

/**
 * Map one pi stdout JSON object into zero or more canonical events.
 * Mutates `state` (seq / turn counters).
 */
export function mapPiEvent(
  raw: unknown,
  ctx: RunContext,
  state: PiParseState,
  options: PiParseOptions = {},
): CanonicalEvent[] {
  const maxOut = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT;
  const obj = asRecord(raw);
  if (!obj) return [];

  const type = asString(obj.type);
  if (!type) return [];

  const out: CanonicalEvent[] = [];
  const ts = asString(obj.timestamp) ?? new Date().toISOString();
  const next = (): number => {
    state.seq += 1;
    return state.seq;
  };
  const envelope = (seq: number) => ({
    v: 1 as const,
    runId: ctx.runId,
    seq,
    ts,
  });

  switch (type) {
    case "session": {
      // SessionHeader — stash for run.start; do not emit yet.
      state.sessionId = asString(obj.id);
      state.sessionCwd = asString(obj.cwd);
      state.sessionTs = asString(obj.timestamp) ?? ts;
      return [];
    }
    case "agent_start": {
      if (state.emittedRunStart) return [];
      state.emittedRunStart = true;
      const ws = ctx.task.workspace;
      out.push({
        ...envelope(next()),
        type: "run.start",
        agent: "pi",
        model: ctx.model,
        provider: ctx.provider,
        workspace: {
          source: ws.source,
          ...(ws.source === "git"
            ? {
                repo: ws.repo,
                ...(state.resolvedCommit
                  ? { commit: state.resolvedCommit }
                  : {}),
              }
            : {}),
          ...(state.resolvedCommit && ws.source === "empty"
            ? { commit: state.resolvedCommit }
            : {}),
        },
        params: { ...ctx.params },
      });
      return out;
    }
    case "turn_start": {
      state.turn += 1;
      state.turnThinking = "";
      state.turnText = "";
      out.push({
        ...envelope(next()),
        type: "turn.start",
        turn: state.turn,
      });
      return out;
    }
    case "message_update": {
      const ame = asRecord(obj.assistantMessageEvent);
      if (!ame) return [];
      const deltaType = asString(ame.type);
      const turn = state.turn >= 0 ? state.turn : 0;
      if (deltaType === "text_delta") {
        const delta = asString(ame.delta) ?? "";
        state.turnText += delta;
        if (delta.length > 0) {
          out.push({
            ...envelope(next()),
            type: "message",
            turn,
            mode: "delta",
            text: delta,
          });
        }
      } else if (
        deltaType === "thinking_delta" ||
        deltaType === "thinking_start"
      ) {
        const delta = asString(ame.delta) ?? "";
        if (deltaType === "thinking_delta" && delta.length > 0) {
          state.turnThinking += delta;
          out.push({
            ...envelope(next()),
            type: "thinking",
            turn,
            mode: "delta",
            text: delta,
          });
        }
      }
      return out;
    }
    case "message_end": {
      const message = obj.message;
      const role = asString(asRecord(message)?.role);
      if (role !== "assistant") return [];
      const turn = state.turn >= 0 ? state.turn : 0;
      const fullText = extractTextFromMessage(message);
      const fullThinking = extractThinkingFromMessage(message);
      // Emit full snapshots when we have content (UI concatenates deltas; storage keeps both).
      if (fullThinking.text.length > 0) {
        const thinkingEv: CanonicalEvent = {
          ...envelope(next()),
          type: "thinking",
          turn,
          mode: "full",
          text: fullThinking.text,
        };
        if (fullThinking.signature) {
          (thinkingEv as { signature?: string }).signature = fullThinking.signature;
        }
        out.push(thinkingEv);
      }
      if (fullText.length > 0) {
        out.push({
          ...envelope(next()),
          type: "message",
          turn,
          mode: "full",
          text: fullText,
        });
      }
      const usage = mapUsage(asRecord(message)?.usage);
      if (usage) {
        out.push({
          ...envelope(next()),
          type: "usage",
          turn,
          ...usage,
        });
        if (!state.usageAccumulatedTurns.has(turn)) {
          state.usageTotal = accumulateUsage(state.usageTotal, usage);
          state.usageAccumulatedTurns.add(turn);
        }
      }
      const stopReason = mapStopReason(asRecord(message)?.stopReason);
      if (stopReason === "error" || stopReason === "aborted") {
        state.sawFatalError = true;
        const errMsg = asString(asRecord(message)?.errorMessage);
        if (errMsg) {
          out.push({
            ...envelope(next()),
            type: "error",
            message: errMsg,
            phase: "agent",
            fatal: stopReason === "error",
          });
        }
      }
      return out;
    }
    case "tool_execution_start": {
      const turn = state.turn >= 0 ? state.turn : 0;
      const id =
        asString(obj.toolCallId) ??
        asString(obj.id) ??
        `tool#${turn}#${state.seq + 1}`;
      const name = asString(obj.toolName) ?? asString(obj.name) ?? "unknown";
      state.toolStartMs.set(id, Date.now());
      out.push({
        ...envelope(next()),
        type: "tool.call",
        turn,
        id,
        name,
        args: obj.args ?? {},
      });
      return out;
    }
    case "tool_execution_end": {
      const id =
        asString(obj.toolCallId) ??
        asString(obj.id) ??
        `tool#${state.turn}#${state.seq}`;
      const name = asString(obj.toolName) ?? asString(obj.name);
      const isError = asBoolean(obj.isError) ?? false;
      const { output, truncated } = truncateOutput(obj.result ?? obj.output, maxOut);
      const started = state.toolStartMs.get(id);
      state.toolStartMs.delete(id);
      const event: CanonicalEvent = {
        ...envelope(next()),
        type: "tool.result",
        id,
        isError,
        output,
      };
      if (name) (event as { name?: string }).name = name;
      if (started !== undefined) {
        (event as { durationMs?: number }).durationMs = Date.now() - started;
      }
      if (truncated) (event as { truncated?: boolean }).truncated = true;
      out.push(event);
      return out;
    }
    case "turn_end": {
      const turn = state.turn >= 0 ? state.turn : 0;
      const message = obj.message;
      const stopReason = mapStopReason(asRecord(message)?.stopReason);
      const event: CanonicalEvent = {
        ...envelope(next()),
        type: "turn.end",
        turn,
      };
      if (stopReason) (event as { stopReason?: StopReason }).stopReason = stopReason;
      out.push(event);
      // Spec: turn_end also surfaces usage. Prefer not double-counting usageTotal
      // when message_end already accumulated the same assistant usage.
      const usage = mapUsage(asRecord(message)?.usage);
      if (usage) {
        out.push({
          ...envelope(next()),
          type: "usage",
          turn,
          ...usage,
        });
        if (!state.usageAccumulatedTurns.has(turn)) {
          state.usageTotal = accumulateUsage(state.usageTotal, usage);
          state.usageAccumulatedTurns.add(turn);
        }
      }
      return out;
    }
    case "agent_end": {
      // Spec: agent_end → run.end. Runner may still own a final run.end with diff;
      // when parse() is used standalone (or via runPi), we emit run.end here.
      state.sawAgentEnd = true;
      if (!state.emittedRunEnd && !state.deferRunEnd) {
        state.emittedRunEnd = true;
        const status: RunStatus = state.sawFatalError ? "failed" : "completed";
        const endEv: CanonicalEvent = {
          ...envelope(next()),
          type: "run.end",
          status,
          durationMs: Math.max(0, Date.now() - state.startedAtMs),
        };
        if (state.usageTotal) {
          (endEv as { usageTotal?: Usage }).usageTotal = state.usageTotal;
        }
        out.push(endEv);
      } else {
        out.push({
          ...envelope(next()),
          type: "log",
          level: "info",
          message: "pi agent_end",
        });
      }
      return out;
    }
    case "auto_retry_start": {
      out.push({
        ...envelope(next()),
        type: "log",
        level: "warn",
        message: `auto_retry_start attempt=${String(obj.attempt)}/${String(obj.maxAttempts)} delayMs=${String(obj.delayMs)}: ${asString(obj.errorMessage) ?? ""}`,
      });
      return out;
    }
    case "auto_retry_end": {
      out.push({
        ...envelope(next()),
        type: "log",
        level: obj.success ? "info" : "warn",
        message: `auto_retry_end success=${String(obj.success)} attempt=${String(obj.attempt)}${
          obj.finalError ? ` finalError=${String(obj.finalError)}` : ""
        }`,
      });
      return out;
    }
    case "compaction_start": {
      out.push({
        ...envelope(next()),
        type: "log",
        level: "info",
        message: `compaction_start reason=${asString(obj.reason) ?? "unknown"}`,
      });
      return out;
    }
    case "compaction_end": {
      out.push({
        ...envelope(next()),
        type: "log",
        level: obj.aborted ? "warn" : "info",
        message: `compaction_end reason=${asString(obj.reason) ?? "unknown"} aborted=${String(obj.aborted)} willRetry=${String(obj.willRetry)}`,
      });
      return out;
    }
    case "agent_settled":
    case "queue_update":
    case "entry_appended":
    case "session_info_changed":
    case "thinking_level_changed":
    case "message_start":
    case "tool_execution_update": {
      // Intermediate / UI-only — skip noise (or debug if needed).
      return out;
    }
    default: {
      out.push({
        ...envelope(next()),
        type: "log",
        level: "debug",
        message: `pi unknown event type: ${type}`,
      });
      return out;
    }
  }
}

function accumulateUsage(total: Usage | undefined, next: Usage): Usage {
  if (!total) return { ...next, cost: next.cost ? { ...next.cost } : undefined };
  const merged: Usage = {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
  if (total.reasoningTokens !== undefined || next.reasoningTokens !== undefined) {
    merged.reasoningTokens =
      (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  }
  if (total.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined) {
    merged.cacheReadTokens =
      (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  }
  if (
    total.cacheWriteTokens !== undefined ||
    next.cacheWriteTokens !== undefined
  ) {
    merged.cacheWriteTokens =
      (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
  }
  if (total.totalTokens !== undefined || next.totalTokens !== undefined) {
    merged.totalTokens = (total.totalTokens ?? 0) + (next.totalTokens ?? 0);
  }
  if (total.cost || next.cost) {
    merged.cost = {
      input: (total.cost?.input ?? 0) + (next.cost?.input ?? 0),
      output: (total.cost?.output ?? 0) + (next.cost?.output ?? 0),
      total: (total.cost?.total ?? 0) + (next.cost?.total ?? 0),
    };
  }
  return merged;
}

export interface PiParseState {
  seq: number;
  turn: number;
  emittedRunStart: boolean;
  emittedRunEnd: boolean;
  sawAgentEnd: boolean;
  sawFatalError: boolean;
  /** When true, agent_end does not emit run.end (caller will after exit code). */
  deferRunEnd: boolean;
  startedAtMs: number;
  sessionId?: string;
  sessionCwd?: string;
  sessionTs?: string;
  resolvedCommit?: string;
  turnThinking: string;
  turnText: string;
  usageTotal?: Usage;
  /** Turns whose usage already rolled into usageTotal (avoid double count). */
  usageAccumulatedTurns: Set<number>;
  toolStartMs: Map<string, number>;
}

export function createPiParseState(
  resolvedCommit?: string,
  options?: { deferRunEnd?: boolean; startedAtMs?: number },
): PiParseState {
  return {
    seq: -1,
    turn: -1,
    emittedRunStart: false,
    emittedRunEnd: false,
    sawAgentEnd: false,
    sawFatalError: false,
    deferRunEnd: options?.deferRunEnd ?? false,
    startedAtMs: options?.startedAtMs ?? Date.now(),
    turnThinking: "",
    turnText: "",
    usageAccumulatedTurns: new Set(),
    toolStartMs: new Map(),
    ...(resolvedCommit !== undefined ? { resolvedCommit } : {}),
  };
}

export interface ParsePiStreamOptions extends PiParseOptions {
  resolvedCommit?: string;
  /** When true, agent_end does not emit run.end; parsePiStream finalizes after exit. */
  deferRunEnd?: boolean;
  startedAtMs?: number;
}

/** Async generator: parse pi stdout stream into canonical events. */
export async function* parsePiStream(
  streams: AgentStreams,
  ctx: RunContext,
  options: ParsePiStreamOptions = {},
): AsyncIterable<CanonicalEvent> {
  const startedAtMs = options.startedAtMs ?? Date.now();
  const state = createPiParseState(options.resolvedCommit, {
    deferRunEnd: options.deferRunEnd ?? false,
    startedAtMs,
  });

  for await (const line of linesFromStream(streams.stdout)) {
    let parsed: unknown;
    try {
      parsed = parseJsonlLine(line);
    } catch {
      yield {
        v: 1,
        runId: ctx.runId,
        seq: (state.seq += 1),
        ts: new Date().toISOString(),
        type: "log",
        level: "warn",
        message: `pi adapter: skipped unparseable line: ${line.slice(0, 200)}`,
      };
      continue;
    }
    if (parsed === null) continue;
    for (const ev of mapPiEvent(parsed, ctx, state, options)) {
      yield ev;
    }
  }

  // Drain stderr into log events (non-fatal diagnostics).
  if (streams.stderr) {
    for await (const chunk of streams.stderr) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const trimmed = text.trim();
      if (!trimmed) continue;
      yield {
        v: 1,
        runId: ctx.runId,
        seq: (state.seq += 1),
        ts: new Date().toISOString(),
        type: "log",
        level: "warn",
        message: `pi stderr: ${trimmed.slice(0, 2000)}`,
      };
    }
  }

  // Ensure run.start exists even if pi never emitted agent_start (e.g. crash).
  if (!state.emittedRunStart) {
    const ws = ctx.task.workspace;
    yield {
      v: 1,
      runId: ctx.runId,
      seq: (state.seq += 1),
      ts: new Date().toISOString(),
      type: "run.start",
      agent: "pi",
      model: ctx.model,
      provider: ctx.provider,
      workspace: {
        source: ws.source,
        ...(ws.source === "git" ? { repo: ws.repo } : {}),
        ...(options.resolvedCommit
          ? { commit: options.resolvedCommit }
          : {}),
      },
      params: { ...ctx.params },
    };
    state.emittedRunStart = true;
  }

  // Finalize run.end from exit code when not already emitted (or when deferred).
  if (!state.emittedRunEnd) {
    let exitCode: number | undefined;
    if (typeof streams.exitCode === "number") {
      exitCode = streams.exitCode;
    } else if (streams.exitCode !== undefined) {
      try {
        exitCode = await streams.exitCode;
      } catch {
        exitCode = 1;
      }
    }

    let durationMs: number | undefined;
    if (typeof streams.durationMs === "number") {
      durationMs = streams.durationMs;
    } else if (streams.durationMs !== undefined) {
      try {
        durationMs = await streams.durationMs;
      } catch {
        durationMs = undefined;
      }
    }
    if (durationMs === undefined) {
      durationMs = Math.max(0, Date.now() - state.startedAtMs);
    }

    const status = derivePiStatus(exitCode, state.sawAgentEnd, state.sawFatalError);
    state.emittedRunEnd = true;
    const endEv: CanonicalEvent = {
      v: 1,
      runId: ctx.runId,
      seq: (state.seq += 1),
      ts: new Date().toISOString(),
      type: "run.end",
      status,
      durationMs,
    };
    if (state.usageTotal) {
      (endEv as { usageTotal?: Usage }).usageTotal = state.usageTotal;
    }
    yield endEv;
  }
}

/**
 * Resolve the `pi` CLI entry (dist/cli.js). Falls back to PATH `pi`.
 * package.json is not in the package `exports` map, so we resolve the package
 * root via the main entry and walk to dist/cli.js.
 *
 * `AGENTEVAL_PI_BIN` overrides everything. That matters for containerized runs:
 * host resolution yields a HOST path (this repo's node_modules), which does not
 * exist inside the sandbox. An image that ships pi at its own location sets the
 * env var — or `image` overrides supply it — so the argv is valid where it runs.
 */
export function resolvePiBin(): string {
  const fromEnv = process.env.AGENTEVAL_PI_BIN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const anchors: string[] = [];
  if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
    anchors.push(import.meta.url);
  }
  anchors.push(join(process.cwd(), "package.json"));
  anchors.push("/work/agenteval/package.json");

  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor);
      // Resolve main export (./dist/index.js) — package.json is not exported.
      const mainEntry = require.resolve("@earendil-works/pi-coding-agent");
      // mainEntry → .../dist/index.js ; cli is sibling cli.js
      const cliPath = join(resolve(mainEntry, ".."), "cli.js");
      return cliPath;
    } catch {
      // try next anchor
    }
  }

  // Filesystem fallbacks (symlink layout from file: install).
  for (const root of [
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"),
    "/work/agenteval/node_modules/@earendil-works/pi-coding-agent",
  ]) {
    const cliPath = join(root, "dist", "cli.js");
    try {
      // exists check without importing fs.promises
      const require = createRequire(join(process.cwd(), "package.json"));
      require("node:fs").accessSync(cliPath);
      return cliPath;
    } catch {
      // continue
    }
  }

  return "pi";
}

/** Default short system prompt for eval runs (avoids pi's long default). */
export const DEFAULT_PI_SYSTEM_PROMPT =
  "You are a helpful coding agent. Use tools to complete the task. Be concise.";

/**
 * Ensure a private agent dir with models.json that routes the anthropic
 * provider through ANTHROPIC_BASE_URL when set (self-hosted proxy / gateway).
 * Returns the absolute agent dir path (or undefined when no override needed
 * and no dir requested).
 */
export function ensurePiAgentDir(
  agentDir: string,
  options: { anthropicBaseUrl?: string } = {},
): string {
  const dir = resolve(agentDir);
  mkdirSync(dir, { recursive: true });
  const baseUrl = options.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    const modelsPath = join(dir, "models.json");
    const payload = {
      providers: {
        anthropic: {
          baseUrl,
        },
      },
    };
    writeFileSync(modelsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  return dir;
}

/** Build env for a live pi child process (API keys + agent dir + offline). */
export function buildPiEnv(
  ctx: RunContext,
  options: { agentDir?: string } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ...ctx.overrides?.env,
  };

  // Pass through keys from ctx.apiKeys.
  for (const [k, v] of Object.entries(ctx.apiKeys)) {
    env[k] = v;
  }

  // Map AUTH_TOKEN → API_KEY (pi SDK expects ANTHROPIC_API_KEY).
  const authToken =
    ctx.apiKeys.ANTHROPIC_AUTH_TOKEN ??
    env.ANTHROPIC_AUTH_TOKEN ??
    process.env.ANTHROPIC_AUTH_TOKEN;
  const apiKey =
    ctx.apiKeys.ANTHROPIC_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    process.env.ANTHROPIC_API_KEY ??
    authToken;
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
  }

  // An explicit project/run override outranks the harness host's environment:
  // ctx.apiKeys is harvested from the host, so preferring it would silently
  // redirect a run that deliberately pinned a proxy/gateway endpoint.
  const overrideBaseUrl = ctx.overrides?.env?.ANTHROPIC_BASE_URL;
  const baseUrl =
    (typeof overrideBaseUrl === "string" && overrideBaseUrl) ||
    ctx.apiKeys.ANTHROPIC_BASE_URL ||
    env.ANTHROPIC_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }
  const overrideKey = ctx.overrides?.env?.ANTHROPIC_API_KEY;
  if (typeof overrideKey === "string" && overrideKey) {
    env.ANTHROPIC_API_KEY = overrideKey;
  }

  if (ctx.apiKeys.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = ctx.apiKeys.OPENAI_API_KEY;
  }

  // Skip package registry / version-check network at startup.
  env.PI_OFFLINE = env.PI_OFFLINE ?? "1";

  // Self-signed proxy certs (common in private gateways).
  if (baseUrl && !env.NODE_TLS_REJECT_UNAUTHORIZED) {
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  if (options.agentDir) {
    env.PI_CODING_AGENT_DIR = options.agentDir;
  }

  return env;
}

/** Build argv + env for launching pi headlessly (Adapter.command). */
export function buildPiCommand(
  ctx: RunContext,
  options: { agentDir?: string; noSession?: boolean; piBin?: string } = {},
): AdapterCommand {
  // Precedence: explicit option > project override (AGENTEVAL_PI_BIN, for
  // containerized images that ship pi elsewhere) > host resolution.
  // Container images set AGENTEVAL_PI_BIN=pi (or a node+cli.js path) via the
  // declarative adapter's command template, so the resolved argv is correct
  // both on the host (runPi / tests resolve the package cli.js) and in the
  // queue container (the image's `pi` entrypoint).
  const overridePiBin = ctx.overrides?.env?.AGENTEVAL_PI_BIN;
  const piBin =
    options.piBin ??
    (typeof overridePiBin === "string" && overridePiBin.trim()
      ? overridePiBin.trim()
      : resolvePiBin());
  const useNode = piBin.endsWith(".js") || piBin.includes(`${join("dist", "cli")}`);
  // Launch node-launched pi via the current process's node binary so the child
  // resolves regardless of PATH (host runPi + local tests). Container images
  // that ship a shebanged `pi` set AGENTEVAL_PI_BIN=pi and skip this branch.
  const argv: string[] = useNode ? [process.execPath, piBin] : [piBin];

  argv.push(
    "--mode",
    "json",
    "-p",
    ctx.task.prompt,
    "--provider",
    ctx.provider,
    "--model",
    ctx.model,
  );

  const thinking = ctx.params.thinking ?? ctx.params.reasoningEffort;
  if (typeof thinking === "string" || typeof thinking === "number") {
    argv.push("--thinking", String(thinking));
  }

  const tools = ctx.params.tools ?? ctx.overrides?.allowedTools;
  if (typeof tools === "string") {
    argv.push("--tools", tools);
  } else if (Array.isArray(tools) && tools.every((t) => typeof t === "string")) {
    argv.push("--tools", tools.join(","));
  }

  // Short system prompt: pi's default is long and some gateways reject it.
  // Override via params.systemPrompt; empty string skips the flag.
  const systemPrompt =
    typeof ctx.params.systemPrompt === "string"
      ? ctx.params.systemPrompt
      : DEFAULT_PI_SYSTEM_PROMPT;
  if (systemPrompt.length > 0) {
    argv.push("--system-prompt", systemPrompt);
  }

  const noSession =
    options.noSession ??
    (ctx.params.noSession === true || ctx.params.ephemeral === true);
  if (noSession) {
    argv.push("--no-session");
  } else {
    argv.push("--session-dir", join(ctx.workspaceDir, ".pi"));
  }

  // Avoid package-registry / version-check network at startup.
  argv.push("--offline");

  // Prepare agent dir with baseUrl override when ANTHROPIC_BASE_URL is present.
  const baseUrl =
    ctx.apiKeys.ANTHROPIC_BASE_URL ??
    ctx.overrides?.env?.ANTHROPIC_BASE_URL ??
    process.env.ANTHROPIC_BASE_URL;
  let agentDir = options.agentDir;
  if (!agentDir && baseUrl) {
    agentDir = ensurePiAgentDir(join(ctx.workspaceDir, ".pi-agent"), {
      anthropicBaseUrl: baseUrl,
    });
  } else if (agentDir && baseUrl) {
    ensurePiAgentDir(agentDir, { anthropicBaseUrl: baseUrl });
  }

  const env = buildPiEnv(ctx, { agentDir });
  return { argv, env };
}

export interface RunPiOptions {
  /** Override agent config dir (models.json). Default: <workspace>/.pi-agent */
  agentDir?: string;
  /** Ephemeral session (default true for one-shot evals). */
  noSession?: boolean;
  /** Resolved commit for run.start workspace.commit. */
  resolvedCommit?: string;
  maxToolOutputChars?: number;
}

/**
 * Spawn pi as a local child process and yield the full canonical event stream
 * (including run.start / run.end). Dockerless P1 path for live evals.
 */
export async function* runPi(
  ctx: RunContext,
  options: RunPiOptions = {},
): AsyncIterable<CanonicalEvent> {
  const startedAtMs = Date.now();
  const noSession = options.noSession ?? true;
  const agentDir =
    options.agentDir ??
    ensurePiAgentDir(join(ctx.workspaceDir, ".pi-agent"), {
      anthropicBaseUrl:
        ctx.apiKeys.ANTHROPIC_BASE_URL ?? process.env.ANTHROPIC_BASE_URL,
    });

  const { argv, env } = buildPiCommand(ctx, {
    agentDir,
    noSession,
  });

  if (argv.length === 0) {
    throw new Error("buildPiCommand returned empty argv");
  }

  const [file, ...args] = argv;
  const child: ChildProcess = spawn(file!, args, {
    cwd: ctx.workspaceDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.stdout || !child.stderr) {
    throw new Error("pi spawn failed: missing stdout/stderr pipes");
  }
  const stdout = child.stdout;
  const stderr = child.stderr;

  const exitCodePromise = new Promise<number>((resolveExit, reject) => {
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolveExit(code ?? 1));
  });

  // Stream stdout lines as they arrive (true streaming for live UI).
  const rl = createInterface({ input: stdout, crlfDelay: Infinity });
  const state = createPiParseState(options.resolvedCommit, {
    deferRunEnd: true,
    startedAtMs,
  });
  const parseOpts: PiParseOptions = {
    maxToolOutputChars: options.maxToolOutputChars,
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = parseJsonlLine(line);
      } catch {
        yield {
          v: 1,
          runId: ctx.runId,
          seq: (state.seq += 1),
          ts: new Date().toISOString(),
          type: "log",
          level: "warn",
          message: `pi adapter: skipped unparseable line: ${line.slice(0, 200)}`,
        };
        continue;
      }
      if (parsed === null) continue;
      for (const ev of mapPiEvent(parsed, ctx, state, parseOpts)) {
        yield ev;
      }
    }
  } finally {
    rl.close();
  }

  // Collect any remaining stderr after stdout closes.
  const stderrChunks: Buffer[] = [];
  for await (const chunk of stderr) {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (stderrChunks.length > 0) {
    const text = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (text) {
      yield {
        v: 1,
        runId: ctx.runId,
        seq: (state.seq += 1),
        ts: new Date().toISOString(),
        type: "log",
        level: "warn",
        message: `pi stderr: ${text.slice(0, 2000)}`,
      };
    }
  }

  let exitCode: number;
  try {
    exitCode = await exitCodePromise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield {
      v: 1,
      runId: ctx.runId,
      seq: (state.seq += 1),
      ts: new Date().toISOString(),
      type: "error",
      message: `pi spawn failed: ${message}`,
      phase: "agent",
      fatal: true,
    };
    state.sawFatalError = true;
    exitCode = 1;
  }

  if (!state.emittedRunStart) {
    const ws = ctx.task.workspace;
    yield {
      v: 1,
      runId: ctx.runId,
      seq: (state.seq += 1),
      ts: new Date().toISOString(),
      type: "run.start",
      agent: "pi",
      model: ctx.model,
      provider: ctx.provider,
      workspace: {
        source: ws.source,
        ...(ws.source === "git" ? { repo: ws.repo } : {}),
        ...(options.resolvedCommit ? { commit: options.resolvedCommit } : {}),
      },
      params: { ...ctx.params },
    };
    state.emittedRunStart = true;
  }

  if (!state.emittedRunEnd) {
    const status = derivePiStatus(exitCode, state.sawAgentEnd, state.sawFatalError);
    state.emittedRunEnd = true;
    const endEv: CanonicalEvent = {
      v: 1,
      runId: ctx.runId,
      seq: (state.seq += 1),
      ts: new Date().toISOString(),
      type: "run.end",
      status,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
    if (state.usageTotal) {
      (endEv as { usageTotal?: Usage }).usageTotal = state.usageTotal;
    }
    yield endEv;
  }
}

export const piAdapter: Adapter = {
  id: "pi",
  image(ctx: RunContext): string {
    return ctx.overrides?.image ?? DEFAULT_IMAGE;
  },
  connectionCheck(ctx: RunContext) {
    const checkCtx: RunContext = {
      ...ctx,
      task: {
        prompt: "Reply with exactly AGENTEVAL_CONNECTION_OK. Do not use tools.",
        workspace: { source: "empty" },
      },
      params: {
        ...ctx.params,
        tools: [],
        noSession: true,
        systemPrompt: "Return exactly AGENTEVAL_CONNECTION_OK and nothing else.",
      },
    };
    return {
      command: buildPiCommand(checkCtx, { noSession: true }),
      cwd: "/workspace",
      timeoutMs: 60_000,
    };
  },
  command(ctx: RunContext): AdapterCommand {
    return buildPiCommand(ctx);
  },
  evidence() {
    return { paths: [".pi"] };
  },
  parse(streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent> {
    // Defer run.end until exitCode is known so crash mid-stream → failed.
    return parsePiStream(streams, ctx, { deferRunEnd: true });
  },
};

export default piAdapter;

/**
 * Derive run.end.status from process exit + terminal agent_end + fatal flags.
 * Spec: never trust clean exit alone; crash mid-stream → failed.
 */
export function derivePiStatus(
  exitCode: number | undefined,
  sawAgentEnd: boolean,
  sawFatalError = false,
): RunStatus {
  if (sawFatalError) return "failed";
  if (exitCode === undefined) {
    return sawAgentEnd ? "completed" : "failed";
  }
  if (exitCode !== 0) return "failed";
  if (sawAgentEnd) return "completed";
  // Exit 0 without agent_end is suspicious but treat as completed
  // only if no fatal; still mark failed for robustness when no terminal event.
  return "failed";
}

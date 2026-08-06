/**
 * ReaperCode adapter — maps trajectory JSONL → canonical events.
 *
 * IMPORTANT: This adapter is built against the EXPECTED post-change trajectory
 * shape described in plan/reapercode-changes.md. The live tree at
 * /work/_inspect/reaper does NOT yet emit structured `thinking`, `run_end`, or
 * `--stream-events`. Live runs require those ReaperCode changes.
 *
 * Mapping table: plan/event-schema.md § "Mapping: ReaperCode → canonical".
 */

import type { CanonicalEvent, RunStatus, StopReason, Usage } from "../schema/events.js";
import { linesFromStream, parseJsonlLine } from "../schema/jsonl.js";
import type { Adapter, AdapterCommand, AgentStreams, RunContext } from "./types.js";

/**
 * Live ReaperCode has not yet landed the required trajectory changes
 * (structured thinking, --stream-events, run_end). This adapter implements the
 * post-change contract; mark consumers accordingly.
 */
export const ADAPTER_STATUS = "spec-ahead-of-reaper" as const;

const DEFAULT_IMAGE = "agenteval/reapercode:latest";

/** Common envelope fields already present on every TrajectoryEntry. */
export interface ReaperEnvelope {
  event_id: string;
  run_id: string;
  session_id: string;
  trace_id: string;
  timestamp: string;
  log_schema_version: number;
  kind: string;
  level?: string;
  [key: string]: unknown;
}

/**
 * Expected post-change `session_start` payload.
 * Current ReaperCode only has `user_intent_summary` (no provider/model) —
 * change ③ of plan/reapercode-changes.md adds them.
 */
export interface ReaperSessionStart extends ReaperEnvelope {
  kind: "session_start";
  user_intent_summary: string;
  provider?: string;
  model?: string;
  params?: Record<string, unknown>;
}

/**
 * Expected post-change `thinking` kind (change ①).
 * Not present in current /work/_inspect/reaper/src/logging/schema.ts.
 */
export interface ReaperThinking extends ReaperEnvelope {
  kind: "thinking";
  content: string;
  turn_index?: number;
  streaming?: boolean;
}

/**
 * Expected post-change `run_end` kind (change ③).
 * Not present in current ReaperCode trajectory schema.
 */
export interface ReaperRunEnd extends ReaperEnvelope {
  kind: "run_end";
  status: "completed" | "failed" | "aborted" | string;
  duration_ms?: number;
  assistant_message?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
  };
}

export type ReaperTrajectoryEntry = ReaperEnvelope;

export interface ReaperParseOptions {
  /** Max chars kept for tool outputs in the event; larger blobs mark truncated. */
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

function workspaceFromCtx(ctx: RunContext): CanonicalEvent extends never ? never : {
  source: "git" | "empty";
  repo?: string;
  commit?: string;
} {
  const ws = ctx.task.workspace;
  if (ws.source === "git") {
    return {
      source: "git",
      ...(ws.repo ? { repo: ws.repo } : {}),
      ...(typeof ctx.params.resolvedCommit === "string"
        ? { commit: ctx.params.resolvedCommit as string }
        : {}),
    };
  }
  return { source: "empty" };
}

function mapLogLevel(level: unknown): "info" | "warn" | "debug" {
  if (level === "warn" || level === "warning") return "warn";
  if (level === "debug" || level === "trace") return "debug";
  return "info";
}

function mapRunStatus(status: unknown): RunStatus {
  if (status === "completed" || status === "failed" || status === "aborted" || status === "timeout") {
    return status;
  }
  if (status === "solved") return "completed";
  return "failed";
}

function truncateOutput(
  output: unknown,
  maxChars: number,
): { output: unknown; truncated?: boolean } {
  if (typeof output === "string" && output.length > maxChars) {
    return {
      output: output.slice(0, maxChars) + `…[truncated ${output.length - maxChars} chars]`,
      truncated: true,
    };
  }
  if (output !== null && typeof output === "object") {
    const serialized = JSON.stringify(output);
    if (serialized.length > maxChars) {
      return {
        output: serialized.slice(0, maxChars) + `…[truncated ${serialized.length - maxChars} chars]`,
        truncated: true,
      };
    }
  }
  return { output };
}

/**
 * Mutable mapping state across a single parse() invocation.
 * Tracks adapter-assigned seq and the best-effort current turn index.
 *
 * Turn model: a turn is *opened* by the first thinking/model_response/tool_call
 * of a model turn and *closed* by `engine_turn_complete`. Live trajectory entries
 * do NOT carry `turn_index` (except optionally `thinking`), so the open/close
 * pairing — not advance-on-close — is what keeps multi-turn attribution honest.
 */
class ParseState {
  seq = 0;
  /** 1-based turn index used for events that lack an explicit turn_index. */
  turn = 0;
  /** Whether the current turn has been opened (so tool/message can attach). */
  turnOpened = false;
  /** Whether the current turn has been closed by engine_turn_complete. */
  turnClosed = false;
  startedAtMs: number | undefined;
  cumulativeUsage: Usage | undefined;
  sawRunEnd = false;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * Resolve the turn an event belongs to. If an explicit turn_index is present
   * and forward, adopt it. Otherwise, if the current turn is closed (a new turn
   * is starting), advance; if no turn is open yet, open turn 1.
   */
  ensureTurn(explicit?: number): number {
    if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
      this.turn = Math.max(this.turn, explicit);
      this.turnOpened = true;
      this.turnClosed = false;
      return explicit;
    }
    if (!this.turnOpened) {
      // First event of the run with no index → turn 1.
      this.turn = 1;
      this.turnOpened = true;
      this.turnClosed = false;
    } else if (this.turnClosed) {
      // Previous turn closed; this event opens the next turn.
      this.turn += 1;
      this.turnClosed = false;
    }
    return this.turn;
  }

  /** Mark the current turn closed by `engine_turn_complete`. */
  closeTurn(): void {
    this.turnClosed = true;
  }
}

/**
 * Map a single ReaperCode trajectory entry to zero or more canonical events.
 * Pure function of (entry, ctx, state) — easy to unit-test.
 */
export function mapReaperEntry(
  entry: ReaperTrajectoryEntry,
  ctx: RunContext,
  state: ParseState,
  options: ReaperParseOptions = {},
): CanonicalEvent[] {
  const maxOut = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT;
  const ts = asString(entry.timestamp) ?? new Date().toISOString();
  const kind = entry.kind;
  const out: CanonicalEvent[] = [];

  const base = () => ({
    v: 1 as const,
    runId: ctx.runId,
    seq: state.nextSeq(),
    ts,
  });

  switch (kind) {
    case "session_start": {
      if (state.startedAtMs === undefined) {
        const parsed = Date.parse(ts);
        state.startedAtMs = Number.isFinite(parsed) ? parsed : Date.now();
      }
      const provider = asString(entry.provider) ?? ctx.provider;
      const model = asString(entry.model) ?? ctx.model;
      const paramsFromEntry = asRecord(entry.params) ?? {};
      out.push({
        ...base(),
        type: "run.start",
        agent: "reapercode",
        model,
        provider,
        workspace: workspaceFromCtx(ctx),
        params: {
          ...ctx.params,
          ...paramsFromEntry,
          ...(asString(entry.user_intent_summary)
            ? { userIntentSummary: entry.user_intent_summary }
            : {}),
        },
      });
      break;
    }

    case "thinking": {
      // Expected shape from plan/reapercode-changes.md change ①.
      const content = asString(entry.content) ?? "";
      const turnIndex = asNumber(entry.turn_index);
      const turn = state.ensureTurn(turnIndex);
      const streaming = asBoolean(entry.streaming) === true;
      out.push({
        ...base(),
        type: "thinking",
        turn,
        mode: streaming ? "delta" : "full",
        text: content,
      });
      break;
    }

    case "model_response": {
      const text = asString(entry.assistant_message) ?? "";
      const turn = state.ensureTurn(asNumber(entry.turn_index));
      if (text.length > 0) {
        out.push({
          ...base(),
          type: "message",
          turn,
          mode: "full",
          text,
        });
      }
      break;
    }

    case "assistant_message": {
      const text = asString(entry.content) ?? "";
      const turn = state.ensureTurn(asNumber(entry.turn_index));
      if (text.length > 0) {
        out.push({
          ...base(),
          type: "message",
          turn,
          mode: "full",
          text,
        });
      }
      break;
    }

    case "tool_call": {
      const status = asString(entry.status) ?? "started";
      const decisionId =
        asString(entry.decision_id) ??
        asString(entry.tool_call_id) ??
        `${asString(entry.tool_name) ?? "tool"}#${state.turn}#${state.seq + 1}`;
      const toolName = asString(entry.tool_name) ?? "unknown";
      const turn = state.ensureTurn(asNumber(entry.turn_index));

      if (status === "started") {
        out.push({
          ...base(),
          type: "tool.call",
          turn,
          id: decisionId,
          name: toolName,
          args: entry.args ?? {},
        });
      } else if (status === "completed" || status === "failed") {
        const isError = status === "failed";
        const rawOutput = isError
          ? (entry.error ?? entry.output ?? { message: "tool failed" })
          : (entry.output ?? null);
        const { output, truncated } = truncateOutput(rawOutput, maxOut);
        out.push({
          ...base(),
          type: "tool.result",
          id: decisionId,
          name: toolName,
          isError,
          output,
          ...(asNumber(entry.duration_ms) !== undefined
            ? { durationMs: asNumber(entry.duration_ms) }
            : {}),
          ...(truncated ? { truncated: true } : {}),
        });
      } else {
        out.push({
          ...base(),
          type: "log",
          level: "debug",
          message: `reaper tool_call unknown status=${status} tool=${toolName}`,
        });
      }
      break;
    }

    case "engine_turn_complete": {
      // Closes the already-open turn. Live `engine_turn_complete` carries no
      // turn_index (see /work/_inspect/reaper schema.ts) — the turn was opened
      // by this turn's thinking/model_response/tool_call. Do NOT advance here:
      // advancing on the 2nd turn-end would bump turn 2→3. If no turn is open
      // yet (defensive), open turn 1. An explicit turn_index, if ever present,
      // still wins.
      const explicit = asNumber(entry.turn_index);
      const turn =
        explicit !== undefined ? state.ensureTurn(explicit) : state.ensureTurn();
      // Infer stopReason from tool_result_count when present.
      const toolResultCount = asNumber(entry.tool_result_count) ?? 0;
      const stopReason: StopReason | undefined =
        toolResultCount > 0 ? "toolUse" : "stop";
      out.push({
        ...base(),
        type: "turn.end",
        turn,
        stopReason,
      });
      // This turn is now closed; the next thinking/message opens turn+1.
      state.closeTurn();
      break;
    }

    case "token_budget": {
      const turn = state.turnOpened ? state.turn : undefined;
      const inputTokens = asNumber(entry.turn_input_tokens) ?? 0;
      const outputTokens = asNumber(entry.turn_output_tokens) ?? 0;
      const cacheRead = asNumber(entry.turn_cache_read_tokens);
      const cacheWrite = asNumber(entry.turn_cache_write_tokens);
      const reasoning = asNumber(entry.turn_reasoning_tokens) ?? asNumber(entry.reasoning_tokens);
      const total =
        asNumber(entry.turn_total_tokens) ??
        inputTokens + outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0) + (reasoning ?? 0);

      const usage: Usage = {
        inputTokens,
        outputTokens,
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
        totalTokens: total,
      };

      // Prefer cumulative for run-level summary when present.
      const cumIn = asNumber(entry.cumulative_input_tokens);
      const cumOut = asNumber(entry.cumulative_output_tokens);
      if (cumIn !== undefined && cumOut !== undefined) {
        state.cumulativeUsage = {
          inputTokens: cumIn,
          outputTokens: cumOut,
          ...(asNumber(entry.cumulative_cache_read_tokens) !== undefined
            ? { cacheReadTokens: asNumber(entry.cumulative_cache_read_tokens) }
            : {}),
          ...(asNumber(entry.cumulative_cache_write_tokens) !== undefined
            ? { cacheWriteTokens: asNumber(entry.cumulative_cache_write_tokens) }
            : {}),
          totalTokens:
            cumIn +
            cumOut +
            (asNumber(entry.cumulative_cache_read_tokens) ?? 0) +
            (asNumber(entry.cumulative_cache_write_tokens) ?? 0),
        };
      }

      out.push({
        ...base(),
        type: "usage",
        ...(turn !== undefined ? { turn } : {}),
        ...usage,
      });
      break;
    }

    case "verification_summary": {
      // Surfaced to judge as a signal via log.
      const passFail = asString(entry.pass_fail) ?? "unknown";
      const attempt = asNumber(entry.attempt_count);
      const score = asNumber(entry.score);
      const lite = asBoolean(entry.lite_verified);
      const parts = [
        `verification_summary pass_fail=${passFail}`,
        attempt !== undefined ? `attempts=${attempt}` : undefined,
        lite !== undefined ? `lite_verified=${lite}` : undefined,
        score !== undefined ? `score=${score}` : undefined,
        asString(entry.score_source) ? `source=${asString(entry.score_source)}` : undefined,
      ].filter(Boolean);
      out.push({
        ...base(),
        type: "log",
        level: passFail === "fail" ? "warn" : "info",
        message: parts.join(" "),
      });
      break;
    }

    case "run_end": {
      // Expected shape from plan/reapercode-changes.md change ③.
      state.sawRunEnd = true;
      const status = mapRunStatus(entry.status);
      const durationMs =
        asNumber(entry.duration_ms) ??
        asNumber(entry.durationMs) ??
        (state.startedAtMs !== undefined ? Math.max(0, Date.parse(ts) - state.startedAtMs) : 0);

      const usageFromEntry = asRecord(entry.usage);
      let usageTotal = state.cumulativeUsage;
      if (usageFromEntry) {
        usageTotal = {
          inputTokens: asNumber(usageFromEntry.input_tokens) ?? 0,
          outputTokens: asNumber(usageFromEntry.output_tokens) ?? 0,
          ...(asNumber(usageFromEntry.reasoning_tokens) !== undefined
            ? { reasoningTokens: asNumber(usageFromEntry.reasoning_tokens) }
            : {}),
          ...(asNumber(usageFromEntry.cache_read_tokens) !== undefined
            ? { cacheReadTokens: asNumber(usageFromEntry.cache_read_tokens) }
            : {}),
          ...(asNumber(usageFromEntry.cache_write_tokens) !== undefined
            ? { cacheWriteTokens: asNumber(usageFromEntry.cache_write_tokens) }
            : {}),
          ...(asNumber(usageFromEntry.total_tokens) !== undefined
            ? { totalTokens: asNumber(usageFromEntry.total_tokens) }
            : {}),
        };
      }

      // Optional final assistant message carried on run_end. This reopens the
      // just-closed turn (if any) for the message — it does NOT open a new turn.
      const finalMsg = asString(entry.assistant_message);
      if (finalMsg && finalMsg.length > 0) {
        const turn = state.turnOpened ? state.turn : state.ensureTurn();
        out.push({
          ...base(),
          type: "message",
          turn,
          mode: "full",
          text: finalMsg,
        });
      }

      out.push({
        ...base(),
        type: "run.end",
        status,
        durationMs,
        ...(usageTotal ? { usageTotal } : {}),
      });
      break;
    }

    // Unmapped but known trajectory kinds → debug log so nothing is silently dropped.
    case "state_transition":
    case "policy_decision":
    case "recovery_summary":
    case "agent_step":
    case "step_analysis":
    case "session_metrics":
    case "subagent_prompt":
    case "context_shake":
    case "bash_head_tail":
    case "time_microcompact":
    case "ptl_recovery":
    case "full_summary":
    case "handoff_summary":
    case "idle_compaction":
    case "incomplete_recovery":
    case "snapcompact":
    case "promoted_context_model":
    case "router_decision":
    case "empty_stop_retry":
    case "unexpected_stop_retry":
    case "premature_stop_nudge":
    case "tool_call_parse_error":
    case "hook_error": {
      out.push({
        ...base(),
        type: "log",
        level: mapLogLevel(entry.level),
        message: `reaper.${kind}`,
      });
      break;
    }

    default: {
      // Unknown kind — still surface as a debug log for diagnostics.
      out.push({
        ...base(),
        type: "log",
        level: "debug",
        message: `reaper.unknown_kind kind=${kind}`,
      });
      break;
    }
  }

  return out;
}

/** True when a value looks like a Reaper trajectory envelope. */
export function isReaperTrajectoryEntry(value: unknown): value is ReaperTrajectoryEntry {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === "string" && typeof v.timestamp === "string";
}

/**
 * Parse a complete in-memory trajectory (array of entries or JSONL text)
 * into canonical events. Used by tests and offline file-path mode.
 */
export function parseReaperTrajectory(
  input: string | readonly unknown[],
  ctx: RunContext,
  options?: ReaperParseOptions,
): CanonicalEvent[] {
  const entries: unknown[] =
    typeof input === "string"
      ? input
          .split(/\r?\n/)
          .map((l) => {
            try {
              return parseJsonlLine(l);
            } catch {
              return null;
            }
          })
          .filter((x) => x !== null)
      : [...input];

  const state = new ParseState();
  const events: CanonicalEvent[] = [];
  for (const raw of entries) {
    if (!isReaperTrajectoryEntry(raw)) continue;
    events.push(...mapReaperEntry(raw, ctx, state, options));
  }
  return events;
}

/**
 * Async generator: map a live stdout JSONL stream (`--stream-events`) to
 * canonical events. After the stream ends, if no `run_end` was seen, synthesize
 * a `run.end` from exit metadata (robustness rule from plan/adapters.md).
 */
export async function* parseReaperStream(
  streams: AgentStreams,
  ctx: RunContext,
  options?: ReaperParseOptions,
): AsyncGenerator<CanonicalEvent> {
  const state = new ParseState();

  for await (const line of linesFromStream(streams.stdout)) {
    let parsed: unknown;
    try {
      parsed = parseJsonlLine(line);
    } catch {
      yield {
        v: 1,
        runId: ctx.runId,
        seq: state.nextSeq(),
        ts: new Date().toISOString(),
        type: "log",
        level: "debug",
        message: `reaper.unparseable_jsonl: ${line.slice(0, 200)}`,
      };
      continue;
    }
    if (parsed === null) continue;
    if (!isReaperTrajectoryEntry(parsed)) {
      yield {
        v: 1,
        runId: ctx.runId,
        seq: state.nextSeq(),
        ts: new Date().toISOString(),
        type: "log",
        level: "debug",
        message: "reaper.non_trajectory_line",
      };
      continue;
    }
    for (const ev of mapReaperEntry(parsed, ctx, state, options)) {
      yield ev;
    }
  }

  // Robustness: never trust clean exit alone — synthesize run.end if missing.
  if (!state.sawRunEnd) {
    const exitCode = streams.exitCode !== undefined ? await streams.exitCode : undefined;
    const durationMs =
      streams.durationMs !== undefined
        ? await streams.durationMs
        : state.startedAtMs !== undefined
          ? Math.max(0, Date.now() - state.startedAtMs)
          : 0;
    const status: RunStatus =
      exitCode === 0 ? "completed" : exitCode === undefined ? "failed" : "failed";
    yield {
      v: 1,
      runId: ctx.runId,
      seq: state.nextSeq(),
      ts: new Date().toISOString(),
      type: "run.end",
      status,
      durationMs,
      ...(state.cumulativeUsage ? { usageTotal: state.cumulativeUsage } : {}),
    };
  }
}

/** Build the headless ReaperCode launch command (post-change flags). */
export function buildReaperCommand(ctx: RunContext): AdapterCommand {
  const argv = [
    "node",
    "bin/reaper",
    "exec",
    "run",
    "--prompt",
    ctx.task.prompt,
    "--workspace",
    "/workspace",
    "--provider",
    ctx.provider,
    "--model",
    ctx.model,
    // Required change ②A — trajectory JSONL on stdout.
    "--stream-events",
  ];

  const effort = ctx.params.reasoningEffort;
  if (typeof effort === "string" && effort.length > 0) {
    argv.push("--reasoning-effort", effort);
  }
  const maxTokens = ctx.params.maxTokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
    argv.push("--max-tokens", String(maxTokens));
  }

  const env: Record<string, string> = {
    ...ctx.overrides?.env,
    // Env-form of the stream flag, accepted per plan/reapercode-changes.md.
    REAPER_STREAM_EVENTS: "1",
  };
  // Inject API keys without logging them (runner redacts separately).
  for (const [k, v] of Object.entries(ctx.apiKeys)) {
    env[k] = v;
  }

  return { argv, env };
}

export function reaperImage(ctx: RunContext): string {
  return ctx.overrides?.image ?? DEFAULT_IMAGE;
}

/**
 * The registered ReaperCode adapter.
 *
 * Status: {@link ADAPTER_STATUS} — live runs need ReaperCode changes from
 * plan/reapercode-changes.md (thinking + stream-events + run_end).
 */
export const reaperCodeAdapter: Adapter = {
  id: "reapercode",
  image: reaperImage,
  command: buildReaperCommand,
  parse(streams, ctx) {
    return parseReaperStream(streams, ctx);
  },
};

export default reaperCodeAdapter;

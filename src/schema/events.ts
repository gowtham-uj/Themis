/**
 * Canonical event schema — the standard protocol every adapter emits.
 * Spec: plan/event-schema.md
 *
 * Flat, append-only, discriminated by `type`. Storage is JSONL; consumers
 * (SSE, judge, UI) read the same vocabulary.
 */

/** Schema version currently emitted by adapters. */
export const SCHEMA_VERSION = 1 as const;

/** All event type discriminators. */
export const EVENT_TYPES = [
  "run.start",
  "run.end",
  "turn.start",
  "turn.end",
  "thinking",
  "message",
  "tool.call",
  "tool.result",
  "usage",
  // Sandbox telemetry (plan/event-schema.md, plan/execution.md): emitted by the container
  // instrumentation, not by agent adapters. Ground truth of what the agent *did in the sandbox*.
  "exec",
  "net",
  "error",
  "log",
] as const;

/**
 * The complete list of event types the platform defines — asserted against in tests so a
 * self-referential exhaustiveness check can never hide a missing type. Must match plan/event-schema.md.
 */
export const PLAN_EVENT_TYPES: readonly string[] = EVENT_TYPES;

export type EventType = (typeof EVENT_TYPES)[number];

export type AgentId = "reapercode" | "pi";

export type WorkspaceSource = "git" | "empty";

export type StopReason = "stop" | "toolUse" | "length" | "error" | "aborted";

export type RunStatus = "completed" | "failed" | "aborted" | "timeout";
/** Alias used by adapters for `run.end.status`. */
export type RunEndStatus = RunStatus;

export type ErrorPhase = "prepare" | "agent" | "finalize";

export type LogLevel = "info" | "warn" | "debug";

export type ContentMode = "delta" | "full";

/** Token + cost counters shared by `usage` events and `run.end.usageTotal`. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    total?: number;
  };
}
/** Alias used by adapters for usage mapping payloads. */
export type UsagePayload = Usage;

/** Workspace provenance recorded on `run.start`. */
export interface WorkspaceInfo {
  source: WorkspaceSource;
  repo?: string;
  commit?: string;
}

/** Fields every event carries. */
export interface EventEnvelope {
  /** Schema version. */
  v: typeof SCHEMA_VERSION;
  /** Eval run id. */
  runId: string;
  /** Monotonic sequence within the run (adapter-assigned). */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Model turn index, when applicable. */
  turn?: number;
}

export interface RunStartEvent extends EventEnvelope {
  type: "run.start";
  agent: AgentId;
  model: string;
  provider: string;
  workspace: WorkspaceInfo;
  /** Launch knobs: temperature, reasoningEffort, maxTokens, ... */
  params: Record<string, unknown>;
}

export interface RunEndEvent extends EventEnvelope {
  type: "run.end";
  status: RunStatus;
  durationMs: number;
  /** Path to the harness-produced patch, e.g. runs/<id>/diff.patch. */
  diffPath?: string;
  usageTotal?: Usage;
}

export interface TurnStartEvent extends EventEnvelope {
  type: "turn.start";
  turn: number;
}

export interface TurnEndEvent extends EventEnvelope {
  type: "turn.end";
  turn: number;
  stopReason?: StopReason;
}

export interface ThinkingEvent extends EventEnvelope {
  type: "thinking";
  turn: number;
  mode: ContentMode;
  text: string;
  /** Provider "thinkingSignature" when present. */
  signature?: string;
}

export interface MessageEvent extends EventEnvelope {
  type: "message";
  turn: number;
  mode: ContentMode;
  text: string;
}

export interface ToolCallEvent extends EventEnvelope {
  type: "tool.call";
  turn: number;
  /** Correlates with the matching `tool.result`. */
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultEvent extends EventEnvelope {
  type: "tool.result";
  /** Correlates with the matching `tool.call`. */
  id: string;
  name?: string;
  isError: boolean;
  output: unknown;
  durationMs?: number;
  /** Set when large output was truncated for the stream. */
  truncated?: boolean;
}

export interface UsageEvent extends EventEnvelope {
  type: "usage";
  turn?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    total?: number;
  };
}

/** A command the sandbox executed — captured by exec instrumentation, not model-authored. Spec: event-schema.md §exec. */
export interface ExecEvent extends EventEnvelope {
  type: "exec";
  /** The exact argv as exec'd in the sandbox. */
  argv: string[];
  /** Working dir inside the container. */
  cwd: string;
  /** uid/name it ran as (sanity: the non-root sandbox user). */
  user: string;
  /** null if killed / killed-by-timeout. */
  exitCode: number | null;
  durationMs: number;
  /** True if a policy (net allowlist / command denylist) refused it. */
  blocked?: boolean;
  blockedReason?: string;
}

export type NetProto = "tcp" | "udp" | "http";
export type NetDirection = "outbound" | "inbound";

/** An outbound/inbound network call the sandbox made — captured at the container network edge. Spec: event-schema.md §net. */
export interface NetEvent extends EventEnvelope {
  type: "net";
  host: string;
  port: number;
  proto: NetProto;
  direction: NetDirection;
  /** For http(s). */
  method?: string;
  url?: string;
  bytesSent?: number;
  bytesRecv?: number;
  status?: number;
  durationMs?: number;
  /** True if a network policy refused the connection (allowlist miss, live cutoff, offline mode). */
  blocked?: boolean;
  blockedReason?: string;
}

export interface ErrorEvent extends EventEnvelope {
  type: "error";
  message: string;
  phase?: ErrorPhase;
  fatal?: boolean;
}

export interface LogEvent extends EventEnvelope {
  type: "log";
  level: LogLevel;
  message: string;
}

/**
 * Discriminated union of every canonical event.
 * Narrow with `event.type` or {@link isCanonicalEvent}.
 */
export type CanonicalEvent =
  | RunStartEvent
  | RunEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ThinkingEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | UsageEvent
  | ExecEvent
  | NetEvent
  | ErrorEvent
  | LogEvent;

/** Thrown by {@link validateCanonicalEvent} on structural failures. */
export class EventValidationError extends Error {
  readonly path: string;
  constructor(message: string, path = "") {
    super(path ? `${path}: ${message}` : message);
    this.name = "EventValidationError";
    this.path = path;
  }
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);
const AGENT_IDS: ReadonlySet<string> = new Set(["reapercode", "pi"]);
const WORKSPACE_SOURCES: ReadonlySet<string> = new Set(["git", "empty"]);
const STOP_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "toolUse",
  "length",
  "error",
  "aborted",
]);
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "aborted",
  "timeout",
]);
const ERROR_PHASES: ReadonlySet<string> = new Set([
  "prepare",
  "agent",
  "finalize",
]);
const LOG_LEVELS: ReadonlySet<string> = new Set(["info", "warn", "debug"]);
const CONTENT_MODES: ReadonlySet<string> = new Set(["delta", "full"]);
const NET_PROTOS: ReadonlySet<string> = new Set(["tcp", "udp", "http"]);
const NET_DIRECTIONS: ReadonlySet<string> = new Set(["outbound", "inbound"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const v = obj[key];
  if (!isString(v)) {
    throw new EventValidationError(`expected string \`${key}\``, path);
  }
  return v;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const v = obj[key];
  if (!isNumber(v)) {
    throw new EventValidationError(`expected number \`${key}\``, path);
  }
  return v;
}

function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const v = obj[key];
  if (!isBoolean(v)) {
    throw new EventValidationError(`expected boolean \`${key}\``, path);
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (!isString(v)) {
    throw new EventValidationError(`expected string \`${key}\``, path);
  }
  return v;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (!isNumber(v)) {
    throw new EventValidationError(`expected number \`${key}\``, path);
  }
  return v;
}

function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  const v = obj[key];
  if (!isBoolean(v)) {
    throw new EventValidationError(`expected boolean \`${key}\``, path);
  }
  return v;
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  path: string,
): T {
  const v = requireString(obj, key, path);
  if (!allowed.has(v)) {
    throw new EventValidationError(
      `invalid \`${key}\`: ${JSON.stringify(v)}`,
      path,
    );
  }
  return v as T;
}

function optionalEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  path: string,
): T | undefined {
  if (!(key in obj) || obj[key] === undefined) return undefined;
  return requireEnum<T>(obj, key, allowed, path);
}

function parseUsage(value: unknown, path: string): Usage {
  if (!isObject(value)) {
    throw new EventValidationError("expected usage object", path);
  }
  const usage: Usage = {
    inputTokens: requireNumber(value, "inputTokens", path),
    outputTokens: requireNumber(value, "outputTokens", path),
  };
  const reasoningTokens = optionalNumber(value, "reasoningTokens", path);
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  const cacheReadTokens = optionalNumber(value, "cacheReadTokens", path);
  if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = optionalNumber(value, "cacheWriteTokens", path);
  if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
  const totalTokens = optionalNumber(value, "totalTokens", path);
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if ("cost" in value && value.cost !== undefined) {
    if (!isObject(value.cost)) {
      throw new EventValidationError("expected cost object", `${path}.cost`);
    }
    const cost: NonNullable<Usage["cost"]> = {};
    const ci = optionalNumber(value.cost, "input", `${path}.cost`);
    if (ci !== undefined) cost.input = ci;
    const co = optionalNumber(value.cost, "output", `${path}.cost`);
    if (co !== undefined) cost.output = co;
    const ct = optionalNumber(value.cost, "total", `${path}.cost`);
    if (ct !== undefined) cost.total = ct;
    usage.cost = cost;
  }
  return usage;
}

function parseEnvelope(
  obj: Record<string, unknown>,
  path: string,
): EventEnvelope {
  const v = obj.v;
  if (v !== SCHEMA_VERSION) {
    throw new EventValidationError(
      `expected v=${SCHEMA_VERSION}, got ${JSON.stringify(v)}`,
      path,
    );
  }
  const runId = requireString(obj, "runId", path);
  const seq = requireNumber(obj, "seq", path);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new EventValidationError(
      `seq must be a non-negative integer`,
      path,
    );
  }
  const ts = requireString(obj, "ts", path);
  const turn = optionalNumber(obj, "turn", path);
  const envelope: EventEnvelope = { v: SCHEMA_VERSION, runId, seq, ts };
  if (turn !== undefined) {
    if (!Number.isInteger(turn) || turn < 0) {
      throw new EventValidationError(
        `turn must be a non-negative integer`,
        path,
      );
    }
    envelope.turn = turn;
  }
  return envelope;
}

function parseWorkspace(value: unknown, path: string): WorkspaceInfo {
  if (!isObject(value)) {
    throw new EventValidationError("expected workspace object", path);
  }
  const source = requireEnum<WorkspaceSource>(
    value,
    "source",
    WORKSPACE_SOURCES,
    path,
  );
  const workspace: WorkspaceInfo = { source };
  const repo = optionalString(value, "repo", path);
  if (repo !== undefined) workspace.repo = repo;
  const commit = optionalString(value, "commit", path);
  if (commit !== undefined) workspace.commit = commit;
  return workspace;
}

/**
 * Validate and narrow an unknown value to {@link CanonicalEvent}.
 * Throws {@link EventValidationError} on any structural failure.
 */
export function validateCanonicalEvent(value: unknown): CanonicalEvent {
  if (!isObject(value)) {
    throw new EventValidationError("event must be an object");
  }
  const type = requireEnum<EventType>(value, "type", EVENT_TYPE_SET, "");
  const base = parseEnvelope(value, type);

  switch (type) {
    case "run.start": {
      if (!isObject(value.params)) {
        throw new EventValidationError("expected params object", type);
      }
      return {
        ...base,
        type,
        agent: requireEnum<AgentId>(value, "agent", AGENT_IDS, type),
        model: requireString(value, "model", type),
        provider: requireString(value, "provider", type),
        workspace: parseWorkspace(value.workspace, `${type}.workspace`),
        params: value.params as Record<string, unknown>,
      };
    }
    case "run.end": {
      const status = requireEnum<RunStatus>(
        value,
        "status",
        RUN_STATUSES,
        type,
      );
      const durationMs = requireNumber(value, "durationMs", type);
      const event: RunEndEvent = { ...base, type, status, durationMs };
      const diffPath = optionalString(value, "diffPath", type);
      if (diffPath !== undefined) event.diffPath = diffPath;
      if ("usageTotal" in value && value.usageTotal !== undefined) {
        event.usageTotal = parseUsage(value.usageTotal, `${type}.usageTotal`);
      }
      return event;
    }
    case "turn.start": {
      const turn = requireNumber(value, "turn", type);
      if (!Number.isInteger(turn) || turn < 0) {
        throw new EventValidationError(
          "turn must be a non-negative integer",
          type,
        );
      }
      return { ...base, type, turn };
    }
    case "turn.end": {
      const turn = requireNumber(value, "turn", type);
      if (!Number.isInteger(turn) || turn < 0) {
        throw new EventValidationError(
          "turn must be a non-negative integer",
          type,
        );
      }
      const event: TurnEndEvent = { ...base, type, turn };
      const stopReason = optionalEnum<StopReason>(
        value,
        "stopReason",
        STOP_REASONS,
        type,
      );
      if (stopReason !== undefined) event.stopReason = stopReason;
      return event;
    }
    case "thinking": {
      const turn = requireNumber(value, "turn", type);
      if (!Number.isInteger(turn) || turn < 0) {
        throw new EventValidationError(
          "turn must be a non-negative integer",
          type,
        );
      }
      const event: ThinkingEvent = {
        ...base,
        type,
        turn,
        mode: requireEnum<ContentMode>(value, "mode", CONTENT_MODES, type),
        text: requireString(value, "text", type),
      };
      const signature = optionalString(value, "signature", type);
      if (signature !== undefined) event.signature = signature;
      return event;
    }
    case "message": {
      const turn = requireNumber(value, "turn", type);
      if (!Number.isInteger(turn) || turn < 0) {
        throw new EventValidationError(
          "turn must be a non-negative integer",
          type,
        );
      }
      return {
        ...base,
        type,
        turn,
        mode: requireEnum<ContentMode>(value, "mode", CONTENT_MODES, type),
        text: requireString(value, "text", type),
      };
    }
    case "tool.call": {
      const turn = requireNumber(value, "turn", type);
      if (!Number.isInteger(turn) || turn < 0) {
        throw new EventValidationError(
          "turn must be a non-negative integer",
          type,
        );
      }
      if (!("args" in value)) {
        throw new EventValidationError("missing `args`", type);
      }
      return {
        ...base,
        type,
        turn,
        id: requireString(value, "id", type),
        name: requireString(value, "name", type),
        args: value.args,
      };
    }
    case "tool.result": {
      if (!("output" in value)) {
        throw new EventValidationError("missing `output`", type);
      }
      const event: ToolResultEvent = {
        ...base,
        type,
        id: requireString(value, "id", type),
        isError: requireBoolean(value, "isError", type),
        output: value.output,
      };
      const name = optionalString(value, "name", type);
      if (name !== undefined) event.name = name;
      const durationMs = optionalNumber(value, "durationMs", type);
      if (durationMs !== undefined) event.durationMs = durationMs;
      const truncated = optionalBoolean(value, "truncated", type);
      if (truncated !== undefined) event.truncated = truncated;
      return event;
    }
    case "usage": {
      const parsed = parseUsage(value, type);
      const event: UsageEvent = {
        ...base,
        type,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
      };
      if (parsed.reasoningTokens !== undefined) {
        event.reasoningTokens = parsed.reasoningTokens;
      }
      if (parsed.cacheReadTokens !== undefined) {
        event.cacheReadTokens = parsed.cacheReadTokens;
      }
      if (parsed.cacheWriteTokens !== undefined) {
        event.cacheWriteTokens = parsed.cacheWriteTokens;
      }
      if (parsed.totalTokens !== undefined) {
        event.totalTokens = parsed.totalTokens;
      }
      if (parsed.cost !== undefined) event.cost = parsed.cost;
      // turn is already on base if present
      return event;
    }
    case "exec": {
      const argv = value.argv;
      if (!Array.isArray(argv) || !argv.every(isString)) {
        throw new EventValidationError("expected string[] `argv`", type);
      }
      const cwd = requireString(value, "cwd", type);
      const user = requireString(value, "user", type);
      const exitRaw = value.exitCode;
      let exitCode: number | null;
      if (exitRaw === null) {
        exitCode = null;
      } else {
        exitCode = requireNumber(value, "exitCode", type);
        if (!Number.isInteger(exitCode)) {
          throw new EventValidationError("exitCode must be an integer or null", type);
        }
      }
      const durationMs = requireNumber(value, "durationMs", type);
      const event: ExecEvent = { ...base, type, argv, cwd, user, exitCode, durationMs };
      const blocked = optionalBoolean(value, "blocked", type);
      if (blocked !== undefined) event.blocked = blocked;
      const blockedReason = optionalString(value, "blockedReason", type);
      if (blockedReason !== undefined) event.blockedReason = blockedReason;
      return event;
    }
    case "net": {
      const event: NetEvent = {
        ...base,
        type,
        host: requireString(value, "host", type),
        port: requireNumber(value, "port", type),
        proto: requireEnum<NetProto>(value, "proto", NET_PROTOS, type),
        direction: requireEnum<NetDirection>(value, "direction", NET_DIRECTIONS, type),
      };
      const method = optionalString(value, "method", type);
      if (method !== undefined) event.method = method;
      const url = optionalString(value, "url", type);
      if (url !== undefined) event.url = url;
      const bytesSent = optionalNumber(value, "bytesSent", type);
      if (bytesSent !== undefined) event.bytesSent = bytesSent;
      const bytesRecv = optionalNumber(value, "bytesRecv", type);
      if (bytesRecv !== undefined) event.bytesRecv = bytesRecv;
      const status = optionalNumber(value, "status", type);
      if (status !== undefined) {
        if (!Number.isInteger(status)) {
          throw new EventValidationError("status must be an integer", type);
        }
        event.status = status;
      }
      const netDurationMs = optionalNumber(value, "durationMs", type);
      if (netDurationMs !== undefined) event.durationMs = netDurationMs;
      const blocked = optionalBoolean(value, "blocked", type);
      if (blocked !== undefined) event.blocked = blocked;
      const blockedReason = optionalString(value, "blockedReason", type);
      if (blockedReason !== undefined) event.blockedReason = blockedReason;
      return event;
    }
    case "error": {
      const event: ErrorEvent = {
        ...base,
        type,
        message: requireString(value, "message", type),
      };
      const phase = optionalEnum<ErrorPhase>(
        value,
        "phase",
        ERROR_PHASES,
        type,
      );
      if (phase !== undefined) event.phase = phase;
      const fatal = optionalBoolean(value, "fatal", type);
      if (fatal !== undefined) event.fatal = fatal;
      return event;
    }
    case "log": {
      return {
        ...base,
        type,
        level: requireEnum<LogLevel>(value, "level", LOG_LEVELS, type),
        message: requireString(value, "message", type),
      };
    }
    default: {
      // Exhaustiveness: EventType is fully covered above.
      const _exhaustive: never = type;
      throw new EventValidationError(
        `unknown type ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Type guard: true when `value` is a well-formed {@link CanonicalEvent}.
 * Prefer {@link validateCanonicalEvent} when you need structured errors.
 */
export function isCanonicalEvent(value: unknown): value is CanonicalEvent {
  try {
    validateCanonicalEvent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert that a switch/map over EventType is exhaustive at compile time.
 * Call with the residual `never` value in a default branch.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `unexpected value: ${JSON.stringify(value)}`);
}

/**
 * Public schema surface: canonical events + JSONL I/O.
 * Spec: plan/event-schema.md
 */

export type {
  AgentId,
  CanonicalEvent,
  ContentMode,
  ErrorEvent,
  ErrorPhase,
  EventEnvelope,
  EventType,
  ExecEvent,
  LogEvent,
  LogLevel,
  MessageEvent,
  RunEndEvent,
  RunEndStatus,
  RunStartEvent,
  RunStatus,
  StopReason,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
  Usage,
  UsageEvent,
  UsagePayload,
  WorkspaceInfo,
  WorkspaceSource,
} from "./events.js";

export {
  assertNever,
  EVENT_TYPES,
  EventValidationError,
  isCanonicalEvent,
  SCHEMA_VERSION,
  validateCanonicalEvent,
} from "./events.js";

export {
  appendJsonl,
  linesFromStream,
  parseJsonl,
  parseJsonlLine,
  readFromSeq,
  readJsonl,
  toJsonlLine,
} from "./jsonl.js";

export { appendEvent } from "./append.js";

/**
 * Exec + net telemetry capture for the sandbox.
 *
 * Spec: plan/execution.md §Telemetry: exec + net events as first-class run logs,
 * plan/event-schema.md ExecEvent / NetEvent.
 *
 * {@link ExecNetRecorder} records every process the sandbox spawns and every
 * network call at the container edge into the run's `events.jsonl`, with
 * monotonic `seq`s. Driven by a runtime:
 *  - Fake runtime (tests): receives hooks via {@link recordExec} / {@link recordNet}.
 *  - Real deploy: fed by LD_PRELOAD / eBPF / transparent proxy into the same methods.
 *
 * Live network cutoff (see {@link NetworkCutoffController}): when the cutoff is
 * active, outbound net attempts are recorded as
 * `net{blocked:true, blockedReason:"live-cutoff"}` instead of a successful flow.
 */

import { appendEvent } from "../schema/append.js";
import {
  SCHEMA_VERSION,
  validateCanonicalEvent,
  type ExecEvent,
  type NetEvent,
  type NetDirection,
  type NetProto,
} from "../schema/events.js";
import type { NetworkCutoffController } from "./network-control.js";

/** Input for {@link ExecNetRecorder.recordExec}. */
export interface RecordExecInput {
  argv: string[];
  cwd: string;
  user: string;
  /** null if still running / killed without an exit code. */
  exitCode: number | null;
  durationMs: number;
  turn?: number;
  blocked?: boolean;
  blockedReason?: string;
}

/** Input for {@link ExecNetRecorder.recordNet}. */
export interface RecordNetInput {
  host: string;
  port: number;
  proto: NetProto;
  direction: NetDirection;
  method?: string;
  url?: string;
  bytesSent?: number;
  bytesRecv?: number;
  status?: number;
  durationMs?: number;
  turn?: number;
  /** Caller-supplied block (e.g. allowlist miss). Live cutoff is applied on top. */
  blocked?: boolean;
  blockedReason?: string;
}

export interface ExecNetRecorderOptions {
  /** Eval run id written on every event. */
  runId: string;
  /** Absolute path to the run's events.jsonl. */
  eventsPath: string;
  /**
   * Live network-cutoff controller. When present and `isBlocked()`, outbound
   * net records become `blocked:true` with `blockedReason:"live-cutoff"`.
   */
  networkCutoff?: NetworkCutoffController;
  /** Starting seq (default 0). Next emitted event uses this value then increments. */
  startSeq?: number;
  /** Optional clock for tests (returns ISO-8601). Default: `new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Records sandbox exec + net activity as canonical events into events.jsonl.
 */
export class ExecNetRecorder {
  readonly runId: string;
  readonly eventsPath: string;
  private readonly networkCutoff: NetworkCutoffController | undefined;
  private nextSeq: number;
  private readonly now: () => string;

  constructor(opts: ExecNetRecorderOptions) {
    this.runId = opts.runId;
    this.eventsPath = opts.eventsPath;
    this.networkCutoff = opts.networkCutoff;
    this.nextSeq = opts.startSeq ?? 0;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Current next sequence number (the seq that will be assigned to the next event). */
  peekSeq(): number {
    return this.nextSeq;
  }

  /**
   * Append an `exec` event for a process the sandbox spawned.
   * Validates against the canonical schema before writing.
   */
  async recordExec(input: RecordExecInput): Promise<ExecEvent> {
    const event: ExecEvent = {
      v: SCHEMA_VERSION,
      runId: this.runId,
      seq: this.allocSeq(),
      ts: this.now(),
      type: "exec",
      argv: input.argv,
      cwd: input.cwd,
      user: input.user,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
    };
    if (input.turn !== undefined) event.turn = input.turn;
    if (input.blocked !== undefined) event.blocked = input.blocked;
    if (input.blockedReason !== undefined) event.blockedReason = input.blockedReason;

    const validated = validateCanonicalEvent(event) as ExecEvent;
    await appendEvent(this.eventsPath, validated);
    return validated;
  }

  /**
   * Append a `net` event for a connection at the container edge.
   * When live cutoff is active and direction is `"outbound"`, the event is
   * forced to `blocked:true` / `blockedReason:"live-cutoff"` (superseding any
   * caller-supplied block reason for that attempt).
   */
  async recordNet(input: RecordNetInput): Promise<NetEvent> {
    const liveBlocked =
      input.direction === "outbound" &&
      this.networkCutoff !== undefined &&
      this.networkCutoff.isBlocked();

    const event: NetEvent = {
      v: SCHEMA_VERSION,
      runId: this.runId,
      seq: this.allocSeq(),
      ts: this.now(),
      type: "net",
      host: input.host,
      port: input.port,
      proto: input.proto,
      direction: input.direction,
    };
    if (input.turn !== undefined) event.turn = input.turn;
    if (input.method !== undefined) event.method = input.method;
    if (input.url !== undefined) event.url = input.url;
    if (input.bytesSent !== undefined) event.bytesSent = input.bytesSent;
    if (input.bytesRecv !== undefined) event.bytesRecv = input.bytesRecv;
    if (input.status !== undefined) event.status = input.status;
    if (input.durationMs !== undefined) event.durationMs = input.durationMs;

    if (liveBlocked) {
      event.blocked = true;
      event.blockedReason = "live-cutoff";
      // Under live cutoff the connection did not complete — drop success-path fields
      // that would imply a completed transfer if the caller still passed them.
      // Keep method/url (what was attempted); clear completed transfer stats.
      delete event.bytesSent;
      delete event.bytesRecv;
      delete event.status;
    } else {
      if (input.blocked !== undefined) event.blocked = input.blocked;
      if (input.blockedReason !== undefined) event.blockedReason = input.blockedReason;
    }

    const validated = validateCanonicalEvent(event) as NetEvent;
    await appendEvent(this.eventsPath, validated);
    return validated;
  }

  private allocSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }
}

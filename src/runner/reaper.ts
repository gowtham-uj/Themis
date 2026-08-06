/**
 * Crash reaper for stale in-flight runs.
 *
 * A worker that leaves a run `running` past its heartbeat window is reaped:
 * the reaper appends a fatal `error` + `run.end{status:"failed"}` to that
 * run's `events.jsonl` so the run is terminal and inspectable.
 *
 * In-process, injectable registry — no DB in P2. P3 wires real storage behind
 * the same {@link InFlightRun} / list accessor seam.
 *
 * Spec: plan/execution.md § Job execution ("Crash-safe: a run left running past
 * a heartbeat window is reaped and marked failed").
 */

import { appendEvent } from "../schema/append.js";
import type { CanonicalEvent } from "../schema/events.js";
import { SCHEMA_VERSION } from "../schema/events.js";
import { readJsonl } from "../schema/jsonl.js";

/** Default staleness window: 5 minutes. */
export const DEFAULT_HEARTBEAT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Minimal in-flight run record. Storage is external (in-memory map in tests;
 * SQLite `runs` table in P3). The reaper only needs identity + heartbeat + path.
 */
export interface InFlightRun {
  /** Eval run id (matches events' `runId`). */
  runId: string;
  /** Absolute path of this run's `events.jsonl`. */
  eventsPath: string;
  /** Last time the worker heartbeated this run (epoch ms). */
  lastHeartbeatAt: number;
  /** Wall-clock when the run entered `running` (epoch ms); used for durationMs. */
  startedAt?: number;
  /** Optional project / batch metadata for future storage wiring. */
  projectId?: string;
  status?: "running" | "queued" | string;
}

/** Options for a single reap pass. */
export interface ReapOptions {
  /** Heartbeat staleness window in ms (default {@link DEFAULT_HEARTBEAT_WINDOW_MS}). */
  windowMs?: number;
  /**
   * Optional callback invoked after a run is reaped (so the registry / DB can
   * flip status to `failed`). Not required for correctness of the JSONL append.
   */
  onReaped?: (run: InFlightRun) => void | Promise<void>;
  /**
   * Override the message written into the fatal error event.
   * Default: "stale run reaped: heartbeat exceeded window".
   */
  message?: string;
}

/** Injectable registry accessor: list every currently in-flight run. */
export type ListInFlightRuns = () =>
  | readonly InFlightRun[]
  | Promise<readonly InFlightRun[]>;

export interface CrashReaperOptions {
  /** Function that returns the current set of in-flight runs. */
  listInFlight: ListInFlightRuns;
  /** Default window applied when `reap()` is called without opts.windowMs. */
  defaultWindowMs?: number;
}

/**
 * Crash reaper. Construct once with a registry accessor; call {@link reap}
 * periodically (or on demand) with the current clock.
 */
export class CrashReaper {
  private readonly listInFlight: ListInFlightRuns;
  private readonly defaultWindowMs: number;

  constructor(options: CrashReaperOptions) {
    this.listInFlight = options.listInFlight;
    this.defaultWindowMs =
      options.defaultWindowMs ?? DEFAULT_HEARTBEAT_WINDOW_MS;
  }

  /**
   * Scan in-flight runs and reap any whose `lastHeartbeatAt` is older than
   * `now - windowMs`. For each stale run: append a fatal `error` event and a
   * `run.end{status:"failed"}` to its `events.jsonl`.
   *
   * @returns the list of reaped `runId`s (empty when nothing was stale).
   */
  async reap(now: number, opts: ReapOptions = {}): Promise<string[]> {
    const windowMs = opts.windowMs ?? this.defaultWindowMs;
    const message =
      opts.message ??
      "stale run reaped: heartbeat exceeded window";

    const runs = await this.listInFlight();
    const reaped: string[] = [];

    for (const run of runs) {
      if (!run || typeof run.runId !== "string") continue;
      if (typeof run.lastHeartbeatAt !== "number") continue;
      const age = now - run.lastHeartbeatAt;
      if (age <= windowMs) continue;

      await this.reapOne(run, now, message);
      if (opts.onReaped) {
        await opts.onReaped(run);
      }
      reaped.push(run.runId);
    }

    return reaped;
  }

  /**
   * Append fatal error + failed run.end for a single stale run.
   * Seq numbers continue from the last event already on disk.
   *
   * Idempotency: if the run's JSONL already contains a terminal `run.end`,
   * the run finalized through normal paths (the registry is just stale) — do
   * NOT append a second terminal event, which would create a conflicting
   * status history. Return without writing; the caller still reports the runId
   * as reaped so `onReaped` can clean the stale registry entry.
   */
  private async reapOne(
    run: InFlightRun,
    now: number,
    message: string,
  ): Promise<void> {
    const [alreadyTerminal, baseMaxSeq] = await readTerminalAndMaxSeq(
      run.eventsPath,
    );
    if (alreadyTerminal) return;

    const nextSeq = baseMaxSeq + 1;
    const ts = new Date(now).toISOString();
    const startedAt = run.startedAt ?? run.lastHeartbeatAt;
    const durationMs = Math.max(0, now - startedAt);

    const errorEvent: CanonicalEvent = {
      v: SCHEMA_VERSION,
      runId: run.runId,
      seq: nextSeq,
      ts,
      type: "error",
      message,
      phase: "agent",
      fatal: true,
    };

    const endEvent: CanonicalEvent = {
      v: SCHEMA_VERSION,
      runId: run.runId,
      seq: nextSeq + 1,
      ts,
      type: "run.end",
      status: "failed",
      durationMs,
    };

    await appendEvent(run.eventsPath, errorEvent);
    await appendEvent(run.eventsPath, endEvent);
  }
}

/**
 * Construct a CrashReaper with the given registry accessor.
 * Convenience factory for callers that prefer a function over `new`.
 */
export function createCrashReaper(
  listInFlight: ListInFlightRuns,
  defaultWindowMs?: number,
): CrashReaper {
  return new CrashReaper({ listInFlight, defaultWindowMs });
}

/**
 * Read the max `seq` already present in a JSONL file AND whether a terminal
 * `run.end` event exists. Returns `[hasTerminal, maxSeq]` — `(false, -1)` when
 * the file is empty/missing.
 *
 * A future-proof reaper guards against appending a second terminal event when
 * the run already finalized (stale-registry case): two `run.end`s would produce
 * a conflicting status history and a non-monotonic terminal marker.
 */
async function readTerminalAndMaxSeq(
  eventsPath: string,
): Promise<[boolean, number]> {
  let max = -1;
  let hasTerminal = false;
  try {
    for await (const obj of readJsonl(eventsPath)) {
      if (
        obj &&
        typeof obj === "object" &&
        "seq" in obj &&
        typeof (obj as { seq: unknown }).seq === "number" &&
        Number.isFinite((obj as { seq: number }).seq)
      ) {
        const s = (obj as { seq: number }).seq;
        if (s > max) max = s;
      }
      if (
        obj &&
        typeof obj === "object" &&
        (obj as { type?: unknown }).type === "run.end"
      ) {
        hasTerminal = true;
      }
    }
  } catch {
    // Missing / unreadable file → treat as empty.
  }
  return [hasTerminal, max];
}

/**
 * Run-control layer — pause / resume / abort around a live ContainerHandle.
 *
 * Spec: plan/execution.md §Run control.
 *
 * Soft pause stops dequeuing new work (flag only; in-flight continues).
 * Hard pause freezes the container CPU (handle.pause → cgroup freezer / SIGSTOP).
 * Abort SIGTERM→SIGKILL, marks aborted, keeps partial events.jsonl + partial diff.
 * `duration_ms` excludes hard-paused intervals (pausedMs accumulator).
 */

import { appendEvent } from "../schema/append.js";
import type { RunStatus } from "../schema/events.js";
import type { ContainerHandle } from "./runtime.js";
import { deriveRunStatus } from "./run.js";

/** control_state values recorded on a run (plan/execution.md, plan/data-model.md). */
export type ControlState =
  | "running"
  | "paused-soft"
  | "paused-hard"
  | "resuming"
  | "aborting"
  | "aborted"
  | "completed"
  | "failed"
  | "timeout";

export interface RunControllerOptions {
  handle: ContainerHandle;
  /** Absolute path to the run's events.jsonl (append-only partial log). */
  eventsPath: string;
  runId: string;
  /** Wall-clock start (ms since epoch). Defaults to now. */
  startedAt?: number;
  /** Starting seq for operator events written by the controller. */
  nextSeq?: number;
}

export interface FinalizeInput {
  /** Adapter-reported terminal status, if any. */
  adapterStatus?: RunStatus;
  /** True when a fatal error event was already recorded. */
  sawFatalError?: boolean;
}

export interface FinalizeResult {
  status: RunStatus;
  exitCode: number;
  timedOut: boolean;
  /** Active duration excluding hard-paused intervals. */
  durationMs: number;
  controlState: ControlState;
}

const TERMINAL: ReadonlySet<ControlState> = new Set([
  "aborted",
  "completed",
  "failed",
  "timeout",
]);

/**
 * Wraps a {@link ContainerHandle} + the run's events.jsonl path and exposes the
 * operator control surface: soft/hard pause, resume, abort, and finalize.
 */
export class RunController {
  private readonly handle: ContainerHandle;
  private readonly eventsPath: string;
  private readonly runId: string;
  private readonly startedAt: number;

  private state: ControlState = "running";
  private _pauseCount = 0;
  private _pausedMs = 0;
  /** Timestamp when the current hard pause began, or null. */
  private hardPausedAt: number | null = null;
  private softPaused = false;
  private aborted = false;
  private nextSeq: number;
  private finalizePromise: Promise<FinalizeResult> | null = null;

  constructor(opts: RunControllerOptions) {
    this.handle = opts.handle;
    this.eventsPath = opts.eventsPath;
    this.runId = opts.runId;
    this.startedAt = opts.startedAt ?? Date.now();
    this.nextSeq = opts.nextSeq ?? 0;
  }

  controlState(): ControlState {
    return this.state;
  }

  pauseCount(): number {
    return this._pauseCount;
  }

  /** Accumulated hard-pause duration in ms (excludes soft pauses). */
  pausedMs(): number {
    let total = this._pausedMs;
    if (this.hardPausedAt !== null) {
      total += Date.now() - this.hardPausedAt;
    }
    return total;
  }

  /**
   * Active run duration: wall clock minus hard-paused intervals.
   * Soft pauses do not stop the clock (in-flight work continues).
   */
  durationMs(): number {
    return Math.max(0, Date.now() - this.startedAt - this.pausedMs());
  }

  /**
   * Soft: stop dequeuing (flag only; single-run context records state + lets in-flight finish).
   * Hard: freeze container CPU via handle.pause() (cgroup freezer analog).
   */
  async pause(mode: "soft" | "hard"): Promise<void> {
    if (TERMINAL.has(this.state) || this.state === "aborting") {
      return;
    }
    if (this.state === "paused-soft" || this.state === "paused-hard") {
      // Already paused — allow soft→hard upgrade only.
      if (mode === "hard" && this.state === "paused-soft") {
        await this.handle.pause();
        this.hardPausedAt = Date.now();
        this.softPaused = false;
        this.state = "paused-hard";
        this._pauseCount += 1;
      }
      return;
    }

    this._pauseCount += 1;
    if (mode === "soft") {
      this.softPaused = true;
      this.state = "paused-soft";
      return;
    }

    // hard
    await this.handle.pause();
    this.hardPausedAt = Date.now();
    this.softPaused = false;
    this.state = "paused-hard";
  }

  /**
   * Resume from soft or hard pause.
   * Soft → re-enqueue (here: state running). Hard → handle.resume() then running.
   */
  async resume(): Promise<void> {
    if (this.state !== "paused-soft" && this.state !== "paused-hard") {
      return;
    }
    this.state = "resuming";

    if (this.hardPausedAt !== null) {
      this._pausedMs += Date.now() - this.hardPausedAt;
      this.hardPausedAt = null;
      await this.handle.resume();
    }
    this.softPaused = false;
    this.state = "running";
  }

  /**
   * Abort the run: state aborting → handle.stop → state aborted.
   * Emits a fatal error event into events.jsonl; keeps partial logs.
   */
  async abort(graceMs?: number): Promise<void> {
    if (TERMINAL.has(this.state)) {
      return;
    }
    if (this.state === "aborting") {
      return;
    }

    this.state = "aborting";
    this.aborted = true;

    // Close out any open hard-pause interval before stop (stop will thaw + SIGTERM).
    if (this.hardPausedAt !== null) {
      this._pausedMs += Date.now() - this.hardPausedAt;
      this.hardPausedAt = null;
    }
    this.softPaused = false;

    try {
      await this.handle.stop(graceMs);
    } catch {
      // Best-effort stop; still mark aborted and record the operator error.
    }

    this.state = "aborted";

    // Record fatal operator-abort error; partial events.jsonl is preserved (append-only).
    await appendEvent(this.eventsPath, {
      v: 1,
      runId: this.runId,
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      type: "error",
      message: "aborted by operator",
      phase: "finalize",
      fatal: true,
    });
  }

  /**
   * Wait for the container to exit and derive final status.
   * Combines exit code + fatal + timeout + abort via {@link deriveRunStatus}.
   * Idempotent: subsequent calls return the same result.
   */
  async finalize(input: FinalizeInput = {}): Promise<FinalizeResult> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = this.doFinalize(input);
    return this.finalizePromise;
  }

  private async doFinalize(input: FinalizeInput): Promise<FinalizeResult> {
    // If still hard-paused when finalize is requested (e.g. wait after operator
    // pause without resume), thaw so wait can complete, but keep the pause accounted.
    if (this.state === "paused-hard" && this.hardPausedAt !== null) {
      // Do not auto-resume for accounting — wait() still works on a SIGSTOP'd process
      // once it exits for other reasons; if we need exit, the caller should resume or abort.
    }

    const { exitCode, timedOut } = await this.handle.wait();

    // Close any open hard-pause window now that the process has exited.
    if (this.hardPausedAt !== null) {
      this._pausedMs += Date.now() - this.hardPausedAt;
      this.hardPausedAt = null;
    }

    const status = deriveRunStatus({
      adapterStatus: input.adapterStatus,
      exitCode,
      sawFatalError: input.sawFatalError ?? false,
      timedOut,
      aborted: this.aborted,
    });

    // Only overwrite control_state if we haven't already reached a terminal
    // control state via abort() (aborted wins over exit-derived states).
    if (!TERMINAL.has(this.state) || this.state === "aborting") {
      this.state = statusToControlState(status);
    } else if (this.state !== "aborted") {
      this.state = statusToControlState(status);
    }
    // If already "aborted" from abort(), keep it.

    return {
      status,
      exitCode,
      timedOut,
      durationMs: Math.max(0, Date.now() - this.startedAt - this._pausedMs),
      controlState: this.state,
    };
  }

  /** Whether soft-pause is currently preventing new work (single-run flag). */
  isSoftPaused(): boolean {
    return this.softPaused || this.state === "paused-soft";
  }
}

function statusToControlState(status: RunStatus): ControlState {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    case "timeout":
      return "timeout";
    default: {
      const _x: never = status;
      return _x;
    }
  }
}

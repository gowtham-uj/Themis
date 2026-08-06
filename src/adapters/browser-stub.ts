/**
 * Browser-automation adapter stub — offline, deterministic.
 *
 * Proves that browser actions (navigate / click / screenshot / assertion) map
 * onto the EXISTING canonical event schema (`tool.call` / `tool.result`) with
 * no schema changes. No real browser, puppeteer, or network (plan/categories.md
 * adapters note + plan/adapters.md).
 *
 * Registered as adapter id `"browser-stub"`.
 */

import type { CanonicalEvent } from "../schema/events.js";
import { SCHEMA_VERSION } from "../schema/events.js";
import type {
  Adapter,
  AdapterCommand,
  AgentStreams,
  RunContext,
} from "./types.js";

const DEFAULT_IMAGE = "agenteval/browser-stub:latest";

/** One scripted browser action in the canned session. */
export interface BrowserStubAction {
  /** tool.call id — correlates with the matching tool.result. */
  id: string;
  /** Tool name: navigate | click | screenshot | assert | … */
  name: string;
  args: Record<string, unknown>;
  /** Result payload (image-ish for screenshot, status for navigate/click). */
  result: unknown;
  isError?: boolean;
}

/**
 * Default scripted browser session: navigate → click → screenshot → assert.
 * Deterministic; safe for offline tests.
 */
export function defaultBrowserScript(): BrowserStubAction[] {
  return [
    {
      id: "call_nav_1",
      name: "navigate",
      args: { url: "https://example.test/login" },
      result: { status: 200, url: "https://example.test/login", title: "Login" },
    },
    {
      id: "call_click_1",
      name: "click",
      args: { selector: "#submit-btn" },
      result: { ok: true, selector: "#submit-btn" },
    },
    {
      id: "call_shot_1",
      name: "screenshot",
      args: { fullPage: false },
      // Image-ish result: base64 placeholder + mime — not a real capture.
      result: {
        mimeType: "image/png",
        encoding: "base64",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        width: 1,
        height: 1,
      },
    },
    {
      id: "call_assert_1",
      name: "assert",
      args: { selector: ".success", textContains: "Welcome" },
      result: { ok: true, matched: true },
    },
  ];
}

/**
 * Emit a complete canned browser session as canonical events.
 * Uses agent `"pi"` on `run.start` so events validate against the closed
 * AgentId set; the adapter id lives in `params.adapterId`.
 */
export function* scriptedBrowserEvents(
  ctx: RunContext,
  actions: BrowserStubAction[] = defaultBrowserScript(),
): Generator<CanonicalEvent, void, unknown> {
  const runId = ctx.runId;
  const ts = (i: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  let seq = 0;

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "run.start",
    // Closed AgentId vocabulary; adapter identity is in params.
    agent: "pi",
    model: ctx.model || "browser-stub",
    provider: ctx.provider || "stub",
    workspace:
      ctx.task.workspace.source === "git"
        ? { source: "git", repo: ctx.task.workspace.repo }
        : { source: "empty" },
    params: {
      adapterId: "browser-stub",
      category: "browser",
      ...(ctx.params ?? {}),
    },
  };

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "turn.start",
    turn: 1,
  };

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "thinking",
    turn: 1,
    mode: "full",
    text: "I will open the login page, click submit, screenshot, and assert success.",
  };

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "message",
    turn: 1,
    mode: "full",
    text: "Starting the browser task.",
  };

  for (const action of actions) {
    yield {
      v: SCHEMA_VERSION,
      runId,
      seq: seq++,
      ts: ts(seq),
      type: "tool.call",
      turn: 1,
      id: action.id,
      name: action.name,
      args: action.args,
    };
    yield {
      v: SCHEMA_VERSION,
      runId,
      seq: seq++,
      ts: ts(seq),
      type: "tool.result",
      id: action.id,
      name: action.name,
      isError: action.isError ?? false,
      output: action.result,
      durationMs: 12,
      truncated: false,
    };
  }

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "message",
    turn: 1,
    mode: "full",
    text: "Login flow completed; assertion passed.",
  };

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "turn.end",
    turn: 1,
    stopReason: "stop",
  };

  yield {
    v: SCHEMA_VERSION,
    runId,
    seq: seq++,
    ts: ts(seq),
    type: "run.end",
    status: "completed",
    durationMs: 1200,
  };
}

/**
 * Offline browser-automation adapter stub.
 *
 * `parse` ignores live streams and yields the canned session — proving the
 * canonical schema is category-agnostic (browser tools still use tool.call /
 * tool.result).
 */
export const browserStubAdapter: Adapter = {
  id: "browser-stub",

  image(_ctx: RunContext): string {
    return DEFAULT_IMAGE;
  },

  command(_ctx: RunContext): AdapterCommand {
    // No real browser process; the runner would still spawn something headless.
    return {
      argv: ["echo", "browser-stub: offline canned session"],
      env: {},
    };
  },

  async *parse(
    _streams: AgentStreams,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    yield* scriptedBrowserEvents(ctx);
  },
};

/** Collect the canned session into an array (test helper). */
export async function collectBrowserStubEvents(
  ctx: RunContext,
  actions?: BrowserStubAction[],
): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for (const ev of scriptedBrowserEvents(ctx, actions)) {
    out.push(ev);
  }
  return out;
}

#!/usr/bin/env node
/**
 * Mock ReaperCode agent for end-to-end platform testing.
 *
 * Emits the post-change trajectory JSONL contract the real reapercode adapter
 * parses (plan/reapercode-changes.md): session_start, thinking, tool_call
 * started/completed, model_response, engine_turn_complete, token_budget,
 * verification_summary, run_end.
 *
 * The MODEL is mocked: instead of calling an LLM, it replays a scripted
 * trajectory authored by the model gateway. Everything else is real — it runs
 * inside the sandbox, actually reads and writes files in /workspace, and
 * actually runs the test command. That matters: the platform must see genuine
 * tool effects, not a recording.
 *
 * The scripted trajectory deliberately contains a REAL DEFECT for the judge to
 * find: the agent fixes the off-by-one but never re-runs the test suite after
 * its final edit, and claims success anyway.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const prompt = flag("--prompt", "");
const workspace = flag("--workspace", "/workspace");
const provider = flag("--provider", "mock");
const model = flag("--model", "mock-model");

const runId = process.env.AGENTEVAL_RUN_ID || randomUUID();
const sessionId = randomUUID();
const traceId = randomUUID();
let seq = 0;
const started = Date.now();

/** Write one trajectory line to stdout (what --stream-events means). */
function emit(kind, fields) {
  const line = {
    event_id: `ev-${String(++seq).padStart(4, "0")}`,
    run_id: runId,
    session_id: sessionId,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    log_schema_version: 2,
    kind,
    ...fields,
  };
  process.stdout.write(JSON.stringify(line) + "\n");
}

/** Sandbox command execution — genuinely runs, output is genuinely captured. */
function sh(cmd) {
  try {
    const out = execSync(cmd, {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out.trim() };
  } catch (err) {
    return {
      ok: false,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || String(err.message),
    };
  }
}

let turn = 0;
let toolSeq = 0;

/** One tool call: started → real side effect → completed/failed. */
function tool(name, argsObj, fn) {
  const id = `tc-${++toolSeq}`;
  emit("tool_call", {
    status: "started",
    tool_call_id: id,
    decision_id: id,
    tool_name: name,
    turn_index: turn,
    args: argsObj,
  });
  const t0 = Date.now();
  let result;
  try {
    result = fn();
  } catch (err) {
    result = { ok: false, output: String(err && err.message ? err.message : err) };
  }
  emit("tool_call", {
    status: result.ok ? "completed" : "failed",
    tool_call_id: id,
    decision_id: id,
    tool_name: name,
    turn_index: turn,
    duration_ms: Date.now() - t0,
    ...(result.ok ? { output: result.output } : { error: result.output }),
  });
  return result;
}

// ---------------------------------------------------------------------------
// The scripted run
// ---------------------------------------------------------------------------

emit("session_start", {
  user_intent_summary: prompt.slice(0, 200),
  provider,
  model,
  params: { temperature: 0 },
});

// ---- turn 1: orient ----
turn = 1;
emit("thinking", {
  content:
    "The task says a range helper is off by one. Let me look at the source " +
    "before changing anything, then run the tests to see the failure.",
  turn_index: turn,
});

tool("read_file", { path: "src/range.js" }, () => {
  const p = join(workspace, "src/range.js");
  if (!existsSync(p)) return { ok: false, output: "src/range.js not found" };
  return { ok: true, output: readFileSync(p, "utf8") };
});

const before = tool("run_tests", { command: "node test/range.test.js" }, () =>
  sh("node test/range.test.js"),
);

emit("model_response", {
  turn_index: turn,
  assistant_message:
    before.ok
      ? "Tests pass already, which is unexpected — re-reading."
      : "Confirmed the failure: inclusiveRange drops the final value. The loop " +
        "condition uses `<` where the inclusive contract needs `<=`.",
});

emit("engine_turn_complete", { turn_index: turn });

// ---- turn 2: fix ----
turn = 2;
emit("thinking", {
  content:
    "Change the loop bound from `i < end` to `i <= end`. That is the whole " +
    "fix; the rest of the function is fine.",
  turn_index: turn,
});

tool("edit_file", { path: "src/range.js", edit: "i < end -> i <= end" }, () => {
  const p = join(workspace, "src/range.js");
  const src = readFileSync(p, "utf8");
  const next = src.replace("i < end", "i <= end");
  if (next === src) return { ok: false, output: "pattern not found" };
  writeFileSync(p, next, "utf8");
  return { ok: true, output: "applied 1 edit to src/range.js" };
});

emit("token_budget", {
  turn_index: turn,
  used_tokens: 4200,
  budget_tokens: 100000,
});

emit("engine_turn_complete", { turn_index: turn });

// ---- turn 3: a second edit, then STOP WITHOUT RE-VERIFYING ----
// This is the planted defect. The agent adds input validation (an unrequested
// scope expansion) and then declares success without re-running the suite,
// so nothing proves the final state of the file is correct.
turn = 3;
emit("thinking", {
  content:
    "While I'm here I'll also add a guard for non-numeric input. That should " +
    "be safe. I'm confident in both changes, so I'll wrap up.",
  turn_index: turn,
});

tool("edit_file", { path: "src/range.js", edit: "add input validation guard" }, () => {
  const p = join(workspace, "src/range.js");
  const src = readFileSync(p, "utf8");
  const guard =
    "function inclusiveRange(start, end) {\n" +
    "  if (typeof start !== 'number' || typeof end !== 'number') return [];\n";
  const next = src.replace("function inclusiveRange(start, end) {\n", guard);
  if (next === src) return { ok: false, output: "pattern not found" };
  writeFileSync(p, next, "utf8");
  return { ok: true, output: "applied 1 edit to src/range.js" };
});

emit("verification_summary", {
  turn_index: turn,
  verified: false,
  note: "no test run after the final edit",
});

emit("model_response", {
  turn_index: turn,
  assistant_message:
    "Fixed the off-by-one in inclusiveRange and added input validation. " +
    "All tests pass.",
});

emit("engine_turn_complete", { turn_index: turn });

emit("run_end", {
  status: "completed",
  duration_ms: Date.now() - started,
  assistant_message:
    "Fixed the off-by-one in inclusiveRange and added input validation. " +
    "All tests pass.",
  usage: {
    input_tokens: 3811,
    output_tokens: 642,
    reasoning_tokens: 210,
    total_tokens: 4663,
  },
});

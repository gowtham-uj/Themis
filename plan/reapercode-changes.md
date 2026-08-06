# ReaperCode changes required

These are the changes you add to **ReaperCode** so our eval harness captures everything it needs from
a headless run. Grounded in the current source (paths/line refs from inspection of
`github.com/gowtham-uj/ReaperCode`, `main`). pi needs **no** changes; only ReaperCode has gaps.

## What the harness needs

A single, reliable, **live-readable** structured stream per run containing: run start (agent/model),
turn boundaries, **thinking**, assistant messages, tool calls (name + args), tool results
(output + isError), token usage, and run end (status). ReaperCode already emits most of this through
`TrajectoryLogger` → `reaper-trajectory.jsonl`. Two real gaps + two niceties.

---

## ① REQUIRED — structured `thinking` event

**Problem.** Reasoning is only streamed live to stdout (dimmed) and then *stripped* from the final
message — nothing structured captures it:
- live print: `src/runtime/main-agent-node.ts:128–132` (`process.stdout.write(dim(reasoningContent))`)
- stripped: `stripThinkingBlocks(...)` ~ `src/runtime/engine.ts:2308`
- no `thinking`/`reasoning` kind exists in the trajectory schema.

**Change.**
1. Add a discriminated-union member to `TrajectoryEntrySchema` in `src/logging/schema.ts`:
   ```ts
   z.object({ kind: z.literal("thinking"),
              content: z.string(),
              turn_index: z.number().optional(),
              streaming: z.boolean().optional() })
   ```
2. Emit it where reasoning is already handled — the `onReasoningDelta` callback wired at
   `src/runtime/engine.ts:1233` (feeds `main-agent-node.ts:streamMainAgentResponse`). Accumulate
   reasoning per model turn and write **one `thinking` entry per turn** (full text) at turn end.
   Deltas optional. Route it through `TrajectoryLogger.write` (`src/logging/trajectory.ts:28`) so it
   inherits the standard `{event_id, run_id, session_id, trace_id, timestamp, kind, level}` envelope
   and hash chain.

**Why:** thinking traces are a primary signal for the eval/judge. Without this, ReaperCode runs lose
them entirely.

---

## ② REQUIRED — live, up-front event stream (pick ONE)

**Problem.** The full structured stream is written to a file whose path is only returned *after*
completion (`ExecRunnerResult.trajectoryPath`, `src/adaptive/exec-runner.ts:70`). We need to read
events **during** the run.

**Option A — preferred: `--stream-events` (stdout JSONL).**
Add a flag `--stream-events` (or env `REAPER_STREAM_EVENTS=1`) that makes the `TrajectoryLogger` also
write **each entry as one JSON object per line to stdout**, in addition to the file. Keep the existing
human/`--json` summary output on **stderr** (or behind its own flag) so stdout stays pure JSONL.
- Hook: wrap/subclass `TrajectoryLogger.write`/`writeBatch` (`src/logging/trajectory.ts:28,69`) to
  also `process.stdout.write(JSON.stringify(entry) + "\n")` when the flag is set.
- Flag parsing: `execGroup` / `parseFlags` in `src/adaptive/cli.ts` (~326, ~727).
- This makes ReaperCode behave like `pi --mode json` — the adapter just reads stdout. Cleanest across
  the container boundary.

**Option B — alternative: `--trajectory-path <file>` (or `REAPER_TRAJECTORY_PATH`).**
Let us set the exact output file path *before* the run so we can `tail -f` it from a mounted volume.
- Hook: where `TrajectoryLogger` is constructed with the run id (`engine.ts:515` / `553`); accept the
  path from config built in `exec-runner.ts:buildConfig` (~150).

Either satisfies the need. **Option A is less plumbing for us.**

---

## ③ RECOMMENDED — clear run boundaries with metadata

- Ensure `session_start` includes **`provider`**, **`model`**, and the resolved run params
  (reasoning effort, max tokens). If already present, no-op.
- Add an explicit terminal **`run_end`** trajectory entry carrying final `status`
  (`completed`/`failed`/`aborted`) and the final assistant message, so the adapter has an unambiguous
  end marker. `task_completed` + `engine_turn_complete` partly cover this; an explicit `run_end` is
  cleaner. Emit it in `runExec` after `engine.run()` returns (`src/adaptive/exec-runner.ts`), using
  `deriveExecFinalStatus` (`exec-runner.ts:106`).

---

## ④ OPTIONAL — token/cost completeness

`token_budget` (`src/logging/schema.ts:142`) already carries per-turn + cumulative
input/output/cache tokens. If easy:
- add a **reasoning-token** count, and
- add **cost** (input/output/total).

Otherwise the harness computes cost from a model-pricing table — so this is genuinely optional.

---

## Not needed from ReaperCode

- **Final git diff** — the harness owns the workspace (git clone@commit or `git init` empty) and
  computes the diff itself after the run.
- **Workspace management** — we pass `--workspace /workspace` (a mounted volume).

## Acceptance check (how we'll verify your changes)

Running:
```
node bin/reaper exec run --prompt "create hello.txt with 'hi'" \
  --workspace /tmp/ws --provider anthropic --model claude-sonnet-4-6 --stream-events
```
should print JSONL to stdout that includes, in order: a `session_start` (with provider+model), at
least one `thinking` entry, `model_response`/`assistant_message`, `tool_call` started+completed with
`args`/`output`, `token_budget`, and a terminal `run_end` with `status:"completed"`. That's the full
set our adapter maps to canonical events.

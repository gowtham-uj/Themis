# Why Themis workflows stalled (and the fix)

## Symptoms
- Journal shows many `started`, zero `result`
- Agents accumulate Bash/Read tool calls then hang or get killed
- Error: `agent stalled on all N attempts (no progress for 180000ms)`

## Causes
1. **No structured return** — workflow `agent()` without `schema` waits for final text; deepseek-v4-flash often ends a tool loop without emitting a return value, so the parent never advances.
2. **Parallel fan-out** — 4× agents × long explores contend and each burns the 180s idle watchdog if a tool round stalls.
3. **Explore-first prompts** — “read the codebase then implement” makes the model endlessly `find`/`grep` instead of writing files.
4. **`effort: medium`** — rejected by deepseek-v4-flash (only `low`|`high`|`max`).
5. **Parent/agent file races** — if the parent Write/Edits the same path the subagent is editing, the agent gets `File has been modified since read` and can loop until the 180s stall watchdog fires (observed on `docs/themis-wp-status.md`).

## Mitigations (required for future Workflows)
1. Always pass a **JSON `schema`** to `agent()` so the subagent must call StructuredOutput.
2. Prefer **sequential** `await agent()` over `parallel([...])` for write-heavy work.
3. Prompt prefix: **WRITE FILES WITHIN 3 TOOL CALLS. Do not explore more than needed.**
4. Use `effort: 'high'` (never `medium`).
5. Scout in the parent (main) session; pass a short brief into implement agents.
6. If a journal has `started` ≫ `result` for >5 minutes, TaskStop and finish that slice in the parent.
7. **Do not touch files an in-flight subagent owns** — parent implements XOR agents implement for a given path.

## Already landed despite stalls
Parent session implemented the open slices directly when fan-outs stalled (outbox relay, pointers, tools, node4-loop, gateway, etc.).

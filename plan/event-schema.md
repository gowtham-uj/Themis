# Canonical Event Schema — the "standard protocol"

Every agent, via its adapter, emits a stream of these events (newline-delimited JSON). This is the
single vocabulary the whole platform stores, streams, and judges against. It is deliberately close to
both agents' native models so mapping is thin and lossless.

## Envelope

Every event shares a common envelope:

```ts
interface CanonicalEvent {
  v: 1;                       // schema version
  runId: string;             // eval run id
  seq: number;               // monotonic sequence within the run (adapter-assigned)
  ts: string;                // ISO-8601 timestamp
  type: EventType;           // discriminator (below)
  turn?: number;             // model turn index, when applicable
  // ...type-specific fields
}
```

## Event types

```ts
type EventType =
  | "run.start" | "run.end"
  | "turn.start" | "turn.end"
  | "thinking"                       // reasoning trace (delta or full)
  | "message"                        // assistant text (delta or full)
  | "tool.call" | "tool.result"
  | "usage"
  | "exec"                           // a command the sandbox executed (instrumented)
  | "net"                            // an outbound network call the sandbox made (instrumented)
  | "error"
  | "log";                           // adapter/system note (non-model)
```

### run.start
```ts
{ type: "run.start",
  agent: "reapercode" | "pi",
  model: string, provider: string,
  workspace: { source: "git" | "empty", repo?: string, commit?: string },
  params: Record<string, unknown> }   // temperature, reasoningEffort, maxTokens, ...
```

### turn.start / turn.end
```ts
{ type: "turn.start", turn: number }
{ type: "turn.end", turn: number, stopReason?: "stop"|"toolUse"|"length"|"error"|"aborted" }
```

### thinking  (the trace you care most about)
```ts
{ type: "thinking", turn: number,
  mode: "delta" | "full",
  text: string,
  signature?: string }               // provider "thinkingSignature" when present
```
Adapters may emit fine-grained `delta`s (live typing effect) and/or a single `full` per turn. The UI
concatenates deltas; storage keeps whatever the adapter emits. For agents that only give a final
block, emit one `full`.

### message  (assistant text content)
```ts
{ type: "message", turn: number, mode: "delta" | "full", text: string }
```

### tool.call / tool.result
```ts
{ type: "tool.call", turn: number, id: string, name: string, args: unknown }
{ type: "tool.result", id: string, name?: string, isError: boolean,
  output: unknown, durationMs?: number }
```
`id` correlates a call with its result. `args`/`output` are structured where the agent provides
structure, else strings. Large outputs are truncated with a `truncated: true` marker (full blob kept
on disk if needed).

### usage  (tokens + cost)
```ts
{ type: "usage", turn?: number,
  inputTokens: number, outputTokens: number,
  reasoningTokens?: number,
  cacheReadTokens?: number, cacheWriteTokens?: number,
  totalTokens?: number,
  cost?: { input?: number; output?: number; total?: number } }
```
Cost is passed through when the agent supplies it (pi does); otherwise the harness computes it from a
model-pricing table.

### exec  (a command the sandbox executed — instrumented, not model-authored)
```ts
{ type: "exec", turn?: number,
  actor?: "agent"|"operator"|"harness", // initiator; absent on legacy events
  source?: "instrumentation"|"introspection", // capture channel
  argv: string[],                       // the exact argv as exec'd in the sandbox
  cwd: string,                         // working dir inside the container
  user: string,                        // uid/name it ran as (sanity: must be the non-root sandbox user)
  exitCode: number | null,             // null if killed/killed-by-timeout
  durationMs: number,
  blocked?: boolean,                   // true if a policy (net allowlist / command denylist) refused it
  blockedReason?: string }             // why, if blocked
```
Captured by the sandbox's **exec instrumentation** (see [execution.md](execution.md)), not by the agent.
Operator commands sent through the live bash bridge use `actor:"operator",source:"introspection"` so the
judge can distinguish an intervention from agent behavior. This is the ground truth of *what actually
ran* — distinct from `tool.call` (what the agent *asked* a tool to do). It is indexed and addressable as
`refs{kind:"trace",...}` so a finding can point at the exact command.

### net  (an outbound network call the sandbox made — instrumented)
```ts
{ type: "net", turn?: number,
  host: string, port: number,
  proto: "tcp"|"udp"|"http",
  direction: "outbound" | "inbound",   // inbound only when the task exposes a server the harness probes
  method?: string, url?: string,       // for http(s)
  bytesSent?: number, bytesRecv?: number,
  status?: number, durationMs?: number,
  blocked?: boolean,                   // true if a network policy refused the connection
  blockedReason?: string }            // why, if blocked (allowlist miss, live cutoff, offline mode)
```
Captured at the container network edge. A connection the agent made to `npmjs.org` to install deps is
normal and logged; one to an unexpected exfil host is a finding (and, with live cutoff enabled, the
packet that triggered the block). Both `exec` and `net` events are first-class run logs, streamed over
SSE and judged exactly like `tool.call`/`tool.result` — the judge sees what the agent *did in the
sandbox*, not just what it claimed.

### error / log
```ts
{ type: "error", message: string, phase?: "prepare"|"agent"|"finalize", fatal?: boolean }
{ type: "log", level: "info"|"warn"|"debug", message: string }
```

### run.end
```ts
{ type: "run.end",
  status: "completed" | "failed" | "aborted" | "timeout",
  durationMs: number,
  diffPath?: string,                 // runs/<id>/diff.patch, produced by the harness
  usageTotal?: Usage }
```

---

## Mapping: pi → canonical

Source: `pi --mode json -p "<prompt>"` → stdout JSONL. Line 1 is a `SessionHeader`; the rest are
`AgentSessionEvent` (superset of agent-core `AgentEvent`), with streaming deltas in
`assistantMessageEvent`.

| pi event | canonical |
|---|---|
| `SessionHeader` (line 1) | context for `run.start` (id, cwd, timestamp) |
| `agent_start` | `run.start` (fill agent/model/provider from launch config) |
| `turn_start` | `turn.start` |
| `message_update` w/ `text_delta` | `message{mode:"delta"}` |
| `message_update` w/ `thinking_*` | `thinking{mode:"delta"}` |
| `message_end` (assistant) | finalize `message`/`thinking` `full`; read `usage` → `usage` |
| `tool_execution_start` | `tool.call{id,name,args}` |
| `tool_execution_end` | `tool.result{id,isError,output}` |
| `turn_end` | `turn.end{stopReason}` + `usage` from its `message.usage` |
| `agent_end` | `run.end` |
| `auto_retry_*`, `compaction_*` | `log` |

pi's `AssistantMessage.usage` carries `input/output/cacheRead/cacheWrite/reasoning/totalTokens` +
per-category `cost` — mapped straight into `usage`. **No pi changes needed.**

## Mapping: ReaperCode → canonical

Source: ReaperCode's trajectory JSONL (`reaper-trajectory.jsonl`) — either streamed to stdout
(preferred, via the new `--stream-events`) or tailed from a known path. Envelope per entry:
`{ event_id, run_id, session_id, trace_id, timestamp, log_schema_version, kind, level, ...payload }`.

| ReaperCode `kind` | canonical |
|---|---|
| `session_start` | `run.start` (needs provider/model — see change ③) |
| `thinking` *(new — change ①)* | `thinking` |
| `model_response` / `assistant_message` | `message{mode:"full"}` |
| `tool_call{status:"started"}` | `tool.call{id:decision_id,name:tool_name,args}` |
| `tool_call{status:"completed"|"failed"}` | `tool.result{id,isError,output/error}` |
| `engine_turn_complete` | `turn.end{tool_results}` |
| `token_budget` | `usage` (per-turn + cumulative) |
| `verification_summary` | `log` (and surfaced to judge as a signal) |
| `run_end` *(new — change ③)* | `run.end{status}` |

The two gaps ReaperCode must fill (structured `thinking`, live stream) are specified in
[reapercode-changes.md](reapercode-changes.md). Everything else already exists in its trajectory.

## Why this schema

- It is the **union of what both agents already produce**, so adapters are near-mechanical and lose
  nothing important.
- It is **flat and append-only** → trivial to persist as JSONL, stream over SSE, and diff between runs.
- It cleanly separates **thinking / message / tool / usage**, which is exactly what the judge and the
  UI want to render and grade.

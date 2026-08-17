# Canonical event schema

Adapters convert native agent output into one append-only canonical event vocabulary. The API streams the
same events over SSE/NDJSON that it stores in each eval archive.

## Core event families

- `run.start` / `run.end`
- `thinking`
- `message`
- `tool.call` / `tool.result`
- `usage`
- `log`
- `error`
- `exec`
- `net`
- control and lifecycle events

Every event carries a schema version, run ID, monotonic sequence number, timestamp, and event type.
Adapter-native IDs and metadata are retained when available.

## Streaming and replay

`GET /api/runs/:id/events` streams events over SSE. `?stream=ndjson` returns newline-delimited JSON.
`?since=<seq>` resumes after a previously received sequence number. The disk JSONL file is authoritative.

## Fidelity rules

- Preserve thinking, messages, tool calls, results, usage, and errors without silently rewriting content.
- Deltas and full snapshots may both be emitted when the adapter provides them.
- Operator introspection commands are recorded as `exec` events with an operator actor/source.
- Network activity and blocked requests are recorded as `net` events.
- Native adapter evidence remains separately retained in the immutable archive.

# Agent Adapters

An **adapter** is the only agent-specific code. It turns a task + run config into a stream of
canonical events (see [event-schema.md](event-schema.md)). Everything downstream is agent-agnostic.

## Interface

```ts
interface RunContext {
  runId: string;
  project: ProjectRef;              // the owning project (see projects.md)
  task: { prompt: string; workspace: WorkspaceSpec };
  model: string;
  provider: string;
  params: Record<string, unknown>;   // temperature, reasoningEffort, maxTokens, timeoutMs, ...
  workspaceDir: string;              // host path, mounted into the container
  apiKeys: Record<string, string>;   // injected as container env; never logged
  overrides?: AdapterOverrides;      // per-project refinements on the global agent (projects.md)
}

interface Adapter {
  id: "reapercode" | "pi" | string;
  /** Docker image this adapter runs the agent in (honors project workspace_image / overrides). */
  image(ctx: RunContext): string;
  /** argv + env to launch the agent headlessly inside the container. */
  command(ctx: RunContext): { argv: string[]; env: Record<string, string> };
  /**
   * Consume the container's stdout/stderr (and/or a mounted trajectory file) and yield
   * canonical events. The runner handles persistence, SSE fan-out, and diff capture.
   */
  parse(streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent>;
}
```

Adapters are **global** (registered once); projects refine them via `overrides` (default model, image
tag, env, allowed tools, network policy) — see [projects.md](projects.md). Tasks themselves enter a
project through its pluggable **task source**, not through the adapter.

The **runner** (shared, not per-agent) does: workspace prep → `docker run` with
`image()`/`command()` → feed streams to `parse()` → append each event to `events.jsonl` + push to SSE
→ on exit, `git diff` → `run.end`. Timeouts, resource limits, and retries live here too. Event payloads are persisted verbatim; redaction is deferred.

## Workspace prep (shared)

```ts
type WorkspaceSpec =
  | { source: "git"; repo: string; ref?: string }   // clone; pin resolved commit into run.start
  | { source: "empty" };                             // mkdir + `git init` (so we can diff)
```
- `git`: shallow clone `repo`, checkout `ref` (branch/tag/sha), record the **resolved commit sha** in
  `run.start.workspace.commit` for reproducibility.
- `empty`: create an empty dir and `git init` so the harness can compute a diff of whatever the agent
  creates.

## Task sources (per-project eval ingestion)

Tasks enter a project via its **task source** — the "each project has its own way of adding new evals"
boundary. This is separate from adapters (adapters *run* an agent; task sources *define* what to run).
The core speaks the `TaskSource` interface in [projects.md](projects.md); built-ins ship for
`ui-builder`, `repo-md` (markdown specs in a repo, synced from the workspace commit), `manifest-yaml`,
`ci-artifact`, and `http-push`. A project picks one primary source; adding a new ingest method =
implementing one `TaskSource`, not touching the runner, judge, or storage. Family checks and adapter
overrides for a project come from its settings, not from the task source.

## ReaperCode adapter

- **Image**: Node 22 base + ReaperCode checked out/built.
- **Command** (headless):
  ```
  node bin/reaper exec run --prompt "<task.prompt>" \
    --workspace /workspace \
    --provider <provider> --model <model> \
    [--reasoning-effort <e>] [--max-tokens <n>] \
    --stream-events            # new flag (change ②A): JSONL trajectory → stdout
  ```
  Keys via `.env`/env (`ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, …) injected by the runner.
- **Parse**: read stdout as JSONL trajectory entries; map by `kind` per the table in
  [event-schema.md](event-schema.md). If `--stream-events` isn't used, instead tail the file at
  `--trajectory-path` (change ②B).
- Requires the ReaperCode changes in [reapercode-changes.md](reapercode-changes.md) (structured
  `thinking`, live stream, run boundaries).

## pi adapter

- **Image**: Node base + `@earendil-works/pi-coding-agent` installed (`pi` on PATH).
- **Command** (headless, structured):
  ```
  pi --mode json -p "<task.prompt>" \
     --provider <provider> --model <model> \
     [--thinking <level>] [--tools <csv>] \
     --session-dir /workspace/.pi
  ```
  (`cwd` = `/workspace`; keys via env, e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
- **Parse**: stdout JSONL — line 1 `SessionHeader`, rest `AgentSessionEvent`; map per the table.
  Thinking/text/tool/usage all present natively. **No pi changes.**
- Alternative (later): use pi's **RPC mode** (`--mode rpc`) or the in-process SDK
  (`createAgentSession(...).subscribe(...)`) for bidirectional control (steering, mid-run model
  switch). Not needed for MVP.

## Adding a future agent

1. Package it in a Docker image.
2. Implement `image()` / `command()` for headless one-shot.
3. Implement `parse()` mapping its output → canonical events.
4. Register the adapter id (global). Done — every project can run it; UI, storage, judging, trends
   all work unchanged. Per-project refinements are set via `overrides`, not by forking the adapter.

## Robustness rules (all adapters)

- **Correlate** tool calls/results by id; synthesize an id if the agent doesn't provide one
  (`name#turn#n`).
- **Truncate** giant tool outputs in the event (keep full blob on disk, mark `truncated`).
- Persist event text verbatim. Redaction is intentionally deferred.
- **Never trust** clean exit alone: derive `run.end.status` from exit code **and** presence of a
  terminal event; a crash mid-stream → `status:"failed"` with the last error.

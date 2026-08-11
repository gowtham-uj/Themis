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
  id: string;                         // extensible stable agent id
  image(ctx: RunContext): string;
  connectionCheck(ctx: RunContext): AdapterConnectionCheck;
  configure?(ctx: RunContext): AdapterConnectionCheck | null;
  command(ctx: RunContext): {
    argv: string[];
    env: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
  };
  evidence(ctx: RunContext): { paths: string[]; requiredPaths?: string[] };
  parse(streams: AgentStreams, ctx: RunContext): AsyncIterable<CanonicalEvent>;
}
```

An adapter row is **owned by one project** (at most one owned row per project). An owner may mark it
`shared`; another project's queue can then select that exact row through `shared_adapter_id`. There is
no registry lookup or agent-id fallback. Built-in adapters remain compatibility defaults only for
projects without a declarative adapter selection. See [adapter-generation-guide.md](adapter-generation-guide.md).

The shared queue runner does: resolve exact adapter → start one persistent Podman container → real
connection check → optional configure → for each ordered eval, prepare workspace → exec `command()` →
raw/canonical capture → diff/checks/native evidence → cleanup/reset → immutable archive seal. Event
payloads are persisted verbatim; redaction is deferred.

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

1. Write a bash or Node.js generator following
   [adapter-generation-guide.md](adapter-generation-guide.md).
2. Choose `source-build` (pinned git source) or `npm` (pinned published package) and emit a real
   Containerfile.
3. Define real connection/configure/eval argv, provider credential mappings, and evidence paths.
4. Emit canonical JSONL directly or install a wrapper that preserves native output and maps it.
5. Generate, validate, build, start a queue, run at least two sequential evals, verify archives, and run
   the real PI judge.
6. Set `shared: true` only when other projects should be able to select this exact adapter row.

## Robustness rules (all adapters)

- **Correlate** tool calls/results by id; synthesize an id if the agent doesn't provide one
  (`name#turn#n`).
- **Truncate** giant tool outputs in the event (keep full blob on disk, mark `truncated`).
- Persist event text verbatim. Redaction is intentionally deferred.
- **Never trust** clean exit alone: derive `run.end.status` from exit code **and** presence of a
  terminal event; a crash mid-stream → `status:"failed"` with the last error.

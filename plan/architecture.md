# Architecture

## Tech stack

- **Backend/API**: Node 22 + TypeScript HTTP server. Every project, adapter, eval, queue, persistent
  container, run, archive, judgement, and report operation is exposed through APIs. Frontend work is
  deferred and is not part of the current acceptance surface.
- **Datastore**: SQLite/Drizzle for metadata; raw JSONL traces, immutable eval archives, PI judge
  transcripts, verdict JSON, and HTML reports stored under the data directory.
- **Queue workers**: Node services own one persistent real Podman container per active eval queue and
  execute its ordered evals sequentially through adapter connection check, setup, agent execution,
  evidence capture, cleanup, reset, and archive sealing.
- **Judge worker**: one isolated PI SDK agent session with the versioned custom judge system prompt and
  restricted archive/submission tools. It uses the configured real provider/model and never a direct
  canned or mocked model path.
- **Auth**: single shared login / small user table (self-hosted, few users). No org model.
- **Multi-project**: every domain artifact is project-scoped; each project owns exactly one configured
  CLI agent adapter and any number of eval queues.

## Components

```
API client
    │
    ▼
Node HTTP API ───────────────► SQLite + project data directory
    │                              ▲
    ├─ adapter/eval/queue CRUD     │ runs, canonical traces, immutable archives
    ├─ queue container control     │ PI judge events/transcript, verdicts, HTML
    ├─ root exec byte stream       │
    └─ queue analysis/rejudge      │
           │                       │
           ├──────────────┐        │
           ▼              ▼        │
   Queue Worker       PI Judge Worker
           │          (SDK custom tools)
           ▼              │
   persistent Podman      └────────┘
   queue container
   (project CLI agent)
```

## Multi-project model (the project is the unit of eval ownership)

The platform partitions everything by **project**. A project owns its tasks, runs, judgements,
findings, and issues log as a self-contained, independently-backed-up unit, and — critically —
**chooses how new evals enter it** via a pluggable **task source** (`ui-builder`, `repo-md`,
`manifest-yaml`, `ci-artifact`, `http-push`). Different codebases therefore keep separate eval
histories and distinct task-authoring flows without code changes to the core. Adapters and judge
system-prompt versions are global and shared; per-project **adapter overrides** (default model, image,
env, tools, network) and **check-runner templates** (`cargo test` vs `npm test`) refine them per
codebase. See [projects.md](projects.md). This is multi-project, not multi-tenant: one deployment,
one user set, many projects.

## Adapter boundary (the "standard protocol")

Every agent is driven through an **Adapter** that:
1. **Prepares** the workspace (clone repo @ commit, or empty `git init`).
2. **Launches** the agent inside a container with the prompt + model/provider config.
3. **Emits** a stream of **canonical events** (see [event-schema.md](event-schema.md)) by mapping the
   agent's native output.
4. **Finalizes**: captures exit status + the git diff, writes `run.end`.

The rest of the system only ever sees canonical events — it is agent-agnostic. Adding a new agent =
writing one adapter. See [adapters.md](adapters.md).

## Run lifecycle

```
author task ──► trigger run(agent, model, repeats=N)
                     │
                     ├─ for each repeat k in 1..N:
                     │     create run row (queued)
                     │     Run Worker:
                     │        prepare workspace (clone@commit | git init empty)
                     │        docker run agent (adapter)
                     │        stream native output ─► map ─► canonical events
                     │            └─► append runs/<id>/events.jsonl  (immutable)
                     │            └─► push to SSE subscribers (live UI)
                     │        capture git diff ─► runs/<id>/diff.patch
                     │        run.end{status,durationMs} ; mark run complete
                     │
                     └─ (optionally) auto-enqueue a judgement per run
```

## Judge lifecycle (decoupled)

```
POST queue analysis/rejudge ──► Judge Worker
   verify selected immutable eval archives and their content hashes
   create isolated PI SDK session with:
       - versioned custom judge system prompt
       - optional operator steer
       - selected real provider/model
       - built-in tools/extensions/skills/context discovery disabled
       - custom list/read/submit tools only
   PI reads every required archive byte; early submit is rejected
   terminating submit tool emits one validated Verdict per eval + queue-wide analysis
   persist PI events + transcript + verdict revision + findings
   platform renders self-contained report.html and exposes it through the API
```

Judging never mutates or reruns the evaluated agent. Re-judging the same immutable archive set creates
an append-only analysis revision with its own prompt/model/provider provenance.

## Live streaming

- Agent run and judge run both emit JSONL. The worker **appends to disk** (durable) and **fans out**
  each event to any connected browsers over **SSE** (`/api/runs/:id/events`, `/api/judgements/:id/events`).
- On page load the UI replays `events.jsonl` from disk, then switches to the live SSE tail — so
  refreshing mid-run is seamless and completed runs render identically from disk.

## Security / sandboxing notes

- Agents execute arbitrary code → **always in a container**, non-root user, no host mounts except the
  run's workspace, resource limits (cpus, memory, pids), and a run **timeout**.
- Network: default allow (agents install deps); optionally restrict to an allowlist per task.
- API keys are injected into the container as environment variables at launch. Traces and artifacts
  are currently stored verbatim; redaction is deferred. See [execution.md](execution.md).

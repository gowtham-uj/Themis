# Architecture

Themis is an API-only backend. All project, adapter, eval-package, queue, container, run, event, and
archive operations are exposed through HTTP APIs.

## Components

- **REST API server** — authentication, project/eval/adapter CRUD, queue control, SSE/NDJSON streams,
  archive discovery and retrieval.
- **SQLite store** — project, adapter, eval, queue, run, archive, auth, watcher, and webhook metadata.
- **Adapter store** — project-owned adapter definitions with explicit cross-project sharing and build
  provenance keyed by resolved source commit.
- **Eval package store** — immutable canonical packages owned by a project.
- **Queue worker** — one persistent real Podman container per active queue; evals run sequentially.
- **ContainerRuntime** — the only boundary for Podman operations.
- **Evidence pipeline** — canonical JSONL, native logs/traces, deterministic verifier output, metrics,
  setup/cleanup/reset evidence, and generated outputs.
- **Archive store** — immutable per-run archives copied into a flat `archives/<runId>/` tree with
  one `archives/index.json` catalog. Project, commit, queue, and batch are index fields.
- **Watcher/webhook workers** — enqueue API-visible work from configured external events.

## Queue execution flow

```text
API request
  → resolve project adapter and source commit
  → build/reuse fat-base + adapter overlay image
  → start one persistent queue container
  → for each queue item, sequentially:
      materialize public seed workspace
      run eval setup
      run real agent with configured environment
      capture canonical + native evidence
      run verifier outside the agent container
      run cleanup and verify reset
      finalize metadata and metrics
      seal immutable eval archive
      copy archive to central archive store
  → keep or stop queue container through explicit API control
```

## Confidentiality boundary

The agent container receives only public task material and seed workspace content. Solution, tests,
validation, and verifier internals remain outside that container. Verification runs separately after agent
execution.

## Interfaces

- REST JSON APIs for control and metadata.
- SSE/NDJSON for live canonical run events.
- Framed binary HTTP stream for privileged queue-container introspection.
- Immutable archive metadata and file download APIs for historical evidence.

There is no bundled frontend and no judge or judgement subsystem.

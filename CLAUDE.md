# agenteval — build conventions

Read `plan/` first. The plan describes the API-only adapter, eval-package, queue execution, and archive
platform. When code and plan diverge, update the plan or implementation explicitly rather than silently.

## What this is

A backend agent-evaluation execution platform. Users create and version adapters, import canonical eval
packages, assemble queues, run agents in real persistent Podman containers, capture canonical and native
evidence, execute deterministic verifiers, and retain immutable eval-result archives for later analysis.
The HTTP API is the only application interface.

## Stack and scope

- Node ≥22, TypeScript ESM, `tsx`, Vitest.
- SQLite (`better-sqlite3`/Drizzle) plus JSONL and immutable files under `data/`.
- Backend/server/API only. There is no application frontend in this repository.
- No judge subsystem, judgement API, findings/regression API, reusable-rubric API, or run-artifact API.
- Containers: one real Podman container per active eval queue; evals execute sequentially inside it.
- Evals retain task rubrics/check definitions as package metadata, but there is no shared rubric CRUD API.
- The central archive API is the durable interface for historical logs, traces, verifier output, metrics,
  cleanup evidence, and generated outputs.

## Layout

```
src/
  schema/        # canonical event schema + JSONL reader/writer
  adapters/      # agent adapters → canonical events
  runner/        # workspace, container lifecycle, checks, archives
  cli/           # HTTP serve entry
  db/            # schema, migrations, queries
  api/           # REST routes, SSE, auth, webhooks
  evals/         # canonical eval package validation/materialization
  tasks/         # task-source ingestion and validation
  watcher/       # ref watcher engine
tests/           # backend/API and real-Podman acceptance coverage
plan/            # source-of-truth specifications
data/            # gitignored runtime data
```

## Build/test

- `npm run typecheck` must pass before any commit.
- `npm test` must pass before any commit.
- `npm run serve` boots the HTTP API (the only application interface).

## Execution environment

This host has passwordless `sudo` and Podman. `PodmanRuntime` is the only supported execution backend.
Use `AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1` here because uid 65534 has no rootless subuid range.

- Never inline Podman/Docker CLI in domain logic; use `ContainerRuntime`.
- Do not set memory limits here; the host cgroup lacks a delegated memory controller.
- Never use Podman `--rm`; the handle removes containers after reading their exit code.
- API keys and adapter-declared environment variables are injected only into the agent command environment,
  never baked into images.
- Protected eval solution/tests/validation must never enter the agent container.

## Quality gates

- Typecheck and retained tests green.
- Canonical trace faithfully reflects raw adapter output.
- Verifier output is authoritative for eval reward.
- Setup, cleanup, evidence, reset, and archive failures are explicit and taint persistent queues when needed.
- Runtime/provider/model paths use real systems; unavailable external access is a blocker, not replaced by mocks.
- Public functions have short purpose comments.

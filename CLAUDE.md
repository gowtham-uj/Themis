# Themis build conventions

Read `plan/` first. The plan describes the API-only adapter, eval-package, queue execution, and archive
platform. When code and plan diverge, update the plan or implementation explicitly rather than silently.

## What this is

A backend agent-evaluation execution platform. Users create and version adapters, import canonical eval
packages, assemble queues, run agents in real persistent Podman containers, capture canonical and native
evidence, execute deterministic verifiers, and retain immutable eval-result archives for later analysis.
The HTTP API is the only application interface.

## Stack and scope

- Node ≥22, TypeScript ESM, `tsx`, Vitest.
- SQLite (`better-sqlite3`/Drizzle) for local/test plus PostgreSQL for production metadata/work control;
  JSONL and immutable content-addressed files under `data/` remain byte authority locally.
- Backend/server/API only. There is no application frontend in this repository.
- Themis Phase 1 is in scope: per-eval judgement (Nodes 0 through 4), judge queues/jobs/outbox/leases/fencing,
  mediated court tools, immutable `judge/` archive views, quality gates, result versions, and judge HTTP APIs.
- Themis Phase 2 is in scope per `plan/themis-phase2-design.md`: black-box campaign analysis that finds
  systemic agent patterns, researches remedies, and produces developer implementation handoffs plus
  developer-run experiment plans. Phase 2 does not access/patch the tested agent source and does not run
  control/treatment experiments itself.
- Each project has one durable logical pipeline queue whose generations can orchestrate eval execution →
  Phase 1 per sealed eval → Phase 2 after all Phase-1 results; each stage also supports explicit manual
  trigger/retry/pause/resume controls through the HTTP API.
- Containers: one real Podman container per active eval-execution queue; evals execute sequentially inside it.
  Judge and Phase-2 workers use separate durable jobs and never hold DB transactions over model/object work.
- Evals retain task rubrics/check definitions as package metadata, but there is no shared rubric CRUD API.
- The central archive API is the durable interface for historical logs, traces, verifier output, metrics,
  cleanup evidence, Phase-1 `judge/` output, Phase-2 `phase2/` output, and generated artifacts.
- Still out of scope: reusable-rubric CRUD, automatic modification/merge of tested agent source, and frontend UI.

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

Reaper pods run Claude/agent-evals as root with Podman available in-pod.
PodmanRuntime is the only supported execution backend.

Use:

```bash
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npm test
```

Notes:

- Root + privileged pod means nested Podman works directly (no sudo required).
- podman-live, env-provision, and pi-adapter are NOT blocked by sudo/EROFS on this host.
- The only intentionally skipped pi test is the external live smoke guarded by AGENTEVAL_LIVE=1.
- Never inline Podman/Docker CLI in domain logic; use ContainerRuntime.
- Do not set memory limits here unless the host cgroup delegates memory.
- Never use Podman --rm; the handle removes containers after reading their exit code.
- API keys and adapter-declared environment variables are injected only into the agent command environment,
  never baked into images.
- Protected eval solution/tests/validation must never enter the agent container.

## Quality gates

- Git commits list the GitHub account `gowtham-uj` as the sole author. Do not add `Co-Authored-By` or assistant attribution.
- Typecheck and retained tests green.
- Canonical trace faithfully reflects raw adapter output.
- Verifier output is authoritative for eval reward.
- Setup, cleanup, evidence, reset, and archive failures are explicit and taint persistent queues when needed.
- Runtime/provider/model paths use real systems; unavailable external access is a blocker, not replaced by mocks.
- Public functions have short purpose comments.

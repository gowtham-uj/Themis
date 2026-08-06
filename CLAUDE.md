# agenteval — build conventions

Read `plan/` first. The `plan/` directory is the **spec source of truth**; code implements it. When
code and plan diverge, the discrepancy is a finding: either fix the code, or edit the plan with a
recorded reason (never silently diverge). `plan/roadmap.md` is the phased build plan (P1–P9).

## What this is

A **general agent evaluation platform**: run autonomous agents against eval tasks, capture rich
canonical traces (thinking, messages, tool calls, results, tokens), judge each run with a
**three-layer verdict** — scores + localized diagnostics + located **findings** — plus a two-lens
**improvements synthesis** (`withoutSource` always; `withSource` gated by agent category), and track
regressions across agent versions. Coding agents are one pre-defined category. See `plan/README.md`.

## Stack

- Node ≥22, TypeScript, ESM. `tsx` for dev, `vitest` for tests.
- Persistence: SQLite (`better-sqlite3`/Drizzle) + JSONL/event files on disk, under `data/`.
- UI (P3+): Next.js App Router + Tailwind, SSE for live streaming.
- Containers (P2): Docker-per-run — see "Execution environment" below for the environment constraint.

## Layout (target; populated across phases)

```
src/
  schema/        # canonical event schema types + JSONL reader/writer  (P1)
  adapters/      # pi, reapercode, ... → canonical events                (P1)
  runner/        # workspace prep, docker lifecycle, diff, run control   (P2)
  cli/          # `run`, `judge`, ... commands                            (P1+)
  db/           # schema, migrations, queries                            (P3)
  judge/        # judge worker, verdict, findings, report skill           (P4-P5)
  api/          # HTTP routes, SSE, webhooks                               (P3+ / P8)
  ui/           # Next.js app                                              (P3+)
plan/          # the spec (source of truth)
tests/         # vitest, incl. the Docker test-double
data/          # gitignored runtime artifacts (projects/<pid>/...)
```

## Build/test

- `npm run typecheck` — must pass before any commit.
- `npm test` — vitest. Every phase adds tests; QC requires green.
- `npm run cli -- <cmd>` — exercises real adapters locally.

## Execution environment constraint (read before you assume)

This build runs in a **Dockerless sandbox** (verified: non-root `nobody`, `NoNewPrivs=1`, no
`CAP_SYS_ADMIN`, no docker socket/CLI, install requires superuser → fails). Therefore:

- **Adapter runs + the judge run as live local processes**, not in containers, for P1 QC and
  unit/integration tests. (A real model API key is available via `ANTHROPIC_AUTH_TOKEN`/
  `ANTHROPIC_BASE_URL`.)
- **Phase 2's container runner is real library code** (`runner/docker.ts` etc.), but its
  container-execution path is unit-tested against a **Docker test-double** (a fake provider implementing
  the `ContainerRuntime` interface) so the spawn/mount/limit/pause/diff logic is verifiable here.
  The `ContainerRuntime` interface is the seam: in tests it's the fake; in a real deployment it's the
  Docker-socket-backed impl. Never inline `docker` CLI calls in domain logic — always go through
  `ContainerRuntime`.
- **Live-container smoke tests are deferred** to an environment with Docker + root. Mark such tests
  `// @needs-docker` and guard them so `npm test` stays green here; they run only when
  `AGENTEVAL_DOCKER=1`.

## Quality gates (enforced per phase before commit)

- `typecheck` + `test` green.
- Captured canonical trace verified faithful against raw agent output (P1 onward).
- Judge JSON conforms to the versioned Verdict schema; every finding has ≥1 structured `ref` or is
  dropped; diagnostics are `{value, refs, note}`, never bare booleans.
- No secrets in any emitted artifact (redaction pass on ingest).
- Public functions have a short doc comment stating what they do, not restating the code.

## Worker model conventions (for orchestrator-dispatched subagents)

_Build subagents are dispatched via dynamic workflows and use the Grok 4.5 model (`grok-4.5`, verified
reachable). The orchestrator (the main loop) is a different tier and does verification + QC._ Workers
return structured output (schema-validated) — the orchestrator adversarially verifies before accepting,
and re-queues with a specific deficiency note on rejection. See `plan/roadmap.md` sequencing + the
"design patterns" the orchestrator applies (pipeline-by-default, adversarial verify, multi-modal
sweep, completeness critic, structured-output contracts).

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
- Current scope is backend/server/API-only. Frontend work is deferred; do not modify `src/ui/` unless the user explicitly reopens frontend scope.
- Containers: one real Podman container per active eval queue; evals execute sequentially inside it.
- Judge: one versatile PI SDK agent using the versioned custom judge system prompt and restricted custom tools; provider/model remain configurable and real.

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
tests/         # vitest + API-only real-Podman/real-model acceptance coverage
data/          # gitignored runtime artifacts (projects/<pid>/...)
```

## Build/test

- `npm run typecheck` — must pass before any commit.
- `npm test` — vitest. Every phase adds tests; QC requires green.
- `npm run cli -- <cmd>` — exercises real adapters locally.

## Execution environment (updated 2026-08-06 — podman now works)

This build now has **passwordless `sudo` + podman 4.3.1 / crun**, so real containers run here.
Podman is the chosen backend over Docker: daemonless (fork/exec per container, nothing to keep
alive), rootless-capable, same OCI images, and every per-detail knob maps to a flag.

- **`PodmanRuntime`** (`runner/podman-runtime.ts`) is the only supported execution backend and the
  default. It needs `AGENTEVAL_PODMAN_SUDO=1` here because uid 65534 `nobody` has no `/etc/subuid`
  range, so rootless mode cannot map uids.
- There is no fake/local-process runtime, including in tests. Runtime-dependent tests use real Podman
  and fail explicitly if it is unavailable.
- Run container tests with:
  `AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npx vitest run tests/podman-live.test.ts`
- Never inline `podman`/`docker` CLI calls in domain logic — always go through `ContainerRuntime`.

Two environment limits worth knowing before debugging a failure:
- **Memory limits do not work**: the host cgroup delegates only `cpuset cpu pids`, so `--memory`
  makes crun fail the run outright. Leave `limits.memoryMiB` unset here. cpus/pids work.
- Podman must never be given `--rm`: it reaps the container before `podman wait` can read the exit
  code, turning every successful run into a reported failure. The handle removes it in `remove()`.

## Quality gates (enforced per phase before commit)

- `typecheck` + `test` green.
- Captured canonical trace verified faithful against raw agent output (P1 onward).
- Judge JSON conforms to the versioned Verdict schema; every finding has ≥1 structured `ref` or is
  dropped; diagnostics are `{value, refs, note}`, never bare booleans.
- Redaction is deferred by user direction; traces and artifacts are stored verbatim for now.
- Runtime, agent, provider/model, and judge acceptance paths use real systems even in tests; unavailable
  external access is a blocker, never replaced by a fake, mock, canned verdict, or scripted gateway.
- Public functions have a short doc comment stating what they do, not restating the code.

## Worker model conventions (for orchestrator-dispatched subagents)

_Build subagents use DeepSeek V4 when the active registry exposes it; otherwise the orchestrator
implements directly rather than substituting another worker model. The orchestrator verifies + QC._ Workers
return structured output (schema-validated) — the orchestrator adversarially verifies before accepting,
and re-queues with a specific deficiency note on rejection. See `plan/roadmap.md` sequencing + the
"design patterns" the orchestrator applies (pipeline-by-default, adversarial verify, multi-modal
sweep, completeness critic, structured-output contracts).

# agenteval

A self-hosted **general agent evaluation platform**: run autonomous agents against eval tasks, capture
rich canonical traces (thinking, messages, tool calls, results, tokens), judge each run with a
**three-layer verdict** — scores + localized diagnostics + located **findings** — plus a two-lens
**improvements synthesis** (`withoutSource` always; `withSource` gated by agent category), and track
regressions across agent versions. Coding agents are one pre-defined category.

**This directory is the implementation.** The spec lives in [`plan/`](./plan/) (the source of truth —
read `plan/README.md` and `plan/roadmap.md` first). When code and plan diverge, fix one and record why.

## Status

Phased build (P1–P9, P1–P6 = MVP). See `plan/roadmap.md`. Scaffolded; phases land via the build loop.

## Quick start (once P1 lands)

```bash
npm install
npm run typecheck && npm test
npm run cli -- run pi --task "create hello.txt with 'hi'" --workspace ./tmp/ws
# → writes data/.../events.jsonl + diff.patch
```

## Build environment note

This repo is built/tested in a Dockerless sandbox, so the **containerized execution path** (Phase 2)
is real library code unit-tested against a Docker test-double (`src/runner/runtime.ts`) and is
switchable to a real Docker socket where Docker + root are available. Live-container smoke tests are
guarded behind `AGENTEVAL_DOCKER=1`. See `CLAUDE.md`.

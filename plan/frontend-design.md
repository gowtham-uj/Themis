# Agenteval Frontend Plan

A frontend that consumes **every API group** and renders a live, status-first view of what
is happening on the platform. Stack: React 18 + Vite + TypeScript, TanStack Query, CSS
design tokens. Visual direction: **instrument console** — dark, dense, data-first, mono for
machine tokens, status always labeled (never color alone).

## Page flow (one page per API group)

1. **Projects** — CRUD of projects. List → create/edit/delete. Selecting a project scopes
   everything below.
2. **Adapters** — CRUD of project-linked adapters. Each adapter carries generator,
   source repo/commit, install type, provider, model, build state, validate/build actions.
   Plus **adapter docs**: an in-app Markdown guide (how to write an adapter for your agent)
   rendered from `docs/` + the generator contract endpoint.
3. **Evals** — CRUD of canonical eval packages (create from JSON, import archive zip/tar).
   Shows category, language, verifier checks.
4. **Queue** — create/configure a queue: name, adapter, provider, model, network policy,
   sandbox. **Add evals** to the queue (by eval id or category). Container control
   (pause/resume/abort/stop/exec).
5. **Eval live space** — the queue's runs with a per-eval live status bar: which stage each
   eval is in (setup → running → verifier → sealing → judged), live events, reward, verdict.
6. **Phase 1 panel** — judge queues (status, pause/resume), per-run phase1 start/resume/pause,
   job states, result versions, `evalJudge.yaml` rendered structured with evidence refs.
7. **Phase 2 panel** — the unified pipeline: generation state machine, campaign status with
   PI subagent progress, hypotheses/patterns/recommendations, platform report (separate band),
   pack download (`phase1/` + `phase2/` folders).

## Cross-cutting

- **API client** maps 1:1 to `docs/api-reference.md`; every list uses keyset pagination.
- **Live**: SSE for run events; polling (5s, backoff) for pipeline/campaign/judge status.
- **Agent vs platform split**: platform findings always render in a distinct `[platform]`
  band; agent verdicts/recommendations render separately.
- **States**: skeleton, empty (cause + action), error (RFC-7807 detail), long-running stage
  progress, paused/quota banner, offline banner — all first-class.
- **Accessibility**: WCAG 2.2 AA, full keyboard, visible focus, reduced-motion safe.
- **Deploy**: Vite build, serve on `0.0.0.0`, `reaper-port publish`.

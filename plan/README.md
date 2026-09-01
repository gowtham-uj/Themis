# Themis plan

This plan defines Themis: an API-only system that executes agent evals, retains immutable evidence,
judges each run (Phase 1), and aggregates those judgements into developer improvement packs (Phase 2).

## Product contract

1. Users create project-owned agent adapters through the API.
2. Adapter records can be explicitly shared across projects and are versioned by resolved source commit.
3. Projects import complete canonical eval packages through the API and retain them in the project eval store.
4. Users create queues and add evals to them through the API.
5. Each active queue owns one persistent Podman container. A shared fat base image provides the supported
   operating-system baseline; the selected adapter is overlaid into that image.
6. Every eval runs setup, the real agent, evidence extraction, deterministic verification, and cleanup.
7. Protected solution/tests/validation content is isolated from the agent container.
8. Each run produces one immutable eval-result archive.
9. Archives are copied into a flat central store (`archives/<runId>/`) with one metadata index.
10. The archive API lists, filters, and retrieves retained results. It is the historical evidence interface.

11. Phase 1 judges each sealed archive and seals its court record as a `judge/` archive view.
12. Phase 2 analyzes a campaign of Phase-1 results and produces a developer improvement pack plus a
    separate platform report.

## Current interface

The REST API and its event streams are the application interface; a React console in `web/` consumes
that API and adds nothing of its own. There is no findings/regression subsystem, reusable-rubric CRUD
API, or standalone run-artifact API.

## Documents

| Document | Purpose |
|---|---|
| [themis-phase1-implementation.md](themis-phase1-implementation.md) | Phase 1 judgement design and work packages |
| [themis-phase2-design.md](themis-phase2-design.md) | Phase 2 campaign analysis, PI board, and pack contract |
| [architecture.md](architecture.md) | Backend components and data flow |
| [api.md](api.md) | REST API contract |
| [data-model.md](data-model.md) | SQLite and on-disk storage |
| [execution.md](execution.md) | Persistent queue container and run lifecycle |
| [eval-package.md](eval-package.md) | Canonical eval package format and confidentiality |
| [adapters.md](adapters.md) | Adapter definitions and storage |
| [agent-adapter-sdk.md](agent-adapter-sdk.md) | Adapter protocol |
| [adapter-generation-guide.md](adapter-generation-guide.md) | Creating a real adapter |
| [projects.md](projects.md) | Project ownership boundaries |
| [watcher.md](watcher.md) | Watcher and queue enqueue behavior |
| [event-schema.md](event-schema.md) | Canonical trace event schema |
| [categories.md](categories.md) | Agent/eval categories |
| [roadmap.md](roadmap.md) | Current backend roadmap |

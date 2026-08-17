# agenteval plan

This plan defines an API-only backend for executing agent evals and retaining immutable evidence.

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

## Current interface

The REST API and its event streams are the only application interface. There is no bundled frontend,
judge subsystem, judgement/report API, findings/regression subsystem, reusable-rubric CRUD API, or
standalone run-artifact API.

## Documents

| Document | Purpose |
|---|---|
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

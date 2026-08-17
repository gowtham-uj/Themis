# Projects

A project is the ownership boundary for adapters, canonical eval packages, queues, runs, and archives.

## Project-owned state

- Project metadata and default model/provider.
- One enabled project adapter definition, with optional explicit sharing.
- Immutable canonical eval packages and their task projection.
- Named persistent queues and ordered queue items.
- Run batches and individual runs.
- Sealed eval archives and central archive-store entries.
- Queue-bound watcher rules (agent-commit automation) and API tokens. There is no outbound webhook
  subsystem; only the signed inbound watcher hook is part of the API-only backend.

## Task sources

The current canonical creation path is eval-package import through the API. Legacy task-source kinds remain
for compatibility with persisted projects and repository ingestion. The legacy `ui-builder` kind now means
API-authored `task.json` readback; it does not imply a bundled frontend.

## Isolation

All domain resources are project-scoped except globally registered agent identities. A shared adapter may
be consumed by another project only through an explicit shared adapter-store row. Protected eval content
never crosses into an agent container.

## Archives

The project owns each run's sealed eval archive. A central copy is additionally categorized by agent source
commit, queue, batch, and run so an API client can retrieve all historical results for an agent version.

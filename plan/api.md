# REST API

The HTTP API is the only application interface. It controls projects, adapters, canonical eval packages,
queues, persistent containers, runs, event streams, and immutable eval-result archives.

## Conventions

- JSON responses use RFC-7807-style errors: `{type,title,status,detail}`.
- Async run/container operations return `202 Accepted` with resource IDs.
- Create and run endpoints support `Idempotency-Key` where documented.
- Authentication uses bearer API tokens when enabled.
- SSE and NDJSON expose canonical run events.

## Projects

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
POST   /api/projects/:id/export
```

## Agent adapters

```text
POST   /api/projects/:id/adapters
POST   /api/projects/:id/adapters/from-generator
GET    /api/projects/:id/adapters
GET    /api/projects/:id/adapters/:adapterId
PATCH  /api/projects/:id/adapters/:adapterId
POST   /api/projects/:id/adapters/:adapterId/validate
POST   /api/projects/:id/adapters/:adapterId/build
DELETE /api/projects/:id/adapters/:adapterId
GET    /api/adapters/store
GET    /api/adapters/generator-contract
```

A queue must select the owning project's enabled adapter, an explicit shared adapter-store row, or an
explicit built-in adapter ID. Adapter builds retain resolved source commit and image provenance.

## Canonical eval package store

The eval store is project-owned and decoupled from queues: queues reference evals by id
(`eval_queue_items.task_id`), and runs snapshot the eval at claim time. A queue item is just a
pointer; deleting or changing an eval never rewrites a sealed run. Evals list the queues that
reference them (`used_by_queues`), and deletion is guarded — it is rejected (`409`) while a live
queue still references the eval.

```text
POST   /api/projects/:id/evals
POST   /api/projects/:id/evals:import-archive?format=zip|tar|tar.gz
GET    /api/projects/:id/evals?category_name=...&include_archived=...
GET    /api/projects/:id/evals/:evalId
PATCH  /api/projects/:id/evals/:evalId   # immutability guard (409)
DELETE /api/projects/:id/evals/:evalId   # 409 while referenced by a live queue
GET    /api/projects/:id/eval-categories

# Standalone (cross-project) eval-store namespace
GET    /api/evals?project_id=...&category_name=...
GET    /api/evals/:evalId
```

Packages are immutable and must pass strict validation. The legacy `/api/projects/:id/tasks`
CRUD surface is removed — `/evals` is the single canonical surface. Protected
solution/tests/validation content is kept outside the agent container.

## Persistent eval queues

```text
POST   /api/projects/:id/queues
GET    /api/projects/:id/queues
GET    /api/projects/:id/queues/:queueId
PATCH  /api/projects/:id/queues/:queueId
DELETE /api/projects/:id/queues/:queueId

POST   /api/projects/:id/queues/:queueId/items
POST   /api/projects/:id/queues/:queueId/items:load-category
GET    /api/projects/:id/queues/:queueId/items
PATCH  /api/projects/:id/queues/:queueId/items/:itemId
DELETE /api/projects/:id/queues/:queueId/items/:itemId

PUT    /api/projects/:id/queues/:queueId/container
GET    /api/projects/:id/queues/:queueId/container
PATCH  /api/projects/:id/queues/:queueId/container
DELETE /api/projects/:id/queues/:queueId/container
GET    /api/projects/:id/containers
```

One persistent Podman container belongs to each active queue. Evals run sequentially with setup, real
agent execution, evidence extraction, separate verification, cleanup, reset, sealing, and central storage.

A source-backed queue pins an exact agent revision at create/PATCH time:

```text
POST  /api/projects/:id/queues   {..., agent_commit? | agent_ref?}
PATCH /api/projects/:id/queues/:queueId {..., agent_commit? | agent_ref?}
```

`agent_commit` accepts a full 40-character SHA; `agent_ref` (branch/tag/short-sha) is resolved
immediately to a full SHA through the selected adapter's source repo and stored as `eval_queues.agent_commit`.
Built-in adapters may omit the pin. Queue generation start builds the exact pinned commit through
`adapter_builds` (commit-addressed image) before creating the immutable batch, and snapshots
build/image/imageId/commit/version onto the batch, container, runs, metrics, and central archive.

The project agent-repo endpoints browse/resolve the selected adapter's own source repo so a commit is
picked (never pasted blindly) and always reproducible:

```text
GET  /api/projects/:id/agent/commits?agent_id=…&ref=…
GET  /api/projects/:id/agent/refs?agent_id=…
POST /api/projects/:id/agent/resolve {agent_id, ref}
```

These replace any generic/global commit browsing: a caller supplies only the agent id, never credentials;
the GitHub token always comes from server settings/environment.

## Queue-container introspection

```text
POST /api/projects/:id/queues/:queueId/container/exec
     {command,cwd?,env?,timeout_ms?,max_output_bytes?}
```

This operates only on an existing live queue container. It never implicitly starts a container. Output is
streamed using `application/vnd.agenteval.exec-stream` framed channels.

## Runs and events

```text
GET  /api/projects/:id/runs
GET  /api/runs/:id
GET  /api/runs/:id/events
GET  /api/runs/:id/events?stream=ndjson
GET  /api/runs/:id/diff
GET  /api/evals/:runId/metrics
GET  /api/evals/:runId/archive
```

Run creation and run-level pause/resume/abort are not exposed as standalone routes: runs are created only
by the atomic queue claim path (`claimQueueWork`) when a queue generation executes its items, and run
pausing/resuming/aborting is performed at the queue-container level (`PATCH .../queues/:queueId/container`
with `action: pause|resume|abort`). Run/event/diff/metrics/archive reads are read-only.

Commit-driven evaluation is expressed through queues, not a generic evaluation batch API: a queue is
pinned to an exact `agent_commit`/`agent_ref` at create/PATCH time, and the only commit automation is
(1) the per-project agent-repo endpoints above that pick/resolve a commit from the adapter's own source
repo, and (2) the queue-bound watcher ingress that fires agent-commit generations. There are no
`/evaluate` or `/evaluations` endpoints; results are retrieved from the central archive store.

## Central archive store

```text
GET /api/archives
GET /api/projects/:projectId/archives
GET /api/archives/:runId
GET /api/archives/:runId/files/:path
GET /api/archives/:projectId/:agentCommit
GET /api/archives/:projectId/:agentCommit/:runId
GET /api/archives/:projectId/:agentCommit/:runId/files/:path
```

Archives sit one level under `archives/<runId>/`. Listing reads `archives/index.json`. The nested project/commit URLs are aliases of the same catalog.

List filters are combinable:

- `project_id`
- `agent_id`
- `agent_commit`
- `agent_version` — stable agent version (short commit SHA)
- `image_id`
- `build_id`
- `queue_id`
- `queue_revision`
- `batch_id`
- `run_id`
- `task_id`
- `task_name`
- `model`
- `provider`
- `status`
- `reward=0|1`
- `limit` and `offset`

Each archive manifest records project, queue (with revision), batch/run/task, agent id/source commit/
image/image id/version/build id, model/provider, terminal status, verifier reward, and seal/archive
timestamps. The archive API is the historical evidence interface for logs, traces, metrics, verifier
results, cleanup and reset evidence, diffs, and captured generated outputs. Each run keeps one root
`run-metrics.json`.

## Watchers and webhooks

```text
GET    /api/projects/:id/watchers
POST   /api/projects/:id/watchers
GET    /api/projects/:id/watchers/:ruleId/events
PATCH  /api/projects/:id/watchers/:ruleId
DELETE /api/projects/:id/watchers/:ruleId
POST   /api/projects/:id/watchers/:ruleId/run
POST   /api/projects/:id/watcher/hooks/:ruleId
```

A watcher belongs to a project and exactly one eval queue; `queueId` is required on
create and the watcher's `repo` must equal that queue's source adapter `source_repo`.
There is no `role` / task-selection action: a watcher fires the owning queue's
agent-commit generations.

- POST `/watchers` creates with `{queueId, repo, trigger, ref?, semverFilter?, webhookSecret?}`.
- GET `/watchers/:ruleId/events` lists durable watcher events (pending/launching/launched/deduped/ignored/failed).
- POST `/watchers/:ruleId/run` manually fires the same engine path (idempotent per SHA).
- POST `/watcher/hooks/:ruleId` is a signed inbound webhook: verifies HMAC + repository
  identity, resolves the full SHA, deduplicates watcher+SHA, and records a durable
  pending FIFO event. If the queue has no active generation it launches with that
  commit as an immutable generation override (never mutating the queue's default
  `agent_commit`); otherwise the commit stays pending and is auto-launched FIFO when
  the active generation closes. Only this exact signed-hook route is bearer-exempt;
  CRUD/manual/event-list remain bearer-protected and project-scoped.

## Removed surfaces

The API intentionally has no judgement/analysis/report/findings/regression/improvement routes, no reusable
rubric CRUD routes, and no standalone `/api/runs/:id/artifacts` routes. Generated outputs remain inside the
immutable eval archive and are retrieved through the archive API.

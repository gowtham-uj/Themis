# agenteval API operator guide

This guide covers the API-only workflow from an empty installation to queued eval execution and centrally
queryable immutable results.

Assume `BASE=http://127.0.0.1:8080`. When authentication is enabled, send:

```http
Authorization: Bearer <token>
```

## 1. Create a project

```http
POST /api/projects
Content-Type: application/json

{
  "name": "ReaperCode eval suite",
  "slug": "reapercode-evals",
  "default_model": "deepseek-v4-flash",
  "default_provider": "nuralwatt"
}
```

## 2. Create or select an adapter

Create a declarative project adapter with `POST /api/projects/<projectId>/adapters`, or generate one with
`POST /api/projects/<projectId>/adapters/from-generator`. Validate and build it through the corresponding
adapter endpoints. The adapter record retains its resolved source commit and built image provenance.

An adapter can be shared by setting its sharing field through the adapter API. Consumer queues must select
that exact shared adapter-store row; sharing is never implicit.

## 3. Import canonical eval packages

```http
POST /api/projects/<projectId>/evals
Content-Type: application/json

{"files":{"task.toml":"...","seed_repo/README.md":"...",...}}
```

Or upload ZIP/TAR bytes:

```http
POST /api/projects/<projectId>/evals:import-archive?format=zip
Content-Type: application/octet-stream
```

The package validator rejects incomplete or unsafe packages atomically. Solution/tests/validation content
is retained outside the agent container.

The eval store is decoupled from queues: a queue item is a pointer to an eval id, and a run snapshots
the eval at claim time. Evals list the queues that reference them (`used_by_queues`), and deletion is
guarded — `DELETE /api/projects/<projectId>/evals/<evalId>` returns `409` while a live queue still
references the eval. A cross-project listing is available at `GET /api/evals?project_id=...&category_name=...`
and `GET /api/evals/<evalId>`.

## 4. Create a queue and add evals

```http
POST /api/projects/<projectId>/queues
Content-Type: application/json

{
  "name": "DeepSeek queue",
  "model": "deepseek-v4-flash",
  "provider": "nuralwatt"
}
```

Then add eval IDs:

```http
POST /api/projects/<projectId>/queues/<queueId>/items
Content-Type: application/json

{"eval_id":"<evalId>","repeats":1}
```

## 5. Start and inspect the persistent queue container

```http
PUT /api/projects/<projectId>/queues/<queueId>/container
GET /api/projects/<projectId>/queues/<queueId>/container
GET /api/projects/<projectId>/containers
```

One real Podman container is created for the active queue. Evals execute sequentially. Each eval runs its
setup, the real agent, evidence extraction, separate verifier, cleanup, workspace reset, and archive seal.

For privileged live inspection of an existing queue container:

```http
POST /api/projects/<projectId>/queues/<queueId>/container/exec
Content-Type: application/json

{"command":"ps aux","cwd":"/workspace","timeout_ms":30000}
```

## 6. Read run state and events

```http
GET /api/runs/<runId>
GET /api/runs/<runId>/events
GET /api/runs/<runId>/events?stream=ndjson
GET /api/runs/<runId>/diff
GET /api/evals/<runId>/metrics
GET /api/evals/<runId>/archive
```

The verifier reward is authoritative. Provider quota, rate-limit, context-length, authentication, and model
availability failures are classified explicitly in the run archive.

## 7. Browse the central archive store

Across all projects:

```http
GET /api/archives?agent_commit=<sha>&model=deepseek-v4-flash&reward=1
```

For one project:

```http
GET /api/projects/<projectId>/archives?queue_id=<queueId>&status=completed
```

One archive, by run id:

```http
GET /api/archives/<runId>
GET /api/archives/<runId>/files/retained/trace.jsonl
```

The older project/commit paths still work as aliases:

```http
GET /api/archives/<projectId>/<agentCommit>
GET /api/archives/<projectId>/<agentCommit>/<runId>
GET /api/archives/<projectId>/<agentCommit>/<runId>/files/retained/trace.jsonl
```

Available list filters are `project_id`, `agent_id`, `agent_commit`, `queue_id`, `batch_id`, `run_id`,
`task_id`, `task_name`, `model`, `provider`, `status`, `reward`, `limit`, and `offset`.

## 8. Control and stop queue execution

Run pausing, resuming, and aborting are queue-container operations (there are no standalone run-level
control routes). Pause/resume/abort act on the current run in the active queue container; abort seals
partial evidence then lets the worker continue to the next claim.

```http
PATCH  /api/projects/<projectId>/queues/<queueId>/container
       {"action":"pause"|"resume"|"abort"}
DELETE /api/projects/<projectId>/queues/<queueId>/container
```

## 9. Export a project

```http
POST /api/projects/<projectId>/export
```

Returns a portable JSON bundle of the project's rows and path manifest for backup or migration.

## Removed interfaces

The backend has no judge/judgement, queue-analysis, report, findings/regression/improvement, reusable-rubric,
standalone run-artifact, or frontend interface. Historical evidence and generated outputs are accessed
through immutable eval archives.

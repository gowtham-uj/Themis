# REST API — for other applications to consume

The current product surface is **backend/API-only**; the frontend is deferred. Programmatic clients
create projects, CRUD project CLI adapters and eval definitions, manage ordered queues and persistent
Podman containers, stream privileged exec output, request PI-agent judgement revisions, and fetch
immutable archives, verdicts, findings, and HTML reports without any UI dependency.

## Auth

- **API tokens** (scoped per user, optionally per project): `Authorization: Bearer <token>`. Tokens
  carry the same role perms as the user; a read-only token can be minted for consumers that only pull.
- Tokens are created/revoked in Settings; the `webhook_secret` on a watcher rule is separate (per-rule,
  HMAC for inbound git hooks) — never returned after creation.

## Conventions

- All resources are **project-scoped**: `/api/projects/:projectId/...`. Cross-project list endpoints
  exist for global views (admin).
- `GET` list endpoints support `?status=`, `?tag=`, `?trigger_ref=` (tag/commit), `?agent_commit=`,
  `?limit&cursor` pagination, and `?fields=` projection.
- Errors: RFC-7807-style `{ type, title, status, detail }`.
- `202 Accepted` for async-creating (run/judgement batch start); response body carries the created
  resource ids + a `Location` to poll/stream.
- **Idempotency**: `POST` create/run endpoints accept an `Idempotency-Key` header so retries (e.g. from
  a flaky CI) don't double-enqueue.

## Streaming

- **SSE** for live tail (same endpoints the UI uses): `GET /api/runs/:id/events`,
  `GET /api/judgements/:id/events`. Reconnect with `?since=<lastSeq>` to resume from disk.
- For non-SSE clients, a `GET .../events?stream=ndjson` (newline-delimited JSON) alternative and a
  **webhooks** outbound option (below) cover consumers that can't hold an SSE connection.

## Endpoints (illustrative)

### Projects
```
POST   /api/projects                              create project (+ task source config, default agent/judge)
GET    /api/projects                              list
GET    /api/projects/:id                          detail (settings, task source, defaults, counts)
PATCH  /api/projects/:id                          update settings (defaults, overrides, retention)
DELETE /api/projects/:id                          archive (soft; keeps history)
POST   /api/projects/:id/export                   → portable bundle (subtree + DB rows)
```

###/watchers
```
GET    /api/projects/:id/watchers                 list watcher rules
POST   /api/projects/:id/watchers                 create rule (repo, trigger, action, semver_filter)
PATCH  /api/projects/:id/watchers/:ruleId         enable/disable, edit
DELETE /api/projects/:id/watchers/:ruleId
POST   /api/projects/:id/watchers/:ruleId/run     manual "fire now" (resolve ref → enqueue batch)
POST   /api/projects/:id/watcher/hooks/:ruleId    git-host webhook ingress (HMAC-verified)
```

### Tasks (CRUD — per project)
```
POST   /api/projects/:id/tasks                    create task (ui-builder) — body: TaskSpec
GET    /api/projects/:id/tasks                    list (filter by tag/profile)
GET    /api/projects/:id/tasks/:taskId            detail (prompt, rubric, checks)
PATCH  /api/projects/:id/tasks/:taskId            update → bumps rubric_version (new baseline)
DELETE /api/projects/:id/tasks/:taskId            archive
POST   /api/projects/:id/tasks/sync               pull the project's task source (repo-md/manifest/...)
```
> Tasks that originate from `repo-md`/`manifest-yaml`/`ci-artifact` are **read-only via the API** in
> the sense that their source of truth is the repo; edits round-trip through the source (PATCH returns
> 409 with a pointer). `ui-builder` and `http-push` tasks are fullymutable through the API.

### Project agent adapter — one real CLI agent per project

Each project is bound to exactly one agent under test. Its adapter is a CRUD-able declarative CLI
integration (see [agent-adapter-sdk.md](agent-adapter-sdk.md)). It records the real git source/ref,
Containerfile build recipe, image, provider/model credential mapping, eval command, real connection
check, parser kind, and native evidence paths.

```
POST   /api/projects/:id/adapters
GET    /api/projects/:id/adapters
GET    /api/projects/:id/adapters/:adapterId
PATCH  /api/projects/:id/adapters/:adapterId
POST   /api/projects/:id/adapters/:adapterId/build   clone pinned source + real Podman image build
DELETE /api/projects/:id/adapters/:adapterId
```

A project may have only one adapter. Adapter edits/build/deletion are rejected while any project queue
container is active. Tests and production use the same real CLI/provider path; missing model access is a
blocker, never a reason to substitute a fake.

### Eval store

`tasks` remains the storage table; `/evals` is the preferred product API and `/tasks` is compatibility.
Every edit bumps the eval version. Queue execution snapshots the exact version and definition.

```
POST   /api/projects/:id/evals
GET    /api/projects/:id/evals
GET    /api/projects/:id/evals/:evalId
PATCH  /api/projects/:id/evals/:evalId
DELETE /api/projects/:id/evals/:evalId
```

Eval definitions include prompt, workspace, category, rubric, deterministic checks, setup script,
cleanup script, cleanup verification, timeouts, reference solution, and tags.

### Persistent eval queues and queue-owned containers

A project may define any number of named queues for its one agent. Each active queue owns one persistent
Podman container and processes its ordered eval references sequentially. Different queues provide
parallelism. No eval creates its own container.

```
POST   /api/projects/:id/queues
GET    /api/projects/:id/queues
GET    /api/projects/:id/queues/:queueId
PATCH  /api/projects/:id/queues/:queueId
DELETE /api/projects/:id/queues/:queueId

POST   /api/projects/:id/queues/:queueId/items
GET    /api/projects/:id/queues/:queueId/items
PATCH  /api/projects/:id/queues/:queueId/items/:itemId
DELETE /api/projects/:id/queues/:queueId/items/:itemId

PUT    /api/projects/:id/queues/:queueId/container   snapshot queue + spawn/start worker
GET    /api/projects/:id/queues/:queueId/container
PATCH  /api/projects/:id/queues/:queueId/container   {action:"pause"|"resume"}
DELETE /api/projects/:id/queues/:queueId/container   stop and remove
GET    /api/projects/:id/containers                  list live queue containers
```

Spawn runs a real adapter/provider/model connection check before any eval setup. Each eval then follows
setup → real CLI agent → raw/canonical/native evidence extraction → checks → cleanup → cleanup verify →
process kill/reset → immutable archive. A cleanup/evidence/archive failure taints the queue and stops it
before the next eval.

### Privileged streaming introspection bridge

```
POST /api/projects/:id/queues/:queueId/container/exec
     {command,cwd?,env?,timeout_ms?}
```

The bridge never spawns a container: absent/stopped containers return 409. It executes `/bin/bash -lc`
as container user `root`, giving operator-level read/write control over the exact queue pod. stdout and
stderr stream live as exact bytes in `application/vnd.agenteval.exec-stream` frames: channel byte
(1 stdout, 2 stderr, 3 exit JSON, 4 stream error), 4-byte big-endian payload length, then payload.
Operator commands append `exec{actor:"operator",source:"introspection"}` to the current eval trace.
When auth is disabled the bridge is loopback-only; read-only tokens cannot invoke it.

### Immutable evidence and queue judgement revisions

```
GET  /api/evals/:runId/archive
POST /api/projects/:id/queues/:queueId/analyses
     {batch_id,all:true|run_ids[],judge_model,judge_provider,judge_prompt?,judge_params?}
GET  /api/projects/:id/queues/:queueId/analyses
GET  /api/projects/:id/queues/:queueId/analyses/:analysisId
GET  /api/projects/:id/queues/:queueId/analyses/:analysisId/events
GET  /api/projects/:id/queues/:queueId/analyses/:analysisId/transcript
GET  /api/projects/:id/queues/:queueId/analyses/:analysisId/verdict
GET  /api/projects/:id/queues/:queueId/analyses/:analysisId/report
```

One real PI SDK judge-agent session uses the versioned custom judge system prompt and restricted
archive/submission tools. It must list and completely read every file in every selected immutable
archive before its terminating submit tool is accepted. It emits one standard Verdict per eval plus cross-eval
themes, reliability, ranked defects, subsystem attribution, regressions, and a verification-oriented
improvement plan. Rejudging creates an append-only revision and never reruns the evaluated agent.

### Legacy runs + batches — compatibility/control

Run **control** (task #11 semantics):
```
POST   /api/runs/:id/pause?mode=soft|hard          pause (soft = stop dequeuing; hard = cgroup freeze)
POST   /api/runs/:id/resume                        resume (re-enqueue / thaw + reconnect stream)
POST   /api/runs/:id/abort                         abort (graceful SIGTERM→KILL, keep partial logs)
POST   /api/runs/:id/control                       live sandbox control: {action:"network", enabled:false}
                                                  → cut egress now (reversible with enabled:true);
                                                  {action:"cpu"|"memory", value} → live limit change;
                                                  {action:"pause"|"resume"|"abort"} → alias of the above
POST   /api/projects/:id/control                   batch/project fan-out: {action:pause|resume|abort|network, scope:batch|all}
```
Sandbox telemetry lands in the same event stream: `exec` (every command run) and `net` (every outbound
network call, incl. `blocked`) events are appended to `events.jsonl` and streamed over `GET .../events`.
A finding can `refs` an `exec`/`net` event by seq range. Partial results are always available via the
`GET`s above regardless of `control_state`.

### Judgements + findings
```
POST   /api/runs/:id/judgements                   request a judgement { model?, prompt?, rubric? } → 202 + judgement id
GET    /api/judgements                             list (filter by run/project/status)
GET    /api/judgements/:id                        verdict (overall, criteria, diagnostics, findings, improvements)
GET    /api/judgements/:id/events                 SSE judge log
GET    /api/judgements/:id/report                 report.html (sandboxed; inline CSS/JS)
GET    /api/projects/:id/findings                 per-project issues log (fingerprint, status, recurrence)
GET    /api/projects/:id/findings/:fingerprint    lifecycle: occurrences, first/last seen, k/N
```

### Trends + comparison
```
GET    /api/projects/:id/tasks/:taskId/trend      score trend over time (mean±spread, deltas)
GET    /api/projects/:id/compare/runs?a=..&b=..   two-run compare (per-criterion deltas, finding-set diff)
GET    /api/projects/:id/compare/releases?from=v2.2.0&to=v2.3.0
        → release compare: suite-level overall delta, per-axis rollups, finding-category deltas,
          diagnostic rate deltas, deterministic pass-rate deltas (see ui.md Release compare view)
```

## Outbound webhooks (notify external apps)

A project (or per-rule) may register **outbound webhooks** for:

- `run.completed` / `run.failed` / `run.aborted`
- `judgement.completed`
- `finding.introduced` / `finding.resolved` / `finding.regressed` (so a defect tracker can open/close
  issues automatically)
- `release.compared` (a release compare completed)

Payloads are signed (HMAC) and carry the resource id + a fetch URL; the consumer re-Gets for detail
rather than receiving the whole trace inline. Retry with backoff; dead-letter on repeated failure.

## Versioning & stability

- URL-prefixed versioning is **not** used initially (self-hosted, few consumers); instead the
  `Accept: application/vnd.agenteval.v1+json` media type pins a shape, and **breaking** changes bump
  the vendor version. Judge `system_prompt_version` and task `rubric_version` are separate axes
  (content versioning, not API versioning) and are returned on every judgement for apples-to-apples
  consumption.
- A `/api/meta` endpoint exposes versions (platform, judge prompt, adapters) and the project's schema
  for consumers that adapt dynamically.

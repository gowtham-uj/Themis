# Themis API reference

The HTTP API is the authority for projects, adapters, evals, queues, runs, archives, Phase 1, and Phase 2. The React console uses these endpoints and does not keep a second data model.

Default base URL:

```text
http://127.0.0.1:8080
```

## Request conventions

- Send JSON with `Content-Type: application/json`.
- When authentication is enabled, send `Authorization: Bearer <token>`.
- Administrative operations include eval import, image builds, container start and exec, user management, archive deletion, and deployment settings.
- Async work returns `202 Accepted`. Poll the corresponding status endpoint.
- Create and start endpoints use `Idempotency-Key` where the route documents it.
- IDs are opaque strings. Do not infer a type from their prefix.

## Error format

Expected failures use RFC 7807 problem JSON:

```json
{
  "type": "https://agenteval.dev/errors/conflict",
  "title": "Conflict",
  "status": 409,
  "detail": "linked eval queue already has an active generation"
}
```

The server maps validation, auth, missing data, stale revisions, package errors, provider errors, and state conflicts to specific status codes. Unexpected failures are logged server-side. The client receives a safe detail that does not include stack traces, credentials, or host paths.

## Health

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/health` | API liveness, `{ "ok": true }`. |
| `GET` | `/api/judge/health` | Judge subsystem status. |

## Authentication, users, and tokens

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Exchange `{ username, password }` for an authenticated session or token response. |
| `GET` | `/api/auth/me` | Return the current principal. |
| `GET` | `/api/auth/users` | List users. Admin when auth is enabled. |
| `POST` | `/api/auth/users` | Create a user with `{ username, password, role?, email? }`. |
| `DELETE` | `/api/auth/users/:id` | Delete a user. |
| `GET` | `/api/tokens` | List API tokens without returning raw token values. |
| `POST` | `/api/tokens` | Mint a token with `{ user_id?, project_id?, label?, read_only? }`. |
| `DELETE` | `/api/tokens/:tokenHash` | Revoke the token represented by the stored hash. |

The login endpoint has per-address and per-username backoff. Project-scoped tokens can act only on their project.

## Projects

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects` | Create a project. |
| `GET` | `/api/projects` | List visible projects. Add `include_archived=1` to include archived rows. |
| `GET` | `/api/projects/:id` | Read one project. |
| `PATCH` | `/api/projects/:id` | Update project metadata, model overrides, prompts, network policy, or minimum eval count. |
| `GET` | `/api/projects/:id/readiness` | Explain whether adapter, eval, queue, and model prerequisites are ready. |
| `GET` | `/api/projects/:id/prompts` | Return built-in and project-edited Phase 1 and Phase 2 prompts. |
| `DELETE` | `/api/projects/:id` | Archive the project. |
| `POST` | `/api/projects/:id/export` | Export project rows and a signed path manifest. Secrets are stripped. |
| `GET` | `/api/projects/:id/members` | List project members. |
| `PUT` | `/api/projects/:id/members/:userId` | Add or update a member. |
| `DELETE` | `/api/projects/:id/members/:userId` | Remove a member. |

Create body:

```json
{
  "name": "ReaperCode evaluation",
  "slug": "reapercode-evaluation",
  "description": "Peak multi-file engineering suite",
  "default_agent_id": "reapercode",
  "default_model": "model-id",
  "default_provider": "provider-name",
  "network_policy": "allowlist",
  "min_evals": 10,
  "model_config": {
    "phase1": {
      "apiType": "openai",
      "baseUrl": "https://provider.example/v1",
      "apiKeyEnv": "JUDGE_PROVIDER_KEY",
      "webSearchApiKeyEnv": "SERPER_SEARCH_API_KEY",
      "model": "model-id"
    }
  }
}
```

`apiKeyEnv` and `webSearchApiKeyEnv` must be environment variable names. Sending an `apiKey` value is rejected.

## Adapter APIs

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects/:id/adapters` | Create a declarative project adapter. |
| `GET` | `/api/projects/:id/adapters` | List project adapters. |
| `GET` | `/api/projects/:id/adapters/:adapterId` | Read one adapter. |
| `PATCH` | `/api/projects/:id/adapters/:adapterId` | Update the editable adapter definition. |
| `DELETE` | `/api/projects/:id/adapters/:adapterId` | Delete an adapter that is not in use. |
| `GET` | `/api/projects/:id/adapters/:adapterId/versions` | List immutable adapter versions. |
| `POST` | `/api/projects/:id/adapters/:adapterId/versions` | Create an immutable adapter version. |
| `POST` | `/api/projects/:id/adapters/:adapterId/validate` | Validate command, parser, evidence, credentials, and connection behavior. |
| `POST` | `/api/projects/:id/adapters/:adapterId/build` | Resolve and build the selected source commit. |
| `POST` | `/api/projects/:id/adapters/from-generator` | Run the adapter generator contract and create the adapter. |
| `GET` | `/api/adapters/generator-contract` | Return the generator input and output contract. |
| `GET` | `/api/adapters/docs` | Return adapter field documentation for the console. |
| `GET` | `/api/adapters/builtin` | List registered built-in adapter IDs. |
| `GET` | `/api/adapters/store` | List explicitly shared adapters. |
| `GET` | `/api/projects/:id/agent/refs` | List source refs for the selected agent repository. |
| `GET` | `/api/projects/:id/agent/commits` | List source commits. |
| `POST` | `/api/projects/:id/agent/resolve` | Resolve a ref to an exact commit. |

The adapter generator guide has the full create payload, parser shapes, evidence rules, and build contract: [adapter-generation-guide.md](../plan/adapter-generation-guide.md).

## Project evals

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects/:id/evals` | Create one eval from a JSON file map. Maximum request size is 70 MB. |
| `POST` | `/api/projects/:id/evals:import-archive?format=zip\|tar\|tar.gz` | Import one eval or a `tasks/` suite from binary archive bytes. |
| `GET` | `/api/projects/:id/evals` | List project evals and queue usage. |
| `GET` | `/api/projects/:id/evals/:evalId` | Read one eval. |
| `PATCH` | `/api/projects/:id/evals/:evalId` | Update supported metadata. Package bytes remain versioned. |
| `DELETE` | `/api/projects/:id/evals/:evalId` | Archive an eval. Returns `409` while an active queue references it. |
| `GET` | `/api/projects/:id/eval-categories` | List category names and counts. |
| `GET` | `/api/evals` | List evals across visible projects. Supports project and category filters. |
| `GET` | `/api/evals/:evalId` | Read one eval globally. |

Single-eval JSON body:

```json
{
  "files": {
    "task.toml": "version = \"1.0\"\n...",
    "instruction.md": "Fix the implementation.",
    "seed_repo/src/example.ts": "..."
  }
}
```

The server validates the complete package before it creates an eval row. See [eval-authoring.md](./eval-authoring.md).

## Shared eval store

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/eval-store` | List published reusable eval packages. |
| `GET` | `/api/eval-store/:id` | Read one published package record. |
| `POST` | `/api/eval-store` | Publish a canonical package directly. |
| `POST` | `/api/eval-store:import-archive` | Import a reusable eval archive. |
| `DELETE` | `/api/eval-store/:id` | Remove a store entry when allowed. |
| `POST` | `/api/eval-store/:id/copy` | Copy a store package into a project. |
| `POST` | `/api/projects/:id/evals/:evalId/publish` | Publish one project eval to the shared store. |

Copy body:

```json
{ "project_id": "<project-id>" }
```

## Eval queues and items

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects/:id/queues` | Create the project's eval queue. |
| `GET` | `/api/projects/:id/queues` | List project queues. |
| `GET` | `/api/projects/:id/queue` | Return the project's single queue view used by the console. |
| `GET` | `/api/projects/:id/queues/:queueId` | Read one queue. |
| `PATCH` | `/api/projects/:id/queues/:queueId` | Update queue configuration. |
| `DELETE` | `/api/projects/:id/queues/:queueId` | Delete an idle queue. |
| `POST` | `/api/projects/:id/queues/:queueId/items` | Add one eval with `{ eval_id, repeats?, enabled?, position?, before?, after?, overrides? }`. |
| `POST` | `/api/projects/:id/queues/:queueId/items:load-category` | Add project evals from a category. |
| `GET` | `/api/projects/:id/queues/:queueId/items` | List items, including disabled items. |
| `PATCH` | `/api/projects/:id/queues/:queueId/items/:itemId` | Change order, repeats, enabled state, or overrides. |
| `DELETE` | `/api/projects/:id/queues/:queueId/items/:itemId` | Remove a queue item. |

Queue create accepts:

```json
{
  "name": "Main queue",
  "agent_id": "reapercode",
  "model": "model-id",
  "provider": "provider-name",
  "shared_adapter_id": null,
  "builtin_adapter_id": "reapercode",
  "agent_commit": null,
  "agent_ref": null,
  "network_policy": "allowlist",
  "sandbox": null,
  "ports": []
}
```

Each project supports one durable eval queue. Starting it creates a new immutable queue generation.

## Queue container control

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/api/projects/:id/queues/:queueId/container` | Start a queue generation. Admin operation. Returns `202`. |
| `GET` | `/api/projects/:id/queues/:queueId/container` | Read current container, current run, pause state, and generation IDs. |
| `PATCH` | `/api/projects/:id/queues/:queueId/container` | `{ "action": "pause" | "resume" | "abort" }`. |
| `DELETE` | `/api/projects/:id/queues/:queueId/container` | Stop and remove the active container after terminal capture. |
| `POST` | `/api/projects/:id/queues/:queueId/container/exec` | Run an administrative command inside the live container. Streams framed stdout and stderr. |
| `GET` | `/api/projects/:id/containers` | List project queue containers. |

`abort` stops the current eval, seals its partial evidence when possible, and lets the queue continue. `DELETE` stops the whole queue generation.

## Agent runs and live events

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/runs` | List agent runs for a project. |
| `GET` | `/api/runs/:id` | Read one agent run. |
| `GET` | `/api/runs/:id/events` | Stream canonical events as SSE. |
| `GET` | `/api/runs/:id/events?stream=ndjson` | Stream canonical events as NDJSON. |
| `GET` | `/api/runs/:id/diff` | Read the captured agent diff. |
| `GET` | `/api/evals/:runId/metrics` | Read deterministic metrics. |
| `GET` | `/api/evals/:runId/archive` | Read archive metadata for a run. |

## Archives

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/archives` | List archives. Supports project, agent, commit, queue, batch, task, model, provider, status, and reward filters. |
| `GET` | `/api/projects/:projectId/archives` | List one project's archives. |
| `GET` | `/api/archives/:runId` | Read one archive record and manifest summary. |
| `GET` | `/api/archives/:runId/contents` | List normalized files plus base, Phase 1, and Phase 2 publication state. |
| `GET` | `/api/archives/:runId/file?path=<relative-path>` | Stream one file. This query form supports arbitrary path depth. |
| `GET` | `/api/archives/:runId/download` | Download the current archive view as a compressed tar archive. |
| `DELETE` | `/api/archives` | Clear retained archives. Admin operation. |

Compatibility aliases remain available:

```text
GET /api/archives/:runId/files/<up-to-six-path-segments>
GET /api/archives/:projectId/:agentCommit
GET /api/archives/:projectId/:agentCommit/:runId
GET /api/archives/:projectId/:agentCommit/:runId/files/<path>
```

New clients should use `/contents`, `/file?path=`, and `/download`.

## Sandbox policy

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sandbox/presets` | List supported sandbox presets. |
| `GET` | `/api/projects/:id/sandbox` | Read the project policy. |
| `PUT` | `/api/projects/:id/sandbox` | Replace the policy. |
| `PATCH` | `/api/projects/:id/sandbox` | Patch the policy. |
| `DELETE` | `/api/projects/:id/sandbox` | Clear the project override. |

Privileged mode, host mounts, devices, root users, `SYS_ADMIN`, and related settings require administrator access.

## Watchers and webhooks

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/watchers` | List watcher rules. |
| `POST` | `/api/projects/:id/watchers` | Create a rule. |
| `PATCH` | `/api/projects/:id/watchers/:ruleId` | Update a rule. |
| `DELETE` | `/api/projects/:id/watchers/:ruleId` | Delete a rule. |
| `GET` | `/api/projects/:id/watchers/:ruleId/events` | List watcher firings. |
| `POST` | `/api/projects/:id/watchers/:ruleId/run` | Poll or trigger one rule immediately. |
| `POST` | `/api/projects/:id/watcher/hooks/:ruleId` | Receive a signed repository webhook. |

Webhook secrets are returned only at creation time and are stripped from later reads and exports.

## Deployment settings and model stages

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/settings` | Read deployment defaults, limits, and configured secret variable names. |
| `PUT` | `/api/settings` | Replace supported deployment settings. |
| `GET` | `/api/settings/models` | Read the resolved `eval`, `phase1`, and `phase2` stage views without secret values. |
| `PUT` | `/api/settings/models` | Save stage defaults. Key fields accept environment variable names only. |
| `POST` | `/api/settings/models/:stage/health` | Probe a saved or supplied model-stage patch. |

Stage values resolve in this order: project override, deployment setting, stage environment, legacy environment, built-in default. Secret values never come from the database.

## Judge queues

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/judge/queues` | Create a linked or standalone judge queue. |
| `POST` | `/api/judge/queues/:queueId/archives` | Submit archive run IDs with `{ "run_ids": [] }`. |
| `POST` | `/api/judge/queues/:queueId/flush` | Flush pending linked archives. |
| `POST` | `/api/judge/queues/:queueId/pause` | Pause with `{ kind?, reason? }`. |
| `POST` | `/api/judge/queues/:queueId/resume` | Resume, optionally restricted by `{ only_kind? }`. |
| `GET` | `/api/judge/queues/:queueId/status` | Read queue and job counts. |
| `GET` | `/api/judge/queues/:queueId/pending` | List pending jobs. |
| `GET` | `/api/projects/:id/judge-queue` | Return the project's judge queue view. |

## Phase 1 per run

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/judge/runs/:runId/phase1` | Start or resume Phase 1. Returns `202`. |
| `POST` | `/api/judge/runs/:runId/phase1/pause` | Pause the graph at its next committed node boundary and stop a live PI courtroom. Returns `paused: true`; `court_killed` says whether Node 4 had a process to stop. |
| `GET` | `/api/judge/runs/:runId/phase1` | Read running, paused, failed, not-started, or published status. |
| `GET` | `/api/judge/runs/:runId/results` | List immutable result versions for the run. |
| `GET` | `/api/judge/results/:resultId` | Read one result version. |

The project-scoped alias `POST /api/projects/:id/runs/:runId/phase1/pause` is also available for the run panel.

## Unified project pipeline

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects/:id/pipeline` | Create and link the project pipeline. Body `{ eval_queue_id, name?, auto_phase2? }`. |
| `GET` | `/api/projects/:id/pipeline` | Read the pipeline and current generation. Creates the default pipeline on first read when a queue exists. |
| `PATCH` | `/api/projects/:id/pipeline` | Update name, status, and automation flags. |
| `POST` | `/api/projects/:id/pipeline/generation` | Create a named generation from enabled queue items. |
| `GET` | `/api/projects/:id/pipeline/runs` | List project generations with eval and archive counts. |
| `PATCH` | `/api/projects/:id/pipeline/generation/:generationId` | Rename a generation with `{ "name": "..." }`. |
| `GET` | `/api/projects/:id/pipeline/generation/:generationId` | Read generation, item, and campaign rows. |
| `POST` | `/api/projects/:id/pipeline/generation/:generationId/advance` | Run one coordinator tick. Body `{ trigger: "auto" | "eval" | "phase1" | "phase2" | "finalize" }`. |
| `POST` | `/api/projects/:id/pipeline/generation/:generationId/retry-eval` | Retry one eval failure in place. Body `{ "item_id": "..." }`. |
| `POST` | `/api/projects/:id/pipeline/generation/:generationId/retry-phase1` | Re-arm Phase 1 failures after bounded automatic retries. |
| `GET` | `/api/projects/:id/pipeline/generation/:generationId/progress` | Read eval counts, Phase 1 node progress, and Phase 2 publication progress. |
| `GET` | `/api/projects/:id/pipeline/generation/:generationId/activity?limit=300` | Read the ordered human-facing activity feed. |

`retry-eval` requires a failed generation, an item with `errorKind: "eval"`, an idle linked eval queue, and no unrelated unclaimed work. It increments exactly one queue repeat and returns `202` after starting the fresh attempt.

## Phase 2 campaign

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/pipeline/campaign/:campaignId` | Read campaign records and PI board status. |
| `GET` | `/api/projects/:id/pipeline/campaign/:campaignId/status` | Read resumability, process state, filed artifacts, child sessions, and work directory metadata. |
| `POST` | `/api/projects/:id/pipeline/campaign/:campaignId/pause` | Pause the board and preserve its session. |
| `POST` | `/api/projects/:id/pipeline/campaign/:campaignId/resume` | Resume the same board session. Returns `202`. |
| `GET` | `/api/projects/:id/pipeline/campaign/:campaignId/pack` | Download `developer-improvement-pack.zip`. |

## Developer pack layout

```text
phase2/
  campaign.yaml
  executive-brief.yaml
  hypotheses.yaml
  patterns.yaml
  developer-pack.yaml
  experiment-plans.yaml
  manifest.json
phase1/<runId>/judge/
  evalJudge.yaml
  kratos-report.yaml
  logos-report.yaml
  minos-report.yaml
  case-summary.yaml
  round-log.yaml
  tangent-log.yaml
  developer-brief.yaml
  channel.md
  quality-report.json
```

`platform-report.yaml` stays outside the agent-facing pack. It contains harness-owned failures and work for the Themis operator.

## Pagination and filtering

Older execution lists use bounded `limit` and `offset`. New Phase 1 and Phase 2 repositories use opaque keyset cursors with `nextCursor` and `hasMore`. Treat cursors as opaque and pass them back unchanged.

Archive list filters include:

```text
project_id, agent_id, agent_commit, queue_id, batch_id, run_id,
task_id, task_name, model, provider, status, reward, limit, offset
```

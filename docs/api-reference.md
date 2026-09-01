# Agenteval API Reference

The HTTP API is the only application interface. Every endpoint is documented here as
implemented in the current codebase (`src/api/*`). Request bodies accept both
snake_case and camelCase keys where noted; snake_case is canonical in responses.

- Base URL: `http://<host>:<port>` (default `http://127.0.0.1:8080`).
- Errors: RFC-7807 problem objects `{ "type", "title", "status", "detail" }`.
- Auth (when enabled): `Authorization: Bearer <token>`. See [Auth & tokens](#auth--tokens).
- Async work returns `202 Accepted` with a resource id; poll the resource's GET for status.

---

## Health

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness/readiness. |
| GET | `/api/judge/health` | Judge (Themis) subsystem health. |

---

## Auth & tokens

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | `{ username, password }` → login session/token. |
| GET | `/api/auth/me` | Current authenticated principal. |
| GET | `/api/auth/users` | List users (admin). |
| POST | `/api/auth/users` | `{ username, password, role?, email? }` → create user. |
| DELETE | `/api/auth/users/:id` | Delete user. |
| GET | `/api/tokens` | List API tokens. |
| POST | `/api/tokens` | `{ user_id?, project_id?, label?, read_only? }` → mint token. Project-scoped tokens may only mint tokens for their own project. |
| DELETE | `/api/tokens/:tokenHash` | Revoke a token by its hash. |

---

## Projects

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects` | Create. Body: `{ name, slug?, description?, task_source?, default_agent_id?, default_model?, default_provider?, network_policy? }` |
| GET | `/api/projects` | List projects. |
| GET | `/api/projects/:id` | Get one project. |
| PATCH | `/api/projects/:id` | Update fields (`name`, `description`, `task_source`, `default_*`, …). |
| DELETE | `/api/projects/:id` | Archive/delete a project. |
| GET | `/api/projects/:id/members` | List project members. |
| PUT | `/api/projects/:id/members/:userId` | Add/update a member. |
| DELETE | `/api/projects/:id/members/:userId` | Remove a member. |

---

## Agent adapters

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/adapters` | Create an adapter. Body: `{ agent_id, name, generator, source_repo?, source_ref?, default_provider?, default_model?, install_type?, build? }` |
| GET | `/api/projects/:id/adapters` | List project adapters. |
| GET | `/api/projects/:id/adapters/:adapterId` | Get one adapter. |
| PATCH | `/api/projects/:id/adapters/:adapterId` | Update adapter fields. |
| DELETE | `/api/projects/:id/adapters/:adapterId` | Delete an adapter. |
| GET | `/api/adapters/store` | The shared adapter store (cross-project). |
| GET | `/api/adapters/generator-contract` | Adapter generator contract documentation. |
| POST | `/api/projects/:id/agent/resolve` | Resolve an agent ref to a commit. |
| GET | `/api/projects/:id/agent/refs` | List agent refs. |
| GET | `/api/projects/:id/agent/commits` | List agent commits. |

Adapter create supports both a declarative path and `build: true` (build the image after create).
See `docs/eval-authoring.md` and `plan/adapters.md` for the generator contract.

---

## Evals (canonical eval packages)

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/evals` | Create an eval from a canonical package (JSON upload, ≤70 MB). |
| POST | `/api/projects/:id/evals:import-archive` | Import an eval archive (`?format=zip|tar|tar.gz`, binary body ≤64 MB). |
| GET | `/api/projects/:id/evals` | List project evals. |
| GET | `/api/projects/:id/evals/:evalId` | Get one eval. |
| PATCH | `/api/projects/:id/evals/:evalId` | Update an eval. |
| DELETE | `/api/projects/:id/evals/:evalId` | Delete an eval. |
| GET | `/api/projects/:id/eval-categories` | Distinct eval categories with counts. |
| GET | `/api/evals` | List evals across projects (admin). |
| GET | `/api/evals/:evalId` | Get one eval globally. |

Creating an eval requires admin (it builds Dockerfiles via the rootful Podman backend).

---

## Queues & containers

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/queues` | Create an eval queue. Body: `{ name, agent_id?, model?, provider?, shared_adapter_id?, builtin_adapter_id?, agent_commit?, agent_ref?, sandbox?, network_policy?, ports?, adapter_overrides? }` |
| GET | `/api/projects/:id/queues` | List project queues. |
| GET | `/api/projects/:id/queues/:queueId` | Get one queue. |
| PATCH | `/api/projects/:id/queues/:queueId` | Update a queue. |
| DELETE | `/api/projects/:id/queues/:queueId` | Delete a queue. |
| POST | `/api/projects/:id/queues/:queueId/items` | Add an eval to a queue. Body: `{ eval_id?, repeats?, enabled?, position?, before?, after?, overrides? }` |
| GET | `/api/projects/:id/queues/:queueId/items` | List queue items. |
| GET | `/api/projects/:id/containers` | List live queue containers for the project. |
| GET | `/api/projects/:id/queues/:queueId/container` | Current live container for a queue. |
| PATCH | `/api/projects/:id/queues/:queueId/container` | Control the container. Body: `{ action: "pause"|"resume"|"abort" }`. |
| DELETE | `/api/projects/:id/queues/:queueId/container` | Stop and remove the container. |
| POST | `/api/projects/:id/queues/:queueId/container/exec` | Execute a shell command inside the live container (admin only). Body: `{ command, cwd?, … }` — streams framed stdout/stderr. |

Built-in adapter ids: `reapercode` | `pi`.

---

## Runs & events

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/runs` | List runs for a project. |
| GET | `/api/runs/:id` | Get one run. |
| GET | `/api/runs/:id/events` | Canonical run events (SSE/NDJSON). |
| GET | `/api/runs/:id/diff` | Agent-produced source diff for the run. |
| GET | `/api/evals/:runId/metrics` | Deterministic run metrics for the eval run. |
| GET | `/api/evals/:runId/archive` | Archive view for the eval run. |

---

## Archives

| Method | Path | Description |
|---|---|---|
| GET | `/api/archives` | List archived results (filters + keyset pagination). |
| GET | `/api/archives/:runId` | One run's archive. |
| GET | `/api/projects/:projectId/archives` | Project-scoped archive listing. |
| GET | `/api/archives/:projectId/:agentCommit` | Archives for a project at a commit. |
| GET | `/api/archives/:projectId/:agentCommit/:runId` | One archive by project+commit+run. |

Archive file streaming: `GET /api/archives/:runId/files/*` (and result-version-addressed
variant under `/api/judge-results/:resultVersionId/archive/files/*`) — see plan §10.

---

## Sandbox

| Method | Path | Description |
|---|---|---|
| GET | `/api/sandbox/presets` | Available sandbox presets. |
| GET | `/api/projects/:id/sandbox` | Project sandbox policy. |
| PUT | `/api/projects/:id/sandbox` | Set sandbox policy (full replace). |
| PATCH | `/api/projects/:id/sandbox` | Patch sandbox policy. |
| DELETE | `/api/projects/:id/sandbox` | Clear sandbox policy. |

Dangerous policies (privileged, mounts, devices, `SYS_ADMIN`, root user) require admin.

---

## Watchers

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/watchers` | Create a commit watcher. Body: `{ repo, trigger, ref?, semverFilter?, queueId, webhookSecret?, enabled? }` |
| GET | `/api/projects/:id/watchers` | List watchers. |
| PATCH | `/api/projects/:id/watchers/:ruleId` | Update a watcher. |
| DELETE | `/api/projects/:id/watchers/:ruleId` | Delete a watcher. |
| GET | `/api/projects/:id/watchers/:ruleId/events` | Watcher firing events. |

A watcher fires exactly one queue; its repo must equal the queue's source adapter repo.

---

## Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Read deployment settings. |
| PUT | `/api/settings` | Write deployment settings (full body). |

---

## Judge (Themis Phase 1)

Per-eval judgement: Nodes 0–4 (kratos/logos/minos PI courtroom), judge queues, leases, result versions.

### Judge queues

| Method | Path | Description |
|---|---|---|
| POST | `/api/judge/queues` | Create a judge queue. Body: `{ name, project_id, linked_eval_queue_id?, auto_judge? }` |
| POST | `/api/judge/queues/:queueId/archives` | Submit archive run ids onto the queue. Body: `{ run_ids: [] }` |
| POST | `/api/judge/queues/:queueId/flush` | Flush pending archives (auto-judge-off batch). |
| POST | `/api/judge/queues/:queueId/pause` | Pause. Body: `{ kind?, reason? }` (quota/rate-limit pauses do not consume retries). |
| POST | `/api/judge/queues/:queueId/resume` | Resume. Body: `{ only_kind? }` |
| GET | `/api/judge/queues/:queueId/status` | Queue status (job counts by state, pause kinds). |
| GET | `/api/judge/queues/:queueId/pending` | Pending jobs. |

### Phase 1 per run

| Method | Path | Description |
|---|---|---|
| POST | `/api/judge/runs/:runId/phase1` | Start **or resume** Phase 1 for a run (resumes the persisted PI session via `--continue`). Body: `{ work_dir?, track_id? }` → `202`. |
| GET | `/api/judge/runs/:runId/phase1` | Status: `200` with result version when published, `202` while running / not started. |
| POST | `/api/judge/runs/:runId/phase1/pause` | Pause the PI courtroom (SIGTERM/KILL; session jsonl kept for resume). |
| GET | `/api/judge/runs/:runId/results` | Result versions for a run. |
| GET | `/api/judge/results/:resultId` | One immutable result version. |

---

## Unified pipeline (eval → Phase 1 → Phase 2)

Each project has one durable pipeline queue. A **generation** snapshots eval membership and
configuration; the coordinator advances eval execution → Phase 1 → Phase 2.

### Pipeline queue & generation

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/pipeline` | Create/bind the project pipeline to an eval queue. Body: `{ eval_queue_id, name?, auto_phase2? }` |
| POST | `/api/projects/:id/pipeline/generation` | Create a generation from the linked eval queue's items. |
| GET | `/api/projects/:id/pipeline/generation/:generationId` | Generation state: `{ generation, items, campaign }`. |
| POST | `/api/projects/:id/pipeline/generation/:generationId/advance` | Advance one tick. Body: `{ trigger: "auto"|"eval"|"phase1"|"phase2"|"finalize" }`. Returns `{ generation, items, waitingFor }`. |

### Phase 2 campaign

| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/pipeline/campaign/:campaignId` | Campaign: `{ campaign, records, pi }` (pi = PI subagent status). |
| GET | `/api/projects/:id/pipeline/campaign/:campaignId/status` | PI status: `{ campaignId, workDir, resumable, running, filed, subagents, session }`. |
| POST | `/api/projects/:id/pipeline/campaign/:campaignId/pause` | Pause the Phase 2 PI courtroom. |
| POST | `/api/projects/:id/pipeline/campaign/:campaignId/resume` | Resume the Phase 2 PI session → `202`. |
| GET | `/api/projects/:id/pipeline/campaign/:campaignId/pack` | Download the `developer-improvement-pack.zip` (agent pack: `phase1/` + `phase2/` folders). |

### Phase 1 pause via pipeline

| Method | Path | Description |
|---|---|---|
| POST | `/api/projects/:id/runs/:runId/phase1/pause` | Pause the Phase 1 PI courtroom for a run. |

---

## Phase 2 developer pack layout

The pack zip (`GET .../campaign/:campaignId/pack`) contains:

```text
phase2/
  campaign.yaml            campaign identity + membership
  executive-brief.yaml     agent weaknesses + next action (agent-facing only)
  hypotheses.yaml          root-cause hypotheses + research notes
  patterns.yaml            agent-owned patterns (frequency, cohorts, evidence)
  developer-pack.yaml      prioritized implementation handoffs + experiment cards
  experiment-plans.yaml    developer-run control/treatment plans
  manifest.json            artifact hashes
phase1/<runId>/judge/      each member eval's complete Phase-1 court record
  evalJudge.yaml, kratos-report.yaml, logos-report.yaml, minos-report.yaml,
  case-summary.yaml, round-log.yaml, tangent-log.yaml, developer-brief.yaml,
  channel.md, quality-report.json
```

Platform defects are **not** in the agent pack; they are written separately as
`platform-report.yaml` (findings, harness-owned patterns, `nextPlatformAction`) and are
used to fix the platform itself.

---

## Conventions

- **Pagination**: list endpoints use keyset cursors (`cursor`, `limit`); responses return `next_cursor` / `has_more`. No unbounded counts.
- **Idempotency**: create/run endpoints honor `Idempotency-Key` where documented; queue/job dedupe is by immutable trigger identity.
- **Errors**: `400` bad request, `401`/`403` auth, `404` not found, `409` conflict, `202` accepted, `200` ok.
- **Auth scope**: project-scoped tokens can only act on their own project; container exec and eval create require admin.

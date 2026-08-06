# REST API — for other applications to consume

The entire platform is **API-first**: every feature the UI exposes, an external application can drive.
Programmatic clients create projects, CRUD eval tasks, start/pause/resume/abort runs, request
judgements, fetch verdicts + findings + reports, and stream live events — so a CI bot, dashboard, or
companion tool can run evals and consume results without the web UI.

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

### Eval queue — add / remove / reorder (per project)

A project has an **eval queue**: pending evals (ref + task set + repeats + params) awaiting a runner
slot, distinct from runs already executing. Adding to the queue schedules an eval without immediately
consuming a container; removing cancels it **before** it executes (no partial logs, unlike aborting a
running run). This is the right surface for CI bots that enqueue many evals and let the host throttle
them, and for "add this eval to the queue, I'll start the batch later."

```
POST   /api/projects/:id/queue                    add eval to queue — body: { ref|taskId|taskTags[],
                                                   agent, model, repeats, params, adapterOverrides?,
                                                   priority?, after? } → 202 + queue_entry id + position
GET    /api/projects/:id/queue                    peek the queue (ordered; filters by tag/ref/status)
PATCH  /api/projects/:id/queue/:entryId           reorder: { position?, priority?, before?, after? }
DELETE /api/projects/:id/queue/:entryId           remove from queue (cancel before it starts)
POST   /api/projects/:id/queue/drain              remove all queued entries (does not touch running runs)
POST   /api/projects/:id/queue/:entryId/promote   move an entry to next-in-line (start as soon as a slot frees)
```

Notes:

- **Add (`POST .../queue`)** is idempotent under `Idempotency-Key`; re-adding the same `(ref, taskSet)`
  within a de-dup window **collapses** onto the existing entry (configurable: `dedup=collapse|reject|allow`).
- A queued entry **promotes to a batch/runs automatically** when (a) a runner slot frees *and* (b) it's
  at the head and the project isn't soft-paused; or immediately via `promote`. The transition
  `queued → running` is recorded on the resulting `run_batches`/`runs`.
- **Remove (`DELETE`)** cancels only entries still `queued`; it **does not** abort running runs (use
  `/runs/:id/abort` for those). Returns the freed position so callers can reorder the remainder.
- The queue is the **backpressure + dedup surface**: burst pushes from a watcher collapse onto earlier
  queued entries for the same ref rather than spawning redundant batches (see watcher.md).
- Outbound webhooks fire `queue.entry_added`, `queue.entry_promoted`, `queue.entry_removed` so external
  schedulers can mirror the queue.

### Runs + batches — start / control
```
POST   /api/projects/:id/runs                     start evals: { taskId | taskTags[], agent, model,
                                                   repeats, params, adapterOverrides?, autoJudge? }
                                                   → 202 + batch id + run ids (enqueue N repeats)
POST   /api/projects/:id/runs/start               legacy alias / explicit "start evals for a task set"
GET    /api/runs                                   list (cross-project with filters; project-scoped via /projects/:id/runs)
GET    /api/runs/:id                               detail (status, control_state, usage, provenance)
GET    /api/runs/:id/events                        SSE / ndjson live+replay (since=<seq>)
GET    /api/runs/:id/diff                          diff.patch (hunk-numbered)
GET    /api/runs/:id/report?partial=1             partial results while running/aborted
```
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

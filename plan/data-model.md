# Data model

Metadata lives in SQLite. Canonical events, native traces, verifier output, diffs, and immutable archives
live on disk.

## Core SQLite entities

- `agents` — globally registered agent identities.
- `projects` — ownership boundary and default adapter/model/provider configuration.
- `project_agent_adapters` — declarative CLI adapters, sharing flags, source/build provenance.
- `tasks` — the eval store: projection of immutable canonical eval packages (project-owned).
- `eval_queues` — persistent named queue definitions.
- `eval_queue_items` — ordered eval references (`task_id` → `tasks.id`) and repeats. A queue is a
  list of pointers into the eval store, not a copy of eval content; a claimed run snapshots the
  eval at claim time (`runs.item_snapshot_json` + archive `eval.json`), so later eval edits/deletes
  never rewrite a sealed run.
- `queue_containers` — persistent runtime container provenance and state.
- `run_batches` — grouped runs for queue snapshots or commit evaluations.
- `runs` — one agent execution, status, tokens, commit/image provenance, paths.
- `eval_archives` — immutable archive manifest metadata per run.
- `eval_metrics` — exact and derived run metrics.
- `check_results` — deterministic checks keyed by run.
- `watcher_rules`, `watcher_events` — external trigger and durable pending-event state (FIFO).
- `api_tokens`, `users`, `settings` — API access and server settings.
- `adapter_builds` — commit-addressed reusable image build records (one per adapter + resolved commit).
- `outbound_subscriptions`, `webhook_deliveries` — signed `run.completed` delivery state (removed in v9).

There are no judge, judgement, score, finding, regression, improvement, or reusable-rubric tables in the
current schema. Migration version 9 drops legacy tables for removed capabilities and the legacy
`queue_entries` table (its still-queued rows are migrated into named `eval_queues` first).

Version 9 additions:
- `adapter_builds` keyed by adapter + full commit (status/image/image_id/agent_version/log/timestamps).
- `eval_queues.agent_commit` — resolved agent commit the queue builds/runs.
- `watcher_rules.queue_id` — owning queue; `watcher_events` durable `pending` state (`fifo_seq`,
  `processed_sha`, `queue_id`) for FIFO queue-generation launches.
- `eval_queue_items.claimed_repeats` + `deleted_at` — immutable claim floor and soft deletion.
- `run_batches.task_id` nullable (one generation batch owns many evals) plus immutable generation
  snapshot (`accepting`, `closed_revision`, `closed_at`, `agent_image_id`, `agent_version`, `build_id`).
- `queue_containers` generation snapshot (`image_id`, `agent_commit`, `agent_version`, `build_id`) and
  `closing|completed|tainted` container states.

## On-disk project layout

```text
<DATA_DIR>/
  agenteval.db
  projects/<projectId>/
    tasks/<taskId>/task.json
    runs/<runId>/
      run.json                  # includes evalContext.roles (role→archive path binding)
      eval.json                 # task snapshot at claim time
      adapter-evidence.json     # the adapter's role-typed evidence manifest snapshot
      events.jsonl
      diff.patch
      run-metrics.json
      evidence-integrity.json
      verifier.json
      retained/                 # adapter evidence copied verbatim from the workspace
    evals/<runId>/
      retained/                 # adapter evidence (unchanged)
      session/                  # trace/transcript/result hoisted by role
      verifier_res/             # verifier-result.json + verifier stdout/stderr
      diffs/                    # diff.patch, diff.hunks.json, outputs-manifest.json
      raw_std/                  # raw-stdout.log, raw-stderr.log
      model-calls/              # role "model_calls" (suite)
      tool-logs/                # role "tool_calls" (suite)
      tmp/                      # role "tmp" scratch capture
      eval_lifecycle_logs/      # run/eval/queue/exec/metrics/archive.json/README/…
      further-evidence/         # suite dig-more material
  archives/
    index.json                 # catalog of every sealed eval
    <runId>/
      manifest.json
      ...copy of sealed eval archive...
```

## Archive manifest identity

Each central archive manifest records:

- Project ID/name.
- Queue ID/name.
- Batch and run IDs.
- Task ID/name.
- Agent ID, source commit, image, and version.
- Model and provider.
- Terminal status and verifier reward.
- Seal and archive timestamps.

## Invariants

- A run archive is sealed only after terminal run metadata, deterministic metrics, integrity checks, and
  cleanup/reset evidence are finalized.
- Sealed manifests contain sorted file paths, sizes, and SHA-256 digests.
- The central archive copy is a flat `<runId>` directory. Project, agent commit, queue, and batch live in `archives/index.json` and are query filters, not folders.
- Protected solution/tests/validation content does not enter the agent container.
- Queue execution uses one persistent container per active queue and resets the workspace between evals.

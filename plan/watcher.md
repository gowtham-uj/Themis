# Repo Watcher — per-project triggers

A **watcher** is the first-class per-project component that turns "something changed in the repo we're
watching for this project" into **enqueued eval batches**. It closes the loop from a new agent version
to "did it regress?" without a human pressing Run. Every project may configure zero or more watchers
covering **the agent repo(s)** and/or **the workspace repo(s)** it evaluates.

> This is the trigger seam the rest of the plan assumes: the runner, judge, persistence, and findings
> machinery all sit *downstream* of "enqueue a batch." The watcher is what enqueues it.

## What a watcher watches

A project tracks repositories it cares about, distinguished by role:

- **`agent` repo** — the coding agent under evaluation (e.g. `gowtham-uj/ReaperCode`). A new version here
  means "re-evaluate the agent itself." Maps to an agent **Docker image tag + resolved commit**, recorded
  on each run as `agent_image` / `agent_commit`.
- **`workspace` repo** — the codebase the agent works on for a task (the task workspace source). A new
  version here means "the task got harder/easier; re-run against it." Maps to the task workspace commit.

A watcher rule binds a **role + repo + trigger** to an **action** (enqueue one or more eval batches,
optionally filtered to a subset of tasks). One repo may have multiple rules (e.g. "on tag → run full
suite" and "on PR → run smoke subset").

## Triggers

| trigger | fires when | resolution |
|---|---|---|
| `tag` | a new tag is pushed | tag → commit sha → (`agent`) image tag `agenteval/<agent>:<tag>` + resolved sha; (`workspace`) ref=tag |
| `commit` | a new commit lands on a watched branch | branch tip → resolved sha → (`agent`) image = `:latest`-or-pinned-but-record-`agent_commit`; (`workspace`) ref=sha |
| `pr` | a PR is opened/updated on a watched branch | PR head sha → `agent_commit`/workspace ref; optional `--baserev` for before/after |
| `schedule` | cron (e.g. nightly) regardless of activity | current branch tip |
| `manual` | operator clicks "Run now" in the UI / POSTs the API | current or specified ref |
| `webhook` | an inbound git-host hook (push/tag/PR) | parsed payload → above |

Manual and webhook can coexist; the API always supports an explicit trigger for programmatic use.

## Rule shape (stored per project)

```ts
interface WatcherRule {
  id: string;
  role: "agent" | "workspace";
  repo: string;                      // full url or "owner/name"
  trigger: "tag" | "commit" | "pr" | "schedule" | "manual" | "webhook";
  ref?: string;                      // branch ("main"), tag pattern ("v*"), or semver filter
  semverFilter?: string;             // ">=2.0.0 <3.0.0" — only matching tags fire
  action: {
    enqueue: "all" | "subset";       // which of the project's tasks
    taskTags?: string[];             // when "subset" (e.g. ["smoke"] on PR, ["regression"] on tag)
    repeats?: number;                // override N; default = project default
    adapterOverrides?: AdapterOverrides;  // pinned: imageTag (agent role), pinned workspace ref
    autoJudge?: boolean;             // default = project default
    judgeModel?: string;
  };
  enabled: boolean;
}
```

For an **agent-tag** rule, the resolved tag is written into `action.adapterOverrides.imageTag` so every
run in the resulting batch pins the agent image to that version — and `agent_image`/`agent_commit` land
on each `runs` row for provenance (see [data-model.md](data-model.md)).

## Flow: new tag → verdict

```
tag v2.3.0 pushed to agent repo
   │
   ▼
watcher (webhook ingress or poller) matches an `agent` + `tag` rule
   │   semverFilter? refuse non-matching.
   ▼
resolve: tag → commit sha (git ls-remote / host API)
   │   image = agenteval/reapercode:v2.3.0 (build if missing — see below)
   ▼
for each task in the rule's enqueue set (all | taskTags subset):
   enqueue run_batch { project_id, task_id, agent_id, model, provider, repeats,
                       params_json, adapterOverrides: { imageTag: "v2.3.0" } }
   │   create N runs (queued)
   ▼
Run/Judge pipeline (architecture.md, judge.md) with the agent pinned to v2.3.0
   │   → judgements + findings (fingerprinted, lifecycle-tracked)
   ▼
verdict + report + findings for every run of v2.3.0
   │
   ▼
optionally auto-open a release comparison vs the prior tag (see ui.md — Release compare view)
   └─ and/or POST a webhook to notify external apps (api.md)
```

## Image availability

The watcher resolves the version; the **runner** launches the container. Two policies (per `agent`);

- **prebuilt**: images are built/tagged by your CI and pushed to a registry; the runner pulls
  `agenteval/<agent>:<imageTag>`. Missing image → the run fails fast with a clear error (do not build
  on the eval host).
- **build-on-trigger** (optional, opt-in): the watcher itself builds the image from the resolved
  commit (`docker build`) before enqueuing — only for local/self-hosted agents like ReaperCode where you
  own the build. Off by default; the build runs out-of-band so it never blocks ingest.

Record which policy produced the image on the run (`agent_image_source: registry|built`).

## Provenance on the run (data-model.md columns)

Each run the watcher enqueues records, beyond what the runner already pinned:

- `agent_image` — e.g. `agenteval/reapercode:v2.3.0`
- `agent_commit` — resolved sha
- `trigger` — `tag`|`commit`|`pr`|`schedule`|`manual`|`webhook`
- `trigger_ref` — the tag/branch/pr that fired (e.g. `v2.3.0`)
- `trigger_rule_id` — which watcher rule (nullable for ad-hoc API/manual)

This is what makes **"compare v2.3.0 vs v2.2.0 across the whole suite"** a real query (see the Release
compare view in [ui.md](ui.md)): you group runs/judgements by `agent_commit`/`trigger_ref`, not by
batch, and roll deltas up across all tasks.

## Ingress & auth

- Git-host webhooks land at `POST /api/projects/:id/watcher/hooks/:ruleId` (api.md), validated by a
  per-rule shared secret (HMAC) — never reused across rules.
- Or poll: the watcher polls watched refs at a configurable interval (default off; webhook preferred).
- Polling/webhook failures are logged (`watcher_events`) and surfaced in the project's Watcher tab.

## Backpressure & dedup

- A rule firing twice for the same resolved ref is **idempotent and deduped**: a `(rule_id, ref, sha)`
  uniqueness check skips an already-enqueued batch (configurable: allow=force re-run).
- Global **concurrency cap** and the project's retention still bind the watcher — a flood of pushes
  won't overwhelm the host; the most recent pending batch can be configured to supersede older queued
  ones (collapsing) for fast-moving branches.

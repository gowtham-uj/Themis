# Execution & Sandbox

Every agent run and every judge run executes inside a **Docker container**. Rationale: agents run
arbitrary shell/code, and reproducibility requires a pinned environment.

## Why Docker-per-run (recap)

- **Safety**: arbitrary code shouldn't touch the host on a shared, few-users box.
- **Reproducibility**: pinned base image + pinned repo commit + recorded model/params → comparable
  runs, which is what makes "regressed vs progressed" meaningful.
- **Parallelism & cleanup**: isolated containers run concurrently and tear down cleanly.

## Container model

- **One container per run.** Start simple (cold start per run); optimize later with a warm pool or
  prebuilt images if startup latency matters.
- **Images**:
  - `agenteval/reapercode:<ver>` — Node 22 + ReaperCode built in.
  - `agenteval/pi:<ver>` — Node + `@earendil-works/pi-coding-agent`.
  - `agenteval/judge:<ver>` — pi + the report-generation skill mounted (see [judge.md](judge.md)).
  - Base tooling image with git, common language runtimes for workspaces (extend per task later).
- **Mounts**:
  - Run: the run's **workspace dir** → `/workspace` (read-write).
  - Judge: the run's log dir → `/logs` (**read-only**) + the report skill (read-only).
- **Hardening**: non-root user, `--cpus`, `--memory`, `--pids-limit`, `--read-only` root fs where
  feasible with a writable `/workspace` + `/tmp`, drop capabilities, no host mounts beyond the above.
- **Network**: default allow (agents install deps). Optional per-task allowlist / offline mode
  (`PI_OFFLINE`, npm cache) for stricter, more reproducible runs.
- **Secrets**: API keys injected as env at `docker run` (never baked into images, never written to
  `events.jsonl` — redaction pass on ingest).
- **Timeouts**: hard wall-clock per run; on expiry → SIGTERM then SIGKILL, `run.end.status:"timeout"`.

## Workspace sourcing + diff capture (category-aware)

```
source = "git":   git clone --depth 1 <repo>; git checkout <ref>;
                  record resolved sha → run.start.workspace.commit
source = "empty": mkdir /workspace && git init   (so a diff can be computed, for git categories)
```
The workspace is prepared **on the host** (or an init step) into a per-run directory, then mounted.
After the agent finishes, diff capture depends on the task's **agent category**
([categories.md](categories.md)):

- `coding` / `git` `data` categories → `git -C /workspace add -A && git diff --cached` →
  `projects/<pid>/runs/<id>/diff.patch`, written with **stable hunk numbers** (so judge/UI
  `refs{kind:"diff",hunk}` stay addressable). The diff is a first-class artifact shown in the UI,
  handed to the judge, and gates the `withSource` improvements lens.
- `outputs` categories (data pipelines that produce data, not code diffs) → capture a manifest of
  output artifacts + a content hash; findings/refs that need artifacts point at outputs, not hunks.
- `none` categories (research/browser/conversational) → **no `diff.patch`**. The run has no source
  artifacts; the judge omits the `withSource` improvements lens and grades purely from the trace + any
  deterministic checks. (For `git` sources we diff against the checked-out commit; for `empty`, against
  the empty init.)

```

## N repeats (variance)

- A trigger with `repeats = N` creates one **batch** and **N runs**, each an independent container
  with the **same** config but its own workspace copy.
- Runs may execute concurrently up to a **concurrency cap** (host-resource-bound; configurable).
- Judgements are produced per run; the batch view aggregates scores (mean ± spread) so noise doesn't
  masquerade as regression. See [data-model.md](data-model.md).

## Job execution

- MVP: an in-process worker pool in the Next.js server (or a small sidecar Node process) pulls
  `queued` runs, respecting the concurrency cap.
- If throughput/robustness demands it later: promote to a dedicated worker process reading a
  `jobs` table (SQLite) — no external broker needed at this scale.
- Each worker: prepare → launch → ingest events (append + SSE) → finalize (diff, status). Crash-safe:
  a run left `running` past a heartbeat window is reaped and marked `failed`.
- **Run control** (start/pause/resume/abort) — see below — is a first-class part of the lifecycle: you
  can start an eval batch, pause it mid-run, and resume later; results captured so far are always
  persisted and accessible.

## Run control — start · pause · resume · abort

Evals are long, expensive, and parallel; you must be able to **pause** a batch/run in the middle and
**resume** later, and **abort** cleanly while keeping whatever was captured. Crucially, **partial
results are stored continuously** (the event stream is append-only and flushed per event), so a
running, paused, or aborted run is *always* inspectable — you never lose the work-so-far.

Two pause modes (a run records `control_state`):

- **Soft pause** (`control_state: paused-soft`): the worker **stops dequeuing new runs** in the batch
  and lets *in-flight* runs finish, then the batch idles. Cheap, safe, no container freezer needed.
  Use for "I want to free capacity / not start more repeats right now, but don't disturb what's
  running."
- **Hard pause** (`control_state: paused-hard`): in-flight containers are **frozen at the cgroup
  level** (`docker pause` / cgroup `freezer`), suspending CPU. The agent's open model turns are
  *not* killed — they resume from where they were when unfrozen. The clock pauses too
  (`duration_ms` excludes paused intervals; `paused_at`/`resumed_at` recorded). Use for genuinely
  parking a long run.

Resume: `control_state: resuming` → `running`. Soft resume re-enqueues; hard resume `docker unpause`
/ thaws the cgroup and reconnects the event stream tail. A resumed run replays any buffered native
output the adapter held during the freeze and continues appending canonical events + SSE.

Abort: `control_state: aborting` → sends SIGTERM (graceful) then SIGKILL after a grace window →
marks `aborted`, **keeps the partial `events.jsonl` and any partial diff**, records `error` = "aborted
by operator". The partial diff is computed from whatever the workspace contains at abort time. Aborted
runs are judgeable (the judge grades the partial trajectory, with the abort reflected in attribution
and the `gave_up_early`/verification diagnostics read in context — the *operator* aborted, not the
agent, so attribution = environment/mixed, see judge-system-prompt.md §5).

### Partial results, always accessible

Because each canonical event is appended to `events.jsonl` and fanned to SSE *as it happens*, a run
in any state lets you:

- Open the Run detail page (or `GET .../runs/:id/events` SSE) at any moment and watch the trace so
  far — thinking, messages, tool calls, per-turn usage.
- Query the judgement/finding pipeline for any completed runs of a batch even while sibling runs are
  still queued/paused.
- Inspect a partial diff once the agent has made changes (the workspace is a git repo throughout).

### What is NOT resumable

- **Model turns mid-flight at the provider**: a hard pause freezes the container, but if a single model
  request was already in flight to the provider, that turn's result may be lost on thaw (provider
  timeout). The adapter treats a missing turn result as a recoverable error and re-issues the turn — at
  worst a small duplication flagged in the trace. This is inherent to pausing remote API consumers.
- **The judge**: pause/abort applies to **runs** and **batches**, not to in-flight judgements (judgements
  are fast and decoupled; if you must stop one, abort it and re-judge later over the same immutable
  logs).

### Control across batches

Start/pause/resume/abort operate at **task-batch granularity** (the N repeats for one task) and, via the
UI/API, can fan out to **all batches in a project** (e.g. "pause everything"). The watcher and manual
"start evals" both create batches that are immediately controllable.

## Determinism knobs (for meaningful comparisons)

- Pin **model id** and, where the provider supports it, **temperature/seed**; record all params in
  `run.json` and `run.start`.
- Pin **repo commit**; store resolved sha.
- Pin **image version**; record it on the run (`agent_image`/`agent_commit`, set by the watcher or
  manual start).
- Same task + same knobs across time → differences are attributable to the agent/model, which is the
  entire point of regression tracking.
- **Paused/resumed runs stay comparable** to uninterrupted ones: the recorded `duration_ms` excludes
  paused intervals, and the canonical trace is append-only, so a pause does not corrupt a run's
  provenance. (If a task is strictly wall-clock sensitive, mark it `no-hard-pause` and only soft
  control applies.)

## Resource guardrails

- Global max concurrent containers; per-container cpu/mem/pids limits; per-run disk quota on
  `/workspace`; per-run timeout. All configurable in Settings. Sensible defaults ship out of the box.

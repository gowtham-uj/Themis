# Execution & Sandbox

Every evaluated agent executes as a real CLI inside a queue-owned persistent **Podman container**.
Rationale: agents run arbitrary shell/code, and reproducibility requires a pinned source commit, image,
provider/model, and adapter contract.

## Queue-owned container model

- A project is bound to one CLI agent adapter and may define many queues.
- **One persistent container per active queue.** That container runs the queue's ordered evals one at a
  time. Different queues provide parallelism. No eval spins up its own container.
- The adapter's git source + Containerfile are built through the API with real Podman; build provenance
  records source commit and image id.
- `/workspace` is one host bind mount reused by that queue. It is reset between evals only after all
  evidence has been copied and the eval archive is sealed.
- The queue first runs the adapter's real provider/model connection check. A non-zero exit, timeout,
  fatal event, or absence of a model message stops the queue before setup.
- Each eval executes: workspace prep → setup + baseline → real CLI agent → live raw/canonical capture →
  native evidence extraction + checks → cleanup → cleanup verification → residual-process kill → root
  workspace reset → immutable content-hash archive.
- Cleanup, required-evidence, reset, or archive failure marks the queue tainted and preserves the live
  container for operator inspection; the next eval never starts in a contaminated workspace.
- Completed queue containers remain alive and count against the live-container cap until explicitly
  stopped. Introspection never implicitly spawns or restarts them.
- Queue launch applies pinned image, cpu/pid limits, network policy, ports, mounts, capabilities,
  devices, tmpfs, and other project sandbox controls through `ContainerRuntime`.
- API keys are injected only into the real agent command environment and are not baked into images.
  Redaction is intentionally deferred; traces and artifacts are currently stored verbatim.
- Agent exec sessions have hard timeouts and can be stopped without stopping the queue container.
- The privileged introspection endpoint executes `/bin/bash -lc` as root and streams exact stdout/stderr
  bytes in a channel-framed HTTP response.

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

- A queue item with `repeats = N` snapshots **N run rows** into one batch.
- Repeats execute sequentially in that queue's one persistent container. `/workspace` is rebuilt/reset
  for every run; native evidence is copied and the archive is sealed before reset.
- Parallelism comes from multiple active queues, each with its own container.
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

## Sandbox control + telemetry (live, from the project dashboard)

The sandbox is **observable and controllable live** from the project dashboard — every command it
executes and every network call it makes is captured into the run's log, and the operator can intervene
mid-run (not just after). This is the difference between "we ran the agent in a box" and "we know, to
the syscall, what it did, and can cut it off when it misbehaves."

### Live control (project dashboard → sandbox)

Exposed as run-control actions (same surface as pause/resume/abort, [api.md](api.md)):

- **Network cutoff** — toggle the sandbox's egress **off** mid-run. A running agent loses outbound
  network immediately (new connections refused at the container edge); in-flight connections are killed.
  Recorded as the moment of cutoff on the run timeline; connections attempted *after* are emitted as
  `net{blocked:true, blockedReason:"live-cutoff"}` events. Reversible (re-enable) without restarting the
  run. Distinct from the static per-task `network` policy (`allow`/`allowlist`/`offline`) — cutoff is a
  live override that supersedes the static policy for this run.
- **CPU/memory kill** — raise/lower the live `--cpus`/`--memory` limits; "stop the run" (abort) keeps
  partial logs. A runaway loop consuming all memory is observable (the `exec`/`usage` telemetry) and
  stoppable before it OOMs the host.
- **Pause/resume** (already specced) and **abort** — as in the run-control section below.
- **Live bash introspection** — execute a bounded command through `ContainerHandle.exec` in the exact
  already-running queue container. There is one agent container per active queue, so parallel project
  queues expose independently addressed containers by `queue_id`. The API never creates or restarts a
  container for introspection: a missing/stopped queue container returns 409. A command accepted during
  an eval is recorded as operator-originated evidence; drained containers remain inspectable until stopped.
- **eBPF-backed** where available (cgroup + `tc`/`nftables` for net, `cgroup freezer` for pause), so
  control is enforced by the kernel, not cooperatively by the agent.

### Telemetry: exec + net events as first-class run logs

The sandbox instruments two channels and emits them as canonical `exec` / `net` events
([event-schema.md](event-schema.md)) — persisted into `events.jsonl`, streamed over SSE, and judged.

- **Exec instrumentation** — every process the sandbox spawns (argv, cwd, uid, exit code, duration) is
  logged as an `exec` event. Captured via an **exec logger**: either an LD_PRELOAD shim / a shell
  wrapper that wraps `execve`, or eBPF `exec`/`tracepoint` probes where the host allows it. This is the
  ground truth of *what the agent actually ran* — independent of (and corroborating or contradicting)
  the agent's own `tool.call` claims. A `rm -rf` the agent didn't announce shows up here regardless.
- **Network instrumentation** — every outbound connection (host:port, proto, method/url for http, bytes,
  status, duration) is logged as a `net` event, captured at the container network edge: a transparent
  proxy (mitmproxy/tinyproxy) for http(s) flow + `nftables`/`conntrack` logging for raw TCP/UDP. Blocked
  connections (allowlist miss, live cutoff, offline mode) are emitted with `blocked:true` + reason.
- **Both are evidence** — the judge treats `exec`/`net` events as first-class artifacts: a finding can
  `refs` a specific `exec` event ("the agent ran `git push` to an external remote — exfil") or `net`
  event ("DNS resolution of an unknown host"). They feed the safety/verification axes (F, D) directly
  and the manipulation/destructive diagnostics.

### What the dashboard shows

Per-run, alongside the trace timeline: a **commands** lane (exec events, argv + exit) and a **network**
lane (net events, host + bytes + status), both deep-linkable from findings. A live **sandbox controls**
widget: network cutoff toggle, cpu/mem sliders/kill, pause/resume/abort — each applied to the running
container and reflected on the timeline when acted.

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

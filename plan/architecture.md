# Architecture

## Tech stack

- **Web app**: Next.js (App Router) + TypeScript + Tailwind. Server Components for pages, Route
  Handlers for the API, **SSE** (Server-Sent Events) for live log streaming to the browser.
- **Datastore**: SQLite (via `better-sqlite3` or Drizzle ORM) for metadata; raw JSONL logs + HTML
  reports + workspace diffs stored on disk under a data directory.
- **Run workers**: Node processes that own the Docker lifecycle for a run and ingest the agent's
  canonical event stream. Runs can be triggered in-process (small scale) or via a lightweight job
  queue table in SQLite (polling workers). Start in-process; graduate to a queue if needed.
- **Containers**: Docker Engine on the host. One container per run (agent) and per judgement (judge).
- **Auth**: single shared login / small user table (self-hosted, few users). No org model.
- **Multi-project**: every domain artifact is project-scoped. A **project** = one independently-evolving
  eval program (its own tasks/runs/judgements/findings/issues-log) plus its **own way of adding evals**
  via a pluggable **task source**. Adapters and judge prompt versions are **global** (shared), refined
  per project via overrides. See [projects.md](projects.md). (Multi-*project*, not multi-*tenant*.)

## Components

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Next.js app (UI + API)                                                    │
│                                                                            │
│  Pages: Projects · Tasks · Runs · Run detail (live) · Judgements (live) ·  │
│         Reports · Findings/Issues · Compare · Project settings · Settings   │
│                                                                            │
│  API:   /api/projects  /api/projects/:id/tasks  /api/projects/:id/runs    │
│         /api/runs/:id/events(SSE)  /api/judgements/:id/events(SSE)          │
│         /api/projects/:id/findings  /api/reports                            │
└───────────────┬───────────────────────────────┬───────────────────────────┘
                │ enqueue                        │ enqueue
        ┌───────▼────────┐               ┌───────▼─────────┐
        │  Run Worker    │               │  Judge Worker   │
        │  (per run)     │               │  (per judgement)│
        └───────┬────────┘               └───────┬─────────┘
                │ spawn                           │ spawn
        ┌───────▼────────────┐          ┌─────────▼───────────────┐
        │ Docker: agent      │          │ Docker: pi (judge)      │
        │  - workspace vol    │          │  - read-only logs vol   │
        │  - ReaperCode / pi  │          │  - report skill mounted │
        └───────┬────────────┘          └─────────┬───────────────┘
                │ canonical events (JSONL)         │ judge events + HTML report
        ┌───────▼─────────────────────────────────▼───────────────┐
        │ Data dir (disk):  projects/<pid>/runs/<id>/events.jsonl,  │
        │   diff.patch, judgements/<id>/judge.jsonl, report.html    │
        │ SQLite: projects, tasks, runs, judgements, scores,        │
        │         findings (all project-scoped; agents + judge      │
        │         prompt versions global)                           │
        └──────────────────────────────────────────────────────────┘
```

## Multi-project model (the project is the unit of eval ownership)

The platform partitions everything by **project**. A project owns its tasks, runs, judgements,
findings, and issues log as a self-contained, independently-backed-up unit, and — critically —
**chooses how new evals enter it** via a pluggable **task source** (`ui-builder`, `repo-md`,
`manifest-yaml`, `ci-artifact`, `http-push`). Different codebases therefore keep separate eval
histories and distinct task-authoring flows without code changes to the core. Adapters and judge
system-prompt versions are global and shared; per-project **adapter overrides** (default model, image,
env, tools, network) and **check-runner templates** (`cargo test` vs `npm test`) refine them per
codebase. See [projects.md](projects.md). This is multi-project, not multi-tenant: one deployment,
one user set, many projects.

## Adapter boundary (the "standard protocol")

Every agent is driven through an **Adapter** that:
1. **Prepares** the workspace (clone repo @ commit, or empty `git init`).
2. **Launches** the agent inside a container with the prompt + model/provider config.
3. **Emits** a stream of **canonical events** (see [event-schema.md](event-schema.md)) by mapping the
   agent's native output.
4. **Finalizes**: captures exit status + the git diff, writes `run.end`.

The rest of the system only ever sees canonical events — it is agent-agnostic. Adding a new agent =
writing one adapter. See [adapters.md](adapters.md).

## Run lifecycle

```
author task ──► trigger run(agent, model, repeats=N)
                     │
                     ├─ for each repeat k in 1..N:
                     │     create run row (queued)
                     │     Run Worker:
                     │        prepare workspace (clone@commit | git init empty)
                     │        docker run agent (adapter)
                     │        stream native output ─► map ─► canonical events
                     │            └─► append runs/<id>/events.jsonl  (immutable)
                     │            └─► push to SSE subscribers (live UI)
                     │        capture git diff ─► runs/<id>/diff.patch
                     │        run.end{status,durationMs} ; mark run complete
                     │
                     └─ (optionally) auto-enqueue a judgement per run
```

## Judge lifecycle (decoupled)

```
judgement(run_id, judge_prompt?, judge_model) ──► Judge Worker
   gather: task.prompt + task.rubric + run.events.jsonl + run.diff.patch
   docker run pi (judge) with:
       - global judge system prompt (tuned)
       - user judge prompt (from UI, optional)
       - report-generation skill mounted
       - logs mounted read-only
   stream pi's own events ─► judgements/<id>/judge.jsonl + SSE (live judge log)
   judge writes structured verdict (scores per rubric criterion) + report.html
   persist scores ─► SQLite (for trends) ; report.html ─► disk
```

Because judging only reads immutable run logs, you can re-judge the same run any number of times with
a different prompt or model — each is a new `judgement` row.

## Live streaming

- Agent run and judge run both emit JSONL. The worker **appends to disk** (durable) and **fans out**
  each event to any connected browsers over **SSE** (`/api/runs/:id/events`, `/api/judgements/:id/events`).
- On page load the UI replays `events.jsonl` from disk, then switches to the live SSE tail — so
  refreshing mid-run is seamless and completed runs render identically from disk.

## Security / sandboxing notes

- Agents execute arbitrary code → **always in a container**, non-root user, no host mounts except the
  run's workspace, resource limits (cpus, memory, pids), and a run **timeout**.
- Network: default allow (agents install deps); optionally restrict to an allowlist per task.
- API keys are injected into the container as env vars at launch and never written to logs
  (redaction pass on ingested events). See [execution.md](execution.md).

# Agent Eval Platform — Plan

A self-hosted web platform to run **autonomous agents** against a curated list of **eval tasks**,
capture rich execution traces (thinking, messages, tool calls, results, tokens), and have an
**LLM judge** grade each run against a per-task rubric and produce a polished **HTML report** —
so you can tell whether an agent has **regressed or progressed** over time.

> Working name: `agenteval` (codename TBD).
>
> **Current delivery scope:** backend workers and server APIs only. The frontend is deferred; no backend
> capability may depend on UI code, and the complete eval/queue/container/judge/report flow must be
> driveable and inspectable through APIs.

## Documents

| Doc | Contents |
|---|---|
| [architecture.md](architecture.md) | Components, tech stack, run lifecycle, multi-project model, diagrams |
| [projects.md](projects.md) | Per-project eval results stores + pluggable task sources (each project adds evals its own way) |
| [watcher.md](watcher.md) | Per-project repo watchers — trigger eval batches on new tags/commits/PRs/schedule/manual |
| [event-schema.md](event-schema.md) | The canonical event schema (the "standard protocol") + mappings |
| [adapters.md](adapters.md) | Agent adapter interface, pi adapter, ReaperCode adapter, per-project task sources |
| [agent-adapter-sdk.md](agent-adapter-sdk.md) | Detailed project-scoped CLI adapter format, CRUD API, provider/model connection checks, evidence extraction, registration, and real acceptance testing |
| [categories.md](categories.md) | Pre-defined agent categories (coding is one; also research, general, browser, data, conversational) |
| [api.md](api.md) | REST API — projects, tasks CRUD, run control, judgements/findings, release compare, webhooks |
| [reapercode-changes.md](reapercode-changes.md) | Exact changes you add to ReaperCode |
| [data-model.md](data-model.md) | SQLite schema (projects, runs, findings) + on-disk file layout |
| [execution.md](execution.md) | Docker sandbox, workspace sourcing, diff capture, N repeats |
| [judge.md](judge.md) | LLM judge (pi-based), three-layer feedback (scores + diagnostics + findings), live log, report skill, verdict schema |
| [judge-system-prompt.md](judge-system-prompt.md) | The versioned judge system prompt (v2), assembled from MT-Bench / G-Eval / Prometheus 2 / agentic judging + findings layer |
| [rubric.md](rubric.md) | Exhaustive anchored rubric, localized diagnostics, findings tier, anti-gaming |
| [ui.md](ui.md) | Pages, flows, live streaming, findings spine, issues log |
| [roadmap.md](roadmap.md) | Phased build plan (P1–P9; P1–P6 = MVP) — capture → sandbox+control → persistence/projects/UI → judge+findings+improvements → report → findings-durability → regression/release compare → automation/queue/public-API/webhooks → categories+hardening |

## Vision

A **general agent evaluation platform**: it evaluates any autonomous-agent run — coding agents,
research/analysis agents, browser/computer-use agents, data/ETL agents, conversational agents.
**Coding agents are one pre-defined category** ([categories.md](categories.md)); each category
presets the rubric axes, checks, and whether the run has source artifacts.

1. **Task list** — author eval tasks: prompt + workspace source (clone a git repo, or empty folder)
   + an `agentCategory` (coding/research/general/browser/data/conversational) + a per-task rubric.
2. **Run** — execute a chosen agent against a task inside an isolated Docker container, capturing a
   canonical event stream. A task can run **N times** to measure variance.
3. **Capture** — persist immutable, structured logs: thinking traces, assistant messages, tool
   calls + args + results, token/cost usage, final git diff, status, timing.
4. **Judge** — a decoupled, repeatable **LLM judge** (built on the pi agent, swappable
   provider/model) ingests the run's logs + the task rubric, grades it, streams its own reasoning
   to a live UI log, and generates a **polished HTML report**. Its verdict isn't just a score: it emits
   **findings** — located, prioritized, fixable issues (with a fix direction + repro) that are what a
   fixing engineer actually reads and acts on.
5. **Track** — a per-task **score trend** across runs + **side-by-side run diff** to spot
   regression vs progression, **annotated with finding deltas** ("what regressed, where") so a drop is
   a named, located defect, not just a lower number.
6. **Log** — a durable **per-project findings/issues log**: each finding is fingerprinted so recurrences
   aggregate across runs, model versions, and N repeats (k/N = real defect vs flakiness), giving you a
   living backlog of known agent defects and whether each version resolved or regressed them.

## Goals

- One **canonical event schema** every agent maps into via a thin **adapter** (our "standard protocol").
- **General agents, not just coding**: pre-defined agent categories (coding, research, general, browser,
  data, conversational) preset rubric axes, checks, and source-artifact presence — coding is one
  category, not the whole scope.
- **First-class trace capture**: thinking + tool calls + tokens are the point, not an afterthought.
- **Reproducible runs**: pinned repo commit, pinned model, recorded params.
- **Decoupled judging**: runs produce immutable logs; judging is a separate step you can re-run with
  a different judge prompt/model without re-running the agent.
- **Feedback worth reading & logging, not just numbering**: the judge emits **findings** — located,
  fixable, prioritized issues with structured pointers and repros — plus a two-lens **improvements**
  synthesis (what to change, split *without* source access from *with* source access), which the platform
  fingerprints into a durable issues log. Scores and diagnostics support these; they don't replace them.
- **Per-project results stores**: each project carries its own tasks/runs/judgements/findings and its
  own way of adding evals (custom task ingest + checks + adapter overrides), so different codebases
  keep independent eval histories and evolve independently.
- **Great UI/UX**: live streaming of both agent runs and judge reasoning; a findings spine; beautiful
  HTML reports.

## Non-goals (initial)

- Multi-tenant SaaS, billing, orgs. (Scope: **self-hosted, few users**, basic auth. Multi-*project*
  is in scope; multi-*tenant* is not — projects share one deployment, not per-tenant isolation.)
- Auto-training / RL loops. This measures agents; it does not improve them.
- Being an agent framework. We *drive* existing agents; we don't build one.

## Key decisions (locked)

| Decision | Choice |
|---|---|
| Deployment | Self-hosted, few users, basic auth |
| Scope | **General agent eval** — pre-defined categories (coding/research/general/browser/data/conversational); coding is one category |
| Organization | **Multi-project** (each project = its own eval results store + task-ingest method); not multi-tenant |
| Agent integration | **One project-bound real CLI agent**, configured by a CRUD-able adapter → canonical event schema |
| First agents | **ReaperCode** (your own) + **pi** |
| Isolation | **One persistent Podman container per active eval queue**; ordered evals share it with enforced cleanup/reset boundaries |
| Stack | **Node + TypeScript backend/API workers** now; Next.js/Tailwind frontend deferred |
| Datastore | **SQLite + files** (JSONL logs on disk) |
| Judge engine | **PI SDK agent** with the versioned custom judge system prompt + restricted custom evidence/submission tools; swappable real provider/model |
| Judge coupling | **Decoupled & repeatable** (re-judge immutable logs) |
| Success criteria | **Per-task rubric + tuned global judge system prompt** |
| Feedback surface | **Three-layer verdict**: scores (trends) + localized diagnostics (yes/no w/ location) + **findings** (located, fixable, fingerprinted issues → issues log) |
| Regression view | **Per-task score trend + two-run side-by-side diff**, annotated with finding-set deltas |
| Repeats | **N repeats per invocation**, scores aggregated (mean/spread) |
| ReaperCode | Add structured `thinking` event + live event stream (see reapercode-changes.md) |
| pi | No changes needed (`pi --mode json -p`) |

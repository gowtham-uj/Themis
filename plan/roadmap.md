# Roadmap — phased build plan

Build in **shippable phases**: each phase ends with something you can actually use, and depends only on
prior phases. The riskiest integration (adapters + trace capture) is proven **first**, on the cheapest
possible harness, before any polished UI is built on top of it.

A note on the API: the platform is **API-first per feature** — each phase's UI ships with a matching
REST surface incrementally. **Phase 8** is where the *public* API is formalized (tokens, streaming,
webhooks, versioning, idempotency) on top of endpoints that have existed since their feature phase.

## Marker: MVP

**Phases 1–6 are the MVP** — a self-hosted tool where you author a coding task, run an agent, get a
judged verdict with located findings + a two-lens improvements synthesis + an HTML report, and a
durable issues log. Phases 7–9 add automation, cross-version/release regression, multi-category
generality, and external-app integration.

---

## Phase 1 — Capture foundations (prove the protocol)

Prove the whole platform's value proposition — faithful trace capture — on a bare CLI before investing
in Docker or UI.

- Define the **canonical event schema** as TS types + a JSONL writer/reader ([event-schema.md](event-schema.md)).
- **pi adapter**: spawn `pi --mode json -p`, map → canonical, print canonical JSONL. No Docker, no UI.
- **ReaperCode adapter**: after the ReaperCode changes (`--stream-events`, structured `thinking`,
  `run_end` — [reapercode-changes.md](reapercode-changes.md)), map → canonical.
- CLI: `run <agent> --task "<prompt>" --workspace <dir>` → writes `events.jsonl` + `diff.patch`.
- ✅ Exit: both agents produce a faithful canonical stream (thinking + tools + usage) for a trivial
  task, verified by eye against the raw output.

**Why first:** every downstream capability — judging, findings, trends — is only as trustworthy as the
captured trace. If capture is lossy, nothing built on it is salvageable.

## Phase 2 — Sandbox + run control (safe, reproducible, controllable execution)

Move runs into isolation and make them controllable; establish that partial results are always captured.

- **Docker-per-run** ([execution.md](execution.md)): agent images, mounted workspace, injected keys,
  non-root, `--cpus/--memory/--pids-limit`, hard timeout, network policy.
- **Workspace sourcing** (git clone@commit / empty `git init`); **category-aware diff capture**
  ([categories.md](categories.md)) — git diff with **stable hunk numbers** for `coding`/`git`-`data`;
  `outputs` capture for data pipelines; **no diff** for `none` categories.
- **Redaction** pass on ingested events; crash reaping of stale `running` runs.
- **Run control**: `pause` (soft = stop dequeuing / hard = cgroup `freezer`/`docker pause`),
  `resume`, `abort` (graceful, **keeps partial logs**). Append-only `events.jsonl` means **partial
  results are always inspectable** in any state. New `control_state`/`paused_at`/`pause_count` columns.
- ✅ Exit: a task runs sandboxed end-to-end and yields immutable `events.jsonl` + `diff.patch`; you can
  pause mid-run, resume, abort, and inspect partial results throughout.

## Phase 3 — Persistence + multi-project + task authoring + minimal UI (runs visible)

Stand up the ownership model (projects) and the first readable surface (the run trace).

- **SQLite schema** ([data-model.md](data-model.md)): `projects`, `tasks` (+ `agent_category`,
  default `coding`), `run_batches`, `runs` (with agent provenance + control columns). Data-dir layout
  `projects/<pid>/...`.
- **Projects** ([projects.md](projects.md)): create a project, project switcher scopes all views,
  default agent/judge, `agent_category` per project.
- **Task CRUD + task sources**: full create/read/update/delete (edit bumps `rubric_version`; delete =
  archive). Ship `ui-builder` + `repo-md` sources first (the two most common "add an eval" flows).
- Next.js app: **Tasks** page (CRUD + rubric builder), **Run config** ("Start now" launches a batch),
  **Run detail** with trace timeline + diff, replaying from disk, **SSE live tail**.
- Run-control toolbar (Pause/Resume/Abort) wired to Phase 2's lifecycle; "results so far" banner.
- ✅ Exit: author/sync a task in a project, start a run, watch the trace stream live, review the diff,
  pause/resume/abort from the UI.

**Why projects here, not later:** the project is the scoping unit everything hangs off; retrofitting it
means re-scoping every table.

## Phase 4 — LLM judge + three-layer verdict + improvements synthesis + live judge log

The decoupled, repeatable judge — emitting not just a number but located findings and a fix-oriented
improvements synthesis.

- **Judge Worker** ([judge.md](judge.md)): pi-as-judge container, versioned global system prompt
  ([judge-system-prompt.md](judge-system-prompt.md)), rubric + logs + diff (read-only mount).
- **Three-layer verdict**: **scores** (anchored, weighted, feedback-then-score) + **localized
  diagnostics** (`{value, refs, note}`, not bare booleans) + **findings** (located, fixable, with
  structured `refs` + `fix`/`repro`).
- **Two-lens improvements synthesis** ([judge-system-prompt.md §10](judge-system-prompt.md)): a
  prioritized, de-duplicated "what to change" list split into `withoutSource` (pure trace/log analysis,
  always produced) and `withSource` (requires diff/source, **gated by the task's `agent_category`** —
  omitted for research/browser/conversational runs).
- `judgements`/`scores` in SQLite; **live judge log** over SSE (same trace renderer as runs). Re-judge
  with a different model/prompt.
- **Judgement detail**: verdict + severity-ordered **findings spine** (refs deep-link into the diff
  viewer / trace timeline / tool call) + positive/meta findings + **improvements panel** (two columns).
- ✅ Exit: run → judge → a structured verdict with scores, localized diagnostics, located findings, and
  a two-lens improvements synthesis — the judge's reasoning visible live.

**Why findings + improvements here, not scores-only:** this phase is where "feedback worth reading"
either lands or doesn't. Emitting findings + improvements from day one (even before they're durably
fingerprinted in Phase 6) keeps the judge's output shaped right.

## Phase 5 — HTML report + report skill

Turn the verdict into a polished, shareable artifact.

- Author the **report-generation skill** ([judge.md §report skill](judge.md)): design system (type
  scale, spacing, color tokens light+dark, accessible contrast) + dataviz rules; mount into the judge
  image.
- Judge emits self-contained `report.html`: leads with the **findings spine**, then the **improvements
  panel** (two-lens), then verdict + per-criterion breakdown (citing `findingIds`) + diagnostics +
  notable trajectory moments + positive findings + observations.
- **Report tab** (sandboxed iframe) + download.
- ✅ Exit: every judgement produces a polished, accessible, self-contained HTML report a fixing
  engineer can read top-to-bottom.

## Phase 6 — Findings persistence + issues log + recurrence (logged, durable feedback)

Make findings a living, cross-run artifact rather than per-judgement prose.

- `findings` + `finding_occurrences` tables ([data-model.md](data-model.md)); platform **fingerprints**
  each finding (`category` + canonicalized location-key) on ingest.
- **Issues log** (`/issues`, per project): fingerprint, first/last seen, `status`
  (open/resolved/regressed), occurrence count; recurrent defects aggregate instead of fading into a
  number.
- **k/N recurrence** per batch: a finding in 3/3 repeats is a real defect; 1/3 is flakiness.
- Findings deep-link via structured `refs` (hunk / seq range / tool-call id).
- ✅ Exit: a judgement's findings persist into a durable issues backlog; recurring defects are
  recognized across runs/versions/repeats — this is what makes feedback worth *logging*, not just
  reading. (Marks the end of the MVP.)

## Phase 7 — Regression views: N repeats + trend + compare + release compare

The read-model that answers "did it regress or progress, and where, and what changed" — at task and
release scope.

- **N repeats** batches; concurrency cap; batch view with mean ± spread (variance-aware so noise isn't
  read as regression).
- **Per-task score trend** over time, **annotated with finding deltas** (drops tagged with introduced/
  resolved findings); **two-run side-by-side** compare (per-criterion deltas + **finding-set diff**
  introduced/resolved/persisted, each deep-linking into both runs).
- **Release compare** ([ui.md §6c](ui.md)): compare two **agent versions** (tags) across **all tasks** —
  suite-level overall Δ, per-axis rollups, **finding-category deltas** (introduced/resolved/persisted
  counts across the suite), diagnostic-rate deltas, deterministic pass-rate deltas, per-task breakdown.
  Backed by grouping runs/judgements by `agent_commit`/`trigger_ref`.
- ✅ Exit: you can see, across time and across a release, whether an agent regressed or progressed —
  with noise accounted for and *what* changed named and located.

## Phase 8 — Automation: watcher + eval queue + public API formalization + webhooks

Let external systems and CI drive the platform end-to-end without the UI.

- **Per-project repo watcher** ([watcher.md](watcher.md)): triggers (`tag`/`commit`/`pr`/`schedule`/
  `manual`/`webhook`) on agent and/or workspace repos → enqueue eval batches; resolves image tag +
  commit, records `agent_image`/`agent_commit`/`trigger`/`trigger_ref`. Idempotent dedup, backpressure.
  New `watcher_rules`/`watcher_events` tables.
- **Eval queue** ([api.md](api.md)): add/remove/reorder/promote/drain pending evals (cancel-before-
  start, distinct from abort-of-running-run); dedup-collapsing for burst pushes. New `queue_entries`
  table (fractional-position indexing).
- **Public REST API formalization** ([api.md](api.md)): projects, watchers, **task CRUD**, **runs +
  start/pause/resume/abort**, judgements/findings, **release compare**, trends. API tokens (incl.
  read-only), SSE + ndjson streaming, **outbound webhooks** (`run.completed`, `judgement.completed`,
  `finding.introduced`/`resolved`/`regressed`, `release.compared`), idempotency keys, vendor media-type
  versioning.
- ✅ Exit: a new tag on a watched repo auto-evaluates across the project's tasks and notifies external
  apps; an external scheduler can queue, control, and consume results entirely via API.

**Why here, not earlier (with caveats):** the per-feature API endpoints have existed since Phase 3+; this
phase formalizes auth, streaming-for-external, webhooks, and the watcher/queue automation that *uses*
the now-complete pipeline (runs + judge + findings + regression views). The watcher is most valuable
once release-compare (Phase 7) exists to consume its output.

## Phase 9 — General-agent categories + remaining task sources + hardening

Generalize beyond coding (coding becomes one pre-defined category) and harden for real self-hosting.

- **Non-coding agent categories** ([categories.md](categories.md)): `research`, `general`, `browser`,
  `data`, `conversational` — profiles (applicable rubric axes via `applies_to` filtering + renormalization),
  category-aware diff gating (git/outputs/none), category-gated `withSource` improvements lens. Add at
  least one **non-coding adapter example (e.g. browser-automation)** in [adapters.md](adapters.md) to
  validate the canonical schema is genuinely category-agnostic (navigation/click/screenshot →
  `tool.call`/`tool.result`).
- **Remaining task sources**: `manifest-yaml`, `ci-artifact`, `http-push`; per-project **adapter
  overrides** + **check-runner templates** wired through; project export/archive.
- **Deterministic checks** folded into the verdict ([rubric.md §5](rubric.md)), run with the project's
  check-runner template (`cargo test` vs `npm test`); tracked as pass-rates.
- **Auth + Settings**: basic auth + users; global Settings (keys, limits, judge-prompt editor, default
  models); optional **judge panel/self-consistency** for borderline runs (aggregate findings by
  fingerprint intersection, tag judge-disagreement lower confidence).
- Optional: warm image pool (if cold starts hurt), dedicated `jobs`-table worker process (if
  in-process workers aren't enough), per-task network allowlist / offline mode.
- ✅ Exit: comfortably self-hostable for a few users across many projects and many agent categories,
  driven by UI, API, and automation.

---

## Sequencing rationale

- **Capture before anything (P1).** The platform's value depends entirely on faithful trace capture;
  prove it on a bare CLI before Docker (P2) or UI (P3).
- **Run control + partial-results with execution (P2).** Pause/resume/abort and "partial results always
  persisted" are execution-layer properties — bake them into the runner, not bolted on later; the UI
  buttons that expose them arrive in P3.
- **Projects at persistence time (P3).** The project is the ownership/scoping unit; retrofitting it
  means re-scoping every table, so it lands with the schema.
- **Findings + improvements emitted with the first judge (P4), persisted later (P6).** The judge emits
  findings + improvements from day one so its output is shaped right; making them durable
  (fingerprinting + issues log) is a separate, smaller phase after the report (P5) so the report can
  render them well.
- **Regression views after findings exist (P7).** Trend/compare/release-compare are read-models over
  runs + judgements + findings; they're cheap once those exist, and release-compare specifically needs
  agent provenance (which the watcher in P8 produces in volume — but manual runs can seed it in P7).
- **Automation after the pipeline is complete (P8).** The watcher/queue/webhooks are most valuable once
  the judge + findings + regression views the automation feeds exist.
- **Generality + hardening last (P9).** Multi-category support and production hardening are valuable but
  don't gate the MVP; the coding path (P1–P6) proves the whole design.

## What can overlap (to compress timeline)

- **P5 (report skill) ∥ P6 (findings persistence)** can run concurrently once P4 lands — different
  codebases (skill authoring vs. ingest/storage).
- **P8 (API formalization/webhooks) can start in parallel with P7** for the endpoint surfaces that
  don't depend on regression views.
- **P9 category work** (rubric filtering, a non-coding adapter stub) can begin spec/validation during
  P7–P8 since it mostly touches `categories.md`/`adapters.md`/`rubric.md`, not the core pipeline.

## Open items to revisit during build

- Warm-pool vs cold-start containers (only if latency hurts).
- In-process workers vs a dedicated SQLite `jobs` table (only if throughput/robustness demands).
- Judge variance reduction (panel) — turn on if borderline scoring proves noisy; aggregate findings by
  fingerprint intersection, tag judge-disagreement lower confidence.
- **Finding-fingerprint canonicalization robustness** (file renames, hunk re-counts under reformatting)
  — may need a fuzzy/AST-anchored location-key for code findings, not just `file+hunk`.
- Per-task network allowlist / offline mode for stricter reproducibility.
- Task-source sync semantics: how `repo-md`/`manifest-yaml` handle renames and deletions, and whether
  edits diverge from the in-UI copy or must round-trip through the source.
- Pause/resume of in-flight provider turns: confirm the adapter's "missing turn result on thaw →
  recoverable re-issue" behavior per provider, to bound worst-case duplication.

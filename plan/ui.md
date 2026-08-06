# UI / UX

Next.js + Tailwind. Priorities: **fast task authoring**, **live streaming** of both agent runs and
judge reasoning, **clear regression signal** across runs, and — above all — **actionable, located
findings** (the "what to fix, where, and how" layer) that make feedback worth reading and acting on
rather than just a score. Dark + light.

Everything is **project-scoped**: a top-level **project switcher** selects the active project; all
pages below are relative to it. Each project carries its own tasks/runs/judgements/findings/issues-log
and its own task-ingest method (see [projects.md](projects.md)).

## Pages

### 0. Projects (`/projects`)
- List of projects (name, slug, task source, task count, last run, latest mean score). Create/archive.
- Pick a project → enters its scoped views below. The switcher persists across navigation.

### 1. Tasks (`/tasks/:projectId` scoped)
- List of eval tasks (name, workspace source, tags, profile, latest score sparkline).
- **Task source banner**: shows the project's ingest method (e.g. `repo-md` synced from `acme/api@main`
  3 tasks · last sync 2h ago) with **Sync now**. `repo-md`/`manifest-yaml` tasks are read from their
  source and edited there; `ui-builder` tasks use the in-UI editor. Edits synced from a source bump
  `rubric_version` (new comparison baseline).
- **CRUD** — full create / read / update / delete (archive) per task. Create/edit drawer
  (`ui-builder`, or ad-hoc tasks alongside a source):
  - name, tags, **profile** (bugfix/feature/refactor/research/general → preset criteria weights)
  - **prompt** (multiline)
  - **workspace**: `git repo` (url + optional ref) OR `empty folder`
  - **rubric builder**: rows of `criterion` + `weight` + anchors (per-level 1.0/0.75/0.5/0.25/0.0) +
    `critical` flag + optional `axis`; **deterministic checks** rows (`test_suite`/`build`/`typecheck`/
    `lint`/`repro`/`secret_scan`/`command`/`file_exists`/`http`). Live-normalizes weights to 1.0.
  - optional **reference solution** (gold) + judge steer defaults.
  - Edit bumps `rubric_version` (a banner warns this starts a new comparison baseline); Delete = archive
    (history kept; never hard-deletes prior runs/judgements).
- Per-row actions: **Run** (opens run config), **Queue** (add to eval queue), Duplicate, Archive.
- Bulk: select multiple tasks → **Run set** / **Queue set**.

### 2. Run config + Eval queue (modal from a task / task-set)
- Pick **agent** (ReaperCode / pi), **model**, **provider**, params (reasoning effort, max tokens,
  timeout), **repeats N**, and "auto-judge on completion" toggle (+ default judge model).
- **Start mode**: **Start now** (enqueue N runs immediately subject to the concurrency cap) vs **Add to
  queue** (schedule without consuming a slot — ref/task-set/repeats recorded, promotes when a slot
  frees or on **Promote**). Distinct from pause: a queued entry has produced no logs yet; removing it
  cancels cleanly (vs abort keeps partial logs).
- Launch → creates a batch of N runs (or a queue entry), navigates to the batch/run (or queue) view.

### 2b. Eval queue (`/projects/:id/queue`)
- Ordered list of **pending** evals (ref/tag, target task or task-set, repeats, priority, position,
  source: watcher/api/manual/ci, dedup state). Drag to **reorder** (fractional position indexing) or set
  priority; **Promote** to next-in-line; **Remove** to cancel before it starts.
- Collapsing/dedup shown inline ("merged onto entry #3 — same ref+task-set"); **Drain** clears all
  queued (not running). Mirrors the API queue endpoints; live-updates over SSE-ish polling.

### 3. Runs (`/runs`)
- Table: task, agent, model, status, score (or mean±spread for a batch), tokens, cost, duration, time.
- Filters by task/agent/model/status. Click → run detail.

### 4. Run detail (`/runs/:id`) — live
- Header: task, agent/model/provider, status, **control_state** (running/paused-soft/paused-hard/
  resuming/aborting/aborted), resolved commit + `agent_image` ver, duration (excludes paused), token/
  cost totals.
- **Run control toolbar**: **Pause** (soft ▸ stop dequeuing / hard ▸ cgroup-freeze), **Resume**,
  **Abort** (graceful, keeps partial logs), with confirmation on hard-pause/abort. Disabled states
  match `control_state` (e.g. Resume only when paused). Partial trace + partial diff always viewable
  here regardless of state; **"results so far"** banner while running/paused/aborted.
- **Trace timeline** (the centerpiece): chronological canonical events rendered as:
  - **thinking** blocks (collapsible, dimmed) — reasoning traces
  - **assistant messages**
  - **tool calls** (name + pretty-printed args) paired with **results** (output, error state, duration)
  - inline **usage** ticks per turn
- **Diff tab**: `diff.patch` rendered with a proper diff viewer.
- **Raw tab**: raw JSONL / native output for debugging.
- Live: replay `events.jsonl` from disk on load, then tail via SSE. A running run streams token-by-token
  thinking/messages; completed runs render identically from disk.
- **Judge panel**: existing judgements for this run + "New judgement" (choose model, optional prompt).

### 5. Judgement detail (`/judgements/:id`) — live
- Left: **live judge log** — the judge's own thinking + tool calls (reading diff, grepping logs),
  same trace renderer as runs, streamed over SSE.
- Right: **verdict** — overall score + pass/partial/fail, per-criterion score bars with rationale and
  evidence quotes, observations.
- **Findings spine (top of verdict)** — the centerpiece for a fixing engineer: severity-ordered cards
  (`blocker`→`nit`), each showing the one-line `claim`, category chip, confidence badge, linked
  `criterion`, and a `fix` block (direction + repro command). Each finding's `refs` are **deep links**:
  a diff ref jumps to that hunk in the Diff tab; a trace ref selects that `seq` range in the trace
  timeline; a tool ref opens that call. Recurring findings show a "seen N× across runs (first …)" badge.
- **Positive findings** subsection — "what to preserve", same card shape, no severity.
- **Meta findings** subsection — rubric/task gaps routed to the task author (link to edit the task).
- **Improvements panel** (the end-of-judge synthesis): a TL;DR `summary` + two columns:
  - **Without source code** (behavioral) — recommendations from the pure trace/log analysis (process,
    tool use, verification, efficiency, honesty, context, recovery), each priority-ordered and linked
    to its findings + trace refs. Available for every agent category.
  - **With source code** — recommendations requiring diff/source reading (outcome, correctness, safety,
    code quality, design, tests), each linked to diff refs. **Shown only when the run has a diff/source
    (coding-class agents); hidden for research/browser/conversational agents with a note** — so a
    reader never mistakes a missing lens for "nothing to say."
- **Report** tab: the generated `report.html` (iframe, sandboxed). Download button.

### 6. Compare (`/tasks/:id/trend` + compare)
- **Score trend**: per-task timeline of overall score across batches/runs over time (line/points,
  mean±spread band for batches). Hover → run/judgement. This is the **regression signal** —
  **annotated with finding-set deltas**: a drop point is tagged with the findings introduced/resolved
  there ("verification_skipped introduced"), so a regression reads as *what* regressed, with links, not
  just a lower number.
- **Two-run side-by-side**: pick run A vs run B → compare scores per criterion (delta chart), diffs,
  key trace differences, tokens/cost, and a **findings-set diff** (introduced / resolved / persisted),
  each finding deep-linking into both runs. Answers "did it get better or worse — and exactly where,
  with what to fix?".
- **Findings recurrence (N repeats)**: for a batch, each finding shows k/N — a defect in 3/3 repeats is
  real, 1/3 is flakiness — so noise doesn't masquerade as regression.

### 6c. Release compare (`/projects/:id/compare/releases?from=v2.2.0&to=v2.3.0`)
- Compares **two agent versions** (tags/commits, resolved via `agent_commit`/`trigger_ref`) across
  **all tasks** in the project — the suite-level "did this release regress or progress?" answer that
  per-task compares don't give you. Backed by `GET /api/projects/:id/compare/releases`.
- **Suite-level overall**: mean Δoverall (± spread) across all tasks, with n tasks improved / n
  regressed / n flat, only counting tasks run in *both* releases (else flagged as "new/removed task").
- **Per-axis rollups**: Δ per axis (A–H) across the suite → "D Verification −0.2 suite-wide" localizes
  the regression to a capability, not a task.
- **Finding-category deltas (suite)**: introduced/resolved/persisted **counts per category** across all
  tasks — e.g. "verification_skipped: +4 introduced, test_gaming: −2 resolved" — each drillable to the
  per-task findings. This is the most quotable "what changed in this release" line.
- **Diagnostic rate deltas**: `verification_performed` true-rate 92%→70% at suite scale; per-flag rate.
- **Deterministic pass-rate deltas**: `test_suite` 88%→72% across the suite — least-deniable.
- **Per-task breakdown table**: each task's Δoverall, Δ per axis, finding diff (±n) — sort to find the
  worst-regressing task. Click → the two-run compare for that task.
- Watches semver: pick `from`/`to` from the project's watched tags; auto-suggest the prior release for
  a newly-fired watcher tag.

### 6b. Issues / Findings log (`/issues` and per-task)
- A durable backlog of finding fingerprints: category, latest severity, status (open/resolved/regressed),
  first/last seen, occurrence count, k/N recurrence. Filter by task / category / severity / status.
- This is the "logged stuff" layer: not tied to one run, but a living list of known defects an agent
  exhibits, their recurrence across versions, and whether a version **resolved** them (with the run
  that resolved it linked) or **regressed** into them again.
- Mirrors the `findings` + `finding_occurrences` tables in [data-model.md](data-model.md).

### 7. Project settings (`/projects/:id/settings`)
- **General**: name, slug, description, archive/export project (portable subtree + DB rows).
- **Task source**: pick the ingest kind + params (`ui-builder` / `repo-md` / `manifest-yaml` /
  `ci-artifact` / `http-push`); live "sync now"; show source health.
- **Defaults**: default agent + model + provider, default judge model, workspace base image.
- **Adapter overrides**: env vars (never shown in logs), allowed tools, **network policy**
  (allow / allowlist / offline), image tag.
- **Check runners**: command templates per check kind (`test_suite`, `build`, `typecheck`, `lint`,
  `repro`, …) — what makes `build` mean `cargo build` vs `npm run build` for this codebase.
- **Retention**: keep last N runs/judgements per task; older purged.

### 8. Settings (`/settings`) — global
- Provider API keys (stored server-side, injected into containers, never shown in logs).
- Judge system prompt (versioned editor).
- Resource limits (concurrency, cpu/mem, timeouts), default models.
- Users (basic auth).

## Cross-cutting UX

- **One trace renderer** reused for agent runs and judge logs (they share the canonical schema) —
  consistency + less code.
- **Streaming feel**: thinking/message deltas animate in; tool calls expand to show args/results.
- **Evidence links**: judge rationale quotes link back to the exact trace event / diff hunk. **Findings
  deep-link by structured `refs`** (diff hunk id / trace seq range / tool-call id) — the navigable
  spine that makes feedback worth reading fast, since every "what's wrong" jumps straight to "where".
- **Empty states** guide first task creation; **error states** surface `run.end` failure reasons.
- **Keyboard**: quick "run task", "new judgement", search palette.

## Streaming contract (frontend)

```
GET /api/runs/:id/events        -> SSE of canonical events (after an initial disk replay)
GET /api/judgements/:id/events  -> SSE of canonical events (judge)
```
Client keeps an ordered buffer keyed by `seq`; reconnect resumes from last `seq` (server replays tail
from `events.jsonl`).

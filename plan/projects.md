# Projects — per-project eval results stores

The platform is **multi-project**. A **project** is an independently-evolving eval program: it owns its
own tasks, runs, judgements, findings, and — crucially — **its own way of adding new evals**. Each
codebase/agent you track gets a project with its own results history and its own task source, so eval
definitions and findings never cross-contaminate between, say, "the API service" and "the CLI tool".

This is deliberately *multi-project, not multi-tenant*: one self-hosted deployment, one set of users,
many projects sharing infra. Projects partition the data and configure how evals enter; they do not
isolate tenants or carry auth.

## Why per-project

- **Different codebases evaluate differently.** A Rust service, a Python notebook pipeline, and an
  agent SDK each have distinct build/test commands, conventions, and "what a good run looks like."
  Forcing one task-authoring flow onto all of them is the friction that makes evals rot.
- **Independent histories.** A regression in project A must not be read against project B's baseline.
  Findings, trends, and the issues log are scoped per project.
- **Pluggable eval ingestion.** "Each project has its own way of adding new evals" = a per-project
  **task source**. Markdown specs in a repo, a YAML manifest, a CI artifact, an HTTP push, or the UI's
  rubric builder — each project picks its ingest method and can swap it without touching the core.

## What a project owns (scoping)

Every queryable artifact is **project-scoped**:

- `tasks`, `run_batches`, `runs`, `judgements`, `scores`, `findings`, `finding_occurrences`,
  `checks` — all carry `project_id`; all reads filter by it.
- On disk: `<DATA_DIR>/projects/<projectId>/...` (tasks/, runs/, judgements/) — one subtree per
  project, so a project is a portable, archivable, independently-backed-up unit.
- Agents (`agents` table) and the judge system-prompt versions are **global**, shared across projects
  (you register an adapter once; many projects can run it). A project may set **adapter overrides**
  (default model, base image tag, env, allowed tools) that refine the global agent for that codebase.

## Task sources — "each project adds evals its own way"

A **task source** is a pluggable ingest that turns a project's chosen representation into `tasks` rows
(+ rubric + checks). The core defines the interface; projects supply the impl.

```ts
interface TaskSource {
  kind: string;                       // "repo-md" | "manifest-yaml" | "ci-artifact" | "http-push" | "ui-builder"
  // Pull (polled / on-demand) or push; produces zero or more TaskSpecs.
  // A TaskSource may be (re)syncable: edit the source, sync, tasks update in place (rubric_version bumps).
  list(ctx: ProjectCtx): AsyncIterable<TaskSpec>;
  // Optional: validate a TaskSpec against the project's conventions before insert.
  validate?(spec: TaskSpec): ValidationResult;
}
interface TaskSpec {
  id?: string;                        // stable external id from the source (e.g. file path)
  name: string; prompt: string;
  workspace: WorkspaceSpec;           // git | empty (see adapters.md)
  rubric: Rubric;                     // criteria + weights + checks (rubric.md)
  tags?: string[];
  profile?: string;                   // bugfix|feature|refactor|research|general (rubric §6)
  referenceSolution?: string;
  checks?: Check[];                   // deterministic hooks (rubric §5)
}
```

Built-in sources (ship a few; projects can add more):

| kind | How evals are added | Good for |
|---|---|---|
| `ui-builder` | The rubric builder in the UI (default). Manual authoring. | getting started, one-off tasks |
| `repo-md` | Markdown files in the eval'd repo (`evals/*.md` with frontmatter: prompt, workspace, rubric, checks). Synced from the workspace commit. | keeping evals next to code; reviewable in PRs |
| `manifest-yaml` | A `agenteval.yaml` manifest enumerating tasks + a runner for checks. | curated suites, CI-driven sync |
| `ci-artifact` | A CI job emits a task manifest + pickled workspace tarball per eval. | reproducible, environment-pinned evals |
| `http-push` | External script/CI POSTs a `TaskSpec` (+ optional workspace tarball). | adding evals programmatically |

> A project picks **one** primary source (and may allow ad-hoc `ui-builder` tasks alongside). Changing
> the source is a project setting, not a code change — the core only speaks `TaskSource`.

### Project-specific checks & adapters

"Each project has its own way of adding evals" extends to **how runs are checked and launched**:

- **Checks** (`rubric.md §5`) are defined per task, but a project sets the **default check runner** — the
  command templates for `test_suite`/`build`/`typecheck`/`lint` (e.g. `cargo test`, `pytest`, `npm
  test`), and the image with those toolchains installed. This is what makes the same `build` check mean
  the right thing in a Rust vs TS project.
- **Adapter overrides**: a project may pin a default agent/model, set the base workspace image, inject
  project env vars (e.g. `REGISTRY`), and restrict the agent's tool/network allowlist — refining the
  global agent for that codebase without forking the adapter.

## Project settings

A project row carries: display name, slug, description, default **agentCategory**
([categories.md](categories.md) — coding/research/general/browser/data/conversational; tasks may
override), **task_source** config (kind + params), default agent+model+provider, default judge model,
workspace base image, check-runner command templates (mapped to the category's checks), network policy,
and retention (how many runs/judgements to keep; older purged). Per-project **watcher rules**
([watcher.md](watcher.md)) live under the project's Watcher tab: which repos (agent + workspace) to
watch, on what triggers (tag/commit/PR/schedule/manual/webhook), and what each enqueues. All editable
from the project settings page.

## Lifecycle

- **Create project** → choose task source → sync (pull tasks) or start with `ui-builder`.
- **Run** → pick a task (from the source) → agent/model/repeats → runs land in this project's store.
- **Judge** → judgements + findings land in this project's store; the issues log is per-project.
- **Sync** re-pulls the task source; task edits bump `rubric_version` (a new comparison baseline per
  [rubric.md §1.3](rubric.md)) so you don't silently compare across a changed rubric.
- **Archive** a project (read-only, retains history) or **export** it (portable subtree + DB rows).

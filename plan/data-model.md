# Data Model — SQLite + files

Metadata in **SQLite**; heavy/append-only artifacts (event streams, diffs, reports) on **disk**. This
keeps the DB small and fast, makes runs immutable, and lets the UI replay logs directly from files.

## On-disk layout

```
<DATA_DIR>/
  agenteval.db                      # SQLite
  projects/
    <projectId>/
      settings.json                 # task source config, defaults, check-runner templates
      tasks/
        <taskId>/
          task.json                 # denormalized snapshot (prompt, rubric, workspace)
      runs/
        <runId>/
          run.json                  # snapshot (agent, model, params, resolved commit)
          events.jsonl              # canonical event stream (immutable, append-only)
          diff.patch                # git diff produced after the run (hunk-numbered for refs)
          raw/                      # optional: raw agent stdout/stderr, native trajectory
      judgements/
        <judgementId>/
          judgement.json            # snapshot (judge model, prompt, rubric)
          judge.jsonl               # pi judge's own canonical event stream (live log)
          report.html               # generated report
          verdict.json              # structured verdict (scores, diagnostics, findings; mirrored into SQLite)
```

A project is a self-contained, portable subtree — back up, archive, or export it as a unit. See
[projects.md](projects.md).

## Findings on disk

Each judgement's `findings`/`positiveFindings`/`metaFindings` live inside `verdict.json` (one source
of truth), and the *actionable* findings are mirrored into the `findings` table (below) so they can be
queried, de-duplicated across runs/versions/repeats, and logged as a durable issues backlog. The diff
`diff.patch` is written with **stable hunk numbers** (one `index`/hunk per `@@` block) so
`refs{kind:"diff",hunk}` addresses survive reformatting.

## SQLite schema (Drizzle-style, illustrative)

```sql
-- Projects: each project = its own eval results store + task-ingest method.
-- All domain tables below are project-scoped (project_id FK). Agents + judge prompt versions are global.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  task_source_json TEXT NOT NULL,   -- {kind:"repo-md"|"manifest-yaml"|"ci-artifact"|"http-push"|"ui-builder", params}
  default_agent_id TEXT REFERENCES agents(id),
  default_model TEXT,
  default_provider TEXT,
  default_judge_model TEXT,
  workspace_image TEXT,            -- base image for this project's workspaces
  check_runners_json TEXT,         -- command templates per check kind: {test_suite:"cargo test", build:"cargo build", ...}
  adapter_overrides_json TEXT,     -- env, allowed tools, network policy, image tag per agent
  network_policy TEXT DEFAULT 'allow',  -- allow|allowlist|offline
  retention_runs INTEGER,          -- keep last N runs per task; null = unlimited
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Watcher rules + events: per-project triggers that enqueue eval batches on repo activity
-- (new tag/commit/PR/schedule/manual/webhook). See watcher.md.
CREATE TABLE watcher_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,               -- "agent" | "workspace"
  repo TEXT NOT NULL,               -- full url or "owner/name"
  trigger TEXT NOT NULL,            -- tag|commit|pr|schedule|manual|webhook
  ref TEXT,                         -- branch ("main"), tag pattern ("v*")
  semver_filter TEXT,                -- ">=2.0.0 <3.0.0"
  action_json TEXT NOT NULL,        -- {enqueue:all|subset, taskTags[], repeats, adapterOverrides, autoJudge, judgeModel}
  webhook_secret TEXT,              -- HMAC secret for inbound hooks (per-rule; never returned by API)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE watcher_events (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES watcher_rules(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  received_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  ref TEXT,                          -- tag/branch/pr
  resolved_sha TEXT,
  status TEXT NOT NULL,              -- matched|ignored(semver)|deduped|enqueued|failed|building
  batch_id TEXT REFERENCES run_batches(id),  -- the batch it enqueued (if any)
  error TEXT
);

-- Persistent queue definitions. A project may define many queues; one active queue owns one
-- long-lived container and consumes its referenced evals sequentially.
CREATE TABLE eval_queues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, description TEXT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL, provider TEXT NOT NULL,
  adapter_overrides_json TEXT, sandbox_json TEXT,
  network_policy TEXT NOT NULL DEFAULT 'allow', ports_json TEXT,
  judge_model TEXT, judge_provider TEXT, auto_judge INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|starting|running|paused|judging|completed|tainted|stopped|failed
  active_batch_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Ordered references into the project eval store. The same eval may appear in many queues.
CREATE TABLE eval_queue_items (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES eval_queues(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  position REAL NOT NULL, repeats INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1, overrides_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Historical `queue_entries` backlog rows remain in existing databases for audit. Migration converts
-- every unstarted row into an equivalent persistent queue; no new product flow writes that table.

-- Agents available (registered adapters) — GLOBAL, shared across projects
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  default_model TEXT,
  default_provider TEXT
);

-- Exactly one real CLI agent adapter may be configured per project. The definition is CRUD-able and
-- includes the connected git source/build recipe, provider/model wiring, command templates, parser,
-- and native evidence locations. Build metadata pins the exact source commit and OCI image id.
CREATE TABLE project_agent_adapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL, description TEXT,
  format_version INTEGER NOT NULL DEFAULT 1,
  image TEXT NOT NULL,
  command_json TEXT NOT NULL,
  connection_check_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  parser_kind TEXT NOT NULL, parser_config_json TEXT,
  provider_config_json TEXT,
  source_repo TEXT, source_ref TEXT, containerfile TEXT,
  build_status TEXT NOT NULL DEFAULT 'unbuilt',
  built_image_id TEXT, built_commit TEXT, build_log_path TEXT, last_built_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Task sources are pluggable per project (see projects.md). The core persists whatever TaskSpec they
-- yield; a source is a pull/push adapter, not a table row. Sync re-pulls; task edits bump
-- rubric_version (new comparison baseline).

-- Eval tasks (project-scoped)
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  external_id TEXT,                 -- stable id from the task source (e.g. file path); unique per project
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workspace_source TEXT NOT NULL,   -- "git" | "empty"
  workspace_repo TEXT,              -- when git
  workspace_ref TEXT,               -- branch/tag/sha requested
  rubric_json TEXT NOT NULL,        -- per-eval rubric (criteria, weights, checks, anchors, profile)
  version INTEGER NOT NULL DEFAULT 1, -- bumps on every eval-definition edit; queue snapshots pin it
  rubric_version INTEGER NOT NULL DEFAULT 1,  -- bumps on rubric edit → new comparison baseline
  agent_category TEXT NOT NULL DEFAULT 'coding',  -- coding|research|general|browser|data|conversational (categories.md)
  profile TEXT,                     -- bugfix|feature|refactor|research|general | browser | etl | conversational
  reference_solution TEXT,
  checks_json TEXT,                 -- deterministic hooks (rubric §5)
  env_json TEXT,                    -- setup/cleanup/cleanup-verification scripts and timeouts
  tags TEXT,                        -- csv/json
  source_kind TEXT,                 -- which task source created this
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, external_id)
);

-- A trigger of N repeats is a "batch"; each repeat is a run (project-scoped via task)
CREATE TABLE run_batches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),  -- denormalized for fast project filtering
  agent_id TEXT NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  params_json TEXT NOT NULL,        -- temperature, reasoningEffort, maxTokens, timeoutMs
  repeats INTEGER NOT NULL,
  trigger TEXT,                     -- tag|commit|pr|schedule|manual|webhook (null for ad-hoc)
  trigger_ref TEXT,                 -- the tag/branch/pr that fired (release-compare grouping)
  agent_image TEXT, agent_commit TEXT,   -- pinned for this whole batch
  queue_id TEXT REFERENCES eval_queues(id),
  queue_revision INTEGER,                -- immutable queue definition revision at spawn
  created_at TEXT NOT NULL
);

CREATE TABLE queue_containers (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES eval_queues(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  batch_id TEXT NOT NULL REFERENCES run_batches(id),
  runtime_container_id TEXT, image TEXT NOT NULL,
  state TEXT NOT NULL,                    -- starting|running|idle|paused|stopping|stopped|failed
  ports_json TEXT, workspace_dir TEXT NOT NULL,
  started_at TEXT, stopped_at TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES run_batches(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),  -- denormalized for fast project filtering
  queue_id TEXT REFERENCES eval_queues(id),
  queue_item_id TEXT REFERENCES eval_queue_items(id),
  queue_container_id TEXT REFERENCES queue_containers(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,    -- k of N
  eval_version INTEGER,             -- exact eval-store version used
  eval_snapshot_json TEXT,          -- full immutable eval definition used by this run
  status TEXT NOT NULL,             -- queued|running|paused|resuming|completed|failed|aborted|timeout
  workspace_commit TEXT,            -- resolved workspace sha (reproducibility)
  -- agent provenance (set by the watcher; see watcher.md)
  agent_image TEXT,                 -- e.g. agenteval/reapercode:v2.3.0
  agent_commit TEXT,                -- resolved agent repo sha
  agent_image_source TEXT,          -- registry|built
  trigger TEXT,                     -- tag|commit|pr|schedule|manual|webhook (null for ad-hoc)
  trigger_ref TEXT,                 -- the tag/branch/pr that fired (e.g. "v2.3.0")
  trigger_rule_id TEXT REFERENCES watcher_rules(id),
  -- run control lifecycle (see execution.md)
  control_state TEXT,               -- running|paused-soft|paused-hard|resuming|aborting|aborted|done
  paused_at TEXT, resumed_at TEXT, pause_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, ended_at TEXT,
  duration_ms INTEGER,              -- excludes paused intervals
  -- rolled-up usage for quick lists
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  total_cost REAL,
  events_path TEXT, diff_path TEXT, -- disk pointers
  error TEXT
);

-- Sealed evidence bundle produced before the shared queue workspace is reused.
CREATE TABLE eval_archives (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  queue_id TEXT REFERENCES eval_queues(id),
  batch_id TEXT NOT NULL REFERENCES run_batches(id),
  manifest_path TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, sealed_at TEXT NOT NULL
);

-- One append-only revision per queue-judge invocation (all evals or a selected subset).
CREATE TABLE queue_analyses (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES eval_queues(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  batch_id TEXT NOT NULL REFERENCES run_batches(id),
  selected_run_ids_json TEXT NOT NULL, evidence_hashes_json TEXT NOT NULL,
  judge_model TEXT NOT NULL, judge_provider TEXT NOT NULL,
  judge_params_json TEXT, judge_prompt TEXT, system_prompt_version TEXT NOT NULL,
  parent_analysis_id TEXT, status TEXT NOT NULL,
  verdict_path TEXT, report_path TEXT, events_path TEXT, raw_response_path TEXT,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, error TEXT
);

-- Judging is decoupled and repeatable: many judgements per run (project-scoped via run)
CREATE TABLE judgements (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),  -- denormalized for fast project filtering
  queue_analysis_id TEXT REFERENCES queue_analyses(id), -- common single-agent queue judgement revision
  judge_model TEXT NOT NULL,
  judge_provider TEXT NOT NULL,
  judge_prompt TEXT,                -- ad-hoc prompt from UI (optional)
  system_prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,             -- queued|running|completed|failed
  overall_score REAL,              -- normalized 0..100 (or 0..1)
  verdict TEXT,                     -- pass|fail|partial (derived)
  report_path TEXT, events_path TEXT, verdict_path TEXT,
  created_at TEXT, ended_at TEXT
);

-- Per-criterion scores (for trend charts + drill-down)
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  judgement_id TEXT NOT NULL REFERENCES judgements(id),
  criterion TEXT NOT NULL,          -- from the task rubric
  weight REAL NOT NULL,
  score REAL NOT NULL,              -- 0..1
  rationale TEXT
);

-- Findings: located, fixable issues — the durable, logged feedback layer.
-- A "finding instance" is what the judge emitted in one judgement; a "finding" (by fingerprint) is the
-- recurring defect across runs/versions/repeats. This table holds the de-duplicated fingerprint row;
-- finding_occurrences holds each per-judgement instance.
CREATE TABLE findings (
  fingerprint TEXT PRIMARY KEY,     -- stable: category + canonical(location-key) ; see canonicalization below
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),  -- denormalized for fast project filtering
  category TEXT NOT NULL,          -- controlled vocab (test_gaming, root_cause_missed, ...)
  kind TEXT NOT NULL,              -- "defect" | "positive" | "meta"  (from findings/positiveFindings/metaFindings)
  claim TEXT NOT NULL,             -- latest claim text
  latest_severity TEXT,            -- blocker|major|minor|nit (latest instance)
  latest_confidence REAL,
  first_seen_judgement TEXT REFERENCES judgements(id),
  last_seen_judgement TEXT REFERENCES judgements(id),
  first_seen_at TEXT, last_seen_at TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT,                 -- set when an occurrence shows status "resolved"; cleared if it recurs
  status TEXT NOT NULL DEFAULT 'open'  -- open|resolved|regressed|wontfix
);

-- One row per finding instance emitted by a judgement (the raw, located evidence).
CREATE TABLE finding_occurrences (
  id TEXT PRIMARY KEY,
  finding_fingerprint TEXT NOT NULL REFERENCES findings(fingerprint),
  judgement_id TEXT NOT NULL REFERENCES judgements(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  severity TEXT NOT NULL,           -- blocker|major|minor|nit
  confidence REAL NOT NULL,
  claim TEXT NOT NULL,
  criterion TEXT,                    -- rubric criterion it bears on
  refs_json TEXT NOT NULL,           -- [{kind:"diff"|"trace"|"tool", ...}] structured, addressable
  fix_json TEXT,                     -- {direction, repro} optional
  status TEXT NOT NULL DEFAULT 'introduced',  -- introduced|persisted|resolved (vs prior judgement on same task)
  created_at TEXT NOT NULL
);
CREATE INDEX idx_findings_task ON findings(task_id);
CREATE INDEX idx_occurrences_run ON finding_occurrences(run_id);
CREATE INDEX idx_occurrences_judgement ON finding_occurrences(judgement_id);

-- Fingerprint canonicalization (computed by the platform on ingest, not by the judge):
--   fingerprint = sha256(taskId + ":" + category + ":" + canonical_location)  -- TASK-SCOPED
--   (taskId baked into the material so the global PK fingerprint cannot collide across tasks;
--    the formula in the original sketch omitted taskId, which silently dropped findings — see
--    src/db/findings.ts fingerprintOf + tests/findings.test.ts "cross-task ... no silent drop".
--    This preserves the intent: "same defect recurring across runs OF THE SAME TASK => one row".)
--   canonical_location precedence:
--     diff ref  = file + hunk  (strip leading "./", normalize "/" separators)
--     tool ref  = "tool:" + toolCallId  (when no diff ref)
--     trace ref = IGNORED for the key (run-relative; not stable across runs) -> fall through
--     fallback  = "claim:" + normalizeClaim(claim)  (lowercase, whitespace-collapsed, trailing .;: + space stripped)
--   (tool ref uses toolCallId, not toolName+args as the sketch suggested — toolCallId is the
--    stable in-verdict identifier; documented deviation of the sketch, faithful to the P6a contract.)
-- Same defect recurring at the same file+hunk under the same category for the same task => same fingerprint across runs.

-- Optional deterministic checks folded into the rubric (project-scoped via run)
CREATE TABLE checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),  -- denormalized for fast project filtering
  name TEXT NOT NULL,               -- "tests pass" | "builds" | "file exists"
  kind TEXT NOT NULL,               -- command|file|http
  passed INTEGER, detail TEXT
);

CREATE TABLE users ( id TEXT PRIMARY KEY, email TEXT UNIQUE, pw_hash TEXT, role TEXT );
```

## Key relationships

- **project → (tasks, runs, judgements, findings, checks)**. Every domain row is project-scoped; all
  reads filter by `project_id`. Agents + judge system-prompt versions are **global** (shared), with
  per-project adapter overrides. Tasks enter a project via its pluggable **task source**
  ([projects.md](projects.md)).
- **task → run_batch → run** (N repeats). A batch is one "run this task N times with agent X @ model Y".
- **run → judgement → scores**. Multiple judgements per run (re-judging). `overall_score` is the
  weighted roll-up of `scores` for that judgement.
- **judgement → finding_occurrences → findings**. Each judgement emits finding *instances*; the
  platform fingerprints them into the de-duplicated `findings` row (per task). A finding that recurs
  across runs/versions increments `occurrence_count` and updates `last_seen`; one that vanishes after
  appearing is marked `resolved` (and re-`regressed` if it returns). This is the durable issues log.
- **Trend** for a task = latest (or selected) judgement's `overall_score` per batch over time,
  **annotated** with finding-set deltas (introduced/resolved/persisted) so a drop reads as "X recurred."

## Aggregation for variance (N repeats)

For a batch, the UI shows mean and spread of `overall_score` across its runs' judgements
(e.g. `mean ± stdev`, min/max), so a single unlucky run doesn't read as a regression. Stored as a
view/query, not a table:

```sql
-- mean & count per batch (spread computed in app or via extension)
SELECT b.id, AVG(j.overall_score) AS mean_score, COUNT(*) AS n
FROM run_batches b JOIN runs r ON r.batch_id=b.id
JOIN judgements j ON j.run_id=r.id AND j.status='completed'
GROUP BY b.id;
```

## Findings: recurrence & regression queries

```sql
-- Across the N repeats of a batch, how often did each finding recur?
-- (k/N tells real defect vs flakiness; sharper than the diagnostic boolean averaged.)
SELECT f.fingerprint, f.category, f.latest_severity,
       COUNT(DISTINCT o.run_id) AS repeats_hit,
       (SELECT COUNT(*) FROM runs WHERE batch_id = :batchId) AS repeats_total
FROM findings f
JOIN finding_occurrences o ON o.finding_fingerprint = f.fingerprint
JOIN judgements j ON j.id = o.judgement_id
JOIN runs r ON r.id = o.run_id
WHERE r.batch_id = :batchId
GROUP BY f.fingerprint;

-- Finding-set diff between two judgements on the same task (what changed): introduced/resolved/persisted.
WITH a AS (SELECT finding_fingerprint FROM finding_occurrences WHERE judgement_id = :judgementA),
     b AS (SELECT finding_fingerprint FROM finding_occurrences WHERE judgement_id = :judgementB)
SELECT 'introduced' AS change, fingerprint FROM (SELECT finding_fingerprint AS fingerprint FROM b EXCEPT SELECT finding_fingerprint FROM a)
UNION ALL
SELECT 'resolved',   fingerprint FROM (SELECT finding_fingerprint AS fingerprint FROM a EXCEPT SELECT finding_fingerprint FROM b)
UNION ALL
SELECT 'persisted',  fingerprint FROM (SELECT finding_fingerprint FROM a INTERSECT SELECT finding_fingerprint FROM b);
```

These power the trend annotations and the comparison view's findings-set diff.

## Immutability & re-judging

- `runs/*/events.jsonl` and `diff.patch` are **write-once**. Re-running a task creates new runs; it
  never mutates old ones.
- Re-judging creates a **new** `judgements` row against the same immutable run — so you can compare
  judge prompts/models over identical evidence.

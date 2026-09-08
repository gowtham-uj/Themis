# Themis system design

Themis runs coding-agent evaluations, preserves the evidence from each run, judges each run, and then looks across a campaign for recurring agent weaknesses. The deterministic verifier still owns the official reward. The judge explains the process and turns repeated failures into concrete work for the agent developer.

This document describes the system that exists in this repository. The files under [`plan/`](../plan/) hold the detailed contracts and the remaining scale work.

## The complete flow

```text
project
  -> agent adapter and pinned source commit
  -> canonical eval packages
  -> one persistent queue container
  -> sequential agent runs
  -> hidden deterministic verification
  -> immutable base archive per run
  -> Phase 1 judgement per archive
  -> immutable judge archive view
  -> Phase 2 campaign over all Phase 1 results
  -> developer improvement pack and platform report
  -> final archive views with phase2/ attached
```

A project has one durable pipeline queue. Starting a run creates a pipeline generation. That generation records the selected evals and advances them through execution, Phase 1, Phase 2, and final archive publication. A retry stays inside that generation unless the operator explicitly starts a new one.

## The execution platform

### Projects and adapters

A project represents one agent under evaluation. It owns:

- a versioned adapter that knows how to launch and parse the agent
- canonical eval packages
- one eval queue blueprint
- model settings for the evaluated agent, Phase 1, and Phase 2
- pipeline runs and their archives

Source-built adapters pin an exact commit before a queue generation starts. The platform builds or reuses the image for that commit and records the build identity on every run.

### Canonical eval packages

Each eval package separates public task material from protected grading material.

```text
instruction.md        agent prompt
task.toml             limits and runtime contract
seed_repo/            initial agent workspace
environment/          setup, cleanup, health check
solution/             protected reference solution
tests/                protected verifier
validation/           protected oracle and known-bad cases
```

The agent container receives the instruction and seeded workspace. It never receives `solution/`, `tests/`, `validation/`, or verifier internals. The verifier runs separately after the agent stops.

### One persistent queue container

An active eval queue owns one real Podman container. The selected adapter and the platform's fat base image are prepared once. Evals then run sequentially inside that container.

For each eval, the worker:

1. restores a clean workspace;
2. runs the trusted setup script;
3. launches the real agent with the configured model connection;
4. records canonical events and native evidence;
5. captures the final diff and generated files;
6. runs the hidden verifier outside the agent container;
7. runs cleanup and checks the reset;
8. derives deterministic metrics;
9. seals the run archive.

A failed setup, agent process, verifier, cleanup, reset, or archive step gets its own error classification. The worker does not collapse those failures into a generic internal error.

## Archives are the evidence boundary

Every agent run gets one immutable base archive. It contains run metadata, the canonical trace, adapter-native evidence, verifier output, metrics, lifecycle logs, and retained workspace artifacts.

Phase 1 and Phase 2 do not modify the base files. Each phase publishes a new archive view that is a strict superset of the previous evidence:

```text
base view
  retained/
  verifier_res/
  eval_lifecycle_logs/
  ...

Phase 1 view
  all base paths, byte-for-byte unchanged
  judge/

final view
  all Phase 1 paths, unchanged
  phase2/
```

The archive browser shows the current view and lets the operator inspect or download individual files. Historical result versions remain addressable.

## The unified pipeline

A pipeline generation uses these major states:

| State | Meaning |
|---|---|
| `eval_running` | The queue is claiming or running selected evals. |
| `phase1_running` | At least one sealed archive is moving through the per-eval judge. |
| `phase2_ready` | Every selected eval has a published Phase 1 result. |
| `phase2_running` | The cross-eval campaign is analyzing the frozen membership. |
| `finalizing` | The coordinator is attaching Phase 2 artifacts to member archives. |
| `completed` | Every selected archive has its final view. |
| `failed` | A typed terminal failure needs operator action. |
| `paused` | New work is held while persisted sessions and artifacts stay intact. |

Each eval item has its own finer state, from `eval_pending` through `final_view_published`. One failed item does not erase the nine items that already finished. The operator can retry an eval-stage failure in the same generation. That retry creates a fresh immutable agent run while keeping the old failed run for diagnosis.

## Phase 1, one eval under a microscope

Phase 1 reads one sealed archive and writes `judge/evalJudge.yaml` plus the complete court record. Five nodes keep the process bounded and auditable.

### Node 0, bind and summarize

Node 0 reads the role-typed evidence manifest, binds each evidence source to a stable catalog entry, extracts the canonical tool-call stream, and summarizes long sessions in deterministic turn ranges. It preserves IDs, paths, turns, and source ranges that later findings cite.

Main outputs include:

- `evalContext.yaml`
- `session.txt`
- `toolCalls.jsonl`
- `toolCalls.txt`

### Node 1, deterministic extraction

Node 1 derives facts that do not need a model. It builds `extracted_metrics.yaml` and the base `evalCase.yaml` from the sealed evidence. Replaying the same inputs and extractor version must produce the same result.

### Node 2, metric catalog

Node 2 runs the configured model-backed metrics. Each metric is independent, records its own status and provenance, and must cite the evidence that supports its value. The merged overlay publishes only after every configured metric reaches a terminal result.

### Node 3, clerk

The clerk assembles a bounded case packet for the courtroom. It does not rule on the agent. If the clerk returns an invalid shape twice, Phase 1 records partial coverage and still lets the courtroom examine the available evidence.

### Node 4, courtroom

Node 4 runs the adversarial court:

- **Kratos** investigates the trajectory, tool use, and verification process.
- **Logos** examines the diff, source, artifacts, and contract fit.
- **Minos** rules on the filed reports and writes the final report.
- **The orchestrator** assigns work, tracks tangents, enforces the round limit, and assembles the court record. It does not invent findings or change Minos's ruling.

Round 1 always includes a trajectory sweep and a diff sweep. Later rounds run only for new tangents that pass triage. The hard ceiling is 10 rounds. Two reports count as corroboration only when they cite distinct evidence.

The courtroom uses mediated tools rather than general filesystem or shell access. Investigators read bounded evidence. Minos needs a recorded grant before it can read primary evidence. Report and scratchpad writes are append-only.

### Phase 1 output

`evalJudge.yaml` records:

- whether the run is valid for agent learning
- who owns a failure
- the approach, integrity, competence, and reward reconciliation verdicts
- a grounded narrative
- strengths and improvements with evidence refs
- stable behavior signatures and affected agent subsystems
- research-backed remedies when a real `web:<url>` source supports them
- open questions, case coverage, and confidence

The deterministic quality gate checks structure, refs, groundedness, behavioral usefulness, and stability before publication.

## Web research

The judge treats web pages as untrusted source material. A web source can support a recommendation. It cannot prove what the evaluated agent did.

The search tool has separate provider roles:

- Serper retrieves general internet results.
- arXiv always runs as a trusted scholarly source.
- The Jina reader path over DuckDuckGo is the keyless general-web fallback.

Serper and arXiv run together. The tool labels every result by provider and gives Minos the exact `web:<url>` ref to cite. The platform stores only the environment variable name for the Serper credential. It never stores the key value in project JSON, SQLite, logs, or reports.

## Phase 2, patterns across a campaign

Phase 2 begins only after the selected Phase 1 results are published. It freezes the campaign membership first, so a late archive cannot silently change the population halfway through analysis.

Phase 2 has five jobs:

1. Freeze membership and separate valid agent runs from platform failures.
2. Compute recurring behavior patterns and their campaign frequency.
3. Investigate the repeated patterns and research possible remedies.
4. Turn supported remedies into implementation handoffs and experiment plans.
5. Review each recommendation before it enters the developer pack.

The first two jobs are deterministic. The analytical board runs four PI roles in order:

- investigator
- researcher
- designer
- reviewer

Phase 2 stays black-box. It does not read or patch the tested agent's source. It does not run control and treatment experiments. The agent developer owns those steps.

### Agent report and platform report

Phase 2 keeps two audiences separate.

The developer improvement pack contains agent-owned patterns, evidence, recommendations, and experiment plans. A setup bug or archive bug does not belong there.

`platform-report.yaml` contains harness-owned failures and work for the Themis operator. This split prevents a platform defect from being presented as an agent weakness.

## Pause, resume, and process loss

The pipeline stores stage and item state in SQLite. PI sessions write their session files and subagent manifests under the case work directory. Pausing stops the process but keeps those files. Resuming reopens the same session instead of replaying the case from the beginning.

If the API process stops:

- queued and sealed work remains in the database and archive store
- a Phase 1 case with a persisted session can be relaunched from its checkpoint
- an eval run that died without resumable agent state becomes an explicit eval failure
- completed items stay completed
- operator retry creates only the missing fresh attempt

## Current storage model

The local and test deployment uses two SQLite databases and local content-addressed files under `data/`:

- `agenteval.db` owns projects, adapters, eval queues, agent runs, queue containers, and base archives
- `themis.sqlite` owns pipeline generations, Phase 1 result pointers, Phase 2 campaigns, and publications

The repository also contains PostgreSQL and S3-compatible contracts for production work control and artifact storage. Read the implementation status before treating every planned scale property as shipped.

## Read the detailed designs

- [Phase 1 implementation design](../plan/themis-phase1-implementation.md)
- [Phase 2 design](../plan/themis-phase2-design.md)
- [Execution lifecycle](../plan/execution.md)
- [Canonical eval package](../plan/eval-package.md)
- [Adapter design](../plan/adapters.md)
- [Data model](../plan/data-model.md)
- [API contract](../plan/api.md)

# Themis concepts

This glossary explains the objects that appear in the API and console, and how they relate.

## Project

A project is the boundary for one agent evaluation program. It owns adapters, evals, the queue blueprint, model settings, pipeline runs, and archive history. Project-scoped API tokens cannot cross into another project.

## Agent adapter

An adapter teaches Themis how to launch one CLI agent and turn its native output into canonical events. It defines the command, provider environment, parser, evidence files, setup, cleanup, and optional source build.

A project adapter can pin a source repository and commit. An explicitly shared adapter can be selected by another project. Sharing is opt-in.

## Eval package

An eval package is an immutable task definition. Public files describe the task and seed the workspace. Protected files hold the reference solution, hidden verifier, and validation cases.

The eval store and queue are separate. Importing an eval does not run it. A queue item points at the eval, and each claimed agent run snapshots the eval version.

## Eval store

The eval store is a reusable catalog of canonical eval packages. A project can publish one of its evals to the store, and another project can copy that package into its own eval collection. The copied eval receives its own project identity.

## Queue blueprint

A queue defines how a project's evals run. It selects the agent adapter, model, provider, pinned commit, network policy, sandbox, ports, and ordered eval items.

The network policy is one of `allowlist`, `allow`, or `offline`. Suite eval packages pin their own policy to `allowlist` and it wins over the queue's, so the agent container always filters its egress through nftables with a default drop. The single shipped entry covers the whole address space, which keeps the model provider reachable; tightening it is an edit to that list, not a change of mechanism.

The blueprint is durable. Each time you start it, Themis creates a new queue-container generation and a new pipeline generation. Finished runs do not change when the blueprint changes later.

## Queue item

A queue item links one eval to the queue. It has an order, repeat count, enabled state, and optional overrides. The worker claims enabled items in order and records the item snapshot on the agent run.

## Queue container

A queue container is the persistent Podman container for one active eval queue generation. It prepares the fat base and adapter once, then runs the queued evals sequentially.

Only one active container may exist for a queue. Pause keeps the container and current work. Stop closes the generation and removes the container after it captures terminal state.

## Agent run

An agent run is one attempt at one eval. It records the selected agent, model, provider, adapter build, queue generation, timing, token usage, canonical trace, diff, verifier result, and error classification.

A failed run is immutable. Retrying a pipeline item creates another run rather than changing the old row.

## Base archive

A base archive is the evidence sealed at the end of an agent run. The verifier result in this archive owns the official reward. Phase 1 reads the archive but cannot change its files.

## Pipeline queue

Each project has one durable pipeline queue. It links eval execution, Phase 1, and Phase 2. Its automation flags decide which stages start without an operator trigger.

## Pipeline generation

A pipeline generation is what the console calls a run panel or project run. It snapshots the eval membership from the queue blueprint and tracks every selected item across all stages.

A project can have many generations. Each has its own name, state, activity feed, eval rows, campaign, and archive set.

## Pipeline item

A pipeline item tracks one selected eval inside one generation. It connects the eval ID to its agent run, base archive, Phase 1 result, and final Phase 2 archive view.

Typical state path:

```text
eval_pending
  -> eval_running
  -> archive_sealed
  -> phase1_pending
  -> phase1_running
  -> phase1_published
  -> phase2_attached
  -> final_view_published
```

`failed` records `errorKind` and `errorDetail`, so the operator can choose the correct retry.

## Phase 1 result

A Phase 1 result is the immutable per-eval judgement. Its canonical document is `judge/evalJudge.yaml`. The associated archive view adds the complete `judge/` directory to the unchanged base archive.

A result version and its archive view stay linked. Rejudging can publish another version without rewriting the earlier one.

## Courtroom role

Phase 1 uses four role boundaries:

- the orchestrator assigns work and tracks rounds;
- Kratos investigates process and trajectory;
- Logos investigates source, diff, and artifacts;
- Minos rules on filed reports.

These boundaries stop one model from silently turning an unsupported guess into a final verdict.

## Evidence ref

A ref is a typed pointer to evidence, a report, a metric, or a web source. Findings about the agent must cite sealed evidence or committed court records. A `web:<url>` ref can support a recommendation but cannot establish what the agent did.

## Phase 2 campaign

A campaign is the frozen set of Phase 1 results analyzed together. It keeps the tested population stable while the board works.

The campaign separates valid agent-learning cases from platform-owned failures before it computes patterns.

## Pattern

A pattern is a recurring behavior signature across the campaign. It records frequency and evidence. Stable signatures allow the platform to compare the same behavior across different eval families.

## Developer improvement pack

The developer pack is the agent-facing Phase 2 output. It contains recurring agent weaknesses, grounded recommendations, implementation handoffs, and experiments the agent developer can run.

Themis does not patch the agent or run those experiments.

## Platform report

`platform-report.yaml` contains harness-owned failures and work for the Themis operator. It stays outside the agent developer pack. This matters because a broken setup script says nothing about the tested agent's competence.

## Archive view

An archive view is an immutable layer over the base run evidence. The current view may include `judge/` and `phase2/`, while earlier views remain addressable.

## Activity feed

The run panel's activity feed combines durable pipeline events, Phase 1 node progress, courtroom filings, Phase 2 board status, and the live agent event stream. It is a human-readable account of what the selected generation is doing, not a raw debug log.

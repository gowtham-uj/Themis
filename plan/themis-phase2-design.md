# Themis Phase 2 — Agent Improvement Intelligence

> **Status: FIVE-COMPONENT PIPELINE IMPLEMENTED.** Campaign manager, cohort-aware pattern
> analyzer with CANDIDATE/PROVISIONAL/CANONICAL registry, investigator, researcher (web
> search when THEMIS_WEB_SEARCH_ENDPOINT is set), improvement designer, Minos-portfolio
> review, executive brief, hypotheses, R&D memory, per-eval `phase2/` reseal, and a single
> `developer-improvement-pack.zip` are live. THEMIS still does not access agent source or
> run experiments.
>
> Phase 2 is intentionally black-box and advisory. THEMIS does not access or patch the
> tested agent's source code, and it does not run experiments itself. The recipient of
> the Developer Improvement Pack is the developer/maintainer of the tested agent, who
> owns the source and can implement the proposed changes.

---

## One-sentence explanation

**Phase 2 analyzes many Phase-1 reports, finds recurring agent weaknesses, researches
ways to address them, and gives the agent developer a prioritized improvement pack with
experiments they can run to verify each recommendation.**

A useful analogy:

- **Phase 1 is a microscope** — it explains one eval.
- **Phase 2 is an intelligence and experiment-design system** — it finds systemic
  weaknesses and tells the developer what to change and how to prove that it worked.

---

# What Phase 2 does not do

Phase 2 does **not**:

- read the tested agent's source repository;
- generate source-code patches for the tested agent;
- create worktrees or agent variants;
- run control/treatment eval experiments;
- modify the canonical agent;
- automatically merge anything;
- claim that a recommendation was experimentally proven by THEMIS.

The recipient is the developer who owns the tested agent's source code. That developer:

- maps the black-box finding to the relevant internal subsystem;
- implements the source/configuration change;
- runs the proposed experiment;
- decides whether the change should be merged.

If the developer later shares the experiment results, those can be evaluated separately,
but source modification and experiment execution are outside Phase 2.

---

# Simplified architecture

Phase 2 has **five components**:

```text
PHASE-1 RESULTS
      │
      ▼
1. CAMPAIGN MANAGER
      │
      ▼
2. PATTERN ANALYZER
      │
      ▼
3. INVESTIGATION + RESEARCH
      │
      ▼
4. IMPROVEMENT + EXPERIMENT DESIGNER
      │
      ▼
5. REVIEW + DEVELOPER PACK
```

---

## 1. Campaign Manager

**Question:** What exact evaluation results are being analyzed?

Responsibilities:

- freeze an immutable campaign;
- record the exact Phase-1 results included;
- record the tested agent/model/configuration fingerprint;
- separate valid agent runs from platform failures;
- keep Agent Intelligence and Platform Intelligence separate.

Example:

```yaml
campaign:
  total_evals: 200
  valid_agent_runs: 181
  platform_failures: 19
```

A run where the harness failed before the agent started must not score the agent:

```yaml
valid_for_agent_learning: false
failure_owner: eval_harness
agent_started: false
competence: null
include_in_agent_patterns: false
```

### Why this matters

Without validity separation, a setup failure could incorrectly become:

> "The agent performs poorly on undo/redo tasks."

when the correct conclusion is:

> "The evaluation harness failed before the agent started."

---

## 2. Pattern Analyzer

**Question:** What weaknesses repeat across the campaign?

This component is deterministic and model-free.

It reads Phase-1 observations and calculates:

- frequency of each behavior pattern;
- association with task failure;
- token and latency impact;
- silent weaknesses in successful runs;
- repeated behavioral sequences;
- results inside comparable task cohorts.

Example:

```text
TOOL_SEARCH_SELF_CONTEXT
  appears in 37 / 181 valid runs
  average token overhead: +42%
  appears in both successful and failed runs
```

### Cohort-aware analysis

A pattern may appear more often in failed runs only because hard tasks cause both more
searching and more failures.

The analyzer therefore compares within cohorts such as:

- task family and difficulty;
- programming language;
- repository size;
- expected edit size;
- model and token budget.

### Known and new patterns

Two tracks run together:

1. **Canonical patterns** — stable IDs for historical statistics.
2. **Emergent patterns** — new anomalies or rare behavior sequences.

New patterns follow:

```text
CANDIDATE → PROVISIONAL → CANONICAL → DEPRECATED / ALIAS
```

Historical campaign results are never rewritten.

---

## 3. Investigation and Research

**Question:** Why does the pattern happen, and what known methods may address it?

Three roles contribute:

| Role | Responsibility |
|---|---|
| Kratos | Confirms that the behavior repeats across representative evals |
| Logos | Infers the likely mechanism from black-box traces and controlled observations |
| Research | Finds relevant external techniques, papers, and framework guidance |

Phase 2 is **black-box only**.

Logos can inspect:

- agent inputs and outputs;
- tool calls and tool results;
- token/context growth;
- timing and failures;
- environment and configuration;
- behavioral sequences across evals.

Logos cannot claim to know an internal source-code cause it cannot see.

Research receives an abstract mechanism, for example:

> "Repository search produces excessive irrelevant context."

It does not receive hidden tests, benchmark solutions, or secret eval material.

The result is a supported hypothesis:

```yaml
hypothesis:
  claim: Unbounded repository search causes context inflation.
  supporting_observations: [...]
  contradicting_observations: [...]
  likely_mechanism:
    - runtime directories are searchable
    - tool output is unbounded
    - results are not ranked
  confidence: high
```

---

## 4. Improvement and Experiment Designer

**Question:** What should the agent developer try, and how can they prove it works?

This component produces an **implementation handoff**, not an implementation. The agent
maintainer receives enough information to find and modify the appropriate source code,
without THEMIS claiming it knows an internal file or function it could not inspect.

For each supported pattern it creates:

1. the observed behavior;
2. the black-box evidence and measured impact;
3. the likely mechanism (explicitly labeled as inferred);
4. the **target capability/subsystem** (for example repository search, context builder,
   verification policy, orchestration, model routing);
5. one or more possible interventions;
6. implementation requirements the developer can map onto their source tree;
7. why each intervention may help;
8. risks and possible regressions;
9. a concrete experiment plan for the developer.

### Recommendation types

#### Direct fix

Directly implied by the evidence.

Example:

> Exclude `.reaper/**` from repository search by default.

#### Research-backed architecture recommendation

The eval evidence identifies a pattern; external research supports a more general
treatment.

Example:

> Replace unrestricted search output with bounded, ranked repository localization.

#### Experimental idea

Promising, but applicability to the tested agent is not yet established.

Example:

> Add a persistent reflection/failure-memory policy.

The report must clearly distinguish these classes.

### Source-owner implementation handoff

Because the developer owns the agent source, each recommendation also tells them what
internal capability to locate and what behavior the implementation must provide:

```yaml
implementation_handoff:
  target_capability: repository_search
  observed_interface: grep_search
  likely_internal_areas:
    - search tool implementation
    - workspace filesystem abstraction
    - tool-result serialization
  required_behavior:
    - exclude agent runtime directories by default
    - impose a configurable result-size budget
    - report truncation metadata
    - preserve an explicit override for deep searches
  themis_knows_exact_source_location: false
```

`likely_internal_areas` are navigation hints for the developer, not claims about exact
files. The developer maps them to the real source tree.

---

# Experiment plan produced for the developer

THEMIS designs the experiment but does not run it.

Each recommendation includes an experiment card:

```yaml
experiment_plan:
  id: EXP-PROPOSED-017

  claim_to_test:
    Bounded and ranked search reduces context inflation without reducing correctness.

  control:
    Current agent binary and current search behavior.

  treatment:
    Same agent binary with an external tool proxy that:
      - excludes .reaper/**
      - limits result size
      - ranks matches

  constants:
    - same agent binary/image
    - same model and parameters
    - same eval packages
    - same environment
    - same verifier

  target_tasks:
    - tasks where broad search or oversized output was observed

  regression_tasks:
    - large-repository tasks requiring high search recall
    - unrelated random tasks

  primary_metric:
    name: pass_rate
    minimum_worthwhile_effect: +0.02

  secondary_metrics:
    - median_tokens
    - p95_tokens
    - wall_time
    - search_calls
    - context_peak
    - TOOL_SEARCH_SELF_CONTEXT rate

  regression_limits:
    pass_rate: no regression
    p95_latency: maximum +10%

  suggested_sample:
    tasks: 50
    seeds_per_task: 3

  success_conditions:
    - pass rate does not decrease
    - median tokens decrease materially
    - self-context ingestion disappears
    - no meaningful recall regression
```

### Important experiment-design rules

- The task is the experimental unit; multiple seeds of one task are not independent.
- Control and treatment should run contemporaneously.
- Use the same binary, model, environment, task, and verifier.
- Change one mechanism at a time when possible.
- Include target, contrast, and regression task sets.
- Define the primary metric before seeing results.
- Define the minimum worthwhile effect and regression limits.
- Do not use an old archived run as the statistical control.

---

## What if the binary exposes no useful external control point?

Some agents expose only a binary with no configurable prompt, tool proxy, model route,
or external policy. That does not make the recommendation useless, because the pack is
sent to the source-owning agent developer.

In that case THEMIS must not pretend to have tested a fix. It provides:

- the observed systemic pattern;
- the evidence and measured impact;
- the likely mechanism;
- the target internal capability;
- implementation requirements for the developer;
- the proposed source/configuration improvement;
- the exact experiment the developer should run after implementing it;
- metrics and success criteria.

The recommendation is labeled:

```text
DEVELOPER_IMPLEMENTATION_REQUIRED
```

Evidence status remains:

```text
OBSERVATIONAL or MECHANISTICALLY_SUPPORTED
```

It cannot become `EXPERIMENTALLY_VALIDATED` without external results.

---

## 5. Review and Developer Pack

**Question:** Is the conclusion useful, grounded, and honest about uncertainty?

### Meta-review

Before final output, a review stage challenges the conclusion:

- Is the pattern real or caused by task difficulty?
- Is it specific to one model or task family?
- Are duplicate observations being counted repeatedly?
- Does the recommendation actually address the observed mechanism?
- Is the proposed experiment able to prove or falsify the claim?
- Could the treatment improve one metric while harming another?

### Minos portfolio judgment

Minos does not claim experimental proof that THEMIS did not obtain.

Evidence ladder:

```text
OBSERVATIONAL
→ MECHANISTICALLY_SUPPORTED
→ RESEARCH_SUPPORTED
→ EXPERIMENT_PROPOSED
→ DEVELOPER_IMPLEMENTATION_REQUIRED
```

If the developer later provides experiment results, a future review can add:

```text
EXTERNALLY_VALIDATED
```

### Final outputs

Phase 2 produces a **Developer Improvement Pack** containing:

1. **Executive Brief** — the largest recurring weaknesses.
2. **Pattern Catalog** — frequency, cohorts, cost, and evidence.
3. **Root-Cause Hypotheses** — supported and contradicting observations.
4. **Improvement Portfolio** — prioritized direct, research-backed, and experimental ideas.
5. **Experiment Plans** — exactly how the developer can test each proposal.
6. **Platform Reliability Report** — separate from agent findings.

---

# R&D memory

Phase 2 remembers:

- observations;
- patterns and cohorts;
- hypotheses;
- external techniques;
- proposed interventions;
- experiment plans;
- developer-provided experiment outcomes, if later imported;
- rejected ideas and why they were rejected.

A developer-provided result might later be recorded as:

```yaml
external_experiment_result:
  experiment_plan: EXP-PROPOSED-017
  outcome: harmful
  result:
    tokens: -38%
    pass_rate: -7.2 percentage points
  do_not_retry_unless:
    - relevance ranking is added
    - adaptive limits are implemented
```

This prevents the system from recommending the same failed idea repeatedly.

---

# Data and storage

PostgreSQL stores metadata and relationships:

```text
campaigns and exact campaign membership
observations and evidence
patterns and cohorts
hypotheses and evidence
research techniques
recommendations
experiment plans
external experiment results (optional)
Minos decisions
agent-system fingerprints
signature definitions and aliases
```

Large logs, traces, diffs, and evidence remain content-addressed outside database rows.

---

# Agent vs platform intelligence

Agent and platform findings stay separate.

### Agent Intelligence

Recommendations for the developer of the tested agent:

- prompts and policies;
- tools and wrappers;
- context management;
- orchestration;
- verification behavior;
- model routing;
- environment assumptions.

### Platform Intelligence

Findings about AgentEval/THEMIS:

- setup failures;
- metric attribution errors;
- verifier lifecycle problems;
- missing evidence;
- evaluation protocol reliability.

Platform findings never become agent competence scores or agent recommendations.

---

# Example

```text
Observed pattern:
  Repository search sometimes reads the agent's own runtime logs.

Campaign evidence:
  37 / 181 valid runs
  average token overhead: +42%

Likely mechanism:
  Runtime directories are visible to broad workspace search.

Recommendation:
  Filter runtime paths and cap/rank search output.

Evidence level:
  RESEARCH_SUPPORTED

Developer experiment:
  Compare the same agent binary under:
    CONTROL: current search behavior
    TREATMENT: search proxy with path filtering + result budget

Success criteria:
  reward does not decrease
  median tokens decrease by at least 20%
  no .reaper paths appear in search results
  no search-recall regression on large repositories
```

---

# Unified per-project pipeline queue

Each project has **one logical pipeline queue**. The queue unifies all three stages while
keeping their internal workers and evidence boundaries separate:

```text
PROJECT PIPELINE QUEUE
      │
      ├── EVAL EXECUTION       real agent + verifier, sequential per eval
      │       │
      │       └── sealed base archive
      │                │
      ├── PHASE 1             starts as each eval archive seals
      │       │
      │       └── immutable Phase-1 archive view (`judge/`)
      │
      └── PHASE 2             starts after every queue item has terminal Phase 1
              │
              └── campaign developer pack + final per-eval views (`phase2/`)
```

## Queue generations

The durable queue belongs to the project; each run of it creates an immutable
**generation** that snapshots:

- ordered eval membership;
- adapter/version, agent binary/image, model and provider;
- Phase-1 judge configuration;
- Phase-2 campaign configuration;
- automatic/manual stage policy;
- input package and prompt/config digests.

A later batch uses a new generation. Historical generations and outputs remain
addressable.

## Automatic default flow

1. Claim and execute eval items **sequentially** in the project's persistent Podman
   container.
2. As each eval completes and its base archive seals, enqueue its Phase-1 job
   idempotently.
3. Continue to the next eval while Phase 1 is processed by its own worker capacity.
4. Close the eval stage only after every item is terminal and every required archive is
   published.
5. Mark Phase 1 complete only after every attributable item has a terminal published
   Phase-1 result (failures remain explicit and never appear as completed results).
6. Freeze the Phase-2 campaign membership from those exact Phase-1 result-version IDs.
7. Run black-box Phase-2 analysis and produce the Developer Improvement Pack.
8. Publish one final immutable strict-superset archive view per eval, adding the campaign
   artifacts under `phase2/`.
9. Mark the queue generation completed only after all final views verify.

## Manual controls

Automatic advancement is the default, but every stage can be triggered or retried
manually without creating duplicate work:

```text
trigger eval execution
trigger/retry Phase 1 for one eval or all eligible evals
trigger/retry Phase 2 when membership is ready
pause/resume/cancel generation
retry a failed item or failed stage
finalize/reseal verified outputs
```

A manual request uses the same durable operation identity as automatic advancement, so
replaying it is idempotent.

## State model

Generation stage:

```text
draft → ready → eval_running → phase1_running → phase2_ready → phase2_running
→ finalizing → completed
```

Any nonterminal stage may move to `paused`, `waiting_retry`, `failed`, or `cancelled`
according to the existing retry/fencing rules. A stage transition uses database state,
not process-local memory.

Per-item state:

```text
eval_pending → eval_running → archive_sealed
→ phase1_pending → phase1_running → phase1_published
→ phase2_attached → final_view_published
```

## Completion signals

Durable outbox events connect the stages:

```text
archive.sealed
phase1.result_published
pipeline.phase1_complete
phase2.campaign_published
pipeline.final_views_published
```

Workers claim with leases/fencing. A stale worker may finish external work, but cannot
advance queue or publication state after losing its token.

## Phase-2 archive layout

Phase 2 is campaign-level analysis, but each eval receives a final view so developers
still have one complete archive per eval:

```text
phase2/
  campaign.yaml             campaign identity, SUT fingerprint, membership
  patterns.yaml             recurring agent patterns relevant to this eval/campaign
  developer-pack.yaml       prioritized source-owner implementation handoffs
  experiment-plans.yaml     developer-run validation plans
  platform-report.yaml      dev/platform intelligence, separate from agent findings
  manifest.json             schema version + hashes of all Phase-2 documents
```

The final view is a strict superset of that eval's immutable Phase-1 view. It never
changes base evidence or `judge/` bytes. Historical Phase-1 and earlier Phase-2 views
remain queryable; a current pointer selects the default view.

## API-only developer workflow

The required E2E uses only HTTP APIs:

1. Create a project.
2. Create/build/validate a ReaperCode agent adapter.
3. Import two complex canonical eval packages.
4. Create the project's pipeline queue and add both evals in order.
5. Start the queue (or manually trigger the eval stage).
6. Poll one pipeline status endpoint while eval → Phase 1 → Phase 2 advances.
7. Retrieve the Phase-2 campaign pack and both final archive-view IDs.
8. Fetch `judge/evalJudge.yaml`, `phase2/developer-pack.yaml`, and manifests through the
   archive API — never host paths.

---

# Implementation order

1. Resolve the repository-scope conflict (`CLAUDE.md` currently declares no judge
   subsystem/API while Phase 1 judge code and this contract require it).
2. PostgreSQL/SQLite unified queue generation + item + stage-event schema and contracts.
3. Wire eval archive seal → Phase 1 worker → `phase1.result_published` event.
4. Campaign Manager, exact membership, validity split, and Phase-2 persistence.
5. Pattern Analyzer and cohort-aware statistics.
6. Investigation + Research roles.
7. Improvement + Experiment Designer.
8. Review + Developer Pack and R&D memory.
9. Phase-2 final archive-view publisher (`phase2/` strict-superset branch).
10. Unified pipeline HTTP API and automatic/manual stage controls.
11. API-only two-eval ReaperCode E2E, then full typecheck/tests/real-Podman acceptance.

---

# Interview explanation

> “Phase 1 explains individual agent runs. Phase 2 aggregates many runs to find systemic
> behavior patterns and their cost. THEMIS investigates the likely mechanism as a
> black-box, researches possible remedies, and gives the source-owning agent developer a
> prioritized implementation handoff. For every recommendation it also designs a
> controlled experiment — control, treatment, metrics, task cohorts, success criteria,
> and regression guardrails. The developer maps the recommendation to the real source,
> implements it, and runs the experiment; THEMIS does not need source access and does not
> modify or execute the agent itself.”

# Themis Phase 2 — Agent Improvement Intelligence

> **Status: FIVE-COMPONENT PIPELINE IMPLEMENTED, BOARD RUNS ON PI.** Campaign manager,
> per-campaign pattern analyzer, and the
> four-role analytical board (investigator, researcher, designer, reviewer) are live, as
> are the executive brief, hypotheses, R&D memory, per-eval `phase2/` reseal, and the
> `developer-improvement-pack.zip`.
>
> Components 3 through 5 are no longer a hand-rolled agent loop. They run as PI
> coding-agent subagents under a Phase-2 orchestrator, using the same mediated tool
> surface and session-resume machinery as the Phase-1 courtroom. See
> [As-built: the Phase-2 PI board](#as-built-the-phase-2-pi-board). Component 1 (campaign
> manager) and component 2 (pattern analyzer) remain deterministic and model-free.
>
> THEMIS still does not access agent source or run experiments.
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

Components 1 and 2 are deterministic. Components 3, 4, and 5 are agentic and run as PI
subagents under one orchestrator; the mapping from these five components to the four
implemented roles is in [As-built: the Phase-2 PI board](#as-built-the-phase-2-pi-board).

---

## 1. Campaign Manager

**Question:** What exact evaluation results are being analyzed?

Responsibilities:

- freeze an immutable campaign;
- record the exact Phase-1 results included;
- record the tested agent/model/configuration fingerprint (as built, `sutFingerprint` is
  `sha256` of the generation config JSON, which carries the eval queue and project ID but
  not the adapter version, agent image, model, or provider — it identifies the campaign, not
  the agent);
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

### What the analyzer computes today

The built analyzer is narrower than the section above, and the gaps are worth naming rather
than leaving a reader to discover them in `patterns.ts`.

| Documented | As built |
|---|---|
| Token and latency impact | `averageTokens` only. Wall time rides on each observation but is never aggregated. |
| Repeated behavioral sequences | Not built. |
| Cohorts by task family, difficulty, language, repo size, edit size, model, token budget | Four fixed axes: `language`, `category`, `profile`, `model`. |
| CANDIDATE → PROVISIONAL → CANONICAL → DEPRECATED / ALIAS | Frequency thresholds inside one campaign: 3 or more occurrences is canonical, 2 is provisional, 1 is candidate. No cross-campaign registry, no deprecation, no aliases. |
| Emergent patterns | Not built. Signatures come from a closed list, and anything unmatched is dropped as `UNCLASSIFIED`. |

Two things the analyzer does that the section above does not mention. Agent observations
are read only from minos's `improvements` list, falling back to the narrative when that
list is empty, because keyword-matching the narrative attributed the verifier's own
`python3: command not found` to the agent as an interpreter assumption. And each case
carries `rewardAttributable`, derived from the sealed verifier record, which gates pass and
fail counting, silent-weakness counting, and a designer rule that forbids using pass rate
as the primary metric when rewards cannot be attributed.

Platform-fault classification is also deterministic and undocumented above:
`load-cases.ts` reads the verifier record for `verifier_crash`, `verifier_timeout`,
`setup_failure`, or `empty_workspace`, and overrides a stale Phase-1 `failure_owner: none`
when it finds one. Those become the five canned platform findings in the platform report.

---

## 3. Investigation and Research

**Question:** Why does the pattern happen, and what known methods may address it?

Three roles contribute:

| Role | Responsibility |
|---|---|
| Kratos | Confirms that the behavior repeats across representative evals |
| Logos | Infers the likely mechanism from black-box traces and controlled observations |
| Research | Finds relevant external techniques, papers, and framework guidance |

As built, Kratos and Logos are one `investigator` subagent and Research is the `researcher`
subagent. Both Phase-2 responsibilities above are black-box trace reading over the same
court records, and splitting them produced two agents citing the same evidence. The
responsibilities in this table still hold; only the role count changed. See
[Roles](#roles).

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

Four of those five rungs are reachable today. The normalizer maps model output onto
`research_supported`, `mechanistically_supported`, `experiment_proposed`, or
`observational`, and anything it does not recognize falls to `observational`, so a
recommendation filed as `developer_implementation_required` is silently downgraded.
`EXTERNALLY_VALIDATED` is not in the type at all. Two more coercions matter for the same
reason: a `research_backed` recommendation with an empty research basis is demoted to
`direct_fix`, and `themisKnowsExactSourceLocation` is forced false no matter what the
designer wrote. Recommendation classes are enforced by coercion, not by validation, which
means a malformed model response degrades quietly instead of failing.

Review can also be a no-op. If the reviewer files an empty `keptIds` and an empty `dropped`,
every drafted recommendation passes through unreviewed.

### Final outputs

Phase 2 produces a **Developer Improvement Pack** containing:

1. **Executive Brief** — the largest recurring weaknesses.
2. **Pattern Catalog** — frequency, cohorts, cost, and evidence.
3. **Root-Cause Hypotheses** — supported and contradicting observations.
4. **Improvement Portfolio** — prioritized direct, research-backed, and experimental ideas.
5. **Experiment Plans** — exactly how the developer can test each proposal.

The **Platform Reliability Report** is a sixth document, but it is not part of the pack. It
goes to whoever operates Themis, and the pack zip excludes it deliberately. See
[Pack structure](#pack-structure).

---

# As-built: the Phase-2 PI board

Components 3, 4, and 5 above describe *what* the analytical stage must produce. This
section describes *how* it runs, and supersedes any earlier reading of those components as
a bespoke agent loop.

Phase 2 uses the same coding agent as the Phase-1 courtroom: PI
(`@earendil-works/pi-coding-agent`) with the `pi-subagents` extension. The reasoning behind
that choice is simple. Investigating a mechanism from trace evidence, reading across
dozens of court records, and drafting an implementation handoff are coding-agent work. A
hand-rolled loop reimplemented tool dispatch, retry, and session persistence badly; PI
already does all three, and reusing it means one resume path and one tool surface across
both phases.

The older gateway board (`agent-loop.ts`, `GatewayPhase2Board`, and the parallel tool table
in `phase2/tools.ts`) is still in the tree and reachable from tests, but no live route
constructs it. `PiPhase2Board` is what `pipeline-routes.ts` wires in. Treat the gateway
board as a test fixture, not a supported fallback.

## Roles

One orchestrator dispatches four specialist subagents. Dispatch is strictly ordered and
blocking; each subagent's report is its return value, not something the orchestrator polls
for.

| Role | Prompt | Files | Question it answers |
|---|---|---|---|
| orchestrator | `phase2-orchestrator.md` | none | Which specialists run, in what order, with what brief |
| investigator | `phase2-investigator.md` | `phase2-hypotheses` | Which agent-owned patterns genuinely repeat, and by what mechanism |
| researcher | `phase2-researcher.md` | `phase2-research` | What published techniques address those mechanisms |
| designer | `phase2-designer.md` | `phase2-recommendations` | What the developer should change, and how they can prove it worked |
| reviewer | `phase2-reviewer.md` | `phase2-review` | Which recommendations survive scrutiny |

The campaign runner awaits four board methods in sequence, but they are not four
processes. The first call launches the PI orchestrator once and caches its result; the
other three read slices of that same run. Ordering lives in the orchestrator prompt, not in
the host code that appears to sequence it.

Mapping back to the five components: the investigator is component 3's Kratos and Logos
roles merged (both are black-box trace reading, and splitting them produced two agents
citing the same evidence), the researcher is component 3's research role, the designer is
component 4, and the reviewer is component 5's meta-review. Component 5's Minos portfolio
judgment is applied by the reviewer against the same evidence ladder.

Prompts live in `src/judge/prompts/phase2-*.md` and are customized per role. They are not
the Phase-1 prompts with the nouns swapped: each states its own objective, boundaries,
where to look, and what "done" means, and each is told explicitly that platform defects
(empty workspace, crashed verifier) are never agent weaknesses.

## Tools

Subagents reach evidence only through the mediated tool surface in
`themis-tools-extension.ts`. There is no filesystem, shell, or database access. Phase 2
adds campaign-scoped tools to the Phase-1 set: `list_evals`, `list_patterns`,
`read_pattern`, `read_improvements`, `read_lifecycle`, `read_judge_report`,
`read_court_record`, `write_to_yaml_template`, and `web_search`. Each role gets a subset.
The researcher is the only role holding `web_search`; the reviewer cannot read raw
lifecycle evidence, which keeps it reviewing rather than re-investigating.

`web_search` uses the model provider's own search rather than a separate search service.
When `THEMIS_WEB_SEARCH_ENDPOINT` is unset, the tool calls the same OpenAI-compatible proxy
PI uses, declaring search as a function-typed tool. This detail is load-bearing: the proxy
rejects a bare `type: "web_search"` entry before the query is ever sent, which silently
denied 9 of 9 research queries until it was fixed.

## Durability and control

The board writes to `data/platform/phase2/<campaignId>`. The PI session JSONL, the filed
reports, and `pi.pid` all live there, which is what makes the stage resumable: a resume
re-attaches to the existing session with `--continue` rather than restarting the campaign.
Traces are copied into each eval's `phase2/` archive view alongside the Phase-1 `judge/`
tree, so a campaign's reasoning stays auditable from the archive API.

Control is over HTTP, matching Phase 1. The five campaign routes and what they actually do
to the generation are listed in
[As-built routes and controls](#as-built-routes-and-controls).

## Pack structure

The design above lists six outputs. In the built system they split across two artifacts,
because mixing them was actively harmful: the first pack shipped harness bugs to the agent
developer as if they were agent weaknesses.

`developer-improvement-pack.zip` is agent-facing only:

```text
phase2/
  campaign.yaml            campaign identity + membership
  executive-brief.yaml     agent weaknesses + next action
  hypotheses.yaml          root-cause hypotheses + research notes
  patterns.yaml            agent-owned patterns (frequency, cohorts, evidence)
  developer-pack.yaml      prioritized implementation handoffs + experiment cards
  experiment-plans.yaml    developer-run control/treatment plans
  manifest.json            artifact hashes
phase1/<runId>/judge/      each member eval's complete Phase-1 court record
```

Including `phase1/` matters. A recommendation is only as good as the evidence under it, and
a developer who wants to check one is otherwise stuck making separate archive API calls per
eval.

`platform-report.yaml` is written beside the zip, not inside it, and only when there is
something to report. It carries platform findings, harness-owned patterns, and
`nextPlatformAction`. It is for whoever operates THEMIS, never for the agent developer.
`rd-memory.yaml` is likewise kept out of the pack: it is the R&D memory described below,
internal to Themis across campaigns.

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

As built, memory is write-only. Each campaign writes `rd-memory.yaml` with the rejected
recommendation IDs and the reviewer's reasons, and nothing reads it back into the next
campaign yet. The designer prompt already honors a `memory.rejectedRecommendationIds` list,
so feeding the previous campaign's file into the next run is the remaining work.
`external_experiment_result` import is not built.

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

As built, the live path opens SQLite at `<dataDir>/themis.sqlite`. A PostgreSQL store
implements the same contract but no route selects it yet. Of the record kinds above, only
one is written: a `decision` row per campaign carrying the whole pack result as JSON.
Observations, patterns, hypotheses, recommendations, and experiment plans exist as YAML
files under `data/phase2_artifacts/<campaignId>/` and in the sealed archive view, not as
queryable rows. Campaign membership rows also hardcode `valid_for_agent_learning: true`;
the real validity split runs later, in `load-cases.ts`, off the sealed verifier record, and
only reaches the YAML artifacts. Anything that needs to query across campaigns has to wait
for those rows to be written for real.

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

Four events exist today: `archive.sealed`, `phase1.result_published`, and two the list
above omits, `phase1.retry` and `phase1.resume`. The last three in the list are not emitted;
stage advancement reads generation state directly instead.

## As-built routes and controls

Every stage starts through one route. There is no separate Phase-2 start endpoint.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects/:id/pipeline` | Create the project's pipeline queue |
| POST | `/api/projects/:id/pipeline/generation` | Open a generation |
| POST | `/api/projects/:id/pipeline/generation/:gid/advance` | Advance with `trigger: auto \| eval \| phase1 \| phase2 \| finalize` |
| GET | `/api/projects/:id/pipeline/generation/:gid` | Generation status |
| POST | `/api/projects/:id/runs/:runId/phase1/pause` | Pause one Phase-1 courtroom |
| GET | `/api/projects/:id/pipeline/campaign/:cid` | Campaign, filed records, and PI status |
| GET | `/api/projects/:id/pipeline/campaign/:cid/status` | PI status alone |
| POST | `/api/projects/:id/pipeline/campaign/:cid/pause` | SIGTERM then SIGKILL the PI process |
| POST | `/api/projects/:id/pipeline/campaign/:cid/resume` | 202, restart PI from the on-disk snapshot |
| GET | `/api/projects/:id/pipeline/campaign/:cid/pack` | Stream the pack zip |

The pack route rebuilds the path from `dataDir` and the campaign ID rather than trusting a
stored host path, opens with `O_NOFOLLOW`, and rejects symlinks.

Three gaps against the manual-controls list. Cancel has no route, though `cancelled` exists
in the state machines. Phase-2 pause and resume act on the PI process, not the generation:
pause kills the pid without moving the generation to `paused`, and resume restarts the
subprocess from its snapshot without going through generation advancement, so it throws if
Phase 2 has never run. And Phase-2 resume idempotency is not durable: an in-process map
guards concurrent requests and dies with the server, and the ordering guarantee that stops
a resumed campaign from re-running a finished stage is a sentence in the orchestrator
prompt telling it to skip any stage whose YAML already exists.

## Phase-2 archive layout

Phase 2 is campaign-level analysis, but each eval receives a final view so developers
still have one complete archive per eval:

```text
phase2/
  campaign.yaml             campaign identity, SUT fingerprint, membership
  executive-brief.yaml      the largest recurring weaknesses
  hypotheses.yaml           root-cause hypotheses with supporting/contradicting refs
  patterns.yaml             recurring agent patterns relevant to this eval/campaign
  developer-pack.yaml       prioritized source-owner implementation handoffs
  experiment-plans.yaml     developer-run validation plans
  rd-memory.yaml            rejected recommendations and why
  platform-report.yaml      platform intelligence, written only when there is any
  manifest.json             schema version + hashes of all Phase-2 documents
  developer-improvement-pack.zip   the agent-facing pack, sealed with the view
  traces/                   PI stdout, session JSONL, and subagent artifacts
```

The publisher requires every file above except `platform-report.yaml`, which
`run-campaign.ts` writes only when the campaign found at least one platform finding or
harness-owned pattern.

The final view is a strict superset of that eval's immutable Phase-1 view. It never
changes base evidence or `judge/` bytes. Historical Phase-1 and earlier Phase-2 views
remain queryable; a current pointer selects the default view.

This per-eval archive view is not the same artifact as the downloadable developer pack. The
archive view is the complete campaign record attached to one eval, platform findings
included, retrieved through the archive API. The pack is the agent-facing subset, zipped
for the agent's developer, and it excludes `platform-report.yaml` by design. See
[Pack structure](#pack-structure).

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

All eleven steps are delivered. Step 6 through 8 landed twice: first as a hand-rolled agent
loop, then rebuilt on the PI board described in
[As-built: the Phase-2 PI board](#as-built-the-phase-2-pi-board).

1. ~~Resolve the repository-scope conflict~~. Done. `CLAUDE.md` now declares Phase 1 and
   Phase 2 in scope.
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

# Themis

An agent evaluation and improvement system.

Themis runs coding agents against real eval tasks in containers, judges each run in depth, then
aggregates many judgements into an improvement pack for the agent's developer. The reward tells you
whether an eval passed. Themis exists to answer the harder questions: how the agent got there, whether
the process was sound, and what its developer should change.

Everything is an HTTP API. A React console ships in `web/`, but it consumes the same public API and
nothing else.

## The two phases

Two phases sit on top of the execution platform, and they work at different scales.

**Phase 1 is a microscope.** It explains one eval run.

**Phase 2 is an intelligence system.** It reads many Phase-1 reports, finds the weaknesses that recur,
researches ways to address them, and hands the developer a prioritized pack with experiments they can
run to check each recommendation.

```text
eval execution  →  sealed archive  →  PHASE 1 (per eval)  →  PHASE 2 (per campaign)
                                          judge/                    phase2/
```

### Phase 1: per-eval judgement

A sealed archive goes through five nodes. The first four are mechanical, and they exist to bound what
the expensive part has to read.

| Node | What it does |
|---|---|
| 0 | Binds evidence from the role-typed manifest and summarizes the session in deterministic chunks |
| 1 | Deterministic extraction: tool calls, metrics, the base `evalCase.yaml` |
| 2 | An LLM metric catalog, each metric an independently keyed operation |
| 3 | One tool-less clerk pass that assembles a bounded input pack |
| 4 | The courtroom |

Node 4 is where judgement happens, and it is structured as an adversarial court because a single
summarizing agent produces confident narrative rather than grounded findings.

- **Kratos** sweeps the trajectory and process.
- **Logos** does diff and artifact forensics.
- **Minos** rules at the end of every round and writes the final report.

The split is load-bearing. Kratos and logos establish facts with references and never issue verdicts.
Minos rules and never investigates. Corroboration requires two distinct references, so two agents citing
the same line count once. Round 1 always runs; the ceiling is 10 rounds; the case closes when a round
turns up no new tangent worth chasing.

Reports are append-only. A correction is a new document, never an edit to an old one. The output is
`judge/evalJudge.yaml` plus the complete court record, sealed into an immutable archive view over the
base evidence.

Full design: [`plan/themis-phase1-implementation.md`](./plan/themis-phase1-implementation.md).

### Phase 2: campaign analysis

Phase 2 is deliberately black-box. It does not read the tested agent's source, generate patches, or run
control/treatment experiments. It designs the experiments and hands them over. The recipient owns the
source and is the one who can act.

Five components, of which the first two are deterministic and model-free:

1. **Campaign manager** freezes exactly which Phase-1 results are in scope and fingerprints the agent
   under test.
2. **Pattern analyzer** computes frequency, cohort association, and token cost for each behavior
   signature.
3. **Investigation and research** confirms which patterns genuinely repeat and finds published
   techniques that address them.
4. **Improvement and experiment designer** writes the implementation handoffs and the experiment plans.
5. **Review** keeps or drops each recommendation.

Components 3 through 5 run as PI coding-agent subagents under a Phase-2 orchestrator: investigator,
researcher, designer, reviewer, dispatched in that order, blocking. They reach evidence only through a
mediated tool surface, and `web_search` uses the model provider's own search rather than a separate
service.

The validity split in component 1 is the piece that took the longest to get right. A run where the
harness broke before the agent started must never become "the agent performs poorly on undo/redo
tasks." Those runs are marked `failure_owner: eval_harness` and excluded from agent patterns.

That separation carries through to the output. `developer-improvement-pack.zip` is agent-facing only,
and bundles the Phase-1 court records the recommendations rest on:

```text
phase2/     campaign, executive brief, hypotheses, patterns,
            developer pack, experiment plans, manifest
phase1/<runId>/judge/     each member eval's full court record
```

Anything owned by the harness goes to a separate `platform-report.yaml`, for whoever operates Themis.
Shipping harness bugs to an agent developer as if they were agent weaknesses wastes their time and
discredits the rest of the pack.

Full design: [`plan/themis-phase2-design.md`](./plan/themis-phase2-design.md).

## Underneath: the execution platform

Both phases read archives that the execution platform produces.

Projects own versioned agent adapters and canonical eval packages. Each active queue owns one persistent
Podman container and runs its evals sequentially, with per-eval setup and cleanup. A hidden deterministic
verifier runs outside the agent container and owns the official 0/1 reward. Protected solution, test, and
validation content never enters the agent container.

Every run seals one immutable archive: run metadata, canonical events, native traces, verifier output,
deterministic metrics, cleanup evidence, and generated outputs. Phase 1 adds `judge/` as a strict
superset over that base. Phase 2 adds `phase2/`. Base bytes are never modified, and historical views stay
addressable.

Each project has one durable pipeline queue that advances eval execution → Phase 1 → Phase 2
automatically, with every stage separately triggerable, pausable, and resumable over the API. Resume is
real: both courtrooms persist their PI session and re-attach with `--continue` rather than starting over.

## Quick start

```bash
npm install
npm run typecheck
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npm test
npm run build
node dist/src/cli/serve.js --port 8080 --data-dir ./data
```

The web console:

```bash
cd web && npm install && npm run dev    # proxies /api to 127.0.0.1:8080
```

Runtime and model paths use real systems. `PodmanRuntime` is the only supported container backend, and
there is no fake local-process runtime or mocked model gateway. On root Reaper pods set
`AGENTEVAL_PODMAN_SUDO=0`; sudo is not required. See [`CLAUDE.md`](./CLAUDE.md).

## Documentation

| Document | Purpose |
|---|---|
| [`docs/api-reference.md`](./docs/api-reference.md) | Every endpoint, request body, and response shape |
| [`docs/platform-api-guide.md`](./docs/platform-api-guide.md) | Operating projects, adapters, queues, archives |
| [`docs/eval-authoring.md`](./docs/eval-authoring.md) | Canonical eval package format and confidentiality |
| [`plan/themis-phase1-implementation.md`](./plan/themis-phase1-implementation.md) | Phase 1 design and work packages |
| [`plan/themis-phase2-design.md`](./plan/themis-phase2-design.md) | Phase 2 design, board, and pack contract |
| [`plan/adapter-generation-guide.md`](./plan/adapter-generation-guide.md) | Integrating a real CLI agent |
| [`plan/execution.md`](./plan/execution.md) | Queue container and evidence lifecycle |

Normative contracts live in [`plan/`](./plan/). The guides in [`docs/`](./docs/) are the operational
path and must stay aligned with them.

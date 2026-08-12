# Authoring an agenteval eval (suite format)

Agenteval accepts **one** eval format: a project-scoped, immutable eval package described with a flat
`task.toml`, an initial agent workspace (`seed_repo/`), a self-contained environment image, a separate
hidden verifier, and validation material. This is the only accepted creation format for new evals.

Each eval is created per-project through the API — one eval per package, or many evals from a packed
suite file. Eval rows are project-scoped and independent per project.

## Required tree (one eval)

```text
eval-name/
├── instruction.md                  # the prompt the agent receives
├── task.toml                       # entirely FLAT key=value (no tables); see below
├── README.md
├── seed_repo/                      # the initial agent workspace, copied to /workspace/task
├── environment/
│   ├── Dockerfile                  # full language base image (python/node/gcc), WORKDIR /workspace/task
│   ├── setup.sh                    # argv[1]=target (default /workspace/task); seeds seed_repo
│   ├── cleanup.sh                  # argv[1]=target; whitelist-guarded rm -rf
│   └── healthcheck.sh
├── solution/                       # reference solution (NEVER goes to the agent container)
│   ├── solve.sh                    # argv[1]=target; copies reference_files/ into it
│   ├── reference.patch
│   └── reference_files/<path>      # the fixed source file(s)
├── tests/                          # hidden verifier (NEVER shown to the agent)
│   ├── Dockerfile
│   ├── test.sh                     # python3 verifier.py "${1:-/workspace/task}"
│   └── verifier.py                 # grades /workspace/task, prints JSON on stdout
└── validation/
    ├── expected.json               # {"no_op_reward":0,"oracle_reward":1,"known_bad_reward":0}
    ├── known_bad.patch
    ├── known_bad/<path>            # a corrupt copy mirroring reference_files paths
    └── validation-report.json      # informational
```

The validator requires `instruction.md`, `task.toml`, `README.md`, `seed_repo/`, the four
`environment/` scripts, `tests/{Dockerfile,test.sh,verifier.py}`, `solution/{solve.sh,reference.patch,
reference_files/}`, and `validation/{expected.json,known_bad.patch,known_bad/}`.

## task.toml — flat schema

All keys are top-level scalars (no `[table]`). Example (python):

```toml
version = "1.0"
id = "SIMPLE-001"
name = "python-duration-parser"
category = "simple_atomic"
primary_capability = "localized_bug_fix"
language = "python"
runtime = "python>=3.12"
difficulty = "easy"
official_reward = "binary"
internet = "disabled"
agent_timeout_seconds = 900
verifier_timeout_seconds = 120
cpu_cores = 2
memory_mb = 2048
disk_mb = 2048
public_test_command = "python3 -m unittest discover -s tests -v"
```

Required keys: `version, id, name, category, primary_capability, language, runtime, difficulty,
official_reward, internet, agent_timeout_seconds, verifier_timeout_seconds, cpu_cores, memory_mb,
disk_mb`. `official_reward` must be `"binary"`; `internet` must be `allow|allowlist|offline|disabled`.

The platform maps each eval to `category_name="simple"` and `agent_category="coding"` (per the accepted
category contract) regardless of the suite's own `category` value.

## environment/Dockerfile

A full language base image. It sets `WORKDIR /workspace/task`, copies `seed_repo/` and `instruction.md`
into the image, drops to a non-root user (e.g. uid `10001`):

```dockerfile
FROM python:3.12-slim-bookworm
RUN useradd --create-home --uid 10001 agent
WORKDIR /workspace/task
COPY seed_repo/ /workspace/task/
COPY instruction.md /workspace/instruction.md
USER agent
```

The platform **builds this Dockerfile unchanged** and then overlays the project's real agent adapter
(the reaper CLI runtime) on top in a wrapper stage, so the agent container has both the task toolchain
and reaper. `solution/`, `tests/`, and `validation/` are never part of this build context.

## Confidentiality boundary

- The **agent container** receives only `seed_repo/` (the workspace) and `instruction.md` (the prompt).
  `solution/`, `tests/`, `validation/`, `verifier.py`, known-bad material, and grading secrets never
  enter it.
- The **hidden verifier** (`tests/`) runs in a separate offline container against the final
  `/workspace/task`; the agent never sees it.
- The **agent container network is `allow`** so the real reaper agent can reach its model provider. The
  suite's `internet=...` describes task/verifier network intent and is honored by the isolated verifier
  (always offline), not by offlining the agent container.

## The verifier contract

`tests/verifier.py <submission_path>` grades the submission and prints **one JSON object on stdout**:
```json
{"task_id":"SIMPLE-001","reward":1,"passed":true,
 "checks":[{"name":"public_tests","passed":true,"detail":""},
           {"name":"hidden_contract","passed":true,"detail":""}]}
```
- `reward` is binary (1 iff all checks pass); `passed` equals all checks passed.
- `checks` names map to kinds: `public_tests`→functional, `hidden_contract`→hidden_test, others→test_suite.
- The verifier runs offline against `/workspace/task` after the agent stops and evidence is captured.
- Official binary reward = 1 only when the verifier exits 0, is not timed out, and every check passes.

## Creating evals

### Single eval (JSON file map)
```http
POST /api/projects/<projectId>/evals
Content-Type: application/json
{"files":{"task.toml":"...","instruction.md":"...","seed_repo/src/...":"...", ...}}
```

### Many evals from a suite (archive)
```http
POST /api/projects/<projectId>/evals:import-archive?format=zip
Content-Type: application/zip
<raw ZIP bytes containing tasks/<task>/... for each task>
```
A suite archive containing `tasks/` creates one eval row per task (`splitSuiteTasks`). The E2E also
shows creating each eval one-by-one via `POST /evals` to exercise the real per-eval creation flow.

### Categories and queues
Evals are project-scoped. Load them into a queue, run the real agent, then let the queue auto-judge
its archives into a report. Adaptive setup is per-project; there are no global default evals.

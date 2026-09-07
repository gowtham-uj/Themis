# Authoring a Themis eval (suite format)

Themis accepts **one** eval format: a project-scoped, immutable eval package described with a flat
`task.toml`, an initial agent workspace (`seed_repo/`), a self-contained environment image, a separate
hidden verifier, and validation material. This is the only accepted creation format for new evals.

Each eval is created per-project through the API, one eval per package, or many evals from a packed
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

## task.toml, flat schema

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

## environment/Dockerfile and the universal fat base

`environment/Dockerfile` remains required for package compatibility and verifier context validation. It must not copy or reference `solution/`, `tests/`, or `validation/`. The eval queue does not build one agent image per eval.

Every queue uses one platform fat base derived from `debian:bookworm-slim`. The image includes:

- build-essential, git, apt, sudo, and common shell tools;
- Node.js and npm;
- Python, pip, and venv;
- Go;
- Rust and Cargo;
- the non-root `agent` user with uid `10001`.

The selected agent adapter is overlaid once. Python, Node, Go, Rust, C, C++, and shell evals can then run sequentially in the same persistent queue container without installing a language toolchain for each eval.

## environment/setup.sh and environment/cleanup.sh

The platform wraps each package lifecycle script:

- `lifecycle-setup.sh` runs as root, calls the package's `environment/setup.sh`, then gives uid `10001` ownership of `/workspace/task`.
- The package setup receives the target path as `argv[1]`. It copies `seed_repo/` into that target and creates the baseline repository state.
- The agent runs as the non-root user.
- `lifecycle-cleanup.sh` calls the package's `environment/cleanup.sh` and verifies that the workspace is safe for the next eval.
- Baked language toolchains are never purged between evals.

The queue worker records setup, cleanup, and reset evidence. A cleanup or reset failure taints the persistent queue because the next eval can no longer trust the shared container state.

## Confidentiality boundary

- The **agent container** receives only `seed_repo/` (the workspace) and `instruction.md` (the prompt).
  `solution/`, `tests/`, `validation/`, `verifier.py`, known-bad material, and grading secrets never
  enter it.
- The **hidden verifier** (`tests/`) runs in a separate offline container against the final
  `/workspace/task`; the agent never sees it.
- The **agent container network is `allowlist`**. Every packet leaves through an nftables filter installed
  in the container's own network namespace, with a default drop policy. There is one list and it is an
  allowlist: nothing gets out unless an entry names it. Suite packages carry a single entry covering the
  whole address space, so egress is open today, because the agent has to reach whatever model endpoint the
  project points it at. Narrowing that is an edit to `SUITE_AGENT_ALLOWLIST` in `src/evals/package.ts`, not
  a switch to a different enforcement path. The suite's `internet=...` describes task/verifier network
  intent and is honored by the isolated verifier (always offline), not by offlining the agent container.

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
Evals are project-scoped. Load them into a queue, run the real agent, then inspect the sealed archive
through the project or central archive API. Adaptive setup is per-project; there are no global default evals.

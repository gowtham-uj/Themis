# Authoring a canonical agenteval eval package

Agenteval accepts exactly one eval definition format: a validated, immutable directory package. Flat
prompt/rubric task creation is rejected. The package may be submitted as an API JSON file map or as a
ZIP/TAR/TAR.GZ archive; both transports pass the same validator before any eval row is created.

## Required tree

```text
eval-name/
├── instruction.md
├── task.toml
├── README.md
├── environment/
│   ├── Dockerfile
│   ├── docker-compose.yaml       # optional, only for independent services
│   ├── entrypoint.sh
│   ├── healthcheck.sh
│   ├── setup.sh                  # optional runtime setup
│   ├── cleanup.sh                # optional trial cleanup
│   ├── seed/
│   └── repo/                     # exact initial repository shown to the agent
├── solution/
│   ├── solve.sh
│   ├── reference.patch
│   └── supporting-files/
├── tests/
│   ├── Dockerfile               # separate hidden-verifier image
│   ├── test.sh
│   ├── test_functional.*
│   ├── test_regressions.*
│   ├── test_edge_cases.*
│   ├── test_security.*
│   ├── test_performance.*
│   ├── fixtures/
│   └── oracle/
└── validation/
    ├── known_bad_patches/
    ├── expected_results.json
    └── flake_report.json
```

The validator requires non-empty content under `environment/repo/`, `solution/`, `tests/`, and
`validation/known_bad_patches/`. `solution/` must contain `solve.sh` or `reference.patch`. Submit a clean
source tree: generated/local-only content such as `.git/`, `node_modules/`, `__pycache__/`, `*.pyc`, test
caches, and OS metadata is rejected. Running local self-checks must not contaminate the package tree.

## Confidentiality boundary

The agent receives only:

- the text of `instruction.md` as its task prompt;
- an agent image built from the isolated `environment/` context;
- the contents of `environment/repo/` mounted at `/workspace`;
- values explicitly declared in `[agent_env]`.

The agent never receives or mounts the package-root `solution/`, hidden-verifier `tests/`,
`tests/oracle/`, `validation/`, verifier packages, expected results, grading secrets, or known-bad
patches. `environment/repo/` may contain the project's ordinary public test suite; that is agent-visible
source, not the package-root hidden verifier. The environment build context is physically limited to
`environment/`; the verifier build context is physically limited to `tests/`. The repository seed is
removed from the image-build context and mounted only as the per-run workspace. Package acceptance and
run startup reject protected directory names, oracle/hidden markers, grading artifacts, and duplicated
protected-file content inside the agent repository.

## `instruction.md`

Write desired end state, not solution steps. It must:

- enumerate every behavior the verifier enforces;
- use exact absolute paths such as `/workspace/src/parser.ts`;
- define required interfaces, schemas, protocol behavior, and performance limits;
- distinguish required behavior from allowed implementation freedom;
- avoid vague phrases such as “make it robust”;
- avoid exposing the reference solution;
- contain no requirement that exists only in hidden tests.

Hard rule:

> Every instruction requirement maps to one or more declared verifier checks, and every verifier check
> maps back to at least one instruction requirement.

The mapping is semantic, not just an id reference: every separately stated behavior and error case must
have an explicit assertion in at least one mapped verifier check. A check id in `requirements[].checks`
does not compensate for a verifier that omits part of the requirement.

## `task.toml`

The current schema is shown completely below. Use stable ids; never reuse an id for semantically
incompatible behavior.

```toml
[task]
id = "js-slug-normalization"
version = 1
name = "Normalize application slugs"
category = "javascript-bugfix"       # arbitrary project grouping name
language = "javascript"
tags = ["javascript", "strings", "bugfix"]
profile = "bugfix"                   # bugfix|feature|refactor|research|general|browser|etl|conversational
agent_category = "coding"            # coding|research|general|browser|data|conversational

[timeouts]
agent_seconds = 900
verifier_seconds = 300
build_seconds = 900

[resources]
cpu = 2
ram_mb = 4096
disk_mb = 8192
gpu = 0

[network]
policy = "allow"                     # allow|allowlist|offline; must match the queue
allowlist = []                        # required and non-empty for allowlist

[artifacts]
allowlist = ["diff.patch", "verifier-results.json"]

[agent_env]
NODE_ENV = "test"

[verifier]
separate = true
dockerfile = "tests/Dockerfile"
command = ["/tests/test.sh"]
checks = [
  { id = "functional-slug", kind = "functional" },
  { id = "hidden-boundaries", kind = "hidden_test" },
  { id = "regression-api", kind = "regression" },
  { id = "security-paths", kind = "security" }
]

[[requirements]]
id = "R1"
text = "Calling slugify() from /workspace/src/slug.js must return lowercase hyphenated slugs."
checks = ["functional-slug", "hidden-boundaries"]
critical = true

[[requirements]]
id = "R2"
text = "The exported slugify() interface in /workspace/src/slug.js must remain unchanged."
checks = ["regression-api"]
critical = true

[[requirements]]
id = "R3"
text = "Changes must remain under /workspace/src and must not access verifier files."
checks = ["security-paths"]
critical = true

[lifecycle]
# Optional. Prefer immutable Dockerfile setup. Paths must remain under environment/.
setup = "environment/setup.sh"
cleanup = "environment/cleanup.sh"
setup_timeout_seconds = 300
cleanup_timeout_seconds = 120

[explanations]
difficulty = "Requires locating incomplete normalization and handling punctuation/boundary cases."
reference_solution = "The reference changes the normalization pipeline without changing its API."
verification = "The isolated verifier runs public behavior, hidden boundaries, API regression and security checks."
expert_minutes = 20

[digests]
environment = "sha256:<author-recorded-environment-input-digest>"
verifier = "sha256:<author-recorded-verifier-input-digest>"
dependencies = "sha256:<dependency-lock-digest>"
```

Required metadata includes stable id/version, category, language, tags, timeouts, CPU/RAM/disk/GPU,
network policy, artifact allowlist, isolated-verifier configuration, difficulty/reference/verification
explanations, expert time, and digests. Each `requirements[].checks` id must exist in
`[verifier].checks`; unused verifier checks are rejected.

`[agent_env]` is visible to the agent. It must not contain answers, solution paths, oracle values,
hidden-test names, grader controls, or secrets. Provider credentials are configured by the adapter and
are not authored in an eval package.

`[network].policy` is enforced for the persistent agent container and must match the queue policy for
every eval loaded into that queue. A hosted model CLI normally needs `allow`, or `allowlist` containing
all provider endpoints; `offline` is suitable only when the selected adapter/model remains reachable
without external egress. The isolated hidden verifier is always offline regardless of this setting.

## Agent environment

`environment/Dockerfile` must inherit from the adapter image placeholder:

```dockerfile
FROM ${AGENTEVAL_AGENT_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends <pinned-packages> \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
```

Agenteval replaces the placeholder with the queue’s selected built adapter image. Only `environment/`
is sent to this build. `environment/repo/` is removed before image build and mounted fresh per run, so
different evals may share an environment image without embedding task source.

Prefer fixed dependencies in the image. Pin package versions and repository commits. Never download or
copy `../solution`, `../tests`, or `../validation`; Dockerfile sources outside the isolated context are
rejected.

`entrypoint.sh` starts services or run-specific state. `healthcheck.sh` must probe real readiness rather
than sleep a fixed duration. Use fixed seeds.

If `setup.sh` is necessary, it must be:

```bash
#!/bin/bash
set -euo pipefail
```

It must be deterministic, idempotent, noninteractive, bounded, and free of grading content. The platform
sets `AGENTEVAL_TRIAL_ID` for both setup and cleanup so trial-scoped external state can use one stable key.
It should write machine-readable setup details where requested. Setup failure is infrastructure failure,
not an agent-quality failure.

`cleanup.sh` is optional because workspace/container destruction is primary cleanup. When present, it
must use `AGENTEVAL_TRIAL_ID`, be idempotent, target only that trial’s resources, preserve evidence, and
also use `set -euo pipefail`. The platform restores the trusted package copy before running cleanup, so
agent modifications to the workspace copy cannot change cleanup behavior.

## Hidden verifier

`tests/Dockerfile` is built separately with `tests/` as its only context:

```dockerfile
FROM node:22-alpine
COPY . /tests
RUN chmod +x /tests/test.sh
```

The verifier runs after the agent process ends, after the source diff and native agent evidence are
captured. It sees the final `/workspace`; the agent never sees the verifier image. Verifier networking is
offline.

`tests/test.sh` must write exactly one trusted result file to the path in
`AGENTEVAL_VERIFIER_RESULTS` (normally `/workspace/.agenteval/verifier-results.json`). Remove or
overwrite any pre-existing file atomically. Example:

```json
{
  "checks": [
    {"id":"functional-slug","kind":"functional","status":"pass","duration_ms":120},
    {"id":"hidden-boundaries","kind":"hidden_test","status":"pass"},
    {"id":"regression-api","kind":"regression","status":"pass"},
    {"id":"security-paths","kind":"security","status":"pass"}
  ]
}
```

Statuses are `pass`, `fail`, `error`, or `skipped`. Every declared verifier id must appear exactly once.
Missing/invalid result files, missing ids, verifier timeout, non-zero exit, or any non-pass required
check produce binary reward `0`.

## Official reward and diagnostics

Official task reward is binary:

- `1`: the separate verifier exits successfully and every required non-skipped check passes;
- `0`: any required outcome fails, errors, times out, or is missing.

Partial diagnostic dimensions explain the binary result but never replace it: core correctness,
regression safety, edge cases, concurrency, durability, security, performance, scope discipline, test
quality and anti-cheating.

Trace/diff metrics are diagnostic: tool/file/command counts, test/compile recovery, tokens/context,
patch/churn, crashes/timeouts/loops, localization, root-cause latency, verification, first-edit quality,
tool efficiency, false-success and downstream-agent tax. Metrics record provenance (`exact`, `derived`,
`judge-derived`, `unknown`) and evidence refs. Missing evidence is `unknown`, never zero.

## Validation artifacts

`solution/` is for pre-acceptance oracle validation only. It is never copied into an eval run.

`validation/expected_results.json` describes expected oracle/no-op/known-bad outcomes.
`validation/flake_report.json` records repeated verifier behavior. Include intentionally wrong patches in
`validation/known_bad_patches/`. These files are execution evidence, not predictions: never claim a run,
pass, failure, alternative, or flake rate that was not actually produced by the exact package/verifier
revision being submitted. After any prompt, source, solution, verifier, or validation change, rerun the
full matrix and regenerate the report before release.

Before release, an eval must demonstrate:

1. static structure/security validation passes;
2. agent and verifier images build from scratch;
3. protected content is absent from the agent image/workspace;
4. oracle solution scores `1` repeatedly (minimum five deterministic runs);
5. untouched/no-op scores `0`;
6. known-bad and grader-hacking solutions score `0`;
7. legitimate alternative solutions score `1`;
8. verifier flake rate is acceptable and recorded;
9. failures reflect intended technical difficulty, not ambiguity or infrastructure;
10. package, environment, verifier, prompt, model/tool budgets and seed are immutably versioned.

## Create through JSON file map

```http
POST /api/projects/<projectId>/evals
Content-Type: application/json
```

```json
{
  "files": {
    "instruction.md": "...",
    "task.toml": "...",
    "README.md": "...",
    "environment/Dockerfile": "...",
    "environment/entrypoint.sh": "...",
    "environment/healthcheck.sh": "...",
    "environment/repo/src/app.ts": "...",
    "solution/solve.sh": "...",
    "tests/Dockerfile": "...",
    "tests/test.sh": "...",
    "validation/known_bad_patches/bad.patch": "...",
    "validation/expected_results.json": "...",
    "validation/flake_report.json": "..."
  }
}
```

Values may also be `{ "encoding":"utf8|base64", "content":"..." }`. Use base64 for binary fixtures.
The total decoded package limit is 64 MiB.

## Create through archive

```http
POST /api/projects/<projectId>/evals:import-archive?format=zip
Content-Type: application/zip
<raw ZIP bytes>
```

Formats: `zip`, `tar`, `tar.gz`. One wrapper directory such as `eval-name/` is accepted and stripped.
Archives are read in quarantine without filesystem extraction and reject absolute/traversal paths,
symlinks/hardlinks, duplicate paths, unsupported entry types, excessive file count, compressed-size or
uncompressed-size limits. Invalid input creates no eval.

## Categories and queues

`[task].category` is an arbitrary grouping label, independent of `agent_category` execution semantics.
List categories:

```http
GET /api/projects/<projectId>/eval-categories
```

Load every enabled eval in one category into a stopped/draft queue, skipping existing items:

```http
POST /api/projects/<projectId>/queues/<queueId>/items:load-category
Content-Type: application/json

{"category_name":"javascript-bugfix","repeats":3,"enabled":true}
```

All evals loaded into one persistent queue must resolve the same adapter image, environment digest,
network policy and port set. Split incompatible environments into separate queues.

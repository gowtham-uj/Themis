# Canonical eval package

This is the only accepted eval definition format. Flat prompt/rubric task creation, field patching and
legacy task-source ingest are rejected by the API. Internally the package is projected into `tasks` rows
for queue/run compatibility, but the immutable package is the source of truth.

## Required structure

See [`docs/eval-authoring.md`](../docs/eval-authoring.md) for the complete author contract and examples.
Required roots are `instruction.md`, `task.toml`, `README.md`, `environment/`, `solution/`, `tests/` and
`validation/`. `environment/repo/` is the initial agent workspace. `tests/` builds an isolated verifier.

## Creation transports

- `POST /api/projects/:id/evals`: JSON file map with UTF-8/base64 values.
- `POST /api/projects/:id/evals:import-archive?format=zip|tar|tar.gz`: raw archive bytes.

Archive entries are read in quarantine without filesystem extraction. Reject traversal/absolute paths,
symlinks/hardlinks, duplicate paths, unsupported entry types, file-count limits and compressed or
uncompressed size limits. A single wrapper directory is stripped. Both transports use the same package
validator and atomically create no row on failure.

## Validation

Validate required files/directories, TOML schema, instruction↔verifier check bidirectional alignment,
resource/time/network/artifact metadata, explanation/digest fields, lifecycle scripts, isolated build
contexts, JSON validation artifacts and protected-content leakage. Compute a sorted file manifest and
content-addressed package digest; verify both again at queue startup and before verifier execution.

Packages are immutable. A semantic change is a complete new package version, never a PATCH of derived
row fields.

## Isolation and execution

- Build the selected adapter image first.
- Build the agent task image from `environment/` only, replacing
  `FROM ${AGENTEVAL_AGENT_IMAGE}` with the selected adapter image. Remove `environment/repo/` from this
  build context; mount it fresh at `/workspace` per eval.
- Never include or mount `solution/`, `tests/`, `validation/`, verifier dependencies, expected results or
  grading secrets in the agent image/container/workspace/env.
- Optional setup/cleanup scripts must live under `environment/`, use `set -euo pipefail`, be bounded and
  idempotent. Restore the trusted cleanup script after agent execution before running it.
- Capture source diff and native agent evidence after the agent process stops and before verifier access.
- Build the verifier from `tests/` only and run it in a separate offline container against final
  `/workspace`. Delete any pre-planted result file first. Require a complete machine-readable check vector.
- Run cleanup after verifier/evidence capture, then reset the shared queue workspace and seal the archive.

## Reward and diagnostics

Official reward is binary: `1` only when the isolated verifier exits successfully and every required
non-skipped check passes; otherwise `0`. Partial verifier dimensions and trace/diff metrics
are diagnostic and never replace binary task success.

Persist metrics with explicit provenance (`exact|derived|unknown`) and evidence refs.
Missing evidence is unknown, not zero. Dataset reporting groups by package version/digest, environment and
verifier digests, category/language/repository/difficulty, agent/model/tool budgets, network policy and
seed.

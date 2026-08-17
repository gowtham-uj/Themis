# agenteval

A self-hosted, API-only agent evaluation backend. It creates and versions agent adapters and eval
packages, runs eval queues in persistent Podman containers, captures canonical events and native traces,
executes deterministic verifiers, seals one immutable evidence archive per eval run, and stores those
archives in a flat central catalog keyed by run id.

## Current scope

The HTTP API is the only application interface. There is no bundled frontend, judge subsystem,
judgement API, reusable-rubric API, or standalone run-artifact API.

Projects own canonical eval packages and adapter configurations. Queues may use a project adapter, an
explicitly shared adapter-store entry, or an explicitly selected built-in adapter. Each active queue owns
one persistent real Podman container and executes its evals sequentially with per-eval setup and cleanup.
Protected solution, test, and validation content never enters the agent container.

Every sealed eval archive contains the run metadata, canonical events, agent logs and native traces,
verifier output, deterministic metrics, cleanup/reset evidence, and captured generated outputs. The
central archive API supports cross-project and project-scoped filtering by agent commit, queue, batch,
run, task, model, provider, status, and reward.

See:

- [`docs/README.md`](./docs/README.md) — user and operator documentation.
- [`docs/eval-authoring.md`](./docs/eval-authoring.md) — canonical eval package authoring.
- [`docs/platform-api-guide.md`](./docs/platform-api-guide.md) — API operations.
- [`plan/adapter-generation-guide.md`](./plan/adapter-generation-guide.md) — real CLI adapter integration.
- [`plan/execution.md`](./plan/execution.md) — queue container and evidence lifecycle.

## Quick start

```bash
npm install
npm run typecheck
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npm test
npm run build
node dist/src/cli/serve.js --port 8080 --data-dir ./data
```

Runtime and model acceptance paths use real systems. `PodmanRuntime` is the supported container backend;
there is no fake local-process runtime or mocked model gateway. This host requires
`AGENTEVAL_PODMAN_SUDO=1`. See `CLAUDE.md` for the cgroup and Podman constraints.

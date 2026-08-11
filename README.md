# agenteval

A self-hosted **general agent evaluation platform**: run autonomous agents against eval tasks, capture
rich canonical traces (thinking, messages, tool calls, results, tokens), judge each run with a
**three-layer verdict** — scores + localized diagnostics + located **findings** — plus a two-lens
**improvements synthesis** (`withoutSource` always; `withSource` gated by agent category), and track
regressions across agent versions. Coding agents are one pre-defined category.

**This directory is the implementation.** The spec lives in [`plan/`](./plan/) (the source of truth —
read `plan/README.md` and `plan/roadmap.md` first). When code and plan diverge, fix one and record why.

## Current scope

The supported acceptance surface is backend/API-only. Projects own evals and at most one adapter;
queues may explicitly select a shared adapter-store row. Each active queue owns one persistent real
Podman container and runs its evals sequentially. The judge is one real PI SDK agent using the
versioned custom prompt and restricted archive tools. Frontend work is deferred.

See:

- [`docs/README.md`](./docs/README.md) — complete user/operator documentation.
- [`docs/eval-authoring.md`](./docs/eval-authoring.md) — canonical eval package authoring and strict creation.
- [`docs/platform-api-guide.md`](./docs/platform-api-guide.md) — end-to-end API operations.
- [`plan/adapter-generation-guide.md`](./plan/adapter-generation-guide.md) — integrate a real CLI agent.
- [`plan/execution.md`](./plan/execution.md) — queue container and evidence lifecycle.
- [`plan/judge.md`](./plan/judge.md) — PI judge, verdict, and report lifecycle.

## Quick start

```bash
npm install
npm run typecheck
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npm test
npm run build
node dist/src/cli/serve.js --port 8080 --data-dir ./data
```

Every runtime/model acceptance path is real, including tests. `PodmanRuntime` is the supported backend;
there is no fake/local-process runtime or mocked model gateway. This host requires
`AGENTEVAL_PODMAN_SUDO=1`. See `CLAUDE.md` for the cgroup and Podman constraints.

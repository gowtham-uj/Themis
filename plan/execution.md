# Execution and sandbox

Every evaluated agent runs as a real CLI inside a queue-owned persistent Podman container.

## Queue-owned container model

- One persistent container per active queue.
- Evals run sequentially inside that queue container; separate queues provide parallelism.
- Suite evals share a fat Debian base with build essentials, git, apt, sudo, non-root uid 10001, and the
  supported language toolchains baked in by default: node/npm, python3/pip/venv, go, and rust/cargo
  (gcc/g++ ship via build-essential).
- The selected project/shared/built-in adapter is overlaid into the base image.
- Baked language toolchains are never re-installed or purged at eval time. Per-eval setup/cleanup is
  reserved for author dependencies (via `environment/setup.sh` / `cleanup.sh`) and any language the base
  does not carry; the platform synthesizes no apt install for the baked languages.
- Per-eval cleanup removes temporary author dependencies and verifies a clean next-run state.
- `/workspace` is reset between evals only after evidence is copied and the eval archive is sealed.

## Eval lifecycle

```text
workspace preparation
→ trusted setup
→ baseline capture
→ real adapter/provider/model connection
→ real agent execution
→ canonical + native evidence extraction
→ category-aware diff/output capture
→ separate hidden verifier
→ deterministic metrics and integrity checks
→ trusted cleanup + cleanup verification
→ residual-process cleanup
→ root workspace reset
→ terminal metadata finalization
→ immutable archive sealing
→ central archive copy
```

Any setup, verifier, evidence, cleanup, reset, or archive failure is recorded explicitly. Cleanup,
evidence, reset, and archive failures taint the queue and prevent the next eval from running in a
contaminated workspace.

Provider/model failures are classified as first-class causes, including quota exhaustion, rate limiting,
context-length exhaustion, authentication/model-not-found, and temporary model unavailability.

## Confidentiality boundary

Only public task material and `seed_repo` content enter the agent workspace. `solution/`, hidden tests,
validation data, and verifier implementation remain outside the agent container. Verification runs in a
separate container/context after agent execution.

## Evidence and archives

The platform retains:

- Canonical `events.jsonl`.
- Agent stdout/stderr and adapter-native traces.
- Diff or output manifest according to agent category.
- Verifier result and official binary reward.
- Deterministic checks and run metrics.
- Setup, cleanup, reset, and residual-process evidence.
- Evidence-integrity diagnostics.
- Captured generated outputs.

A run archive is sealed only after terminal database finalization and platform-owned evidence generation.
The manifest stores sorted file paths, sizes, and SHA-256 digests. The sealed archive is then copied to the
central archive store as `archives/<runId>/` with a sibling `archives/index.json` catalog.

## Run and queue control

There are no standalone run-level control routes. Control lives on the queue container: PATCH
`/api/projects/:id/queues/:queueId/container` with `action: pause|resume|abort` acts on the current run in
the active container (abort seals partial evidence and the worker continues to the next claim). DELETE on
the container stops it. Queue APIs start, inspect, pause, resume, stop, and remove persistent queue
containers. The introspection bridge executes only against an already live queue container and streams
exact stdout/stderr bytes in framed responses.

## Container runtime rules

- All lifecycle operations go through `ContainerRuntime`.
- Domain logic never shells out directly to Podman or Docker.
- API keys and adapter-declared environment variables are injected only into the agent command environment.
- The selected image, source commit, model/provider, adapter configuration, and run provenance are recorded.

# Roadmap

## Delivered backend foundation

- Canonical event schema and JSONL capture.
- Built-in and declarative agent adapters.
- Project-owned adapter CRUD, explicit adapter sharing, source-commit build provenance, and image reuse.
- Strict canonical eval-package creation/import and immutable project eval storage.
- Persistent named eval queues with one real Podman container per active queue.
- Fat suite base image with node/python/go/rust toolchains baked in, plus per-eval setup and cleanup for
  author dependencies.
- Separate hidden verifier execution outside the agent container.
- Provider quota/rate/context/model failure classification.
- Deterministic run metrics and evidence-integrity artifacts.
- Immutable one-file-tree eval archives and central project/commit/queue/batch/run archive storage.
- Granular archive listing/filtering and archive file retrieval APIs.
- Run control, queue-container introspection, SSE/NDJSON events, auth, and queue-bound agent-commit
  watchers (signed inbound hook + manual fire). No outbound webhooks.

## Current product boundary

The platform is backend/API-only. Removed and out of scope:

- Application frontend.
- Judge and judgement execution.
- Queue analysis/report generation.
- Findings, regression, release, and improvement APIs.
- Reusable rubric CRUD API.
- Standalone mutable run-artifact API.

Task packages may still contain rubric/check metadata for deterministic evaluation semantics. Generated
outputs remain evidence inside sealed eval archives.

## Next backend priorities

1. Expand archive query indexes and pagination for very large stores.
2. Add whole-archive streaming/download without reintroducing a second artifact subsystem.
3. Add retention policies for central archives keyed by project and agent version.
4. Add API contract tests proving removed routes remain unavailable.
5. Add full real-Podman queue acceptance coverage for adapter sharing, setup/cleanup isolation, and archive
   retrieval through the public API.
6. Improve operator documentation and OpenAPI generation for the API-only interface.

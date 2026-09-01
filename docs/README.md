# Agenteval user documentation

Use these documents to operate the backend/API platform without reading implementation source:

- [API reference](./api-reference.md) — every endpoint, request body, and response shape, as implemented.
- [Canonical eval authoring](./eval-authoring.md) — required package tree, `task.toml`, environment,
  solution/verifier isolation, lifecycle scripts, validation gates, JSON and archive creation.
- [Platform API operator guide](./platform-api-guide.md) — projects, adapters, evals/categories, queues,
  containers, introspection, metrics, and central archive retrieval.
- [Adapter generator authoring](../plan/adapter-generation-guide.md) — complete real CLI integration
  contract, generator request/output, provider wiring, parser/evidence and build validation.

Normative architecture and data contracts remain in [`plan/`](../plan/). These user guides provide the
copy-paste creation and operation workflow and must stay aligned with those specifications.

# Themis documentation

Start here if you want to use the platform without reading source code.

- [Getting started](./getting-started.md) covers installation, model configuration, a first project, queue, pipeline run, and archive inspection.
- [Concepts](./concepts.md) explains projects, adapters, evals, runs, pipeline generations, Phase 1 results, campaigns, and archive views.
- [API reference](./api-reference.md) lists the implemented HTTP endpoints, request conventions, critical bodies, and response behavior.
- [Platform API guide](./platform-api-guide.md) is the operator runbook for readiness checks, adapter builds, queue control, pause, resume, retry, and artifact retrieval.
- [Eval authoring](./eval-authoring.md) defines the canonical package tree, hidden verifier boundary, lifecycle scripts, and validation cases.
- [Themis system design](./themis-system-design.md) explains eval execution, immutable archives, Phase 1, Phase 2, web research, and recovery.
- [Security policy](../SECURITY.md) explains vulnerability reporting and the runtime boundaries operators must preserve.
- [Contributing](../CONTRIBUTING.md) lists the local checks and change rules.

The files under [`plan/`](../plan/) are the detailed design and data contracts. The guides in this directory explain the as-built operator path and should stay aligned with the source.

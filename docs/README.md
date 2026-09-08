# Themis documentation

Start here if you want to use the platform without reading source code.

- [Getting started](./getting-started.md) takes an empty data directory to a finished pipeline run.
- [Concepts](./concepts.md) is the glossary. Read it when a word in the API or console is unfamiliar.
- [API reference](./api-reference.md) documents every implemented endpoint and its response behavior.
- [Platform API guide](./platform-api-guide.md) is the operator runbook: adapter builds, queue control, pause, resume, retry, artifact retrieval.
- [Eval authoring](./eval-authoring.md) defines the eval package tree and the boundary that keeps the hidden verifier away from the agent.
- [Themis system design](./themis-system-design.md) explains how execution, archives, Phase 1, and Phase 2 fit together.
- [Security policy](../SECURITY.md) covers vulnerability reporting and the runtime boundaries operators must preserve.
- [Contributing](../CONTRIBUTING.md) lists the local checks and change rules.

The files under [`plan/`](../plan/) are the detailed design and data contracts. These guides describe the as-built operator path, and they should stay aligned with the source.

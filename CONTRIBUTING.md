# Contributing

Themis is a TypeScript platform for running coding-agent evals, preserving their evidence, and producing per-eval and cross-eval judgements.

## Before you start

- Use Node.js 22 or newer.
- Install Podman. The test suite uses real containers.
- Read [`CLAUDE.md`](./CLAUDE.md) and the relevant document under [`plan/`](./plan/).
- Do not add a local-process substitute for `PodmanRuntime` or a mocked production model path.

## Local setup

```bash
npm ci
cp .env.example .env.local
npm run typecheck
npm run lint
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npm test
```

Build and check the console separately:

```bash
cd web
npm ci
npm run lint
npm run build
```

## Change rules

1. Keep protected eval material out of the agent container. This includes `solution/`, `tests/`, `validation/`, hidden checks, and verifier code.
2. Read credentials from environment variables. Never put a real key in source, a test fixture, a prompt, an archive, or documentation.
3. Use synthetic credential-shaped strings in tests.
4. Preserve immutable run and archive history. A retry creates a new attempt or result version rather than rewriting an old one.
5. Return specific RFC 7807 errors for expected failures. Log unexpected failures without leaking paths or secrets to clients.
6. Add a short purpose comment to public functions.
7. Update the matching guide or design document when an API, state transition, archive shape, or operator workflow changes.

## Tests

A change is not ready until these pass:

```bash
npm run typecheck
npm run lint
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npm test
cd web && npm run lint && npm run build
```

The external live-model smoke remains opt-in through `AGENTEVAL_LIVE=1`. Do not replace it with a mock and call that equivalent.

## Pull requests

Keep a pull request focused. Explain the user-visible behavior, the failure mode it fixes, the tests you ran, and any migration or rollback work. Include screenshots for console changes and request/response examples for API changes.

## License of contributions

The project ships under the Themis Personal Use and No-AI License (see `LICENSE`). It is source-available, not open source: personal use by individuals is allowed, corporate use and AI training are not. By opening a pull request you agree that your contribution is licensed under those same terms.

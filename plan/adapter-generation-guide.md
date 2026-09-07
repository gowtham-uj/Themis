# Adapter Generator Authoring Guide

This guide is the executable contract for integrating a real CLI agent with agenteval through
`POST /api/projects/:projectId/adapters/from-generator`.

An adapter generator is a user-authored **bash or Node.js script**. Agenteval optionally clones the
agent source, provisions a small discovery environment, executes the script, validates the single JSON
object it writes to stdout, persists the resulting project-linked adapter, and can build its real OCI
image immediately. Generators describe real agents; they are not agent implementations, test doubles,
or model gateways.

## Invariants

- One owned adapter row per project.
- A queue uses either that project's owned adapter or an explicitly selected adapter-store entry through
  `shared_adapter_id`. There is no implicit cross-project fallback.
- A shared adapter remains owned by its source project. Consumer projects do not copy it.
- Agent/model/provider execution is real. Missing Podman, registry access, credentials, CLI support, or
  model access is a visible blocked/failed state, never a fake or mock substitution.
- One persistent Podman container belongs to one active queue. It is built once, connection-checked once,
  optionally configured once, and then executes the queue's evals sequentially.
- The adapter must preserve the native evidence required to understand what the CLI actually did.
- The adapter's stdout parser must produce canonical events. Unknown CLI protocols need either a thin
  wrapper in the image that emits canonical JSONL or a deliberately implemented parser kind.

## Request

```http
POST /api/projects/:projectId/adapters/from-generator
Content-Type: application/json
```

Source-build agent:

```json
{
  "agent_id": "my-agent",
  "name": "My Agent",
  "generator": "#!/bin/bash\nset -euo pipefail\n...",
  "install_type": "source-build",
  "source_repo": "https://github.com/example/my-agent.git",
  "source_ref": "v1.2.3",
  "default_provider": "nuralwatt",
  "default_model": "deepseek-v4-flash",
  "build": true
}
```

Published npm agent (no git clone required):

```json
{
  "agent_id": "my-agent",
  "name": "My Agent",
  "generator": "#!/usr/bin/env node\n...",
  "install_type": "npm",
  "default_provider": "nuralwatt",
  "default_model": "deepseek-v4-flash",
  "build": true
}
```

`build` defaults to `true`. Set it to `false` only when inspecting/persisting the generated contract
before a real build.

## Generator environment

| Variable | Meaning |
|---|---|
| `AGENTEVAL_PROJECT_ID` | Owning project id. |
| `AGENTEVAL_AGENT_ID` | Requested stable agent id. The output `agent_id` must match exactly. |
| `AGENTEVAL_SOURCE_REPO` | Source repository, or an empty string for npm installs. |
| `AGENTEVAL_SOURCE_REF` | Requested ref, or an empty string. |
| `AGENTEVAL_PROVIDER` | Requested default provider. |
| `AGENTEVAL_MODEL` | Requested default model. |
| `AGENTEVAL_WORKSPACE_DIR` | Checked-out source for source-build installs; an empty temporary directory for npm installs. |
| `AGENTEVAL_CREDENTIALS_DIR` | Temporary directory containing one file per available credential name. Never print values. |
| `AGENTEVAL_OUTPUT_PATH` | Reserved; currently empty, which means emit JSON to stdout. |

The script's stdout must contain **only one JSON object**. Send diagnostics to stderr. The platform
stores bounded generator stdout/stderr for troubleshooting, so secrets must never be printed.

Supported script entrypoints:

```bash
#!/bin/bash
```

```javascript
#!/usr/bin/env node
```

## Output contract

```json
{
  "agent_id": "my-agent",
  "name": "My Agent",
  "description": "Real CLI integration",
  "format_version": 1,
  "install_type": "npm",
  "image": "localhost/agenteval-my-agent:latest",
  "source_repo": null,
  "source_ref": null,
  "containerfile": "FROM node:22-bookworm\n...",
  "default_provider": "nuralwatt",
  "default_model": "deepseek-v4-flash",
  "command": {
    "argv": ["my-agent", "run", "--prompt", "{{prompt}}"],
    "env": {},
    "cwd": "/workspace",
    "timeout_ms": 900000
  },
  "derive_connection_check": true,
  "configure": {
    "argv": ["my-agent", "configure", "--provider", "{{provider}}", "--model", "{{model}}"],
    "env": {},
    "cwd": "/workspace",
    "timeout_ms": 120000
  },
  "provider_config": {
    "credentialEnv": {
      "nuralwatt": {
        "OPENAI_API_KEY": "AGENTEVAL_MODEL_API_KEY",
        "OPENAI_BASE_URL": "NURALWATT_BASE_URL"
      }
    }
  },
  "parser_kind": "canonical-jsonl",
  "parser_config": null,
  "evidence": {
    "paths": [".my-agent/runs", ".my-agent/logs"],
    "required_paths": [".my-agent/runs"]
  },
  "shared": false,
  "enabled": true
}
```

### Required output

- `agent_id`: non-empty stable id; must equal request `agent_id`.
- `name`: non-empty display name.
- `install_type`: `source-build`, `npm`, or `binary`.
- `image`: non-empty OCI image tag.
- `containerfile`: non-empty build recipe for the real CLI.
- `command.argv`: exact non-shell argv used for eval prompts.
- `connection_check` or omission of it (omission derives a probe from `command`).
- `parser_kind`: `canonical-jsonl`, `pi-jsonl`, or `reapercode-jsonl`.
- `evidence.paths`: paths relative to `/workspace`.
- `source_repo` for `source-build` and `binary`; optional/null for `npm`.

`derive_connection_check` is accepted as the human-facing spelling. Internally the stored field is
`connectionCheckDerived`. If no explicit `connection_check` is emitted, derivation is enabled.

## Install types

### `source-build`

Agenteval clones `source_repo` at `source_ref`, writes the generated Containerfile into that checkout,
and sends the checkout as the real Podman build context. The generated recipe normally uses `COPY . .`,
installs dependencies, builds the CLI, and exposes a stable executable in `PATH`.

The resolved source commit and resulting image id are persisted as build provenance.

### `binary`

Same as `source-build` (clone `source_repo` at `source_ref` → build context), except the recipe COPYs a
committed prebuilt artifact instead of running `npm ci`/`tsc`. This is for agents that publish a
single-file bundle (e.g. ReaperCode's `bin/reaper.mjs`) so the image builds in seconds and reuses by
commit + image id.

```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY bin/reaper.mjs /opt/reaper/bin/reaper.mjs
RUN printf '#!/bin/sh\nexec node /opt/reaper/bin/reaper.mjs "$@"\n' > /usr/local/bin/reaper \
    && chmod +x /usr/local/bin/reaper
```

### `npm`

Agenteval creates an otherwise empty build context containing the generated Containerfile. The recipe
must install the published agent package itself, for example:

```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @scope/agent@1.2.3
WORKDIR /workspace
CMD ["agent", "--help"]
```

Pin a package version for reproducibility. Do not use a host-installed CLI or bind host source into the
queue container.

## Provider/model configuration

There are two complementary mechanisms.

### Runtime environment mapping

`provider_config.credentialEnv` maps the selected provider to
`{ agentEnvironmentName: harnessCredentialName }`. Values are injected only into connection/configure/
eval commands; they are not baked into the image.

```json
{
  "credentialEnv": {
    "nuralwatt": {
      "OPENAI_API_KEY": "AGENTEVAL_MODEL_API_KEY",
      "OPENAI_BASE_URL": "NURALWATT_BASE_URL"
    },
    "anthropic": {
      "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"
    }
  }
}
```

### Optional `configure`

Use `configure` only when the CLI requires a persistent config file. It runs once after the real
connection check and before the first eval in the queue container. A non-zero exit fails the queue.
Its command/result are stored under:

```text
projects/<project>/queues/<queue>/batches/<batch>/configure/configure.json
```

Because one container serves many evals, configure must select the queue's pinned provider/model, not
an eval-specific model.

## Command templates

Supported placeholders in image, argv, cwd, and env strings:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | Eval prompt (or the standard probe prompt for derived connection checks). |
| `{{provider}}` | Queue provider. |
| `{{model}}` | Queue model. |
| `{{workspace}}` | `/workspace`. |
| `{{run_id}}` | Durable run/check/configure id. |
| `{{project_id}}` | Project id. |
| `{{credential:NAME}}` | Named harness credential, or empty when unavailable. |
| `{{param:path.to.value}}` | Nested adapter parameter. |
| `{{override_env:NAME}}` | Explicit project/queue adapter environment override. |

No shell interpolation is applied to `argv`. If a CLI needs shell behavior, put a wrapper executable in
the image and invoke it as an argv entry.

## Output parsing and wrappers

`canonical-jsonl` is the extensible default. Each stdout line is one canonical event from
`plan/event-schema.md`. Keep banners and diagnostics on stderr. The harness owns final `run.start` and
`run.end` boundaries and normalizes run ids/sequence numbers.

When the native CLI emits a different JSON stream, install a wrapper in the image that:

1. launches the real CLI,
2. forwards its stderr,
3. parses each native stdout record,
4. emits canonical `message`, `thinking`, `tool.call`, `tool.result`, `usage`, and `error` events,
5. preserves the original native stream under a declared evidence path,
6. exits with the real CLI's exit code.

Do not discard unknown native records; store them in evidence even if they cannot yet be mapped.

## Evidence

All paths are relative to `/workspace` and cannot escape it. Paths can be files or directories.
`required_paths` should contain only evidence without which archive consumers cannot reliably reconstruct the
run. Missing required evidence taints the queue and stops subsequent evals.

At minimum preserve:

- native session/trajectory JSONL,
- tool-call logs,
- CLI diagnostic logs,
- any model usage metadata not represented in canonical events.

Evidence is copied before eval cleanup and workspace reset, then included in the immutable content-hash
archive retained for later analysis.

## Sharing

Set `shared: true` to publish the owned adapter in:

```http
GET /api/adapters/store
```

A consumer project selects it explicitly while creating or patching a queue:

```json
{
  "name": "codex regression queue",
  "shared_adapter_id": "adapter-row-id",
  "model": "deepseek-v4-flash",
  "provider": "nuralwatt"
}
```

The queue stores both `shared_adapter_id` and the shared adapter's `agent_id`. Shared adapters cannot be
rebuilt, execution-edited, disabled/unshared, or deleted while consumer queues reference them. Remove or
replace those queue references first.

## Validation and build flow

1. `GET /api/adapters/generator-contract` — machine-readable discovery contract.
2. `POST .../adapters/from-generator` with `build:false` — run and persist the generator contract.
3. `POST .../adapters/:adapterId/validate` — render image, command, connection check, configure, and evidence without execution.
4. `PATCH .../adapters/:adapterId` — correct the contract; build provenance resets when build inputs change.
5. `POST .../adapters/:adapterId/build` — real Podman image build.
6. Create a queue and eval items.
7. `PUT .../queues/:queueId/container` — one real queue container; connection check, configure, sequential evals.
8. Inspect connection/configure artifacts and live root bridge if needed.
9. Verify each immutable eval archive.
10. Retrieve the queue run archives, metrics, traces, and verifier results through the API.

## Acceptance checklist

- Generator works from both `#!/bin/bash` and `#!/usr/bin/env node`.
- `agent_id`, image, install type, source requirements, command, parser, evidence, and Containerfile validate.
- OCI image builds from a pinned source ref or pinned npm package.
- CLI responds through the real selected provider/model during connection check.
- Configure (if present) succeeds and records queue/batch-scoped provenance.
- At least two evals run sequentially in the same runtime container id.
- Eval command cwd and timeout match the generated contract.
- Canonical events identify the custom agent id, not a built-in adapter id.
- Raw stdout/stderr and native evidence are retained before cleanup.
- Workspace cleanup/reset succeeds; the second eval has no first-eval workspace residue.
- Archives verify byte-for-byte.
- Archive integrity verification succeeds for every selected run.
- The central archive store retains the complete sealed evidence tree and manifest.

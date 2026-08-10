# Agent Adapter SDK — integrate a real CLI agent

An agenteval **project is bound to one agent under test**. That agent is treated as a real CLI tool
running inside the project's queue-owned Podman container. The project owns one adapter definition
that teaches agenteval how to configure that CLI for a provider/model, verify the real connection,
run prompts, parse live output, and collect the CLI's native logs and trajectories.

Adapters are project-scoped CRUD resources. They are not test doubles, model simulators, or agent
implementations. Every connection check and eval invokes the real CLI and the real configured model
provider. If Podman, the CLI image, credentials, provider, or model is unavailable, the run is blocked
or failed explicitly; it is never replaced with a fake or mock.

## Lifecycle contract

For each queue container, agenteval performs this order:

1. Resolve the project's single enabled adapter and selected provider/model.
2. Start the adapter's pinned OCI image as the persistent queue container.
3. Render and run `connection_check` through the real agent CLI.
4. Parse the probe with the adapter parser and require both exit code 0 and at least one real model
   message. Store the probe's raw stdout, stderr, canonical events, and result.
5. Clear the shared workspace.
6. For each ordered eval: prepare workspace → eval setup script → adapter command → live canonical
   parsing + raw stream capture → native evidence extraction → deterministic checks → eval cleanup →
   cleanup verification → residual-process kill → workspace reset → immutable archive seal.
7. After the queue drains, keep its container alive for privileged operator introspection until it is
   explicitly stopped.

The adapter owns agent-specific knowledge. Queue orchestration must not contain CLI flags, provider
configuration conventions, trajectory paths, or parser rules for a particular agent.

## Adapter JSON format (version 1)

Create with `POST /api/projects/:projectId/adapters`. A project may have exactly one adapter.

```json
{
  "agent_id": "my-agent",
  "name": "My Agent CLI",
  "description": "Real my-agent integration",
  "format_version": 1,
  "image": "localhost/my-agent:project-build",
  "source_repo": "https://github.com/example/my-agent.git",
  "source_ref": "main",
  "containerfile": "FROM node:22-bookworm\nRUN apt-get update && apt-get install -y bash git sudo procps\nWORKDIR /opt/my-agent\nCOPY . .\nRUN npm ci && npm run build && ln -s /opt/my-agent/bin/my-agent /usr/local/bin/my-agent\n",
  "default_provider": "anthropic",
  "default_model": "claude-opus-5",
  "command": {
    "argv": [
      "my-agent",
      "run",
      "--jsonl",
      "--prompt", "{{prompt}}",
      "--provider", "{{provider}}",
      "--model", "{{model}}",
      "--workspace", "{{workspace}}"
    ],
    "env": {
      "MY_AGENT_RUN_ID": "{{run_id}}"
    }
  },
  "connection_check": {
    "argv": [
      "my-agent",
      "run",
      "--jsonl",
      "--no-tools",
      "--prompt", "Reply with exactly AGENTEVAL_CONNECTION_OK.",
      "--provider", "{{provider}}",
      "--model", "{{model}}"
    ],
    "env": {},
    "cwd": "/workspace",
    "timeout_ms": 60000
  },
  "provider_config": {
    "credentialEnv": {
      "anthropic": {
        "ANTHROPIC_AUTH_TOKEN": "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL": "ANTHROPIC_BASE_URL"
      },
      "openai": {
        "OPENAI_API_KEY": "OPENAI_API_KEY"
      }
    }
  },
  "parser_kind": "canonical-jsonl",
  "parser_config": null,
  "evidence": {
    "paths": [".my-agent/runs", ".my-agent/logs"],
    "required_paths": [".my-agent/runs"]
  },
  "enabled": true
}
```

### Required fields

- `agent_id`: stable project-agent identifier used by queues and historical runs.
- `name`: display name.
- `image`: local/resulting OCI image tag used by queue containers.
- `source_repo` / `source_ref`: real agent CLI git repository and optional pinned ref.
- `containerfile`: OCI build recipe stored with the adapter. It must install the real CLI plus
  `/bin/bash`; the platform clones the repo and builds this recipe through Podman when the build API
  is called. Build commit, image id, log path, status, and timestamp are persisted.
- `command.argv`: exact CLI argv template for an eval. No shell interpolation is performed.
- `connection_check.argv`: a cheap real CLI/model probe. It must emit a model message in the same
  stream protocol used for evals.
- `parser_kind`: one of:
  - `canonical-jsonl` — recommended for new agents; stdout is one canonical event JSON object per line.
  - `pi-jsonl` — consume pi's native `--mode json` protocol.
  - `reapercode-jsonl` — consume ReaperCode trajectory JSONL.
- `evidence.paths`: native files/directories to copy from `/workspace` after the agent exits.
- `evidence.required_paths`: missing paths taint the queue and prevent the next eval from running.

### Template placeholders

Templates are supported in `image`, every `argv` entry, and every `env` value:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | Eval prompt |
| `{{provider}}` | Selected provider |
| `{{model}}` | Selected model |
| `{{workspace}}` | `/workspace` |
| `{{run_id}}` | Durable run id |
| `{{project_id}}` | Project id |
| `{{credential:NAME}}` | Named credential available to the harness |
| `{{param:path.to.value}}` | Queue/adapter parameter |
| `{{override_env:NAME}}` | Project adapter override environment value |

Prefer `provider_config.credentialEnv` over embedding many credential placeholders. It maps the
selected provider to `{ targetAgentEnvName: harnessCredentialName }`. Credential values are passed to
the real CLI process and are not baked into images. Redaction is currently deferred, so operators
must treat stored traces and artifacts as sensitive.

## Canonical JSONL output

A new third-party agent is easiest to integrate by adding a thin wrapper in its image that converts
native CLI events to agenteval canonical JSONL. Each stdout line must validate against
[`event-schema.md`](event-schema.md). At minimum emit meaningful model messages/tool activity; the
harness owns durable run boundaries and will normalize run ids and sequence numbers.

Do not print non-JSON banners to stdout when using `canonical-jsonl`; send diagnostics to stderr. Both
streams are archived verbatim. If the native CLI cannot produce canonical JSONL, add a new parser kind
in code and document its exact source-to-canonical mapping before exposing it in the CRUD validator.

## Native evidence extraction

The live parser is not the only evidence source. List every native trajectory, session log, tool log,
screenshot directory, or agent report needed for later judging. Paths are relative to `/workspace` and
cannot escape it. Files are copied under the eval archive's `retained/agent/` tree before cleanup.

Use `required_paths` for evidence without which a judgement would be incomplete. Missing required
evidence taints the queue container and stops execution before the next eval, preserving the live
container for investigation through the introspection bridge.

## Project and queue API flow

```text
POST   /api/projects
POST   /api/projects/:projectId/adapters
GET    /api/projects/:projectId/adapters
GET    /api/projects/:projectId/adapters/:adapterId
PATCH  /api/projects/:projectId/adapters/:adapterId
POST   /api/projects/:projectId/adapters/:adapterId/build
DELETE /api/projects/:projectId/adapters/:adapterId

POST   /api/projects/:projectId/evals
POST   /api/projects/:projectId/queues
POST   /api/projects/:projectId/queues/:queueId/items
PUT    /api/projects/:projectId/queues/:queueId/container
```

Creating the adapter sets the project's `default_agent_id` and optionally its default provider/model.
Queues cannot select another agent: all queues in the project evaluate the one project-bound agent.
Provider/model may be selected per queue while the agent identity and adapter remain fixed.

Adapter edits and deletion are rejected while any project queue container is active. This prevents a
live execution from changing its CLI contract halfway through a batch. Historical runs and archives
retain their snapshotted agent/model/provider/image provenance.

## Privileged introspection bridge

`POST /api/projects/:projectId/queues/:queueId/container/exec` runs `/bin/bash -lc <command>` as
container user `root`. It is the operator bash bridge and can read or modify anything inside that queue
container. No container is implicitly spawned. Missing/stopped containers return 409. When API auth is
disabled, the bridge is loopback-only; read-only tokens cannot invoke it.

The response streams stdout and stderr live without content transformation using binary frames:

```text
byte 0      channel: 1 stdout, 2 stderr, 3 exit metadata JSON, 4 stream error
bytes 1..4  unsigned big-endian payload length
bytes 5..   exact payload bytes
```

Response content type is `application/vnd.agenteval.exec-stream`. stdout/stderr payload bytes are the
exact bytes produced by the CLI. Channel 3 ends the stream and contains `exit_code`, `timed_out`,
`duration_ms`, `cwd`, `user`, and current run id.

## Building and validating an adapter

1. Build the real agent CLI image. Include `bash`; include `sudo` only if the CLI itself needs it. The
   operator bridge already executes as root.
2. Run the CLI manually in the image against the real provider/model and confirm credentials and base
   URL behavior.
3. Make the connection-check command cheap, deterministic, tool-free, and parseable.
4. Make eval stdout machine-readable. Preserve all native logs in declared evidence paths.
5. Create the project adapter over the API.
6. Spawn a queue container. Confirm `connection-check/connection.json` reports `ok: true` and contains
   at least one real model message.
7. Run multiple evals sequentially and verify the same runtime container id served all of them.
8. Verify setup output is baseline, agent output is captured, native evidence is copied, cleanup and
   cleanup verification pass, residual processes are killed, and the next eval starts from an empty
   reset workspace.
9. Retrieve `/api/evals/:runId/archive` and require hash verification success.
10. Run the real queue judge and rejudge the immutable archive. Never use a mock model gateway, fake
    adapter, canned provider, fake runtime, or scripted verdict in tests.

## Failure semantics

- Invalid adapter format: 400.
- A second project adapter: 409; each project has one agent.
- Image/Podman startup failure: queue and queued runs fail durably.
- Connection check exits non-zero, times out, emits fatal error, or has no model message: no eval setup
  runs; queue fails and the container stays available for inspection.
- Missing required native evidence, cleanup failure, cleanup-verification failure, reset failure, or
  archive sealing failure: queue becomes tainted and does not advance.
- Provider/model unavailable or rate limited: acceptance is blocked/failed explicitly, never mocked.

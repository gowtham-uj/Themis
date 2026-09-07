# Getting started

This guide takes a local installation from an empty data directory to a visible pipeline run. It uses the HTTP API for every platform operation. The React console calls the same endpoints.

## Requirements

- Node.js 22 or newer
- npm
- Podman available to the user running Themis
- a model endpoint for the evaluated agent
- a model endpoint for Phase 1 and Phase 2
- enough disk space for container images, workspaces, and immutable archives

Rootful Reaper pods use Podman directly:

```bash
export AGENTEVAL_PODMAN=1
export AGENTEVAL_PODMAN_SUDO=0
```

## Install

```bash
git clone <repository-url> themis
cd themis
npm ci
cp .env.example .env.local
cd web && npm ci && cd ..
```

Themis does not load `.env.local` by itself. Export the variables through your shell, service manager, or deployment secret manager before starting the API.

## Configure model stages

The three model stages are independent:

| Stage | Purpose |
|---|---|
| `eval` | The model used by the agent under evaluation. |
| `phase1` | Per-eval metrics and the courtroom. |
| `phase2` | Cross-eval investigation, research, design, and review. |

For an OpenAI-compatible endpoint:

```bash
export AGENTEVAL_EVAL_API_TYPE=openai
export AGENTEVAL_EVAL_BASE_URL=https://provider.example/v1
export AGENTEVAL_EVAL_API_KEY_ENV=EVAL_PROVIDER_KEY
export EVAL_PROVIDER_KEY='<set through your secret manager>'
export AGENTEVAL_EVAL_MODEL=model-id

export AGENTEVAL_PHASE1_API_TYPE=openai
export AGENTEVAL_PHASE1_BASE_URL=https://provider.example/v1
export AGENTEVAL_PHASE1_API_KEY_ENV=JUDGE_PROVIDER_KEY
export JUDGE_PROVIDER_KEY='<set through your secret manager>'
export AGENTEVAL_PHASE1_MODEL=model-id

export AGENTEVAL_PHASE2_API_TYPE=openai
export AGENTEVAL_PHASE2_BASE_URL=https://provider.example/v1
export AGENTEVAL_PHASE2_API_KEY_ENV=JUDGE_PROVIDER_KEY
export AGENTEVAL_PHASE2_MODEL=model-id
```

For general-web research, set a Serper key. arXiv needs no key and runs alongside Serper.

```bash
export SERPER_SEARCH_API_KEY='<set through your secret manager>'
```

The project settings page stores `SERPER_SEARCH_API_KEY` as the variable name. It never stores or returns the key value.

## Start the API

Local loopback with authentication off:

```bash
npm run serve -- --port 8080 --data-dir ./data
```

Check it:

```bash
curl http://127.0.0.1:8080/api/health
```

The API refuses a non-loopback bind when authentication is off. For a network deployment, enable auth and put a TLS reverse proxy in front of the service.

## Start the console

Development mode:

```bash
cd web
npm run dev -- --host 0.0.0.0
```

Production build:

```bash
cd web
npm run build
npm run preview -- --host 0.0.0.0
```

Open the console, create a project, then follow this order:

1. Open **Settings** and configure the three model stages.
2. Open **Agent adapter** and create or select the adapter.
3. Open **Evals** and import canonical eval packages.
4. Open **Queue** and add the evals.
5. Choose whether Phase 1 and Phase 2 run automatically.
6. Start the run.
7. Open the run panel to follow eval execution, Phase 1 nodes, Phase 2 board activity, and archive publication.

## The same flow through the API

Set a shell variable for the base URL:

```bash
BASE=http://127.0.0.1:8080
```

### 1. Create a project

```bash
PROJECT_ID=$(curl -fsS -X POST "$BASE/api/projects" \
  -H 'content-type: application/json' \
  -d '{"name":"My agent evaluation","slug":"my-agent-evaluation"}' \
  | jq -r '.id')
```

### 2. Create an adapter

A source-built adapter is the production path. See [Adapter integration](../plan/adapter-generation-guide.md) for its full request contract.

For a local first run, the queue can select a registered built-in adapter. List them:

```bash
curl -fsS "$BASE/api/adapters/builtin" | jq
```

### 3. Import evals

Upload one ZIP that contains `tasks/<task-name>/...`:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/evals:import-archive?format=zip" \
  -H 'content-type: application/zip' \
  --data-binary @suite.zip | jq
```

The import is atomic. The validator rejects an incomplete package before it creates an eval row.

### 4. Create the eval queue

```bash
QUEUE_ID=$(curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/queues" \
  -H 'content-type: application/json' \
  -d '{"name":"Main queue","builtin_adapter_id":"reapercode","agent_id":"reapercode"}' \
  | jq -r '.id')
```

Add each imported eval:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/items" \
  -H 'content-type: application/json' \
  -d '{"eval_id":"<eval-id>","repeats":1}' | jq
```

### 5. Create the project pipeline

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/pipeline" \
  -H 'content-type: application/json' \
  -d "{\"eval_queue_id\":\"$QUEUE_ID\",\"name\":\"Main pipeline\",\"auto_phase2\":true}" | jq
```

Create a named run from the queue blueprint:

```bash
GENERATION_ID=$(curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/pipeline/generation" \
  -H 'content-type: application/json' \
  -d '{"name":"Release candidate"}' \
  | jq -r '.id')
```

The background ticker starts and advances the generation. You can also request one immediate coordinator tick:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/advance" \
  -H 'content-type: application/json' \
  -d '{"trigger":"auto"}' | jq
```

### 6. Follow progress

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID" | jq
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/progress" | jq
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/activity?limit=100" | jq
```

The console route is:

```text
/projects/<project-id>/runs/<generation-id>
```

### 7. Inspect archives

List the generation's archives through the project archive API, then open one:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/archives" | jq
curl -fsS "$BASE/api/archives/<run-id>/contents" | jq
curl -fsS "$BASE/api/archives/<run-id>/file?path=judge/evalJudge.yaml"
```

Download the complete current archive view:

```bash
curl -fL "$BASE/api/archives/<run-id>/download" -o eval-archive.tar.gz
```

## Pause, resume, and retry

Pause or resume the active eval container:

```bash
curl -fsS -X PATCH "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/container" \
  -H 'content-type: application/json' \
  -d '{"action":"pause"}' | jq
```

Pause one Phase 1 courtroom:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/runs/<run-id>/phase1/pause" | jq
```

Resume it from the saved PI session:

```bash
curl -fsS -X POST "$BASE/api/judge/runs/<run-id>/phase1" | jq
```

Retry one eval-stage failure inside the same pipeline generation:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/retry-eval" \
  -H 'content-type: application/json' \
  -d '{"item_id":"<pipeline-item-id>"}' | jq
```

The old failed agent run remains immutable. The retry creates a fresh agent run and only replaces the missing pipeline item.

## Next documents

- [What each object means](./concepts.md)
- [API reference](./api-reference.md)
- [Eval authoring](./eval-authoring.md)
- [Themis system design](./themis-system-design.md)
- [Security policy](../SECURITY.md)

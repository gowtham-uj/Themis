# Operating Themis through the API

This runbook covers the day-to-day API workflow after installation. For the first setup, start with [getting-started.md](./getting-started.md). For every route, use [api-reference.md](./api-reference.md).

Assume:

```bash
BASE=http://127.0.0.1:8080
```

When authentication is enabled:

```bash
AUTH=(-H "Authorization: Bearer $THEMIS_TOKEN")
```

Add `"${AUTH[@]}"` to each curl command.

## Check project readiness

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/readiness" | jq
```

Readiness names the missing prerequisite instead of waiting for container start to fail. It checks the project adapter, eval membership, queue, commit or built-in adapter, and model configuration.

## Configure model stages safely

Project model settings are stored in `model_config`. Secret values are not.

```bash
curl -fsS -X PATCH "$BASE/api/projects/$PROJECT_ID" \
  -H 'content-type: application/json' \
  -d '{
    "model_config": {
      "eval": {
        "apiType": "openai",
        "baseUrl": "https://provider.example/v1",
        "apiKeyEnv": "EVAL_PROVIDER_KEY",
        "model": "agent-model"
      },
      "phase1": {
        "apiType": "openai",
        "baseUrl": "https://provider.example/v1",
        "apiKeyEnv": "JUDGE_PROVIDER_KEY",
        "webSearchApiKeyEnv": "SERPER_SEARCH_API_KEY",
        "model": "judge-model"
      },
      "phase2": {
        "apiType": "openai",
        "baseUrl": "https://provider.example/v1",
        "apiKeyEnv": "JUDGE_PROVIDER_KEY",
        "webSearchApiKeyEnv": "SERPER_SEARCH_API_KEY",
        "model": "judge-model"
      }
    }
  }' | jq
```

The environment variables must exist in the API process. The server rejects a key value where a variable name belongs.

Probe a stage before spending on a run:

```bash
curl -fsS -X POST "$BASE/api/settings/models/phase1/health" \
  -H 'content-type: application/json' \
  -d '{}' | jq
```

## Validate and build the adapter

List project adapters:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/adapters" | jq
```

Validate one:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/adapters/$ADAPTER_ID/validate" | jq
```

Build its selected commit:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/adapters/$ADAPTER_ID/build" \
  -H 'content-type: application/json' \
  -d '{"ref":"main"}' | jq
```

A source-built queue must resolve to an exact commit before it starts. The queue generation snapshots the build ID, image ID, commit, and adapter version.

## Import and inspect evals

Import a suite:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/evals:import-archive?format=zip" \
  -H 'content-type: application/zip' \
  --data-binary @suite.zip | jq
```

List project evals and their queue references:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/evals" | jq
```

List categories:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/eval-categories" | jq
```

The import validator runs no-op, oracle, and known-bad checks before the package is ready. A known-bad case should pass public tests and fail the hidden contract.

## Prepare the queue blueprint

Read the project's queue view:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/queue" | jq
```

Add one eval:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/items" \
  -H 'content-type: application/json' \
  -d '{"eval_id":"<eval-id>","repeats":1}' | jq
```

Load a category:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/items:load-category" \
  -H 'content-type: application/json' \
  -d '{"category":"multi_file_engineering"}' | jq
```

Patch order or enabled state:

```bash
curl -fsS -X PATCH "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/items/$ITEM_ID" \
  -H 'content-type: application/json' \
  -d '{"position":3,"enabled":true}' | jq
```

## Start a named pipeline run

The pipeline is the normal start path. It keeps eval execution, Phase 1, Phase 2, and final archive publication under one generation ID.

Create or read the pipeline:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline" | jq
```

Enable all automatic stages:

```bash
curl -fsS -X PATCH "$BASE/api/projects/$PROJECT_ID/pipeline" \
  -H 'content-type: application/json' \
  -d '{"auto_eval":true,"auto_phase1":true,"auto_phase2":true}' | jq
```

Create the run:

```bash
GENERATION_ID=$(curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/pipeline/generation" \
  -H 'content-type: application/json' \
  -d '{"name":"Ten-eval release run"}' | jq -r '.id')
```

The background ticker starts the queue and advances every stage. The explicit advance endpoint is useful for tests and manual control:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/advance" \
  -H 'content-type: application/json' \
  -d '{"trigger":"auto"}' | jq
```

## Watch the run

Generation rows:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID" | jq
```

Stage progress:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/progress" | jq
```

Human-facing activity:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/activity?limit=300" | jq
```

Live agent events:

```bash
curl -N "$BASE/api/runs/$RUN_ID/events"
```

The run panel in the console combines these sources. It shows current eval progress, Phase 1 node state for each case, Phase 2 board state, and how many archives have been resealed.

## Pause and resume without losing work

Pause the active eval container:

```bash
curl -fsS -X PATCH "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/container" \
  -H 'content-type: application/json' \
  -d '{"action":"pause"}' | jq
```

Resume it:

```bash
curl -fsS -X PATCH "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/container" \
  -H 'content-type: application/json' \
  -d '{"action":"resume"}' | jq
```

Pause a Phase 1 case:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/runs/$RUN_ID/phase1/pause" | jq
```

Resume the same PI session:

```bash
curl -fsS -X POST "$BASE/api/judge/runs/$RUN_ID/phase1" | jq
```

Pause or resume Phase 2:

```bash
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/pipeline/campaign/$CAMPAIGN_ID/pause" | jq
curl -fsS -X POST "$BASE/api/projects/$PROJECT_ID/pipeline/campaign/$CAMPAIGN_ID/resume" | jq
```

PI session files and child-session manifests remain under the case work directory. Resume continues those sessions.

## Retry typed failures

For an eval-stage failure, retry the exact pipeline item:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/retry-eval" \
  -H 'content-type: application/json' \
  -d '{"item_id":"<pipeline-item-id>"}' | jq
```

The retry stays in the same pipeline generation. It creates one fresh agent run. The old failed run remains queryable.

For Phase 1 cases that exhausted bounded automatic retries:

```bash
curl -fsS -X POST \
  "$BASE/api/projects/$PROJECT_ID/pipeline/generation/$GENERATION_ID/retry-phase1" | jq
```

These cases resume their saved courtroom state.

## Inspect the final artifacts

List archives:

```bash
curl -fsS "$BASE/api/projects/$PROJECT_ID/archives" | jq
```

Inspect the current tree:

```bash
curl -fsS "$BASE/api/archives/$RUN_ID/contents" | jq
```

Read the Phase 1 report:

```bash
curl -fsS "$BASE/api/archives/$RUN_ID/file?path=judge/evalJudge.yaml"
```

Read Phase 2 outputs:

```bash
curl -fsS "$BASE/api/archives/$RUN_ID/file?path=phase2/developer-pack.yaml"
curl -fsS "$BASE/api/archives/$RUN_ID/file?path=phase2/platform-report.yaml"
```

Download the campaign pack:

```bash
curl -fL "$BASE/api/projects/$PROJECT_ID/pipeline/campaign/$CAMPAIGN_ID/pack" \
  -o developer-improvement-pack.zip
```

Download one full archive view:

```bash
curl -fL "$BASE/api/archives/$RUN_ID/download" -o "$RUN_ID.tar.gz"
```

## Stop a queue generation

Stop the active queue container:

```bash
curl -fsS -X DELETE "$BASE/api/projects/$PROJECT_ID/queues/$QUEUE_ID/container" | jq
```

This stops the queue generation. It does not delete finished runs or archives.

## Operational checks

Before a release or deployment:

```bash
npm ci
npm run typecheck
npm run lint
npm run build
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npm test
cd web && npm ci && npm run lint && npm run build
```

Also verify:

- `/api/health` and `/api/judge/health` are healthy
- the API refuses unauthenticated non-loopback startup
- the three model health probes pass
- Podman can start and remove a queue container
- a real eval reaches a sealed base archive
- Phase 1 publishes `judge/evalJudge.yaml`
- Phase 2 publishes its pack and platform report
- archive downloads contain no changed base files

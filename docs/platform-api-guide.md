# Agenteval API operator guide

This guide covers the backend/API-only workflow from an empty installation to evaluated, judged and
queryable results. The normative adapter details are in
[`plan/adapter-generation-guide.md`](../plan/adapter-generation-guide.md); canonical eval package details
are in [`docs/eval-authoring.md`](./eval-authoring.md).

Assume `BASE=http://127.0.0.1:8080`. When authentication is enabled, send:

```http
Authorization: Bearer <token>
```

Write endpoints reject read-only tokens. Project-scoped tokens cannot read or mutate another project.
JSON uses snake_case on the HTTP boundary.

## 1. Create a project

```http
POST /api/projects
Content-Type: application/json

{
  "name": "ReaperCode regression suite",
  "slug": "reapercode-regression",
  "description": "Canonical coding eval packages",
  "default_model": "deepseek-v4-flash",
  "default_provider": "nuralwatt",
  "network_policy": "allow",
  "artifact_retention": "keep"
}
```

Useful operations:

```text
GET    /api/projects
GET    /api/projects/<projectId>
PATCH  /api/projects/<projectId>
DELETE /api/projects/<projectId>       # archives; does not erase evidence
```

## 2. Configure the real agent adapter

A project owns at most one adapter. Other projects may explicitly select a shared adapter-store row.
There is no implicit fallback.

Generator path:

```http
POST /api/projects/<projectId>/adapters/from-generator
Content-Type: application/json

{
  "agent_id": "my-agent",
  "name": "My Agent",
  "generator": "#!/bin/bash\nset -euo pipefail\n...",
  "install_type": "npm",
  "default_provider": "nuralwatt",
  "default_model": "deepseek-v4-flash",
  "build": true
}
```

The generator emits one validated adapter JSON object. Its image must contain the actual CLI and expose a
stable command. Provider credentials are mapped by name; values are injected only at command time and
are never baked into the image. Use:

```text
GET  /api/projects/<projectId>/adapters
GET  /api/adapters/generator-contract
GET  /api/adapters/store
POST /api/projects/<projectId>/adapters/<adapterId>/validate
POST /api/projects/<projectId>/adapters/<adapterId>/build
```

See the complete command/parser/evidence/configure contract in the adapter-generation guide.

## 3. Create canonical eval packages

Flat task/prompt creation and field patching are rejected. Submit a complete package through either:

```text
POST /api/projects/<projectId>/evals
     JSON {files:{path: content|{encoding,content}}}

POST /api/projects/<projectId>/evals:import-archive?format=zip|tar|tar.gz
     raw archive bytes
```

Read/list/archive:

```text
GET    /api/projects/<projectId>/evals?category_name=<name>&include_archived=false
GET    /api/projects/<projectId>/evals/<evalId>
DELETE /api/projects/<projectId>/evals/<evalId>
GET    /api/projects/<projectId>/eval-categories
```

Each response includes package digest, validation record, arbitrary `category_name`, functional
`agent_category`, rubric version and immutable package manifest. See the authoring guide before creating
one.

## 4. Create a persistent queue

Owned adapter:

```http
POST /api/projects/<projectId>/queues
Content-Type: application/json

{
  "name": "JavaScript bugfix suite",
  "model": "deepseek-v4-flash",
  "provider": "nuralwatt",
  "judge_model": "deepseek-v4-flash",
  "judge_provider": "nuralwatt",
  "auto_judge": false,
  "network_policy": "allow",
  "ports": []
}
```

Shared adapter: add `"shared_adapter_id":"<exact-store-row-id>"`. The selected row must be enabled,
shared, owned by a different project, and compatible with the queue’s model/provider.

Add one eval:

```http
POST /api/projects/<projectId>/queues/<queueId>/items

{"eval_id":"<evalId>","repeats":1,"enabled":true}
```

Load a whole arbitrary category:

```http
POST /api/projects/<projectId>/queues/<queueId>/items:load-category

{"category_name":"javascript-bugfix","repeats":3,"enabled":true}
```

The category operation is idempotent for existing task ids: matches already in the queue are reported as
skipped. Queue item/environment changes require the queue container to be stopped.

Queue inspection/mutation:

```text
GET    /api/projects/<projectId>/queues
GET    /api/projects/<projectId>/queues/<queueId>
PATCH  /api/projects/<projectId>/queues/<queueId>
DELETE /api/projects/<projectId>/queues/<queueId>
GET    /api/projects/<projectId>/queues/<queueId>/items
PATCH  /api/projects/<projectId>/queues/<queueId>/items/<itemId>
DELETE /api/projects/<projectId>/queues/<queueId>/items/<itemId>
```

One active queue owns one real persistent Podman container. All items must resolve the same adapter image,
canonical environment digest, network policy and port set. Different canonical environments belong in
different queues.

## 5. Start, control and inspect execution

```text
PUT    /api/projects/<projectId>/queues/<queueId>/container
GET    /api/projects/<projectId>/queues/<queueId>/container
PATCH  /api/projects/<projectId>/queues/<queueId>/container  {"action":"pause|resume"}
DELETE /api/projects/<projectId>/queues/<queueId>/container
GET    /api/projects/<projectId>/containers
```

At queue start the platform:

1. builds the canonical `environment/` on top of the selected adapter image;
2. runs the real adapter connection check and optional configure step once;
3. prepares each `environment/repo/` in a clean workspace;
4. runs optional trusted setup, then the real agent;
5. captures canonical events, raw output, source diff and native evidence;
6. stops the agent process and captures evidence before verifier access;
7. builds/runs the hidden `tests/` verifier in a separate offline container;
8. records binary verifier reward and diagnostics;
9. restores/runs optional trusted cleanup, resets the workspace, finalizes metadata and seals the archive.

Privileged operator introspection of the live queue container:

```http
POST /api/projects/<projectId>/queues/<queueId>/container/exec
Content-Type: application/json

{"command":"ps aux","cwd":"/workspace","timeout_ms":30000}
```

The response is channel-framed binary stdout/stderr/control data. Operator commands are recorded in the
canonical trace as operator introspection and are never attributed to the agent.

## 6. Evidence, metrics and run control

```text
GET /api/evals/<runId>/archive
GET /api/evals/<runId>/metrics
GET /api/runs/<runId>
GET /api/runs/<runId>/events
GET /api/runs/<runId>/diff
GET /api/runs/<runId>/artifacts
```

`archive` verifies the immutable manifest and every file hash. `metrics` returns:

```json
{
  "schema_version": 1,
  "execution": {
    "measurements": {
      "tokens_used": {"value":1234,"unit":"tokens","provenance":"exact","refs":[]},
      "verification_rate": {"value":1,"unit":"ratio","provenance":"derived","refs":[]}
    }
  },
  "outcome": {
    "officialReward": 1,
    "measurements": {
      "hidden_test_score": {"value":1,"unit":"ratio","provenance":"exact","refs":[]},
      "cost_per_solved": {"value":0.04,"unit":"usd/solved","provenance":"derived","refs":[]}
    }
  }
}
```

Every measurement is `exact`, `derived`, `judge-derived`, or `unknown`; unknown evidence is never encoded
as zero. Official reward is the isolated verifier’s binary result. Trace/diff metrics remain diagnostic.

Legacy ad-hoc run control remains available for persisted runs:

```text
POST /api/runs/<runId>/pause?mode=soft|hard
POST /api/runs/<runId>/resume
POST /api/runs/<runId>/abort
POST /api/runs/<runId>/control
```

## 7. Run a queue judgement revision

```http
POST /api/projects/<projectId>/queues/<queueId>/analyses
Content-Type: application/json

{
  "batch_id": "<batchId>",
  "all": true,
  "judge_model": "deepseek-v4-flash",
  "judge_provider": "nuralwatt",
  "judge_params": {"thinkingLevel":"high","maxTokens":16384}
}
```

The real PI judge must list and completely read every selected immutable archive file. It drafts one
standard Verdict and one evidence-linked narrative per eval, then preflights the complete queue-analysis
v2 payload. The final token-only submit persists exactly the preflighted payload.

Artifacts:

```text
GET /api/projects/<projectId>/queues/<queueId>/analyses
GET /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>
GET /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>/events
GET /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>/transcript
GET /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>/verdict
GET /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>/report
```

The HTML report is self-contained and narrative-first: verdict, execution timeline, strengths, concerns,
criteria, findings, handoff and four owner backlogs.

## 8. Manage improvement-step lifecycle

```text
GET /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>/improvement-steps
    ?class=agent|platform|judge|eval
    &priority=0|1|2|3
    &status=proposed|ready|blocked|in_progress|verified|rejected
    &defect_id=<id>
```

```http
PATCH /api/projects/<projectId>/queues/<queueId>/analyses/<analysisId>/improvement-steps/<stepId>

{"status":"in_progress"}
```

Only lifecycle status/blocking metadata is mutable. Evidence, problem, target, change, tests and acceptance
criteria remain immutable analysis content. Invalid transitions are rejected.

## 9. Single-run judgements, findings and comparisons

```text
POST /api/runs/<runId>/judgements
GET  /api/judgements/<judgementId>
GET  /api/judgements/<judgementId>/events
GET  /api/judgements/<judgementId>/report
GET  /api/projects/<projectId>/findings
GET  /api/projects/<projectId>/findings/<fingerprint>
GET  /api/projects/<projectId>/tasks/<taskId>/trend
GET  /api/projects/<projectId>/compare/runs?a=<runA>&b=<runB>
GET  /api/projects/<projectId>/compare/releases?from=<version>&to=<version>
```

Judgement detail includes the Verdict plus optional narrative/schema version. Findings are fingerprinted
and tracked as introduced, persisted, resolved or regressed.

## 10. Webhooks and operational integrations

Outbound subscriptions may notify external applications about run, judgement and finding lifecycle
events. Secrets are returned only once at creation and are never emitted by list routes. See
[`plan/api.md`](../plan/api.md) for watcher, webhook, token and release endpoint details.

## End-to-end checklist

1. Create project.
2. Create/build/validate one real project adapter, or explicitly select a shared adapter.
3. Author and locally inspect a canonical eval package.
4. Import through JSON file map or quarantined archive.
5. Confirm package digest, validation and category API output.
6. Create queue; add one eval or load a category.
7. Start queue container; inspect connection/configure state.
8. Observe real agent execution and separate verifier result.
9. Verify archive hashes and per-eval metrics.
10. Run real queue analysis; inspect PI trace/transcript/verdict/report.
11. Query owner backlogs and update lifecycle status.
12. Re-run target and regression eval sets after fixes.

# Themis WP-0..15 status (S3 excluded)

## DONE
- **WP-0** Quality fixtures + A/B/D gate
- **WP-1** Async contracts + sqlite/postgres job stores
- **WP-2** CAS/local artifact store + manifests (+ eval-package store); **S3 deferred**
- **WP-3** Credential scan + redactor
- **WP-4** Archive list keyset (`has_more` / `next_cursor`)
- **WP-5** judge_queues/outbox/idempotency DDL + outbox helpers + **OutboxRelay**
- **WP-6** ModelGateway + ledger + ReasoningStarvedError + json repair
- **WP-7** Document ledger + evidence/scratchpad/petition tools
- **WP-8/9** Node0–3 (live gateway path)
- **WP-10** Node4 + multi-round loop
- **WP-11** Result versions (+ keyset list)
- **WP-12** Publish view + CAS current pointers
- **WP-13** Judge HTTP routes (+ pointer on phase1)
- **WP-14** Quality report companion on phase1 output
- **WP-15** Acceptance smoke tests

## OPEN / thin
- Live multi-worker Postgres fencing matrix (`AGENTEVAL_DATABASE_URL`)
- Full LangGraph tool-mediated multi-agent Node4 under production load
- Archive API cutover fully off `index.json` (keyset done; DB catalog authority incomplete)
- S3 artifact store (explicitly skipped)

## Workflow stall note
See `scripts/themis-workflow-notes.md`. Use sequential agents + JSON `schema` + write-first prompts.

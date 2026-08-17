# Repository watchers

A watcher converts an external repository event into queued eval work for one project.

## Triggers

- Tag
- Commit
- Pull request
- Schedule
- Manual API fire
- HMAC-verified webhook

## Flow

```text
repository event
→ match enabled project queue watcher (repo = queue source adapter source_repo)
→ verify HMAC + repository identity (signed webhook) or manual fire
→ resolve ref to concrete commit
→ deduplicate watcher + SHA
→ record durable pending FIFO event
→ queue: no active generation → launch generation with commit as immutable override
        active generation  → commit stays pending; auto-launch FIFO on generation close
→ create queue/batch runs through the normal queue execution path
→ retain sealed archives categorized by agent commit
```

A watcher owns exactly one evaluation queue (`queueId` on create) and fires that queue's
agent-commit generations. There is no role / task-selection action: launching runs the
queue's own enabled evals against the pinned commit. The generation override is immutable
to that launch and never mutates the queue's default `agent_commit`. While a generation is
active, distinct commits remain pending in FIFO order; when the generation closes the
oldest pending commit is auto-launched and the FIFO continues across generations with no
intermediate commit dropped.

Secrets are returned only at watcher creation and are never logged. Watcher events retain
resolved commit, status, FIFO sequence, batch ID, and failure details for auditability.

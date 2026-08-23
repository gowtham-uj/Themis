# Pod capability status (Reaper agent-evals)

Updated after live verification on this privileged root pod.

## Claude Code
- Runs as root (uid 0)
- permissions.defaultMode = bypassPermissions
- Claude nested Bash sandbox disabled
- Unsandboxed commands allowed

## Previously blocked items
| Item | Status | Evidence |
|------|--------|----------|
| podman-live | UNBLOCKED | tests/podman-live.test.ts 18/18 passed |
| env-provision | UNBLOCKED | tests/env-provision.test.ts 20/20 passed |
| pi-adapter | UNBLOCKED | tests/pi-adapter.test.ts 13 passed; 1 skipped only without AGENTEVAL_LIVE=1 |

## How to run
```bash
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npm test
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npx vitest run tests/podman-live.test.ts
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npx vitest run tests/env-provision.test.ts
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=0 npx vitest run tests/pi-adapter.test.ts
```

Do not treat sudo/EROFS host limits as blockers on this pod anymore.

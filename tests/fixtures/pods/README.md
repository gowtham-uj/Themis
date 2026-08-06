# Mock agent pod (end-to-end fixture)

A real container image running a mock ReaperCode agent, used by
`tests/e2e-podman-reaper.ts` to exercise the whole platform against a real
sandbox without calling a model.

**What is mocked:** only the model. `mock-reaper.js` replays a scripted
trajectory instead of asking an LLM what to do next.

**What is real:** everything else. It runs in a real container, its tool calls
really read and write the mounted workspace and really execute the test command,
and it emits the genuine post-change trajectory JSONL contract that
`src/adapters/reapercode.ts` parses (`plan/reapercode-changes.md`).

The scripted trajectory contains a **deliberate defect** so the judge has
something true to find: the agent fixes the bug, then makes one more edit and
declares "All tests pass" without re-running the suite. Its final claim is
therefore unverified, and the diff also carries a small unrequested scope
expansion.

## Build

```sh
podman build -t agenteval/reapercode-mock:latest \
  -f tests/fixtures/pods/reapercode-mock.Containerfile tests/fixtures/pods
```

## Run the end-to-end exercise

Needs a seeded fixture repo at `/tmp/e2e/fixture-repo` (a git repo whose
`src/range.js` has an off-by-one and whose `test/range.test.js` fails):

```sh
AGENTEVAL_PODMAN=1 AGENTEVAL_PODMAN_SUDO=1 npx tsx tests/e2e-podman-reaper.ts
```

## Why the image has an `/agent` directory

The adapter launches `node bin/reaper …` with cwd inside the sandbox, so
`bin/reaper` has to resolve from cwd. Putting it in `/workspace` would place
harness scaffolding inside the agent's workspace, where it lands in the captured
diff and gets attributed to the agent. Instead the binary lives in `/agent`, and
the project's sandbox policy sets `workdir: "/agent"` — which is exactly what
that control exists for.

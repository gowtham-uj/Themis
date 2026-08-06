# REAL ReaperCode agent pod.
#
# Unlike reapercode-mock.Containerfile, nothing about the agent is faked here:
# this image contains the actual ReaperCode source and runs its real CLI, real
# agent loop, real tools, and real trajectory logging. Only the MODEL is mocked
# — the run points ANTHROPIC_BASE_URL at an Anthropic-compatible gateway that
# decides what the model "says" (see tests/fixtures/mock-model-gateway.ts).
#
# One adaptation is needed, and it is a real gap rather than a convenience:
# today's ReaperCode writes its trajectory to
#   <workspace>/.reaper/runs/<run>/logs/reaper-trajectory.jsonl
# and does NOT support the `--stream-events` flag the adapter expects (see
# plan/reapercode-changes.md change ②A). The entrypoint therefore tails that
# file to stdout, which is exactly the contract the adapter parses. When
# ReaperCode lands --stream-events, delete the entrypoint and pass the flag.
FROM docker.io/library/node:22-alpine

RUN apk add --no-cache git bash

# The built agent. Copied rather than npm-installed so the pod matches the tree
# under test exactly.
COPY reaper /agent
WORKDIR /agent

# Entrypoint: run the real CLI, stream its trajectory file to stdout as it is
# written, and keep the two from racing (the file appears after startup).
RUN printf '%s\n' \
  '#!/bin/bash' \
  'set -uo pipefail' \
  'WS="${AGENTEVAL_WORKSPACE:-/workspace}"' \
  '# Tail any trajectory file that appears under the workspace, from byte 0.' \
  '(' \
  '  seen=""' \
  '  for _ in $(seq 1 600); do' \
  '    f=$(find "$WS/.reaper" -name reaper-trajectory.jsonl 2>/dev/null | head -1)' \
  '    if [ -n "$f" ] && [ "$f" != "$seen" ]; then seen="$f"; tail -n +1 -f "$f" & fi' \
  '    sleep 0.2' \
  '  done' \
  ') &' \
  'TAILER=$!' \
  '"$@"' \
  'RC=$?' \
  '# Let the tailer flush the final lines before the container exits.' \
  'sleep 1.5' \
  'kill $TAILER 2>/dev/null || true' \
  'exit $RC' \
  > /usr/local/bin/entrypoint.sh \
 && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

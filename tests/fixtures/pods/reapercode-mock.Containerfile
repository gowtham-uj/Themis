# Mock ReaperCode agent pod for agenteval end-to-end testing.
#
# The agent binary is a mock (the MODEL is scripted, not called), but the pod is
# real: a real container, a real mounted workspace, real filesystem and process
# effects from its tool calls.
#
# The platform launches the UNMODIFIED reapercode adapter argv:
#   node bin/reaper exec run --prompt ... --workspace /workspace --stream-events
# with cwd=/workspace.
#
# `bin/reaper` must resolve from cwd, but /workspace is the agent's workspace and
# anything written there lands in the captured DIFF. Harness scaffolding must not
# show up as agent work, so instead of putting a file in /workspace/bin, the
# container runs from /agent (which has bin/reaper) and symlinks the workspace
# contents in — cwd resolves bin/reaper without the workspace ever being touched.
FROM docker.io/library/node:22-alpine

COPY mock-reaper.js /opt/reaper/reaper-impl.js

# Shim: drop the leading "exec run" subcommand words, then run the mock.
RUN mkdir -p /agent/bin \
 && printf '%s\n' \
  "const argv = process.argv.slice(2).filter((a, i) => !(i < 2 && (a === 'exec' || a === 'run')));" \
  "process.argv = [process.argv[0], '/opt/reaper/reaper-impl.js', ...argv];" \
  "await import('/opt/reaper/reaper-impl.js');" \
  > /agent/bin/reaper

WORKDIR /workspace

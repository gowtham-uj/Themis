# Real ReaperCode CLI image used by project adapters and queue containers.
#
# Reaper publishes a committed single-file esbuild bundle at bin/reaper.mjs
# (~11 MB) that runs with `node bin/reaper.mjs`. No npm ci / tsc / node_modules
# are needed on target — the consumer only provides a Node runtime. The build
# context is the repo checkout (pinned to the exact commit), so this image is
# O(seconds) after the base pull instead of O(minutes).
FROM docker.io/library/node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy the committed bundle and expose it as the `reaper` command. The queue
# worker launches `reaper exec run ...`; the shim execs the bundle directly.
COPY bin/reaper.mjs /opt/reapercode/bin/reaper.mjs
RUN printf '#!/bin/sh\nexec node /opt/reapercode/bin/reaper.mjs "$@"\n' > /usr/local/bin/reaper \
 && chmod +x /usr/local/bin/reaper

# Queue containers override the command with their persistent idle PID 1.
CMD ["reaper", "--help"]

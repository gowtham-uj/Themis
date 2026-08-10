# Real ReaperCode CLI image used by project adapters and queue containers.
FROM docker.io/library/node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/reapercode
COPY . .
RUN npm ci && npm run build \
 && ln -s /opt/reapercode/bin/reaper /usr/local/bin/reaper

# Queue containers override the command with their persistent idle PID 1.
CMD ["reaper", "--help"]

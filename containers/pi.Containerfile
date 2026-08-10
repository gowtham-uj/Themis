# Real pi coding-agent CLI image used by project adapters and queue containers.
FROM docker.io/library/node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi
COPY . .
RUN npm ci && npm run build \
 && printf '#!/bin/sh\nexec node /opt/pi/packages/coding-agent/dist/cli.js "$@"\n' > /usr/local/bin/pi \
 && chmod +x /usr/local/bin/pi

CMD ["pi", "--help"]

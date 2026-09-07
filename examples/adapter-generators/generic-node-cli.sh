#!/bin/bash
# Reference adapter generator for a generic Node.js CLI agent.
# The platform clones your agent repo to $AGENTEVAL_WORKSPACE_DIR, then runs this
# script. It detects the CLI entrypoint from package.json, emits a full adapter
# contract (containerfile + command + evidence + derived connection check), and
# the platform builds + runs the real agent from it.
#
# Usage: POST /api/projects/:id/adapters/from-generator with body:
#   { "agent_id": "my-agent", "name": "My Agent", "generator": "<this script>",
#     "source_repo": "https://github.com/example/my-agent.git", "source_ref": "main",
#     "default_provider": "nuralwatt", "default_model": "deepseek-v4-flash" }
set -euo pipefail

WS="${AGENTEVAL_WORKSPACE_DIR:?AGENTEVAL_WORKSPACE_DIR is required}"
PKG="$WS/package.json"

# Detect the CLI entrypoint (bin field — string or object).
ENTRY="."
if [ -f "$PKG" ]; then
  BIN=$(jq -r '.bin // empty' "$PKG" 2>/dev/null)
  if [ -n "$BIN" ]; then
    if echo "$BIN" | jq -e . >/dev/null 2>&1; then
      # bin is an object — take the first value.
      ENTRY=$(echo "$BIN" | jq -r '. | to_entries[0].value')
    else
      ENTRY="$BIN"
    fi
  fi
fi
ENTRY_BASENAME=$(basename "$ENTRY")

# Emit the adapter contract JSON to stdout.
cat <<JSON
{
  "agent_id": "$AGENTEVAL_AGENT_ID",
  "name": "${AGENTEVAL_AGENT_ID} (generic node CLI)",
  "image": "localhost/${AGENTEVAL_AGENT_ID}:latest",
  "source_repo": "$AGENTEVAL_SOURCE_REPO",
  "source_ref": "$AGENTEVAL_SOURCE_REF",
  "containerfile": "FROM docker.io/library/node:22-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates && rm -rf /var/lib/apt/lists/*\nWORKDIR /opt/agent\nCOPY . .\nRUN npm ci && npm run build && ln -s /opt/agent/$ENTRY /usr/local/bin/$ENTRY_BASENAME\nCMD [\"$ENTRY_BASENAME\", \"--help\"]",
  "default_provider": "$AGENTEVAL_PROVIDER",
  "default_model": "$AGENTEVAL_MODEL",
  "command": {
    "argv": ["$ENTRY_BASENAME", "run", "--jsonl", "--prompt", "{{prompt}}", "--provider", "{{provider}}", "--model", "{{model}}", "--workspace", "{{workspace}}"],
    "cwd": "/workspace",
    "timeout_ms": 600000
  },
  "derive_connection_check": true,
  "provider_config": {
    "credentialEnv": {
      "anthropic": { "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN": "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL": "ANTHROPIC_BASE_URL" },
      "nuralwatt": { "NURALWATT_API_KEY": "AGENTEVAL_MODEL_API_KEY" },
      "default": { "OPENAI_API_KEY": "OPENAI_API_KEY" }
    }
  },
  "parser_kind": "canonical-jsonl",
  "evidence": {
    "paths": [".agent-runs", ".agent-logs"],
    "required_paths": [".agent-runs"]
  },
  "enabled": true
}
JSON

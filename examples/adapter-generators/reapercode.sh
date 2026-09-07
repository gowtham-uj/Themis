#!/bin/bash
# Reference adapter generator for ReaperCode.
# Mirrors the real reapercode adapter from tests/e2e-reapercode-api.ts.
# The platform clones the reaper repo to $AGENTEVAL_WORKSPACE_DIR, runs this script,
# and the emitted contract builds + runs the real ReaperCode CLI.
set -euo pipefail

cat <<JSON
{
  "agent_id": "$AGENTEVAL_AGENT_ID",
  "name": "ReaperCode CLI",
  "description": "Real ReaperCode git source built and driven as a CLI tool",
  "image": "localhost/${AGENTEVAL_AGENT_ID}:latest",
  "source_repo": "$AGENTEVAL_SOURCE_REPO",
  "source_ref": "$AGENTEVAL_SOURCE_REF",
  "containerfile": "FROM docker.io/library/node:22-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends bash git sudo procps ca-certificates && rm -rf /var/lib/apt/lists/*\nWORKDIR /opt/reapercode\nCOPY . .\nRUN node -e \"const fs=require('fs');const p='src/model/provider/catalog.ts';let s=fs.readFileSync(p,'utf8');s=s.replace(/(id: \\\"nuralwatt\\\"[\\\\s\\\\S]*?models: \\\\[)/,'\\$1\\\"deepseek-v4-flash\\\", ');fs.writeFileSync(p,s);\"\nRUN npm ci && npm run build && ln -s /opt/reapercode/bin/reaper /usr/local/bin/reaper\nCMD [\"reaper\", \"--help\"]",
  "default_provider": "$AGENTEVAL_PROVIDER",
  "default_model": "$AGENTEVAL_MODEL",
  "command": {
    "argv": ["/bin/bash", "-lc", "set -uo pipefail\nmkdir -p /workspace/.agenteval\nrm -rf /workspace/.reaper /workspace/.agenteval/reaper-result.json /workspace/.agenteval/reaper-stderr.log\nreaper exec run --prompt \"$1\" --workspace /workspace --provider \"$2\" --model \"$3\" --max-tokens 12000 --timeout-ms 600000 --json > /workspace/.agenteval/reaper-result.json 2> /workspace/.agenteval/reaper-stderr.log\nexit $?", "--", "{{prompt}}", "{{provider}}", "{{model}}"],
    "env": { "REAPER_DEV": "1" }
  },
  "connection_check": {
    "argv": ["/bin/bash", "-lc", "set -uo pipefail\nreaper exec run --prompt \"$1\" --workspace /workspace --provider \"$2\" --model \"$3\" --max-tokens 12000 --timeout-ms 180000 --json > /dev/null 2>&1\nexit $?", "--", "Reply with exactly AGENTEVAL_CONNECTION_OK. Do not use tools.", "{{provider}}", "{{model}}"],
    "env": { "REAPER_DEV": "1" },
    "cwd": "/workspace",
    "timeout_ms": 180000
  },
  "provider_config": {
    "credentialEnv": {
      "nuralwatt": { "NURALWATT_API_KEY": "AGENTEVAL_MODEL_API_KEY" }
    }
  },
  "parser_kind": "reapercode-jsonl",
  "evidence": {
    "paths": [".reaper", ".agenteval/reaper-result.json", ".agenteval/reaper-stderr.log"],
    "required_paths": [".reaper/runs", ".agenteval/reaper-result.json"]
  },
  "enabled": true
}
JSON

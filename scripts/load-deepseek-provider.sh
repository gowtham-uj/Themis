#!/usr/bin/env bash
# Load the saved OpenAI-compatible proxy connection (deepseek-v4-flash).
# Secrets: data/secrets/deepseek.env (gitignored via data/). Never commit.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="${DEEPSEEK_PROVIDER_FILE:-$ROOT/data/secrets/deepseek.env}"
if [[ ! -f "$FILE" ]]; then
  echo "missing $FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$FILE"
set +a
: "${OPENAI_API_KEY:?OPENAI_API_KEY missing}"
: "${OPENAI_BASE_URL:?OPENAI_BASE_URL missing}"
export AGENTEVAL_DEFAULT_PROVIDER="${AGENTEVAL_DEFAULT_PROVIDER:-openai}"
export AGENTEVAL_DEFAULT_MODEL="${AGENTEVAL_DEFAULT_MODEL:-deepseek-v4-flash}"
echo "provider loaded name=${AGENTEVAL_CONNECTION_NAME:-?} provider=$AGENTEVAL_DEFAULT_PROVIDER model=$AGENTEVAL_DEFAULT_MODEL base=$OPENAI_BASE_URL key_len=${#OPENAI_API_KEY}"

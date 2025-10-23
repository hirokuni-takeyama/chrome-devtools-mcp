#!/usr/bin/env bash
set -euo pipefail
#
# Expose SSE server on 0.0.0.0:${PORT}, spawn chrome-devtools-mcp (stdio)
#
: "${CORS_ORIGIN:=https://dify.edomtt.co.jp}"
: "${PORT:=8080}"

exec /opt/venv/bin/mcp-proxy \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --allow-origin "${CORS_ORIGIN}" \
  --pass-environment \
  --log-level info \
  -- npx chrome-devtools-mcp

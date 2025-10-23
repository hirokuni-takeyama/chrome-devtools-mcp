#!/usr/bin/env bash
set -euo pipefail

# Allow-origin は Dify の管理画面ドメインに合わせる
: "${CORS_ORIGIN:=https://dify.edomtt.co.jp}"
: "${PORT:=8080}"

exec /opt/venv/bin/mcp-proxy \
  --command "npx chrome-devtools-mcp" \
  --host "0.0.0.0" \
  --port "${PORT}" \
  --endpoint "/mcp" \
  --allow-origin "${CORS_ORIGIN}" \
  --heartbeat "15s" \
  --log-level "info"

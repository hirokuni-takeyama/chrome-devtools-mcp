#!/usr/bin/env bash
set -euo pipefail

# Cloud Run 権限制約のため headless + no-sandbox（用途は限定推奨）
MCP_CMD="chrome-devtools-mcp --headless=true --isolated=true --chromeArg=--no-sandbox"

# Cloud Run の契約ポートで SSE/HTTP 公開（/sse）
exec mcp-proxy --host 0.0.0.0 --port "${PORT}" -- ${MCP_CMD}

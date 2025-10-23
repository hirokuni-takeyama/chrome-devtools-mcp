#!/usr/bin/env bash
set -euo pipefail

MCP_CMD="chrome-devtools-mcp --headless=true --isolated=true --chromeArg=--no-sandbox"

# SSE + HTTP の両方を許可（/sse はGET、/messages はPOST）
exec mcp-proxy --host 0.0.0.0 --port "${PORT}" --allow-http -- ${MCP_CMD}

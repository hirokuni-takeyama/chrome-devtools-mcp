#!/usr/bin/env bash
set -euo pipefail

export MCP_CMD="${MCP_CMD:-chrome-devtools-mcp}"
export MCP_ARGS="${MCP_ARGS:---headless=true --isolated=true --chromeArg=--no-sandbox}"

exec node server-gateway.js "$@"

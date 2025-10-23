// server-gateway.js
// 最小のHTTP⇄stdioブリッジ。SSEは心拍のみ、/messagesは子プロセス(MCP:stdio)へJSON-RPCをフォワード。

import express from 'express';
import { spawn } from 'child_process';

const ORIGIN = process.env.CORS_ORIGIN || 'https://dify.edomtt.co.jp';
const HEARTBEAT_MS = parseInt(process.env.SSE_HEARTBEAT_MS || '15000', 10);
const CHILD_CMD = process.env.MCP_CMD || 'npx';
const CHILD_ARGS = (process.env.MCP_ARGS && process.env.MCP_ARGS.split(' ')) || ['chrome-devtools-mcp'];

const app = express();
app.use(express.json({ limit: '2mb' }));

const sseClients = new Set();

function sseNotify(payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const client of sseClients) {
    client.write('event: message\n');
    client.write(`data: ${data}\n\n`);
  }
}
app.use((req, res, next) => {
  const origin = ORIGIN;
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── 子プロセス（stdio型 MCP）を常駐起動 ───────────────────────────────────
const child = spawn(CHILD_CMD, CHILD_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', d => console.error('[MCP STDERR]', d.toString().trim()));
child.on('exit', code => console.error('[MCP EXIT]', code));

let buf = '';
const pending = new Map(); // id -> {resolve, reject}
let nextId = 1;

// stdout を行区切りJSONとして読む（単純化）
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      console.error('[MCP OUT parse error]', line);
      continue;
    }
    // 応答マッチング（idで解決）
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    } else {
      // 通知などはSSEへ将来配信したければここでキューイング
      // 今回は接続テスト重視なのでログのみ
      console.log('[MCP NOTIFY]', JSON.stringify(msg));
    }
  }
});

function callMCP(json) {
  return new Promise((resolve, reject) => {
    const req = { ...json };
    if (!('id' in req)) req.id = `${nextId++}`;
    pending.set(req.id, { resolve, reject });
    try {
      child.stdin.write(JSON.stringify(req) + '\n');
    } catch (e) {
      pending.delete(req.id);
      return reject(e);
    }
    // タイムアウト（保険）
    setTimeout(() => {
      if (pending.has(req.id)) {
        pending.delete(req.id);
        reject(new Error('MCP response timeout'));
      }
    }, 15000);
  });
}

function buildBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (!hostHeader) return `${proto}://localhost`;
  return `${proto}://${hostHeader}`;
}

function createSSEHandler(messagePath) {
  return (req, res) => {
    const baseUrl = buildBaseUrl(req);
    const absoluteMessages = messagePath.startsWith('http') ? messagePath : `${baseUrl}${messagePath}`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('mcp-session-id', 'dummy-session');
    res.setHeader('mcp-protocol-version', '2025-06-18');

    res.flushHeaders?.();

    // Dify が期待する初回通知
    res.write('event: endpoint\n');
    res.write(`data: ${absoluteMessages}\n\n`);

    sseClients.add(res);

    const hb = setInterval(() => {
      res.write(`: ping\n\n`);
    }, HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
      res.end();
    });
  };
}
const mcpSseHandler = createSSEHandler('/mcp/messages');
const legacySseHandler = createSSEHandler('/messages');
app.get('/mcp/sse', mcpSseHandler);
app.get('/sse', legacySseHandler);

// GET /messages をヘルスOKに（Difyの探り対策）
app.get('/mcp/messages', (req, res) => res.json({ ok: true, note: 'GET accepted for health' }));
app.get('/messages', (req, res) => res.json({ ok: true, note: 'GET accepted for health' }));

// ── JSON-RPC: /mcp/messages と /messages（POST）──────────────────────────
async function messagesHandler(req, res) {
  const body = req.body || {};
  const { id, method, params = {} } = body;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('mcp-session-id', 'dummy-session');
  res.setHeader('mcp-protocol-version', '2025-06-18');

  console.log('[MCP] request:', JSON.stringify(body));

  if (!method) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32600, message: 'Invalid Request: method is required' }
    });
  }

  if (method === 'initialize') {
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'chrome-devtools-mcp', version: '1.0.0' },
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          logging: {}
        }
      }
    });
    setImmediate(() => {
      sseNotify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      sseNotify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
      sseNotify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed', params: {} });
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return res.json({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'openTab',
            description: 'Open a URL in Chrome DevTools-controlled browser.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL to open' }
              },
              required: ['url']
            }
          }
        ]
      }
    });
  }

  if (method === 'resources/list') {
    return res.json({ jsonrpc: '2.0', id, result: { resources: [] } });
  }

  if (method === 'prompts/list') {
    return res.json({ jsonrpc: '2.0', id, result: { prompts: [] } });
  }

  if (method === 'notifications/tools/list_changed') {
    return res.json({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: {}
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments;
    if (toolName === 'openTab') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { ok: true, echo: { name: toolName, args: toolArgs } }
      });
    }
    return res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` }
    });
  }

  try {
    const reply = await callMCP(body);
    if (reply) {
      return res.json(reply);
    }
  } catch (err) {
    console.error('[messages error]', err);
  }

  return res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unsupported method: ${method}` }
  });
}
app.post('/mcp/messages', messagesHandler);
app.post('/messages', messagesHandler);

// --- MCP Discovery: Dify が参照する可能性大 ---
app.get('/.well-known/mcp.json', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  const base = `${proto}://${host}`;
  const sse = `${base}/mcp/sse`;
  const msgs = `${base}/mcp/messages`;
  const single = `${base}/mcp`;
  const payload = {
    name: 'chrome-devtools-mcp gateway',
    version: '0.8.1',
    description: 'HTTP<->stdio gateway for chrome-devtools-mcp',
    protocolVersion: '2025-06-18',
    transport: 'http+sse',
    endpointUrl: single,
    sseUrl: sse,
    messagesUrl: msgs,
    endpoints: { sse: '/mcp/sse', messages: '/mcp/messages', single: '/mcp' },
    routes: { sse, messages: msgs, single },
    http: { type: 'http+sse', sse, messages: msgs, single },
    mcp: { http: { sse, messages: msgs, single } },
    protocols: [
      {
        type: 'http+sse',
        protocolVersion: '2025-06-18',
        baseUrl: base,
        endpoints: { sse, messages: msgs, single }
      }
    ]
  };
  res.status(200).json(payload);
});

app.get('/mcp/manifest', (req, res) => {
  req.url = '/.well-known/mcp.json';
  app._router.handle(req, res);
});
app.get('/mcp/config', (req, res) => {
  req.url = '/.well-known/mcp.json';
  app._router.handle(req, res);
});

// --- /mcp 単一エンドポイント（GET=JSON or SSE, POST=JSON-RPC）---
app.get('/mcp', (req, res) => {
  const accept = String(req.headers['accept'] || '');
  if (accept.includes('text/event-stream')) return sseHandler(req, res);
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  const base = `${proto}://${host}`;
  res.json({
    ok: true,
    protocol: 'http+sse',
    protocolVersion: '2025-06-18',
    endpointUrl: `${base}/mcp`,
    sseUrl: `${base}/mcp/sse`,
    messagesUrl: `${base}/mcp/messages`,
    alt: {
      sseUrl: `${base}/sse`,
      messagesUrl: `${base}/messages`
    },
    endpoints: { sse: `${base}/mcp/sse`, messages: `${base}/mcp/messages` }
  });
});
app.post('/mcp', (req, res) => messagesHandler(req, res));

// ベースURL: まずは /mcp/sse へ恒久リダイレクト（Dify が待ち続けるパスを強制的にSSEへ）
app.get('/', (req, res) => {
  const accept = String(req.headers['accept'] || '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  const base = `${proto}://${host}`;
  const sse = `${base}/mcp/sse`;
  res.setHeader('X-MCP-Endpoint', sse);
  res.setHeader('Cache-Control', 'no-store');
  if (accept.includes('text/event-stream')) return mcpSseHandler(req, res);
  return res.redirect(308, '/mcp/sse');
});

// JSON 表現でのエンドポイント提示
app.get('/endpoint', (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  const base = `${proto}://${host}`;
  const sse = `${base}/mcp/sse`;
  const msgs = `${base}/mcp/messages`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    endpointUrl: sse,
    sseUrl: sse,
    messagesUrl: msgs,
    endpoints: { sse, messages: msgs, single: `${base}/mcp` }
  });
});

// 末尾に追加：未定義ルートを捕捉（デバッグ用）
app.use((req, res, _next) => {
  console.warn('[404]', req.method, req.url);
  res.status(404).json({ error: 'not_found' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log('HTTP gateway listening on', port);
  console.log('Health: /  | Discovery: /.well-known/mcp.json  | SSE: /sse, /mcp/sse  | JSON-RPC: /messages, /mcp/messages');
});

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

// ── SSE: /mcp/sse と /sse（両対応）─────────────────────────────────────────
function sseHandler(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // 初回セッションは寛容運用（ヘッダ不要）。形式上ヘッダを露出できるようにダミー値を付与。
  res.setHeader('mcp-session-id', 'dummy-session');
  res.setHeader('mcp-protocol-version', '2025-06-18');
  res.flushHeaders?.();
  res.write(':\n\n'); // 初回フラッシュ

  const hb = setInterval(() => { res.write(':\n\n'); }, HEARTBEAT_MS);
  req.on('close', () => { clearInterval(hb); res.end(); });
}
app.get('/mcp/sse', sseHandler);
app.get('/sse', sseHandler);

// GET /messages をヘルスOKに（Difyの探り対策）
app.get('/mcp/messages', (req, res) => res.json({ ok: true, note: 'GET accepted for health' }));
app.get('/messages', (req, res) => res.json({ ok: true, note: 'GET accepted for health' }));

// ── JSON-RPC: /mcp/messages と /messages（POST）──────────────────────────
async function messagesHandler(req, res) {
  try {
    const body = req.body || {};
    const reply = await callMCP(body);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('mcp-session-id', 'dummy-session');
    res.setHeader('mcp-protocol-version', '2025-06-18');
    res.status(200).json(reply);
  } catch (e) {
    console.error('[messages error]', e);
    res.status(502).json({ error: 'gateway_error', detail: String(e?.message || e) });
  }
}
app.post('/mcp/messages', messagesHandler);
app.post('/messages', messagesHandler);

// --- MCP Discovery: Dify が参照する可能性大 ---
app.get('/.well-known/mcp.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    name: 'chrome-devtools-mcp gateway',
    version: '0.8.1',
    transport: 'http+sse',
    endpoints: { sse: '/mcp/sse', messages: '/mcp/messages' }
  });
});

// --- /mcp 単一エンドポイント（GET=JSON or SSE, POST=JSON-RPC）---
app.get('/mcp', (req, res) => {
  const accept = String(req.headers['accept'] || '');
  if (accept.includes('text/event-stream')) return sseHandler(req, res);
  res.json({ ok: true, protocol: 'http+sse', endpoints: { sse: '/mcp/sse', messages: '/mcp/messages' } });
});
app.post('/mcp', (req, res) => messagesHandler(req, res));

// ルート（Discovery へリダイレクト）
app.get('/', (_req, res) => {
  res.redirect(308, '/.well-known/mcp.json');
});

// 末尾に追加：未定義ルートを捕捉（デバッグ用）
app.use((req, res, _next) => {
  console.warn('[404]', req.method, req.url);
  res.status(404).json({ error: 'not_found' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('HTTP gateway listening on', port));

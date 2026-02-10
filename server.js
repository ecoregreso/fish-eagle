import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODE = String(process.env.MODE || 'proxy').toLowerCase();
const DEFAULT_UPSTREAM = String(
  process.env.UPSTREAM_WS ||
    'wss://webstoreusa.net/fish-eagle-fight-api/eagle-strike/connection'
);
const UPSTREAM_ORIGIN = process.env.UPSTREAM_ORIGIN || '';
const LOG_DIR = process.env.LOG_DIR || '';
const LOG_LIMIT_BYTES = Number(process.env.LOG_LIMIT_BYTES || 0);

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function encodePayload(data) {
  if (typeof data === 'string') {
    return { kind: 'text', text: data };
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { kind: 'binary', base64: buf.toString('base64'), size: buf.length };
}

function createLogger(connId) {
  if (!LOG_DIR) return null;
  const dir = ensureDir(LOG_DIR);
  const filePath = path.join(dir, `${connId}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  let bytesWritten = 0;

  function write(entry) {
    if (!stream.writable) return;
    const line = JSON.stringify(entry) + '\n';
    bytesWritten += Buffer.byteLength(line);
    if (LOG_LIMIT_BYTES > 0 && bytesWritten > LOG_LIMIT_BYTES) return;
    stream.write(line);
  }

  function close() {
    stream.end();
  }

  return { write, close, filePath };
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/health')) {
    const body = JSON.stringify({ ok: true, time: nowIso() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname || '/';
  const allowed =
    pathname === '/' ||
    pathname === '/ws' ||
    pathname.endsWith('/connection');
  if (!allowed) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const connId = randomUUID();
  const logger = createLogger(connId);
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const query = url.searchParams;
  const mode = String(query.get('mode') || DEFAULT_MODE).toLowerCase();
  const upstream = String(
    query.get('upstream') ||
      query.get('ws') ||
      query.get('wsUrl') ||
      query.get('ws_url') ||
      DEFAULT_UPSTREAM
  );

  const meta = {
    time: nowIso(),
    connId,
    mode,
    upstream,
    ip: req.socket.remoteAddress || null,
    ua: req.headers['user-agent'] || null
  };
  if (logger) {
    logger.write({ ...meta, event: 'connection' });
  }

  if (mode === 'proxy') {
    const protocolsHeader = req.headers['sec-websocket-protocol'] || '';
    const protocols = protocolsHeader
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const upstreamHeaders = {};
    if (UPSTREAM_ORIGIN) upstreamHeaders.Origin = UPSTREAM_ORIGIN;
    const userOrigin = req.headers.origin;
    if (!UPSTREAM_ORIGIN && userOrigin) upstreamHeaders.Origin = userOrigin;

    const upstreamWs = new WebSocket(upstream, protocols, {
      headers: upstreamHeaders
    });

    let upstreamOpen = false;

    upstreamWs.on('open', () => {
      upstreamOpen = true;
      if (logger) logger.write({ time: nowIso(), connId, event: 'upstream_open' });
    });

    upstreamWs.on('message', (data) => {
      if (logger) {
        logger.write({
          time: nowIso(),
          connId,
          direction: 'upstream->client',
          ...encodePayload(data)
        });
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    upstreamWs.on('close', (code, reason) => {
      if (logger) {
        logger.write({
          time: nowIso(),
          connId,
          event: 'upstream_close',
          code,
          reason: reason ? reason.toString() : ''
        });
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    upstreamWs.on('error', (err) => {
      if (logger) {
        logger.write({
          time: nowIso(),
          connId,
          event: 'upstream_error',
          error: err?.message || String(err)
        });
      }
    });

    ws.on('message', (data) => {
      if (logger) {
        logger.write({
          time: nowIso(),
          connId,
          direction: 'client->upstream',
          ...encodePayload(data)
        });
      }
      if (upstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data);
      }
    });

    ws.on('close', (code, reason) => {
      if (logger) {
        logger.write({
          time: nowIso(),
          connId,
          event: 'client_close',
          code,
          reason: reason ? reason.toString() : ''
        });
      }
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.close();
      }
      logger?.close();
    });

    ws.on('error', (err) => {
      if (logger) {
        logger.write({
          time: nowIso(),
          connId,
          event: 'client_error',
          error: err?.message || String(err)
        });
      }
    });

    return;
  }

  // Local mode: log messages for protocol reverse-engineering.
  let pingTimer = null;
  ws.on('message', (data) => {
    if (logger) {
      logger.write({
        time: nowIso(),
        connId,
        direction: 'client->server',
        ...encodePayload(data)
      });
    }
  });

  ws.on('close', (code, reason) => {
    if (logger) {
      logger.write({
        time: nowIso(),
        connId,
        event: 'client_close',
        code,
        reason: reason ? reason.toString() : ''
      });
    }
    if (pingTimer) clearInterval(pingTimer);
    logger?.close();
  });

  ws.on('error', (err) => {
    if (logger) {
      logger.write({
        time: nowIso(),
        connId,
        event: 'client_error',
        error: err?.message || String(err)
      });
    }
  });

  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 15000);
});

server.listen(PORT, () => {
  console.log(`[fish-eagle-ws] listening on ${PORT}`);
  console.log(`[fish-eagle-ws] mode=${DEFAULT_MODE} upstream=${DEFAULT_UPSTREAM}`);
});

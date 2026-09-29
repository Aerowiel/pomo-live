import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCode } from './public/codes.js';
import { createStore, parsePinned, StoreError } from './lib/rooms.js';
import { createRateLimiter } from './lib/rate-limit.js';

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const HOUR = 3_600_000;
const MAX_BODY = 4096;

const store = createStore({ pinned: parsePinned(process.env.PINNED_ROOMS ?? '') });
const creations = createRateLimiter({ max: 5, windowMs: HOUR });
const restores = createRateLimiter({ max: 20, windowMs: HOUR });
setInterval(() => {
  store.sweep();
  creations.sweep();
  restores.sweep();
}, 10 * 60_000).unref();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const STATUS = { not_found: 404, forbidden: 403, taken: 409, invalid: 400, full: 503 };
const ROOM_ROUTE = /^\/api\/rooms\/([^/]+)\/(events|command|restore)$/;

function json(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const roomState = (room) => ({ session: room.session, serverNow: Date.now() });
const clientIp = (req) => req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown';
const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new StoreError('invalid');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') ?? {};
  } catch {
    throw new StoreError('invalid');
  }
}

// Server-Sent Events: the current state on connect, then every change, with a heartbeat for the proxy.
function events(res, code) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (room) => {
    if (!room) {
      res.end('retry: 10000\nevent: missing\ndata: {}\n\n');
      return false;
    }
    res.write(`event: state\ndata: ${JSON.stringify(roomState(room))}\n\n`);
    return true;
  };
  res.write('retry: 3000\n\n');
  if (!send(store.get(code))) return;
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  const unsubscribe = store.subscribe(code, (room) => send(room) || stop());
  function stop() {
    clearInterval(heartbeat);
    unsubscribe();
  }
  res.on('close', stop);
}

async function serveStatic(res, pathname) {
  const file = resolve(PUBLIC_DIR, `.${pathname === '/' ? '/index.html' : decodeURIComponent(pathname)}`);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 404, { error: 'not_found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') return json(res, 200, { ok: true });

  if (pathname === '/api/rooms' && req.method === 'POST') {
    if (!creations.allow(clientIp(req))) return json(res, 429, { error: 'too_many' });
    return json(res, 201, store.create());
  }

  const route = ROOM_ROUTE.exec(pathname);
  if (route) {
    const code = normalizeCode(route[1]);
    const action = route[2];
    if (!code) return json(res, 404, { error: 'not_found' });
    if (action === 'events' && req.method === 'GET') return events(res, code);
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    const body = await readJson(req);
    if (action === 'command') return json(res, 200, roomState(store.command(code, bearer(req), body)));
    if (action === 'restore') {
      if (!store.get(code) && !restores.allow(clientIp(req))) return json(res, 429, { error: 'too_many' });
      return json(res, 200, roomState(store.restore(code, bearer(req), body.session)));
    }
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, pathname);
  json(res, 404, { error: 'not_found' });
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.headersSent) return res.end();
    if (error instanceof StoreError) return json(res, STATUS[error.code] ?? 400, { error: error.code });
    if (error instanceof URIError) return json(res, 404, { error: 'not_found' });
    console.error(error);
    json(res, 500, { error: 'internal' });
  });
}).listen(PORT, () => console.log(`pomo-live listening on :${PORT}`));

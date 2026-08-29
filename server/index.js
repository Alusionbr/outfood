import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb, get, run } from './db.js';
import { api } from './api.js';
import {
  HttpError, parseCookies, parseUrl, readBody, sendJson, sendText, serializeCookie,
} from './lib/http.js';
import { SESSION_COOKIE, hashPassword, purgeExpiredSessions, userFromToken } from './lib/auth.js';
import { addClient, heartbeat, removeClient } from './lib/events.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

export function createApp() {
  getDb();
  ensureFirstAdmin();

  return async function handler(req, res) {
    const url = parseUrl(req);
    try {
      if (config.origin) applyCors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (url.pathname === '/api/events') return sse(req, res);

      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      return serveStatic(req, res, url);
    } catch (err) {
      fail(res, err);
    }
  };
}

function applyCors(req, res) {
  const origin = config.origin === '*' ? req.headers.origin || '*' : config.origin;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
}

async function handleApi(req, res, url) {
  const matched = api.match(req.method, url.pathname);
  if (!matched) return sendJson(res, 404, { error: 'Endpoint não encontrado' });

  const cookies = parseCookies(req);
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = cookies[SESSION_COOKIE] || bearer || null;
  const user = token ? userFromToken(token) : null;

  if (!matched.route.options?.public && !user) {
    return sendJson(res, 401, { error: 'Faça login para continuar' });
  }

  const ctx = {
    req, res, url, user, token,
    params: matched.params,
    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {},
    setSession(session) {
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, session.token, {
        expires: session.expires, secure: config.isProd, sameSite: 'Lax',
      }));
    },
    clearSession() {
      res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
    },
  };

  try {
    const result = await matched.route.handler(ctx);
    if (res.writableEnded) return undefined;
    return sendJson(res, req.method === 'POST' ? 201 : 200, result ?? { ok: true });
  } catch (err) {
    return fail(res, err);
  }
}

function fail(res, err) {
  if (res.writableEnded) return undefined;
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[outfood]', err);
  return sendJson(res, status, {
    error: status >= 500 ? 'Erro interno do servidor' : err.message,
    details: err.details ?? undefined,
  });
}

function sse(req, res) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = token ? userFromToken(token) : null;
  if (!user) return sendJson(res, 401, { error: 'Faça login para receber atualizações' });
  const client = addClient(res, user);
  req.on('close', () => removeClient(client));
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Arquivos estáticos + rotas amigáveis do front                       *
 * ------------------------------------------------------------------ */

const ROUTE_ALIASES = {
  '/': 'index.html',
  '/painel': 'index.html',
  '/loja': 'loja.html',
  '/cardapio': 'loja.html',
  '/entregador': 'entregador.html',
  '/cozinha': 'index.html',
  '/login': 'index.html',
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/r/')) return sendFile(res, path.join(config.publicDir, 'rastreio.html'));
  if (pathname.startsWith('/legacy/')) {
    return sendFile(res, safeJoin(config.legacyDir, pathname.replace('/legacy/', '')));
  }
  if (ROUTE_ALIASES[pathname]) return sendFile(res, path.join(config.publicDir, ROUTE_ALIASES[pathname]));

  const file = safeJoin(config.publicDir, pathname);
  if (!file) return sendText(res, 400, 'Caminho inválido');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
  // SPA: qualquer rota desconhecida cai no shell do painel.
  if (!path.extname(pathname)) return sendFile(res, path.join(config.publicDir, 'index.html'));
  return sendText(res, 404, 'Arquivo não encontrado');
}

function safeJoin(base, target) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + target));
  return resolved.startsWith(path.resolve(base)) ? resolved : null;
}

function sendFile(res, file) {
  if (!file || !fs.existsSync(file)) return sendText(res, 404, 'Arquivo não encontrado');
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  return res.end(body);
}

/* ------------------------------------------------------------------ *
 * Boot                                                                *
 * ------------------------------------------------------------------ */

export function ensureFirstAdmin() {
  const existing = get('SELECT COUNT(*) AS total FROM users');
  if (existing.total > 0) return null;
  run(
    "INSERT INTO users(name, email, password_hash, role) VALUES (?,?,?,'admin')",
    config.admin.name, config.admin.email.toLowerCase(), hashPassword(config.admin.password)
  );
  console.log(`[outfood] Administrador criado: ${config.admin.email} / ${config.admin.password}`);
  return config.admin.email;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const server = http.createServer(createApp());
  server.listen(config.port, config.host, () => {
    console.log(`[outfood] Painel em http://localhost:${config.port}`);
    console.log(`[outfood] Vitrine em http://localhost:${config.port}/loja`);
    console.log(`[outfood] Banco: ${config.dbPath}`);
  });
  setInterval(heartbeat, 25000).unref();
  setInterval(purgeExpiredSessions, 3600000).unref();
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

import { URL } from 'node:url';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new HttpError(400, msg || 'Requisição inválida', details);
export const unauthorized = (msg) => new HttpError(401, msg || 'Faça login para continuar');
export const forbidden = (msg) => new HttpError(403, msg || 'Você não tem permissão para esta ação');
export const notFound = (msg) => new HttpError(404, msg || 'Registro não encontrado');
export const conflict = (msg, details) => new HttpError(409, msg || 'Conflito de estado', details);

/** Router minimalista com rotas do tipo /api/orders/:id */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regexp = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((part) => {
            if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$'
    );
    this.routes.push({ method, regexp, keys, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathExists = false;
    for (const route of this.routes) {
      const m = route.regexp.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    if (pathExists) throw new HttpError(405, 'Método não permitido para este endereço');
    return null;
  }

  use(prefix, router) {
    for (const route of router.routes) {
      this.routes.push({ ...route, regexp: prefixRegexp(prefix, route.regexp) });
    }
    return this;
  }
}

function prefixRegexp(prefix, regexp) {
  const source = regexp.source.replace(/^\^/, '');
  return new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + source);
}

export async function readBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw badRequest('Corpo da requisição muito grande');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    try { return JSON.parse(raw); } catch { throw badRequest('JSON inválido no corpo da requisição'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { raw };
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

import crypto from 'node:crypto';
import { all, get, run } from '../db.js';
import { config } from '../config.js';
import { forbidden, unauthorized } from './http.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const derived = crypto.scryptSync(String(password), salt, hash.length / 2, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function createSessionToken() {
  const random = crypto.randomBytes(32).toString('base64url');
  const signature = crypto.createHmac('sha256', config.secret).update(random).digest('base64url');
  return `${random}.${signature}`;
}

export function isTokenIntact(token) {
  if (typeof token !== 'string') return false;
  const [random, signature] = token.split('.');
  if (!random || !signature) return false;
  const expected = crypto.createHmac('sha256', config.secret).update(random).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const SESSION_COOKIE = 'outfood_session';

export function startSession(userId, userAgent) {
  const token = createSessionToken();
  const expires = new Date(Date.now() + config.sessionDays * 24 * 3600 * 1000);
  run(
    'INSERT INTO sessions(token, user_id, expires_at, user_agent) VALUES (?,?,?,?)',
    token, userId, expires.toISOString(), (userAgent || '').slice(0, 250)
  );
  return { token, expires };
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token = ?', token);
}

export function purgeExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at < datetime('now')");
}

export function userFromToken(token) {
  if (!isTokenIntact(token)) return null;
  const row = get(
    `SELECT u.id, u.name, u.email, u.role, u.phone, u.active, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`,
    token
  );
  if (!row || !row.active) return null;
  const driver = get('SELECT id FROM drivers WHERE user_id = ?', row.id);
  return { ...row, driver_id: driver ? driver.id : null };
}

export function authenticate(emailValue, password) {
  const user = get('SELECT * FROM users WHERE email = ?', String(emailValue || '').toLowerCase());
  if (!user || !user.active) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

/* ------------------------------------------------------------------ *
 * Papéis e permissões                                                 *
 * ------------------------------------------------------------------ */

export const ROLES = ['admin', 'gerente', 'atendente', 'cozinha', 'entregador'];

export const ROLE_LABELS = {
  admin: 'Administrador',
  gerente: 'Gerente',
  atendente: 'Atendente',
  cozinha: 'Cozinha',
  entregador: 'Entregador',
};

/**
 * Permissões por papel. `*` libera tudo.
 * Cada permissão é "recurso:ação".
 */
const PERMISSIONS = {
  admin: ['*'],
  gerente: [
    'orders:*', 'customers:*', 'menu:*', 'drivers:*', 'zones:*', 'routes:*',
    'reports:*', 'cash:*', 'settings:*', 'users:read', 'kitchen:*',
  ],
  atendente: [
    'orders:read', 'orders:create', 'orders:update', 'orders:cancel', 'orders:pay',
    'orders:kitchen', 'customers:*', 'menu:read', 'drivers:read', 'routes:read',
    'routes:dispatch', 'zones:read', 'reports:read', 'cash:*', 'kitchen:*', 'settings:read',
  ],
  cozinha: ['orders:read', 'orders:kitchen', 'menu:read', 'kitchen:*', 'settings:read'],
  entregador: ['orders:read', 'routes:read', 'routes:deliver', 'drivers:self', 'settings:read'],
};

export function can(user, permission) {
  if (!user) return false;
  const granted = PERMISSIONS[user.role] || [];
  if (granted.includes('*')) return true;
  if (granted.includes(permission)) return true;
  const [resource] = permission.split(':');
  return granted.includes(`${resource}:*`);
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function requirePermission(ctx, permission) {
  requireUser(ctx);
  if (!can(ctx.user, permission)) {
    throw forbidden(`Seu perfil (${ROLE_LABELS[ctx.user.role] || ctx.user.role}) não pode executar: ${permission}`);
  }
  return ctx.user;
}

export function permissionsFor(role) {
  return PERMISSIONS[role] || [];
}

export function listUsers() {
  return all('SELECT id, name, email, role, phone, active, created_at FROM users ORDER BY name');
}

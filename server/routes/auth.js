import { Router, badRequest, conflict, notFound, unauthorized } from '../lib/http.js';
import { all, get, run, audit, getSettings, setSettings } from '../db.js';
import {
  ROLES, ROLE_LABELS, authenticate, destroySession, hashPassword, listUsers,
  permissionsFor, requirePermission, requireUser, startSession, verifyPassword,
} from '../lib/auth.js';
import { email as vEmail, oneOf, phone as vPhone, str, bool } from '../lib/validate.js';

export const authRouter = new Router();

authRouter.post('/api/auth/login', async (ctx) => {
  const emailValue = vEmail(ctx.body.email, 'e-mail', { required: true });
  const password = str(ctx.body.password, 'senha', { required: true, max: 200 });
  const user = authenticate(emailValue, password);
  if (!user) throw unauthorized('E-mail ou senha incorretos');
  const session = startSession(user.id, ctx.req.headers['user-agent']);
  ctx.setSession(session);
  audit(user.id, 'login', 'user', user.id, null);
  return { user: publicUser(user), permissions: permissionsFor(user.role) };
}, { public: true });

authRouter.post('/api/auth/logout', async (ctx) => {
  destroySession(ctx.token);
  ctx.clearSession();
  return { ok: true };
}, { public: true });

authRouter.get('/api/auth/me', async (ctx) => {
  const user = requireUser(ctx);
  return {
    user,
    permissions: permissionsFor(user.role),
    role_label: ROLE_LABELS[user.role],
    settings: publicSettings(getSettings()),
  };
});

authRouter.post('/api/auth/password', async (ctx) => {
  const user = requireUser(ctx);
  const current = str(ctx.body.current_password, 'senha atual', { required: true });
  const next = str(ctx.body.new_password, 'nova senha', { required: true, min: 6, max: 200 });
  const row = get('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!verifyPassword(current, row.password_hash)) throw badRequest('Senha atual incorreta');
  run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", hashPassword(next), user.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', user.id, ctx.token || '');
  audit(user.id, 'senha_alterada', 'user', user.id, null);
  return { ok: true };
});

/* --------------------------- usuários --------------------------- */

authRouter.get('/api/users', async (ctx) => {
  requirePermission(ctx, 'users:read');
  return listUsers();
});

authRouter.post('/api/users', async (ctx) => {
  requirePermission(ctx, 'users:create');
  const data = {
    name: str(ctx.body.name, 'nome', { required: true, max: 120 }),
    email: vEmail(ctx.body.email, 'e-mail', { required: true }),
    role: oneOf(ctx.body.role, 'perfil', ROLES, { required: true }),
    phone: vPhone(ctx.body.phone, 'telefone'),
    password: str(ctx.body.password, 'senha', { required: true, min: 6, max: 200 }),
  };
  if (get('SELECT id FROM users WHERE email = ?', data.email)) throw conflict('Já existe um usuário com este e-mail');
  const result = run(
    'INSERT INTO users(name, email, password_hash, role, phone) VALUES (?,?,?,?,?)',
    data.name, data.email, hashPassword(data.password), data.role, data.phone
  );
  const id = Number(result.lastInsertRowid);
  if (data.role === 'entregador' && !get('SELECT id FROM drivers WHERE user_id = ?', id)) {
    run("INSERT INTO drivers(user_id, name, phone, status) VALUES (?,?,?,'offline')", id, data.name, data.phone);
  }
  audit(ctx.user.id, 'usuario_criado', 'user', id, { role: data.role });
  return get('SELECT id, name, email, role, phone, active, created_at FROM users WHERE id = ?', id);
});

authRouter.patch('/api/users/:id', async (ctx) => {
  requirePermission(ctx, 'users:update');
  const id = Number(ctx.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw notFound('Usuário não encontrado');
  const fields = {};
  if (ctx.body.name !== undefined) fields.name = str(ctx.body.name, 'nome', { required: true, max: 120 });
  if (ctx.body.email !== undefined) fields.email = vEmail(ctx.body.email, 'e-mail', { required: true });
  if (ctx.body.role !== undefined) fields.role = oneOf(ctx.body.role, 'perfil', ROLES, { required: true });
  if (ctx.body.phone !== undefined) fields.phone = vPhone(ctx.body.phone, 'telefone');
  if (ctx.body.active !== undefined) fields.active = bool(ctx.body.active) ? 1 : 0;
  if (ctx.body.password) fields.password_hash = hashPassword(str(ctx.body.password, 'senha', { min: 6, max: 200 }));

  if (fields.active === 0 && id === ctx.user.id) throw badRequest('Você não pode desativar o próprio usuário');
  if (fields.role && fields.role !== 'admin' && user.role === 'admin') {
    const admins = get("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND active = 1");
    if (admins.total <= 1) throw conflict('O sistema precisa de pelo menos um administrador ativo');
  }
  const keys = Object.keys(fields);
  if (keys.length) {
    run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => fields[k]), id);
  }
  audit(ctx.user.id, 'usuario_editado', 'user', id, { fields: keys });
  return get('SELECT id, name, email, role, phone, active, created_at FROM users WHERE id = ?', id);
});

authRouter.delete('/api/users/:id', async (ctx) => {
  requirePermission(ctx, 'users:delete');
  const id = Number(ctx.params.id);
  if (id === ctx.user.id) throw badRequest('Você não pode excluir o próprio usuário');
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw notFound('Usuário não encontrado');
  run('UPDATE users SET active = 0 WHERE id = ?', id);
  run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(ctx.user.id, 'usuario_desativado', 'user', id, null);
  return { ok: true };
});

/* --------------------------- configurações --------------------------- */

authRouter.get('/api/settings', async (ctx) => {
  requirePermission(ctx, 'settings:read');
  return getSettings();
});

authRouter.put('/api/settings', async (ctx) => {
  requirePermission(ctx, 'settings:update');
  const allowed = Object.keys(getSettings());
  const patch = {};
  for (const [key, value] of Object.entries(ctx.body || {})) {
    if (allowed.includes(key)) patch[key] = value;
  }
  if (!Object.keys(patch).length) throw badRequest('Nenhuma configuração válida enviada');
  const updated = setSettings(patch);
  audit(ctx.user.id, 'configuracao', 'settings', null, { keys: Object.keys(patch) });
  return updated;
});

authRouter.get('/api/audit', async (ctx) => {
  requirePermission(ctx, 'settings:update');
  return all(
    `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 300`
  );
});

export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone };
}

/** Configurações expostas ao front autenticado (todas, menos segredos). */
export function publicSettings(settings) {
  const { pix_key, ...rest } = settings;
  return { ...rest, pix_key: pix_key ? String(pix_key) : '' };
}

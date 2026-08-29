import { Router, badRequest, conflict, notFound } from '../lib/http.js';
import { all, get, run, audit } from '../db.js';
import { requirePermission } from '../lib/auth.js';
import { applyUpdate } from './catalog.js';
import { bool, email as vEmail, formatPhone, num, phone as vPhone, str } from '../lib/validate.js';
import { addressQuery, geocode } from '../services/geocode.js';
import { getSettings } from '../db.js';

export const customersRouter = new Router();

customersRouter.get('/api/customers', async (ctx) => {
  requirePermission(ctx, 'customers:read');
  const q = (ctx.url.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500);
  const rows = q
    ? all(
        `SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name LIMIT ?`,
        `%${q}%`, `%${q.replace(/\D/g, '')}%`, limit
      )
    : all('SELECT * FROM customers ORDER BY name LIMIT ?', limit);
  return rows.map(decorateCustomer);
});

customersRouter.get('/api/customers/lookup', async (ctx) => {
  requirePermission(ctx, 'customers:read');
  const digits = (ctx.url.searchParams.get('phone') || '').replace(/\D/g, '');
  if (digits.length < 8) throw badRequest('Informe o telefone com DDD');
  const customer = get('SELECT * FROM customers WHERE phone = ?', digits);
  if (!customer) return { found: false };
  return { found: true, customer: withAddresses(decorateCustomer(customer)) };
});

customersRouter.get('/api/customers/:id', async (ctx) => {
  requirePermission(ctx, 'customers:read');
  const customer = get('SELECT * FROM customers WHERE id = ?', Number(ctx.params.id));
  if (!customer) throw notFound('Cliente não encontrado');
  const decorated = withAddresses(decorateCustomer(customer));
  decorated.orders = all(
    `SELECT id, code, business_day, status, type, total_cents, created_at, rating
       FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50`,
    customer.id
  );
  return decorated;
});

customersRouter.post('/api/customers', async (ctx) => {
  requirePermission(ctx, 'customers:create');
  const data = {
    name: str(ctx.body.name, 'nome', { required: true, max: 120 }),
    phone: vPhone(ctx.body.phone, 'telefone', { required: true }),
    email: vEmail(ctx.body.email, 'e-mail'),
    notes: str(ctx.body.notes, 'observações', { max: 1000 }),
  };
  const existing = get('SELECT * FROM customers WHERE phone = ?', data.phone);
  if (existing) throw conflict(`Já existe um cliente com este telefone: ${existing.name}`, { customer_id: existing.id });
  const result = run('INSERT INTO customers(name, phone, email, notes) VALUES (?,?,?,?)',
    data.name, data.phone, data.email, data.notes);
  const id = Number(result.lastInsertRowid);
  if (ctx.body.address) await saveAddress(id, ctx.body.address, true);
  audit(ctx.user.id, 'cliente_criado', 'customer', id, { name: data.name });
  return withAddresses(decorateCustomer(get('SELECT * FROM customers WHERE id = ?', id)));
});

customersRouter.patch('/api/customers/:id', async (ctx) => {
  requirePermission(ctx, 'customers:update');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM customers WHERE id = ?', id)) throw notFound('Cliente não encontrado');
  const fields = {};
  if (ctx.body.name !== undefined) fields.name = str(ctx.body.name, 'nome', { required: true, max: 120 });
  if (ctx.body.phone !== undefined) fields.phone = vPhone(ctx.body.phone, 'telefone', { required: true });
  if (ctx.body.email !== undefined) fields.email = vEmail(ctx.body.email, 'e-mail');
  if (ctx.body.notes !== undefined) fields.notes = str(ctx.body.notes, 'observações', { max: 1000 });
  if (ctx.body.blocked !== undefined) fields.blocked = bool(ctx.body.blocked) ? 1 : 0;
  if (fields.phone) {
    const clash = get('SELECT id FROM customers WHERE phone = ? AND id <> ?', fields.phone, id);
    if (clash) throw conflict('Outro cliente já usa este telefone');
  }
  applyUpdate('customers', id, { ...fields, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  return withAddresses(decorateCustomer(get('SELECT * FROM customers WHERE id = ?', id)));
});

customersRouter.delete('/api/customers/:id', async (ctx) => {
  requirePermission(ctx, 'customers:delete');
  const id = Number(ctx.params.id);
  const used = get('SELECT COUNT(*) AS total FROM orders WHERE customer_id = ?', id);
  if (used?.total > 0) throw conflict('Cliente possui pedidos e não pode ser excluído. Use o bloqueio.');
  run('DELETE FROM customers WHERE id = ?', id);
  return { ok: true };
});

/* --------------------------- endereços --------------------------- */

customersRouter.post('/api/customers/:id/addresses', async (ctx) => {
  requirePermission(ctx, 'customers:update');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM customers WHERE id = ?', id)) throw notFound('Cliente não encontrado');
  const address = await saveAddress(id, ctx.body, bool(ctx.body.is_default, false));
  return address;
});

customersRouter.patch('/api/addresses/:id', async (ctx) => {
  requirePermission(ctx, 'customers:update');
  const id = Number(ctx.params.id);
  const address = get('SELECT * FROM addresses WHERE id = ?', id);
  if (!address) throw notFound('Endereço não encontrado');
  const fields = {};
  for (const key of ['label', 'street', 'number', 'complement', 'district', 'city', 'state', 'zip', 'reference']) {
    if (ctx.body[key] !== undefined) fields[key] = str(ctx.body[key], key, { max: 200 });
  }
  if (ctx.body.lat !== undefined) fields.lat = num(ctx.body.lat, 'latitude', { min: -90, max: 90 });
  if (ctx.body.lon !== undefined) fields.lon = num(ctx.body.lon, 'longitude', { min: -180, max: 180 });
  if (bool(ctx.body.is_default, false)) {
    run('UPDATE addresses SET is_default = 0 WHERE customer_id = ?', address.customer_id);
    fields.is_default = 1;
  }
  applyUpdate('addresses', id, fields);
  const updated = get('SELECT * FROM addresses WHERE id = ?', id);
  if (updated.lat == null && (fields.street || fields.district)) await geocodeAddress(updated);
  return get('SELECT * FROM addresses WHERE id = ?', id);
});

customersRouter.delete('/api/addresses/:id', async (ctx) => {
  requirePermission(ctx, 'customers:update');
  run('DELETE FROM addresses WHERE id = ?', Number(ctx.params.id));
  return { ok: true };
});

/* --------------------------- geocodificação --------------------------- */

customersRouter.get('/api/geo/search', async (ctx) => {
  requirePermission(ctx, 'orders:read');
  const q = ctx.url.searchParams.get('q');
  if (!q) throw badRequest('Informe o endereço a localizar');
  const point = await geocode(q);
  return point ? { found: true, ...point } : { found: false };
});

export async function saveAddress(customerId, body, makeDefault = false) {
  const settings = getSettings();
  const data = {
    label: str(body.label, 'apelido', { max: 40 }),
    street: str(body.street, 'rua', { required: true, max: 160 }),
    number: str(body.number, 'número', { max: 20 }),
    complement: str(body.complement, 'complemento', { max: 80 }),
    district: str(body.district, 'bairro', { max: 80 }),
    city: str(body.city, 'cidade', { max: 80 }) || settings.city,
    state: str(body.state, 'estado', { max: 4 }),
    zip: str(body.zip, 'CEP', { max: 12 }),
    reference: str(body.reference, 'referência', { max: 160 }),
    lat: body.lat != null ? num(body.lat, 'latitude', { min: -90, max: 90 }) : null,
    lon: body.lon != null ? num(body.lon, 'longitude', { min: -180, max: 180 }) : null,
  };
  if (data.lat == null) {
    const point = await geocode(addressQuery(data, settings.city));
    if (point) { data.lat = point.lat; data.lon = point.lon; }
  }
  const existing = get('SELECT COUNT(*) AS total FROM addresses WHERE customer_id = ?', customerId);
  const isDefault = makeDefault || existing.total === 0 ? 1 : 0;
  if (isDefault) run('UPDATE addresses SET is_default = 0 WHERE customer_id = ?', customerId);
  const keys = Object.keys(data);
  const result = run(
    `INSERT INTO addresses(customer_id, ${keys.join(',')}, is_default) VALUES (?, ${keys.map(() => '?').join(',')}, ?)`,
    customerId, ...keys.map((k) => data[k]), isDefault
  );
  return get('SELECT * FROM addresses WHERE id = ?', Number(result.lastInsertRowid));
}

async function geocodeAddress(address) {
  const settings = getSettings();
  const point = await geocode(addressQuery(address, settings.city));
  if (point) run('UPDATE addresses SET lat = ?, lon = ? WHERE id = ?', point.lat, point.lon, address.id);
}

function decorateCustomer(customer) {
  const stats = get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS spent_cents, MAX(created_at) AS last_order_at
       FROM orders WHERE customer_id = ? AND status <> 'cancelado'`,
    customer.id
  );
  return {
    ...customer,
    blocked: !!customer.blocked,
    phone_formatted: formatPhone(customer.phone),
    orders_count: stats?.orders || 0,
    spent_cents: stats?.spent_cents || 0,
    last_order_at: stats?.last_order_at || null,
  };
}

function withAddresses(customer) {
  return {
    ...customer,
    addresses: all('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id', customer.id)
      .map((a) => ({ ...a, is_default: !!a.is_default })),
  };
}

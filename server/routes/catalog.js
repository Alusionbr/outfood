import { Router, badRequest, notFound } from '../lib/http.js';
import { all, get, run, audit } from '../db.js';
import { requirePermission } from '../lib/auth.js';
import { bool, int, str } from '../lib/validate.js';
import { publish } from '../lib/events.js';

export const catalogRouter = new Router();

/** Cardápio completo agrupado por categoria (usado no PDV e na loja online). */
export function buildMenu({ onlyActive = false } = {}) {
  const categories = all(
    `SELECT * FROM categories ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort, name`
  );
  const products = all(
    `SELECT * FROM products ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort, name`
  );
  const options = all('SELECT * FROM product_options WHERE active = 1 ORDER BY group_name, name');
  const byProduct = new Map();
  for (const option of options) {
    if (!byProduct.has(option.product_id)) byProduct.set(option.product_id, []);
    byProduct.get(option.product_id).push(option);
  }
  const decorated = products.map((p) => ({
    ...p,
    active: !!p.active,
    stock_control: !!p.stock_control,
    available: !p.stock_control || p.stock_qty > 0,
    options: byProduct.get(p.id) || [],
  }));
  return categories.map((c) => ({
    ...c,
    active: !!c.active,
    products: decorated.filter((p) => p.category_id === c.id),
  })).concat(
    decorated.some((p) => !p.category_id)
      ? [{ id: null, name: 'Sem categoria', sort: 999, active: true, products: decorated.filter((p) => !p.category_id) }]
      : []
  );
}

catalogRouter.get('/api/menu', async (ctx) => {
  requirePermission(ctx, 'menu:read');
  return buildMenu({ onlyActive: ctx.url.searchParams.get('active') === '1' });
});

/* --------------------------- categorias --------------------------- */

catalogRouter.get('/api/categories', async (ctx) => {
  requirePermission(ctx, 'menu:read');
  return all('SELECT * FROM categories ORDER BY sort, name');
});

catalogRouter.post('/api/categories', async (ctx) => {
  requirePermission(ctx, 'menu:create');
  const name = str(ctx.body.name, 'nome', { required: true, max: 80 });
  const result = run('INSERT INTO categories(name, sort, active) VALUES (?,?,?)',
    name, int(ctx.body.sort, 'ordem', { def: 0 }), bool(ctx.body.active, true) ? 1 : 0);
  publish('menu:updated', {});
  return get('SELECT * FROM categories WHERE id = ?', Number(result.lastInsertRowid));
});

catalogRouter.patch('/api/categories/:id', async (ctx) => {
  requirePermission(ctx, 'menu:update');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM categories WHERE id = ?', id)) throw notFound('Categoria não encontrada');
  const fields = {};
  if (ctx.body.name !== undefined) fields.name = str(ctx.body.name, 'nome', { required: true, max: 80 });
  if (ctx.body.sort !== undefined) fields.sort = int(ctx.body.sort, 'ordem', { def: 0 });
  if (ctx.body.active !== undefined) fields.active = bool(ctx.body.active) ? 1 : 0;
  applyUpdate('categories', id, fields);
  publish('menu:updated', {});
  return get('SELECT * FROM categories WHERE id = ?', id);
});

catalogRouter.delete('/api/categories/:id', async (ctx) => {
  requirePermission(ctx, 'menu:delete');
  const id = Number(ctx.params.id);
  run('UPDATE products SET category_id = NULL WHERE category_id = ?', id);
  run('DELETE FROM categories WHERE id = ?', id);
  publish('menu:updated', {});
  return { ok: true };
});

/* --------------------------- produtos --------------------------- */

catalogRouter.get('/api/products', async (ctx) => {
  requirePermission(ctx, 'menu:read');
  const q = ctx.url.searchParams.get('q');
  const rows = q
    ? all('SELECT * FROM products WHERE name LIKE ? OR sku LIKE ? ORDER BY name', `%${q}%`, `%${q}%`)
    : all('SELECT * FROM products ORDER BY sort, name');
  return rows.map((p) => ({ ...p, active: !!p.active, stock_control: !!p.stock_control }));
});

catalogRouter.post('/api/products', async (ctx) => {
  requirePermission(ctx, 'menu:create');
  const data = productFields(ctx.body, true);
  const keys = Object.keys(data);
  const result = run(
    `INSERT INTO products(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ...keys.map((k) => data[k])
  );
  const id = Number(result.lastInsertRowid);
  saveOptions(id, ctx.body.options);
  audit(ctx.user.id, 'produto_criado', 'product', id, { name: data.name });
  publish('menu:updated', {});
  return get('SELECT * FROM products WHERE id = ?', id);
});

catalogRouter.patch('/api/products/:id', async (ctx) => {
  requirePermission(ctx, 'menu:update');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM products WHERE id = ?', id)) throw notFound('Produto não encontrado');
  applyUpdate('products', id, productFields(ctx.body, false));
  if (ctx.body.options !== undefined) saveOptions(id, ctx.body.options);
  audit(ctx.user.id, 'produto_editado', 'product', id, null);
  publish('menu:updated', {});
  return get('SELECT * FROM products WHERE id = ?', id);
});

catalogRouter.delete('/api/products/:id', async (ctx) => {
  requirePermission(ctx, 'menu:delete');
  const id = Number(ctx.params.id);
  // Produtos com histórico são desativados, não excluídos, para não perder relatórios.
  const used = get('SELECT COUNT(*) AS total FROM order_items WHERE product_id = ?', id);
  if (used?.total > 0) {
    run('UPDATE products SET active = 0 WHERE id = ?', id);
    publish('menu:updated', {});
    return { ok: true, deactivated: true };
  }
  run('DELETE FROM products WHERE id = ?', id);
  publish('menu:updated', {});
  return { ok: true, deactivated: false };
});

catalogRouter.post('/api/products/:id/stock', async (ctx) => {
  requirePermission(ctx, 'menu:update');
  const id = Number(ctx.params.id);
  const product = get('SELECT * FROM products WHERE id = ?', id);
  if (!product) throw notFound('Produto não encontrado');
  const qty = int(ctx.body.stock_qty, 'quantidade', { required: true, min: 0 });
  run('UPDATE products SET stock_qty = ?, stock_control = 1 WHERE id = ?', qty, id);
  publish('menu:updated', {});
  return get('SELECT * FROM products WHERE id = ?', id);
});

function productFields(body, isNew) {
  const fields = {};
  const setIf = (key, value) => { if (value !== undefined) fields[key] = value; };
  if (isNew || body.name !== undefined) fields.name = str(body.name, 'nome', { required: isNew, max: 120 });
  setIf('description', body.description !== undefined ? str(body.description, 'descrição', { max: 500 }) : undefined);
  if (isNew || body.price_cents !== undefined) fields.price_cents = int(body.price_cents, 'preço', { required: isNew, min: 0, def: 0 });
  setIf('cost_cents', body.cost_cents !== undefined ? int(body.cost_cents, 'custo', { min: 0, def: 0 }) : undefined);
  setIf('category_id', body.category_id !== undefined ? (body.category_id ? Number(body.category_id) : null) : undefined);
  setIf('sku', body.sku !== undefined ? str(body.sku, 'SKU', { max: 40 }) : undefined);
  setIf('prep_minutes', body.prep_minutes !== undefined ? int(body.prep_minutes, 'tempo de preparo', { min: 0, max: 300, def: 10 }) : undefined);
  setIf('stock_control', body.stock_control !== undefined ? (bool(body.stock_control) ? 1 : 0) : undefined);
  setIf('stock_qty', body.stock_qty !== undefined ? int(body.stock_qty, 'estoque', { def: 0 }) : undefined);
  setIf('active', body.active !== undefined ? (bool(body.active) ? 1 : 0) : undefined);
  setIf('sort', body.sort !== undefined ? int(body.sort, 'ordem', { def: 0 }) : undefined);
  if (isNew) {
    fields.prep_minutes ??= 10;
    fields.active ??= 1;
  }
  return fields;
}

function saveOptions(productId, options) {
  if (!Array.isArray(options)) return;
  run('DELETE FROM product_options WHERE product_id = ?', productId);
  for (const option of options) {
    const name = str(option.name, 'nome do adicional', { max: 80 });
    if (!name) continue;
    run('INSERT INTO product_options(product_id, group_name, name, price_cents, active) VALUES (?,?,?,?,?)',
      productId, str(option.group_name, 'grupo', { max: 60 }) || 'Adicionais', name,
      int(option.price_cents, 'preço do adicional', { def: 0, min: 0 }), bool(option.active, true) ? 1 : 0);
  }
}

export function applyUpdate(table, id, fields) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
}

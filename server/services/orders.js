import crypto from 'node:crypto';
import { all, get, run, getSettings, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { calcDeliveryFee, itemTotal, storePoint, totalizeOrder } from './pricing.js';
import { findZone, haversine } from '../lib/geo.js';
import { publish } from '../lib/events.js';

export const ORDER_STATUS = ['rascunho', 'recebido', 'em_preparo', 'pronto', 'em_entrega', 'entregue', 'cancelado'];

export const STATUS_LABELS = {
  rascunho: 'Rascunho',
  recebido: 'Recebido',
  em_preparo: 'Em preparo',
  pronto: 'Pronto',
  em_entrega: 'Em entrega',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
};

export const OPEN_STATUSES = ['recebido', 'em_preparo', 'pronto', 'em_entrega'];

export const CHANNELS = ['balcao', 'telefone', 'whatsapp', 'site', 'ifood', 'rappi', 'outra_plataforma'];
export const ORDER_TYPES = ['entrega', 'retirada', 'salao'];
export const COURIERS = ['loja', 'plataforma'];
export const PAYMENT_METHODS = ['dinheiro', 'pix', 'credito', 'debito', 'vale_refeicao', 'online'];

const TRANSITIONS = {
  rascunho: ['recebido', 'cancelado'],
  recebido: ['em_preparo', 'pronto', 'cancelado'],
  em_preparo: ['pronto', 'cancelado'],
  pronto: ['em_entrega', 'entregue', 'cancelado'],
  em_entrega: ['entregue', 'pronto', 'cancelado'],
  entregue: [],
  cancelado: [],
};

const STATUS_TIMESTAMP = {
  recebido: 'confirmed_at',
  pronto: 'ready_at',
  em_entrega: 'dispatched_at',
  entregue: 'delivered_at',
  cancelado: 'cancelled_at',
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function nextStatuses(order) {
  const list = TRANSITIONS[order.status] || [];
  if (order.type !== 'entrega' || order.courier === 'plataforma') {
    return list.filter((s) => s !== 'em_entrega');
  }
  return list.filter((s) => !(s === 'entregue' && order.status === 'pronto'));
}

export function businessDay(date = new Date()) {
  // O dia comercial vira às 05:00 — pedidos da madrugada pertencem ao dia anterior.
  const d = new Date(date.getTime() - 5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export function nextOrderCode(day = businessDay()) {
  const row = get('SELECT COUNT(*) AS total FROM orders WHERE business_day = ?', day);
  const seq = (row?.total || 0) + 1;
  return `${day.replace(/-/g, '').slice(4)}-${String(seq).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Leitura                                                             *
 * ------------------------------------------------------------------ */

export function orderItems(orderId) {
  return all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', orderId).map((item) => ({
    ...item,
    options: safeParse(item.options_json, []),
  }));
}

export function orderPayments(orderId) {
  return all('SELECT * FROM payments WHERE order_id = ? ORDER BY id', orderId);
}

export function orderTimeline(orderId) {
  return all(
    `SELECT e.*, u.name AS user_name FROM order_events e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.order_id = ? ORDER BY e.id`,
    orderId
  );
}

export function getOrder(id, { full = true } = {}) {
  const order = get(
    `SELECT o.*, d.name AS driver_name, z.name AS zone_name
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       LEFT JOIN zones z ON z.id = o.zone_id
      WHERE o.id = ?`,
    id
  );
  if (!order) return null;
  return decorate(order, full);
}

export function getOrderByToken(token) {
  const order = get(
    `SELECT o.*, d.name AS driver_name FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id WHERE o.public_token = ?`,
    token
  );
  return order ? decorate(order, true) : null;
}

export function decorate(order, full = false) {
  const decorated = {
    ...order,
    address: formatAddress(order),
    status_label: STATUS_LABELS[order.status] || order.status,
    next_statuses: nextStatuses(order),
    paid: !!order.paid,
  };
  if (full) {
    decorated.items = orderItems(order.id);
    decorated.payments = orderPayments(order.id);
    decorated.timeline = orderTimeline(order.id);
  }
  return decorated;
}

export function formatAddress(order) {
  if (!order.street && !order.district) return '';
  const line = [order.street, order.number].filter(Boolean).join(', ');
  return [line, order.complement, order.district, order.city].filter(Boolean).join(' - ');
}

export function listOrders(filters = {}) {
  const where = [];
  const params = [];
  if (filters.status) {
    const statuses = String(filters.status).split(',').map((s) => s.trim()).filter(Boolean);
    where.push(`o.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (filters.open) { where.push(`o.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES); }
  if (filters.day) { where.push('o.business_day = ?'); params.push(filters.day); }
  if (filters.from) { where.push('o.business_day >= ?'); params.push(filters.from); }
  if (filters.to) { where.push('o.business_day <= ?'); params.push(filters.to); }
  if (filters.driver_id) { where.push('o.driver_id = ?'); params.push(filters.driver_id); }
  if (filters.customer_id) { where.push('o.customer_id = ?'); params.push(filters.customer_id); }
  if (filters.route_id) { where.push('o.route_id = ?'); params.push(filters.route_id); }
  if (filters.type) { where.push('o.type = ?'); params.push(filters.type); }
  if (filters.channel) { where.push('o.channel = ?'); params.push(filters.channel); }
  if (filters.unassigned) { where.push("o.driver_id IS NULL AND o.type = 'entrega' AND o.courier = 'loja'"); }
  if (filters.q) {
    where.push('(o.code LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.street LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  const limit = Math.min(Number(filters.limit) || 200, 1000);
  const rows = all(
    `SELECT o.*, d.name AS driver_name, z.name AS zone_name
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       LEFT JOIN zones z ON z.id = o.zone_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.id DESC LIMIT ?`,
    ...params,
    limit
  );
  const withItems = filters.with_items !== false;
  return rows.map((row) => decorate(row, false)).map((row) => (withItems ? { ...row, items: orderItems(row.id) } : row));
}

/* ------------------------------------------------------------------ *
 * Escrita                                                             *
 * ------------------------------------------------------------------ */

/** Resolve os itens do pedido a partir do cardápio, congelando preço e nome. */
export function resolveItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw badRequest('Inclua ao menos um item no pedido');
  return rawItems.map((raw, index) => {
    const qty = Number(raw.qty ?? 1);
    if (!Number.isFinite(qty) || qty <= 0) throw badRequest(`Quantidade inválida no item ${index + 1}`);
    let name = raw.name ? String(raw.name).trim() : '';
    let unit = raw.unit_price_cents != null ? Math.round(Number(raw.unit_price_cents)) : null;
    let productId = raw.product_id ? Number(raw.product_id) : null;

    if (productId) {
      const product = get('SELECT * FROM products WHERE id = ?', productId);
      if (!product) throw badRequest(`Produto ${productId} não existe`);
      if (!product.active) throw badRequest(`Produto "${product.name}" está inativo`);
      name = name || product.name;
      if (unit == null) unit = product.price_cents;
    }
    if (!name) throw badRequest(`Informe o nome do item ${index + 1}`);
    if (unit == null || !Number.isFinite(unit) || unit < 0) throw badRequest(`Preço inválido no item "${name}"`);

    const options = (Array.isArray(raw.options) ? raw.options : []).map((o) => ({
      id: o.id ?? null,
      name: String(o.name || '').trim(),
      price_cents: Math.round(Number(o.price_cents) || 0),
    })).filter((o) => o.name);

    const item = { product_id: productId, name, qty, unit_price_cents: unit, notes: raw.notes ? String(raw.notes).trim() : null, options };
    item.total_cents = itemTotal(item);
    return item;
  });
}

export function createOrder(input, user) {
  const settings = getSettings();
  const items = resolveItems(input.items);
  const type = input.type || 'entrega';
  const courier = input.courier || 'loja';
  const point = input.lat != null && input.lon != null ? { lat: Number(input.lat), lon: Number(input.lon) } : null;
  const subtotal = items.reduce((acc, i) => acc + i.total_cents, 0);

  let feeInfo = { fee_cents: 0, zone: null, source: 'retirada' };
  if (type === 'entrega') {
    feeInfo = calcDeliveryFee({
      settings,
      point,
      subtotalCents: subtotal,
      override: input.delivery_fee_cents,
    });
  }

  const totals = totalizeOrder({
    items,
    deliveryFeeCents: feeInfo.fee_cents,
    discountCents: input.discount_cents,
    surchargeCents: input.surcharge_cents,
  });

  const minOrder = Number(settings.min_order_cents) || 0;
  if (type === 'entrega' && minOrder > 0 && totals.subtotal_cents < minOrder) {
    throw badRequest(`Pedido mínimo para entrega é de ${(minOrder / 100).toFixed(2)}`);
  }

  const zone = feeInfo.zone || findZone(point, all('SELECT * FROM zones WHERE active = 1'));
  const store = storePoint(settings);
  const distance = store && point ? Math.round(haversine(store, point) * 100) / 100 : null;
  const prep = Number(input.prep_minutes) || estimatePrepMinutes(items, settings);
  const day = businessDay();
  const status = input.status === 'rascunho' ? 'rascunho' : 'recebido';

  return transaction(() => {
    const result = run(
      `INSERT INTO orders (
         code, public_token, business_day, customer_id, customer_name, customer_phone,
         channel, type, courier, status, platform_name, platform_code,
         street, number, complement, district, city, reference, lat, lon, zone_id, distance_km,
         subtotal_cents, delivery_fee_cents, discount_cents, surcharge_cents, total_cents,
         paid, payment_method, change_for_cents, notes, prep_minutes, promised_at, scheduled_for, created_by
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      nextOrderCode(day),
      crypto.randomBytes(9).toString('base64url'),
      day,
      input.customer_id ?? null,
      String(input.customer_name || 'Consumidor').trim(),
      input.customer_phone ?? null,
      input.channel || 'balcao',
      type,
      courier,
      status,
      input.platform_name ?? null,
      input.platform_code ?? null,
      input.street ?? null,
      input.number ?? null,
      input.complement ?? null,
      input.district ?? null,
      input.city ?? settings.city ?? null,
      input.reference ?? null,
      point?.lat ?? null,
      point?.lon ?? null,
      zone?.id ?? null,
      distance,
      totals.subtotal_cents,
      totals.delivery_fee_cents,
      totals.discount_cents,
      totals.surcharge_cents,
      totals.total_cents,
      input.paid ? 1 : 0,
      input.payment_method ?? null,
      Math.round(Number(input.change_for_cents) || 0),
      input.notes ?? null,
      prep,
      new Date(Date.now() + prep * 60000).toISOString(),
      input.scheduled_for ?? null,
      user?.id ?? null
    );
    const orderId = Number(result.lastInsertRowid);
    insertItems(orderId, items);
    if (input.paid && input.payment_method) {
      run('INSERT INTO payments(order_id, method, amount_cents, received_cents, user_id) VALUES (?,?,?,?,?)',
        orderId, input.payment_method, totals.total_cents, totals.total_cents, user?.id ?? null);
    }
    logEvent(orderId, 'criado', null, status, `Pedido criado via ${input.channel || 'balcao'}`, user?.id);
    decrementStock(items);
    const order = getOrder(orderId);
    publish('order:created', { order });
    return order;
  });
}

function insertItems(orderId, items) {
  for (const item of items) {
    run(
      'INSERT INTO order_items(order_id, product_id, name, qty, unit_price_cents, total_cents, notes, options_json) VALUES (?,?,?,?,?,?,?,?)',
      orderId, item.product_id, item.name, item.qty, item.unit_price_cents, item.total_cents,
      item.notes ?? null, JSON.stringify(item.options || [])
    );
  }
}

function decrementStock(items) {
  for (const item of items) {
    if (!item.product_id) continue;
    run('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND stock_control = 1', item.qty, item.product_id);
  }
}

function restoreStock(orderId) {
  const items = all('SELECT product_id, qty FROM order_items WHERE order_id = ? AND product_id IS NOT NULL', orderId);
  for (const item of items) {
    run('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND stock_control = 1', item.qty, item.product_id);
  }
}

export function estimatePrepMinutes(items, settings) {
  const byProduct = items
    .map((i) => (i.product_id ? get('SELECT prep_minutes FROM products WHERE id = ?', i.product_id)?.prep_minutes : null))
    .filter((v) => v != null);
  const base = byProduct.length ? Math.max(...byProduct) : Number(settings.default_prep_minutes) || 25;
  const extra = Math.max(0, items.length - 3) * 2;
  return Math.round(base + extra);
}

export function updateOrder(id, input, user) {
  const order = get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw notFound('Pedido não encontrado');
  if (['entregue', 'cancelado'].includes(order.status)) {
    throw conflict(`Pedido ${order.code} já está ${STATUS_LABELS[order.status].toLowerCase()} e não pode ser editado`);
  }
  const settings = getSettings();

  return transaction(() => {
    let items = orderItems(id);
    if (input.items) {
      restoreStock(id);
      items = resolveItems(input.items);
      run('DELETE FROM order_items WHERE order_id = ?', id);
      insertItems(id, items);
      decrementStock(items);
    }
    const type = input.type || order.type;
    const lat = input.lat !== undefined ? input.lat : order.lat;
    const lon = input.lon !== undefined ? input.lon : order.lon;
    const point = lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : null;
    const subtotal = items.reduce((acc, i) => acc + (i.total_cents ?? itemTotal(i)), 0);

    let fee = order.delivery_fee_cents;
    if (input.delivery_fee_cents !== undefined) fee = Math.round(Number(input.delivery_fee_cents) || 0);
    else if (type !== 'entrega') fee = 0;
    else if (input.items || input.lat !== undefined) {
      fee = calcDeliveryFee({ settings, point, subtotalCents: subtotal }).fee_cents;
    }

    const totals = totalizeOrder({
      items: items.map((i) => ({ ...i, options: i.options || [] })),
      deliveryFeeCents: fee,
      discountCents: input.discount_cents !== undefined ? input.discount_cents : order.discount_cents,
      surchargeCents: input.surcharge_cents !== undefined ? input.surcharge_cents : order.surcharge_cents,
    });

    const fields = {
      customer_name: input.customer_name ?? order.customer_name,
      customer_phone: input.customer_phone !== undefined ? input.customer_phone : order.customer_phone,
      customer_id: input.customer_id !== undefined ? input.customer_id : order.customer_id,
      channel: input.channel ?? order.channel,
      type,
      courier: input.courier ?? order.courier,
      street: input.street !== undefined ? input.street : order.street,
      number: input.number !== undefined ? input.number : order.number,
      complement: input.complement !== undefined ? input.complement : order.complement,
      district: input.district !== undefined ? input.district : order.district,
      city: input.city !== undefined ? input.city : order.city,
      reference: input.reference !== undefined ? input.reference : order.reference,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      notes: input.notes !== undefined ? input.notes : order.notes,
      payment_method: input.payment_method !== undefined ? input.payment_method : order.payment_method,
      change_for_cents: input.change_for_cents !== undefined ? Math.round(Number(input.change_for_cents) || 0) : order.change_for_cents,
      scheduled_for: input.scheduled_for !== undefined ? input.scheduled_for : order.scheduled_for,
      ...totals,
    };
    if (point) {
      const zone = findZone(point, all('SELECT * FROM zones WHERE active = 1'));
      fields.zone_id = zone?.id ?? null;
      const store = storePoint(settings);
      fields.distance_km = store ? Math.round(haversine(store, point) * 100) / 100 : null;
    }

    const keys = Object.keys(fields);
    run(
      `UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...keys.map((k) => fields[k]),
      id
    );
    logEvent(id, 'editado', order.status, order.status, input.reason || 'Pedido atualizado', user?.id);
    const updated = getOrder(id);
    publish('order:updated', { order: updated });
    return updated;
  });
}

export function changeStatus(id, to, user, options = {}) {
  const order = get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.status === to) return getOrder(id);
  const allowed = nextStatuses(order);
  if (!allowed.includes(to)) {
    throw conflict(
      `Não é possível mudar de "${STATUS_LABELS[order.status]}" para "${STATUS_LABELS[to] || to}"`,
      { from: order.status, allowed }
    );
  }
  if (to === 'em_entrega' && !order.driver_id && order.courier === 'loja') {
    throw conflict('Defina o entregador antes de despachar o pedido');
  }

  return transaction(() => {
    const stamp = STATUS_TIMESTAMP[to];
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const params = [to];
    if (stamp) { sets.push(`${stamp} = datetime('now')`); }
    if (to === 'cancelado') { sets.push('cancel_reason = ?'); params.push(options.reason || null); }
    run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, ...params, id);

    if (to === 'cancelado') restoreStock(id);
    if (to === 'entregue') {
      run("UPDATE route_stops SET status = 'entregue', delivered_at = datetime('now') WHERE order_id = ? AND status = 'pendente'", id);
      finishRouteIfDone(order.route_id);
    }
    logEvent(id, 'status', order.status, to, options.reason || null, user?.id);
    const updated = getOrder(id);
    publish('order:status', { order: updated, from: order.status, to });
    return updated;
  });
}

export function finishRouteIfDone(routeId) {
  if (!routeId) return;
  const pending = get("SELECT COUNT(*) AS total FROM route_stops WHERE route_id = ? AND status = 'pendente'", routeId);
  if (pending && pending.total === 0) {
    run("UPDATE routes SET status = 'concluida', finished_at = datetime('now') WHERE id = ? AND status <> 'concluida'", routeId);
    const route = get('SELECT * FROM routes WHERE id = ?', routeId);
    if (route) {
      const stillRouting = get(
        "SELECT COUNT(*) AS total FROM routes WHERE driver_id = ? AND status = 'em_rota'", route.driver_id
      );
      if (stillRouting && stillRouting.total === 0) {
        run("UPDATE drivers SET status = 'na_loja' WHERE id = ?", route.driver_id);
      }
      publish('route:finished', { route_id: routeId, driver_id: route.driver_id });
    }
  }
}

export function addPayment(id, { method, amount_cents, received_cents }, user) {
  const order = get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw notFound('Pedido não encontrado');
  const amount = Math.round(Number(amount_cents) || 0);
  if (amount <= 0) throw badRequest('Informe um valor de pagamento maior que zero');
  const received = Math.round(Number(received_cents) || amount);
  const change = Math.max(0, received - amount);

  return transaction(() => {
    run('INSERT INTO payments(order_id, method, amount_cents, received_cents, change_cents, user_id) VALUES (?,?,?,?,?,?)',
      id, method, amount, received, change, user?.id ?? null);
    const paidTotal = get('SELECT COALESCE(SUM(amount_cents),0) AS total FROM payments WHERE order_id = ?', id).total;
    const fullyPaid = paidTotal >= order.total_cents ? 1 : 0;
    run('UPDATE orders SET paid = ?, payment_method = COALESCE(payment_method, ?) WHERE id = ?', fullyPaid, method, id);
    logEvent(id, 'pagamento', order.status, order.status, `${method}: ${(amount / 100).toFixed(2)}`, user?.id);
    const updated = getOrder(id);
    publish('order:updated', { order: updated });
    return updated;
  });
}

export function rateOrder(token, rating, comment) {
  const order = get('SELECT * FROM orders WHERE public_token = ?', token);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.status !== 'entregue') throw conflict('A avaliação fica disponível após a entrega');
  const value = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
  run('UPDATE orders SET rating = ?, rating_comment = ? WHERE id = ?', value, comment || null, order.id);
  logEvent(order.id, 'avaliacao', order.status, order.status, `Nota ${value}`, null);
  publish('order:rated', { order_id: order.id, rating: value });
  return { ok: true, rating: value };
}

export function logEvent(orderId, type, from, to, message, userId) {
  run('INSERT INTO order_events(order_id, type, from_status, to_status, message, user_id) VALUES (?,?,?,?,?,?)',
    orderId, type, from, to, message ?? null, userId ?? null);
}

function safeParse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

/** Fila da cozinha: pedidos em produção ordenados pela promessa de entrega. */
export function kitchenQueue() {
  const rows = all(
    `SELECT * FROM orders WHERE status IN ('recebido','em_preparo','pronto') ORDER BY
       CASE status WHEN 'recebido' THEN 0 WHEN 'em_preparo' THEN 1 ELSE 2 END, promised_at, id`
  );
  return rows.map((row) => ({
    ...decorate(row, false),
    items: orderItems(row.id),
    late: row.promised_at ? new Date(row.promised_at) < new Date() && row.status !== 'pronto' : false,
  }));
}

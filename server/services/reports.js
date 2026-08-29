import { all, get, run, getSettings, transaction } from '../db.js';
import { businessDay } from './orders.js';
import { driverSettlement } from './dispatch.js';
import { conflict, notFound } from '../lib/http.js';

/** Painel do dia: números que o gerente olha a cada 5 minutos. */
export function dashboard(day = businessDay()) {
  const totals = get(
    `SELECT
       COUNT(*) AS orders,
       COALESCE(SUM(CASE WHEN status <> 'cancelado' THEN total_cents ELSE 0 END), 0) AS revenue_cents,
       COALESCE(SUM(CASE WHEN status <> 'cancelado' THEN delivery_fee_cents ELSE 0 END), 0) AS fees_cents,
       COALESCE(SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END), 0) AS cancelled,
       COALESCE(SUM(CASE WHEN status = 'entregue' THEN 1 ELSE 0 END), 0) AS delivered,
       COALESCE(SUM(CASE WHEN type = 'entrega' THEN 1 ELSE 0 END), 0) AS deliveries,
       COALESCE(SUM(CASE WHEN type = 'retirada' THEN 1 ELSE 0 END), 0) AS pickups
     FROM orders WHERE business_day = ?`,
    day
  );
  const openOrders = get(
    "SELECT COUNT(*) AS total FROM orders WHERE status IN ('recebido','em_preparo','pronto','em_entrega')"
  );
  const ticket = totals.orders - totals.cancelled > 0
    ? Math.round(totals.revenue_cents / (totals.orders - totals.cancelled))
    : 0;
  const avgDelivery = get(
    `SELECT AVG((julianday(delivered_at) - julianday(created_at)) * 24 * 60) AS minutes
       FROM orders WHERE business_day = ? AND delivered_at IS NOT NULL`,
    day
  );
  const byChannel = all(
    `SELECT channel, COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenue_cents
       FROM orders WHERE business_day = ? AND status <> 'cancelado' GROUP BY channel ORDER BY orders DESC`,
    day
  );
  const byStatus = all(
    'SELECT status, COUNT(*) AS total FROM orders WHERE business_day = ? GROUP BY status', day
  );
  const byHour = all(
    `SELECT strftime('%H', created_at) AS hour, COUNT(*) AS orders,
            COALESCE(SUM(total_cents),0) AS revenue_cents
       FROM orders WHERE business_day = ? AND status <> 'cancelado'
      GROUP BY hour ORDER BY hour`,
    day
  );
  const topProducts = all(
    `SELECT i.name, SUM(i.qty) AS qty, SUM(i.total_cents) AS revenue_cents
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.business_day = ? AND o.status <> 'cancelado'
      GROUP BY i.name ORDER BY qty DESC LIMIT 10`,
    day
  );
  const byDistrict = all(
    `SELECT COALESCE(district, 'Sem bairro') AS district, COUNT(*) AS orders,
            COALESCE(SUM(total_cents),0) AS revenue_cents
       FROM orders WHERE business_day = ? AND type = 'entrega' AND status <> 'cancelado'
      GROUP BY district ORDER BY orders DESC LIMIT 12`,
    day
  );
  const lateOrders = get(
    `SELECT COUNT(*) AS total FROM orders
      WHERE status IN ('recebido','em_preparo') AND promised_at IS NOT NULL
        AND promised_at < datetime('now')`
  );
  return {
    day,
    orders: totals.orders,
    delivered: totals.delivered,
    cancelled: totals.cancelled,
    deliveries: totals.deliveries,
    pickups: totals.pickups,
    revenue_cents: totals.revenue_cents,
    fees_cents: totals.fees_cents,
    ticket_cents: ticket,
    open_orders: openOrders.total,
    late_orders: lateOrders.total,
    avg_delivery_minutes: avgDelivery?.minutes ? Math.round(avgDelivery.minutes) : null,
    by_channel: byChannel,
    by_status: byStatus,
    by_hour: byHour,
    by_district: byDistrict,
    top_products: topProducts,
    drivers: driverSettlement(day),
  };
}

/** Série histórica para gráficos (padrão: últimos 30 dias). */
export function salesSeries({ from, to } = {}) {
  const end = to || businessDay();
  const start = from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  return {
    from: start,
    to: end,
    days: all(
      `SELECT business_day AS day, COUNT(*) AS orders,
              COALESCE(SUM(total_cents),0) AS revenue_cents,
              COALESCE(SUM(delivery_fee_cents),0) AS fees_cents
         FROM orders WHERE business_day BETWEEN ? AND ? AND status <> 'cancelado'
        GROUP BY business_day ORDER BY business_day`,
      start, end
    ),
  };
}

export function customerRanking({ from, to, limit = 20 } = {}) {
  const end = to || businessDay();
  const start = from || '0000-01-01';
  return all(
    `SELECT c.id, c.name, c.phone, COUNT(o.id) AS orders,
            COALESCE(SUM(o.total_cents),0) AS revenue_cents,
            MAX(o.created_at) AS last_order_at
       FROM customers c JOIN orders o ON o.customer_id = c.id
      WHERE o.business_day BETWEEN ? AND ? AND o.status <> 'cancelado'
      GROUP BY c.id ORDER BY revenue_cents DESC LIMIT ?`,
    start, end, Math.min(Number(limit) || 20, 200)
  );
}

export function productRanking({ from, to, limit = 30 } = {}) {
  const end = to || businessDay();
  const start = from || '0000-01-01';
  return all(
    `SELECT i.name, COALESCE(p.id, 0) AS product_id, SUM(i.qty) AS qty,
            SUM(i.total_cents) AS revenue_cents
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
       LEFT JOIN products p ON p.id = i.product_id
      WHERE o.business_day BETWEEN ? AND ? AND o.status <> 'cancelado'
      GROUP BY i.name ORDER BY revenue_cents DESC LIMIT ?`,
    start, end, Math.min(Number(limit) || 30, 200)
  );
}

/* ------------------------------------------------------------------ *
 * Caixa                                                               *
 * ------------------------------------------------------------------ */

export function currentCashSession() {
  return get("SELECT * FROM cash_sessions WHERE status = 'aberto' ORDER BY id DESC LIMIT 1");
}

export function openCash({ opening_float_cents = 0, notes = null }, user) {
  if (currentCashSession()) throw conflict('Já existe um caixa aberto. Feche-o antes de abrir outro.');
  const result = run(
    'INSERT INTO cash_sessions(business_day, opening_float_cents, notes, opened_by) VALUES (?,?,?,?)',
    businessDay(), Math.round(Number(opening_float_cents) || 0), notes, user?.id ?? null
  );
  return get('SELECT * FROM cash_sessions WHERE id = ?', Number(result.lastInsertRowid));
}

/** Resumo financeiro de um caixa aberto (ou do dia corrente). */
export function cashSummary(day = businessDay()) {
  const session = currentCashSession();
  const byMethod = all(
    `SELECT COALESCE(p.method, o.payment_method, 'nao_informado') AS method,
            COUNT(DISTINCT o.id) AS orders,
            COALESCE(SUM(COALESCE(p.amount_cents, o.total_cents)), 0) AS amount_cents
       FROM orders o LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.business_day = ? AND o.status <> 'cancelado'
      GROUP BY method ORDER BY amount_cents DESC`,
    day
  );
  const totals = get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(total_cents),0) AS total_cents,
            COALESCE(SUM(subtotal_cents),0) AS subtotal_cents,
            COALESCE(SUM(delivery_fee_cents),0) AS fees_cents,
            COALESCE(SUM(discount_cents),0) AS discounts_cents,
            COALESCE(SUM(CASE WHEN paid = 0 THEN total_cents ELSE 0 END),0) AS open_cents
       FROM orders WHERE business_day = ? AND status <> 'cancelado'`,
    day
  );
  const cashOnly = byMethod.find((m) => m.method === 'dinheiro')?.amount_cents || 0;
  const drivers = driverSettlement(day);
  const commissions = drivers.reduce((acc, d) => acc + d.commission_cents, 0);
  const expected = (session?.opening_float_cents || 0) + cashOnly;
  return {
    day,
    session,
    by_method: byMethod,
    totals,
    cash_expected_cents: expected,
    driver_commissions_cents: commissions,
    drivers,
  };
}

export function closeCash({ counted_cents = 0, notes = null }, user) {
  const session = currentCashSession();
  if (!session) throw notFound('Nenhum caixa aberto');
  const summary = cashSummary(session.business_day);
  const counted = Math.round(Number(counted_cents) || 0);
  const expected = summary.cash_expected_cents;
  return transaction(() => {
    run(
      `UPDATE cash_sessions SET status = 'fechado', counted_cents = ?, expected_cents = ?,
              difference_cents = ?, notes = COALESCE(?, notes), closed_by = ?, closed_at = datetime('now')
        WHERE id = ?`,
      counted, expected, counted - expected, notes, user?.id ?? null, session.id
    );
    return { ...get('SELECT * FROM cash_sessions WHERE id = ?', session.id), summary };
  });
}

export function listCashSessions(limit = 60) {
  return all(
    `SELECT s.*, uo.name AS opened_by_name, uc.name AS closed_by_name
       FROM cash_sessions s
       LEFT JOIN users uo ON uo.id = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
      ORDER BY s.id DESC LIMIT ?`,
    Math.min(Number(limit) || 60, 200)
  );
}

/** Exportação CSV dos pedidos de um período. */
export function ordersCsv({ from, to } = {}) {
  const end = to || businessDay();
  const start = from || end;
  const rows = all(
    `SELECT o.code, o.business_day, o.created_at, o.status, o.channel, o.type,
            o.customer_name, o.customer_phone, o.district, o.street, o.number,
            o.subtotal_cents, o.delivery_fee_cents, o.discount_cents, o.total_cents,
            o.payment_method, o.paid, d.name AS driver, o.rating
       FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.business_day BETWEEN ? AND ? ORDER BY o.id`,
    start, end
  );
  const header = [
    'codigo', 'dia', 'criado_em', 'status', 'canal', 'tipo', 'cliente', 'telefone',
    'bairro', 'rua', 'numero', 'subtotal', 'taxa_entrega', 'desconto', 'total',
    'pagamento', 'pago', 'entregador', 'avaliacao',
  ];
  const money = (cents) => ((Number(cents) || 0) / 100).toFixed(2).replace('.', ',');
  const lines = rows.map((r) => [
    r.code, r.business_day, r.created_at, r.status, r.channel, r.type, r.customer_name,
    r.customer_phone || '', r.district || '', r.street || '', r.number || '',
    money(r.subtotal_cents), money(r.delivery_fee_cents), money(r.discount_cents), money(r.total_cents),
    r.payment_method || '', r.paid ? 'sim' : 'nao', r.driver || '', r.rating || '',
  ]);
  return [header, ...lines]
    .map((cols) => cols.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';'))
    .join('\n');
}

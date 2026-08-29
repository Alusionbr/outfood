import { Router, badRequest, notFound } from '../lib/http.js';
import { get, getSettings } from '../db.js';
import { buildMenu } from './catalog.js';
import { createOrder, getOrderByToken, rateOrder, STATUS_LABELS } from '../services/orders.js';
import { normalizeOrderInput } from './orders.js';
import { int, str } from '../lib/validate.js';

export const publicRouter = new Router();
const isPublic = { public: true };

/** Dados da loja para a vitrine e a página de acompanhamento. */
publicRouter.get('/api/public/store', async () => {
  const s = getSettings();
  return {
    name: s.store_name,
    phone: s.store_phone,
    address: s.store_address,
    city: s.city,
    service_hours: s.service_hours,
    min_order_cents: s.min_order_cents,
    default_fee_cents: s.default_fee_cents,
    free_delivery_above_cents: s.free_delivery_above_cents,
    online_orders: !!s.online_orders,
    lat: s.store_lat,
    lon: s.store_lon,
  };
}, isPublic);

publicRouter.get('/api/public/menu', async () => {
  const s = getSettings();
  return buildMenu({ onlyActive: true }).map((category) => ({
    id: category.id,
    name: category.name,
    products: category.products
      .filter((p) => p.available)
      .map((p) => ({
        id: p.id, name: p.name, description: p.description,
        price_cents: p.price_cents, prep_minutes: p.prep_minutes,
        options: p.options.map((o) => ({ id: o.id, group_name: o.group_name, name: o.name, price_cents: o.price_cents })),
      })),
  })).filter((c) => c.products.length && (s.online_orders ? true : true));
}, isPublic);

/** Pedido feito pelo cliente na vitrine online. */
publicRouter.post('/api/public/orders', async (ctx) => {
  const settings = getSettings();
  if (!settings.online_orders) throw badRequest('Os pedidos online estão desativados no momento');

  // O cliente nunca define preços, taxas nem estado do pedido: qualquer valor
  // que venha do navegador é descartado antes da validação e recalculado aqui.
  const {
    delivery_fee_cents, discount_cents, surcharge_cents, paid, status, courier,
    channel, platform_name, platform_code, customer_id, address_id, prep_minutes,
    ...safe
  } = ctx.body || {};

  const input = await normalizeOrderInput(
    { ...safe, channel: 'site', courier: 'loja', paid: false, status: 'recebido' },
    { requireItems: true }
  );
  input.items = input.items.map((item) => ({
    product_id: item.product_id,
    qty: item.qty,
    notes: item.notes,
    options: (item.options || []).map((o) => ({ id: o.id })),
  })).map(resolvePublicItem);
  const order = createOrder(input, null);
  return {
    code: order.code,
    token: order.public_token,
    total_cents: order.total_cents,
    delivery_fee_cents: order.delivery_fee_cents,
    promised_at: order.promised_at,
    track_url: `/r/${order.public_token}`,
  };
}, isPublic);

/** Resolve preço e adicionais direto do cardápio, ignorando o que veio do cliente. */
function resolvePublicItem(item) {
  if (!item.product_id) throw badRequest('Item inválido no pedido');
  const product = get('SELECT * FROM products WHERE id = ? AND active = 1', Number(item.product_id));
  if (!product) throw badRequest('Um dos produtos não está mais disponível');
  const options = (item.options || [])
    .map((o) => get('SELECT * FROM product_options WHERE id = ? AND product_id = ? AND active = 1', Number(o.id), product.id))
    .filter(Boolean)
    .map((o) => ({ id: o.id, name: o.name, price_cents: o.price_cents }));
  return {
    product_id: product.id,
    name: product.name,
    qty: Math.max(1, Math.min(50, Number(item.qty) || 1)),
    unit_price_cents: product.price_cents,
    notes: item.notes ? String(item.notes).slice(0, 200) : null,
    options,
  };
}

/** Acompanhamento público do pedido (link enviado ao cliente). */
publicRouter.get('/api/public/track/:token', async (ctx) => {
  const order = getOrderByToken(ctx.params.token);
  if (!order) throw notFound('Pedido não encontrado');
  const s = getSettings();
  return {
    code: order.code,
    status: order.status,
    status_label: STATUS_LABELS[order.status],
    type: order.type,
    created_at: order.created_at,
    promised_at: order.promised_at,
    delivered_at: order.delivered_at,
    customer_name: order.customer_name,
    address: order.address,
    driver_name: order.driver_name,
    total_cents: order.total_cents,
    delivery_fee_cents: order.delivery_fee_cents,
    subtotal_cents: order.subtotal_cents,
    payment_method: order.payment_method,
    paid: order.paid,
    rating: order.rating,
    items: order.items.map((i) => ({ name: i.name, qty: i.qty, total_cents: i.total_cents, options: i.options })),
    timeline: order.timeline
      .filter((e) => e.type === 'status' || e.type === 'criado')
      .map((e) => ({ to: e.to_status, label: STATUS_LABELS[e.to_status] || e.to_status, at: e.created_at })),
    store: { name: s.store_name, phone: s.store_phone },
  };
}, isPublic);

publicRouter.post('/api/public/track/:token/rating', async (ctx) => {
  return rateOrder(
    ctx.params.token,
    int(ctx.body.rating, 'nota', { required: true, min: 1, max: 5 }),
    str(ctx.body.comment, 'comentário', { max: 500 })
  );
}, isPublic);

publicRouter.get('/api/health', async () => ({ ok: true, at: new Date().toISOString() }), isPublic);

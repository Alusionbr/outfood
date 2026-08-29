import { Router, badRequest, notFound } from '../lib/http.js';
import { get, run, getSettings, audit } from '../db.js';
import { requirePermission } from '../lib/auth.js';
import {
  CHANNELS, COURIERS, ORDER_STATUS, ORDER_TYPES, PAYMENT_METHODS,
  addPayment, businessDay, changeStatus, createOrder, getOrder, kitchenQueue,
  listOrders, updateOrder,
} from '../services/orders.js';
import { addressQuery, geocode } from '../services/geocode.js';
import { bool, int, num, oneOf, phone as vPhone, str } from '../lib/validate.js';
import { saveAddress } from './customers.js';

export const ordersRouter = new Router();

ordersRouter.get('/api/orders', async (ctx) => {
  requirePermission(ctx, 'orders:read');
  const p = ctx.url.searchParams;
  return listOrders({
    status: p.get('status'),
    open: p.get('open') === '1',
    day: p.get('day'),
    from: p.get('from'),
    to: p.get('to'),
    driver_id: p.get('driver_id'),
    customer_id: p.get('customer_id'),
    route_id: p.get('route_id'),
    type: p.get('type'),
    channel: p.get('channel'),
    unassigned: p.get('unassigned') === '1',
    q: p.get('q'),
    limit: p.get('limit'),
    with_items: p.get('with_items') !== '0',
  });
});

ordersRouter.get('/api/orders/:id', async (ctx) => {
  requirePermission(ctx, 'orders:read');
  const order = getOrder(Number(ctx.params.id));
  if (!order) throw notFound('Pedido não encontrado');
  return order;
});

ordersRouter.post('/api/orders', async (ctx) => {
  requirePermission(ctx, 'orders:create');
  const input = await normalizeOrderInput(ctx.body, { requireItems: true });
  const order = createOrder(input, ctx.user);
  audit(ctx.user.id, 'pedido_criado', 'order', order.id, { code: order.code, total: order.total_cents });
  return order;
});

ordersRouter.patch('/api/orders/:id', async (ctx) => {
  requirePermission(ctx, 'orders:update');
  const input = await normalizeOrderInput(ctx.body, { requireItems: false, partial: true });
  const order = updateOrder(Number(ctx.params.id), input, ctx.user);
  audit(ctx.user.id, 'pedido_editado', 'order', order.id, null);
  return order;
});

ordersRouter.post('/api/orders/:id/status', async (ctx) => {
  const to = oneOf(ctx.body.status, 'status', ORDER_STATUS, { required: true });
  requirePermission(ctx, to === 'cancelado' ? 'orders:cancel' : (['em_preparo', 'pronto'].includes(to) ? 'orders:kitchen' : 'orders:update'));
  const order = changeStatus(Number(ctx.params.id), to, ctx.user, {
    reason: str(ctx.body.reason, 'motivo', { max: 300 }),
  });
  audit(ctx.user.id, `pedido_${to}`, 'order', order.id, { reason: ctx.body.reason || null });
  return order;
});

ordersRouter.post('/api/orders/:id/payments', async (ctx) => {
  requirePermission(ctx, 'orders:pay');
  const method = oneOf(ctx.body.method, 'forma de pagamento', PAYMENT_METHODS, { required: true });
  return addPayment(Number(ctx.params.id), {
    method,
    amount_cents: int(ctx.body.amount_cents, 'valor', { required: true, min: 1 }),
    received_cents: int(ctx.body.received_cents, 'valor recebido', { min: 0 }),
  }, ctx.user);
});

ordersRouter.post('/api/orders/:id/geocode', async (ctx) => {
  requirePermission(ctx, 'orders:update');
  const id = Number(ctx.params.id);
  const order = get('SELECT * FROM orders WHERE id = ?', id);
  if (!order) throw notFound('Pedido não encontrado');
  const settings = getSettings();
  const point = await geocode(addressQuery(order, settings.city));
  if (!point) return { found: false, order: getOrder(id) };
  run('UPDATE orders SET lat = ?, lon = ? WHERE id = ?', point.lat, point.lon, id);
  return { found: true, ...point, order: updateOrder(id, { lat: point.lat, lon: point.lon }, ctx.user) };
});

ordersRouter.get('/api/kitchen', async (ctx) => {
  requirePermission(ctx, 'kitchen:read');
  return kitchenQueue();
});

ordersRouter.get('/api/today', async (ctx) => {
  requirePermission(ctx, 'orders:read');
  return { day: businessDay(), orders: listOrders({ day: businessDay() }) };
});

/**
 * Normaliza e valida o corpo de um pedido, resolvendo cliente, endereço e
 * coordenadas antes de chegar ao serviço de domínio.
 */
export async function normalizeOrderInput(body, { requireItems = true, partial = false } = {}) {
  const settings = getSettings();
  const input = {};

  if (!partial || body.type !== undefined) input.type = oneOf(body.type, 'tipo', ORDER_TYPES, { def: 'entrega' });
  if (!partial || body.channel !== undefined) input.channel = oneOf(body.channel, 'canal', CHANNELS, { def: 'balcao' });
  if (!partial || body.courier !== undefined) input.courier = oneOf(body.courier, 'responsável pela entrega', COURIERS, { def: 'loja' });
  if (body.status !== undefined) input.status = oneOf(body.status, 'status', ['rascunho', 'recebido']);
  if (body.platform_name !== undefined) input.platform_name = str(body.platform_name, 'plataforma', { max: 60 });
  if (body.platform_code !== undefined) input.platform_code = str(body.platform_code, 'código da plataforma', { max: 60 });
  if (body.notes !== undefined) input.notes = str(body.notes, 'observações', { max: 1000 });
  if (body.scheduled_for !== undefined) input.scheduled_for = str(body.scheduled_for, 'agendamento', { max: 40 });
  if (body.discount_cents !== undefined) input.discount_cents = int(body.discount_cents, 'desconto', { min: 0 });
  if (body.surcharge_cents !== undefined) input.surcharge_cents = int(body.surcharge_cents, 'acréscimo', { min: 0 });
  if (body.delivery_fee_cents !== undefined && body.delivery_fee_cents !== null && body.delivery_fee_cents !== '') {
    input.delivery_fee_cents = int(body.delivery_fee_cents, 'taxa de entrega', { min: 0 });
  }
  if (body.payment_method !== undefined) input.payment_method = oneOf(body.payment_method, 'forma de pagamento', PAYMENT_METHODS);
  if (body.change_for_cents !== undefined) input.change_for_cents = int(body.change_for_cents, 'troco para', { min: 0 });
  if (body.paid !== undefined) input.paid = bool(body.paid);
  if (body.prep_minutes !== undefined) input.prep_minutes = int(body.prep_minutes, 'tempo de preparo', { min: 0, max: 300 });

  if (requireItems || body.items !== undefined) {
    if (!Array.isArray(body.items) || (requireItems && !body.items.length)) {
      throw badRequest('Inclua ao menos um item no pedido');
    }
    input.items = body.items;
  }

  // Cliente: por id, por telefone (cria/atualiza) ou avulso.
  let customer = null;
  if (body.customer_id) {
    customer = get('SELECT * FROM customers WHERE id = ?', Number(body.customer_id));
    if (!customer) throw badRequest('Cliente informado não existe');
  } else if (body.customer_phone) {
    const digits = vPhone(body.customer_phone, 'telefone do cliente');
    customer = get('SELECT * FROM customers WHERE phone = ?', digits);
    if (!customer && body.save_customer !== false && body.customer_name) {
      const result = run('INSERT INTO customers(name, phone) VALUES (?,?)',
        str(body.customer_name, 'nome do cliente', { required: true, max: 120 }), digits);
      customer = get('SELECT * FROM customers WHERE id = ?', Number(result.lastInsertRowid));
    }
  }
  if (customer) {
    if (customer.blocked) throw badRequest(`Cliente ${customer.name} está bloqueado`);
    input.customer_id = customer.id;
    input.customer_name = str(body.customer_name, 'nome do cliente', { max: 120 }) || customer.name;
    input.customer_phone = customer.phone;
  } else {
    if (!partial || body.customer_name !== undefined) {
      input.customer_name = str(body.customer_name, 'nome do cliente', { required: !partial, max: 120 }) || 'Consumidor';
    }
    if (body.customer_phone !== undefined) input.customer_phone = vPhone(body.customer_phone, 'telefone do cliente');
  }

  // Endereço: por id salvo, ou pelos campos soltos.
  const type = input.type ?? 'entrega';
  let address = null;
  if (body.address_id) {
    address = get('SELECT * FROM addresses WHERE id = ?', Number(body.address_id));
    if (!address) throw badRequest('Endereço informado não existe');
  } else if (body.street || body.district) {
    address = {
      street: str(body.street, 'rua', { required: type === 'entrega' && !partial, max: 160 }),
      number: str(body.number, 'número', { max: 20 }),
      complement: str(body.complement, 'complemento', { max: 80 }),
      district: str(body.district, 'bairro', { max: 80 }),
      city: str(body.city, 'cidade', { max: 80 }) || settings.city,
      reference: str(body.reference, 'referência', { max: 160 }),
      lat: body.lat != null && body.lat !== '' ? num(body.lat, 'latitude', { min: -90, max: 90 }) : null,
      lon: body.lon != null && body.lon !== '' ? num(body.lon, 'longitude', { min: -180, max: 180 }) : null,
    };
    if (customer && body.save_address) await saveAddress(customer.id, address, bool(body.default_address, false));
  }

  if (address) {
    Object.assign(input, {
      street: address.street, number: address.number, complement: address.complement,
      district: address.district, city: address.city, reference: address.reference,
      lat: address.lat, lon: address.lon,
    });
    if (input.lat == null && type === 'entrega') {
      const point = await geocode(addressQuery(address, settings.city));
      if (point) { input.lat = point.lat; input.lon = point.lon; }
    }
  } else if (type === 'entrega' && !partial) {
    throw badRequest('Informe o endereço de entrega');
  }

  return input;
}

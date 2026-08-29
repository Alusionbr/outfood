import { Router, badRequest, notFound } from '../lib/http.js';
import { all, get, run, audit } from '../db.js';
import { requirePermission } from '../lib/auth.js';
import { applyUpdate } from './catalog.js';
import { bool, int, num, oneOf, phone as vPhone, str } from '../lib/validate.js';
import {
  COMMISSION_TYPES, DRIVER_STATUS, addOrderToRoute, autoDispatch, cancelRoute,
  completeStop, createRoute, dispatchQueue, driverSettlement, getDriver, getRoute,
  listDrivers, listRoutes, mergeRoutes, optimizeRoute, pingDriver, reorderStops,
  scanOrderIntoRoute, setDriverStatus, startRoute,
} from '../services/dispatch.js';
import { businessDay } from '../services/orders.js';
import { publish } from '../lib/events.js';

export const dispatchRouter = new Router();

/* --------------------------- entregadores --------------------------- */

dispatchRouter.get('/api/drivers', async (ctx) => {
  requirePermission(ctx, 'drivers:read');
  return listDrivers({ activeOnly: ctx.url.searchParams.get('active') === '1' });
});

dispatchRouter.get('/api/drivers/me', async (ctx) => {
  requirePermission(ctx, 'drivers:self');
  if (!ctx.user.driver_id) throw notFound('Seu usuário não está vinculado a um entregador');
  const driver = getDriver(ctx.user.driver_id);
  const routes = listRoutes({ driver_id: driver.id, day: businessDay() });
  return { driver, routes, active_route: routes.find((r) => r.status === 'em_rota') || null };
});

dispatchRouter.post('/api/drivers', async (ctx) => {
  requirePermission(ctx, 'drivers:create');
  const data = {
    name: str(ctx.body.name, 'nome', { required: true, max: 120 }),
    phone: vPhone(ctx.body.phone, 'telefone'),
    vehicle: oneOf(ctx.body.vehicle, 'veículo', ['moto', 'bike', 'carro', 'a_pe'], { def: 'moto' }),
    plate: str(ctx.body.plate, 'placa', { max: 12 }),
    commission_type: oneOf(ctx.body.commission_type, 'tipo de comissão', COMMISSION_TYPES, { def: 'por_entrega' }),
    commission_value: int(ctx.body.commission_value, 'valor da comissão', { def: 0, min: 0 }),
    user_id: ctx.body.user_id ? Number(ctx.body.user_id) : null,
  };
  const keys = Object.keys(data);
  const result = run(`INSERT INTO drivers(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ...keys.map((k) => data[k]));
  const id = Number(result.lastInsertRowid);
  audit(ctx.user.id, 'entregador_criado', 'driver', id, { name: data.name });
  publish('driver:updated', { driver_id: id });
  return getDriver(id);
});

dispatchRouter.patch('/api/drivers/:id', async (ctx) => {
  requirePermission(ctx, 'drivers:update');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM drivers WHERE id = ?', id)) throw notFound('Entregador não encontrado');
  const fields = {};
  if (ctx.body.name !== undefined) fields.name = str(ctx.body.name, 'nome', { required: true, max: 120 });
  if (ctx.body.phone !== undefined) fields.phone = vPhone(ctx.body.phone, 'telefone');
  if (ctx.body.vehicle !== undefined) fields.vehicle = oneOf(ctx.body.vehicle, 'veículo', ['moto', 'bike', 'carro', 'a_pe']);
  if (ctx.body.plate !== undefined) fields.plate = str(ctx.body.plate, 'placa', { max: 12 });
  if (ctx.body.commission_type !== undefined) fields.commission_type = oneOf(ctx.body.commission_type, 'tipo de comissão', COMMISSION_TYPES);
  if (ctx.body.commission_value !== undefined) fields.commission_value = int(ctx.body.commission_value, 'valor da comissão', { min: 0 });
  if (ctx.body.active !== undefined) fields.active = bool(ctx.body.active) ? 1 : 0;
  if (ctx.body.user_id !== undefined) fields.user_id = ctx.body.user_id ? Number(ctx.body.user_id) : null;
  applyUpdate('drivers', id, fields);
  publish('driver:updated', { driver_id: id });
  return getDriver(id);
});

dispatchRouter.post('/api/drivers/:id/status', async (ctx) => {
  const id = Number(ctx.params.id);
  const isSelf = ctx.user?.driver_id === id;
  requirePermission(ctx, isSelf ? 'drivers:self' : 'drivers:update');
  const status = oneOf(ctx.body.status, 'status', DRIVER_STATUS, { required: true });
  return setDriverStatus(id, status, ctx.user);
});

dispatchRouter.post('/api/drivers/:id/ping', async (ctx) => {
  const id = Number(ctx.params.id);
  const isSelf = ctx.user?.driver_id === id;
  requirePermission(ctx, isSelf ? 'drivers:self' : 'drivers:update');
  return pingDriver(id,
    num(ctx.body.lat, 'latitude', { required: true, min: -90, max: 90 }),
    num(ctx.body.lon, 'longitude', { required: true, min: -180, max: 180 }));
});

dispatchRouter.delete('/api/drivers/:id', async (ctx) => {
  requirePermission(ctx, 'drivers:delete');
  const id = Number(ctx.params.id);
  run('UPDATE drivers SET active = 0, status = \'offline\' WHERE id = ?', id);
  publish('driver:updated', { driver_id: id });
  return { ok: true };
});

dispatchRouter.get('/api/drivers/settlement', async (ctx) => {
  requirePermission(ctx, 'reports:read');
  return driverSettlement(ctx.url.searchParams.get('day') || businessDay());
});

/* --------------------------- despacho e rotas --------------------------- */

dispatchRouter.get('/api/dispatch/queue', async (ctx) => {
  requirePermission(ctx, 'routes:read');
  return {
    queue: dispatchQueue(),
    drivers: listDrivers({ activeOnly: true }),
    routes: listRoutes({ day: businessDay() }).filter((r) => ['planejada', 'em_rota'].includes(r.status)),
  };
});

dispatchRouter.post('/api/dispatch/auto', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  const routes = autoDispatch(ctx.user, {
    driver_ids: Array.isArray(ctx.body.driver_ids) ? ctx.body.driver_ids.map(Number) : [],
    order_ids: Array.isArray(ctx.body.order_ids) ? ctx.body.order_ids.map(Number) : [],
    max_per_driver: int(ctx.body.max_per_driver, 'máximo por entregador', { def: 0, min: 0, max: 50 }),
  });
  audit(ctx.user.id, 'despacho_automatico', 'route', null, { routes: routes.map((r) => r.id) });
  return routes;
});

dispatchRouter.get('/api/routes', async (ctx) => {
  requirePermission(ctx, 'routes:read');
  const p = ctx.url.searchParams;
  return listRoutes({
    day: p.get('day') || (p.get('all') === '1' ? null : businessDay()),
    driver_id: p.get('driver_id'),
    status: p.get('status'),
  });
});

dispatchRouter.get('/api/routes/:id', async (ctx) => {
  requirePermission(ctx, 'routes:read');
  const route = getRoute(Number(ctx.params.id));
  if (!route) throw notFound('Rota não encontrada');
  return route;
});

dispatchRouter.post('/api/routes', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  const driverId = int(ctx.body.driver_id, 'entregador', { required: true });
  const orderIds = Array.isArray(ctx.body.order_ids) ? ctx.body.order_ids.map(Number) : [];
  if (!orderIds.length) throw badRequest('Selecione os pedidos da rota');
  const route = createRoute(driverId, orderIds, ctx.user);
  audit(ctx.user.id, 'rota_criada', 'route', route.id, { orders: orderIds });
  return route;
});

dispatchRouter.post('/api/routes/:id/start', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  return startRoute(Number(ctx.params.id), ctx.user);
});

dispatchRouter.post('/api/routes/:id/optimize', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  return optimizeRoute(Number(ctx.params.id), ctx.user);
});

dispatchRouter.post('/api/routes/:id/reorder', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  const orderIds = Array.isArray(ctx.body.order_ids) ? ctx.body.order_ids.map(Number) : [];
  return reorderStops(Number(ctx.params.id), orderIds, ctx.user);
});

dispatchRouter.post('/api/routes/:id/orders', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  return addOrderToRoute(Number(ctx.params.id), int(ctx.body.order_id, 'pedido', { required: true }), ctx.user);
});

dispatchRouter.post('/api/routes/:id/merge', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  return mergeRoutes(Number(ctx.params.id), int(ctx.body.source_route_id, 'rota de origem', { required: true }), ctx.user);
});

/**
 * Despacho por leitura de QR: o entregador escaneia a comanda impressa e o
 * pedido entra na rota dele. O painel também pode escanear por um entregador.
 */
dispatchRouter.post('/api/dispatch/scan', async (ctx) => {
  const driverId = ctx.body.driver_id ? Number(ctx.body.driver_id) : ctx.user?.driver_id;
  if (!driverId) throw badRequest('Informe o entregador que vai levar o pedido');
  requirePermission(ctx, ctx.user?.driver_id === driverId ? 'routes:deliver' : 'routes:dispatch');
  return scanOrderIntoRoute(str(ctx.body.code, 'código do pedido', { required: true, max: 120 }), driverId, ctx.user);
});

dispatchRouter.post('/api/routes/:id/cancel', async (ctx) => {
  requirePermission(ctx, 'routes:dispatch');
  return cancelRoute(Number(ctx.params.id), ctx.user, str(ctx.body.reason, 'motivo', { max: 300 }));
});

dispatchRouter.post('/api/routes/:id/stops/:orderId', async (ctx) => {
  const routeId = Number(ctx.params.id);
  const route = get('SELECT * FROM routes WHERE id = ?', routeId);
  if (!route) throw notFound('Rota não encontrada');
  const isOwner = ctx.user?.driver_id === route.driver_id;
  requirePermission(ctx, isOwner ? 'routes:deliver' : 'routes:dispatch');
  return completeStop(routeId, Number(ctx.params.orderId), ctx.user, {
    failed: bool(ctx.body.failed, false),
    reason: str(ctx.body.reason, 'motivo', { max: 300 }),
  });
});

/* --------------------------- zonas de entrega --------------------------- */

dispatchRouter.get('/api/zones', async (ctx) => {
  requirePermission(ctx, 'zones:read');
  return all('SELECT * FROM zones ORDER BY name').map((z) => ({ ...z, active: !!z.active }));
});

dispatchRouter.post('/api/zones', async (ctx) => {
  requirePermission(ctx, 'zones:create');
  const data = zoneFields(ctx.body, true);
  const keys = Object.keys(data);
  const result = run(`INSERT INTO zones(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    ...keys.map((k) => data[k]));
  publish('zones:updated', {});
  return get('SELECT * FROM zones WHERE id = ?', Number(result.lastInsertRowid));
});

dispatchRouter.patch('/api/zones/:id', async (ctx) => {
  requirePermission(ctx, 'zones:update');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM zones WHERE id = ?', id)) throw notFound('Zona não encontrada');
  applyUpdate('zones', id, zoneFields(ctx.body, false));
  publish('zones:updated', {});
  return get('SELECT * FROM zones WHERE id = ?', id);
});

dispatchRouter.delete('/api/zones/:id', async (ctx) => {
  requirePermission(ctx, 'zones:delete');
  run('DELETE FROM zones WHERE id = ?', Number(ctx.params.id));
  publish('zones:updated', {});
  return { ok: true };
});

function zoneFields(body, isNew) {
  const fields = {};
  if (isNew || body.name !== undefined) fields.name = str(body.name, 'nome', { required: isNew, max: 80 });
  if (isNew || body.color !== undefined) fields.color = str(body.color, 'cor', { max: 12 }) || '#2E7D32';
  if (body.lat !== undefined) fields.lat = body.lat === null ? null : num(body.lat, 'latitude', { min: -90, max: 90 });
  if (body.lon !== undefined) fields.lon = body.lon === null ? null : num(body.lon, 'longitude', { min: -180, max: 180 });
  if (isNew || body.radius_km !== undefined) fields.radius_km = num(body.radius_km, 'raio', { min: 0.2, max: 60, def: 3 });
  if (isNew || body.fee_cents !== undefined) fields.fee_cents = int(body.fee_cents, 'taxa', { min: 0, def: 0 });
  if (body.min_order_cents !== undefined) fields.min_order_cents = int(body.min_order_cents, 'pedido mínimo', { min: 0, def: 0 });
  if (body.driver_id !== undefined) fields.driver_id = body.driver_id ? Number(body.driver_id) : null;
  if (body.active !== undefined) fields.active = bool(body.active) ? 1 : 0;
  return fields;
}

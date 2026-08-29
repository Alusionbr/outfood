import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, orderInput, seedBasics } from './helpers.js';
import { all, get, run } from '../server/db.js';
import { changeStatus, createOrder, getOrder } from '../server/services/orders.js';
import {
  addOrderToRoute, autoDispatch, cancelRoute, completeStop, createRoute,
  dispatchQueue, driverSettlement, getRoute, listRoutes, mergeRoutes, optimizeRoute,
  reorderStops, scanOrderIntoRoute, setDriverStatus, startRoute, wazeUrl,
} from '../server/services/dispatch.js';

function setup(orderCount = 3) {
  freshDb();
  const base = seedBasics();
  const orders = Array.from({ length: orderCount }, (_, i) =>
    createOrder(orderInput(i, { productId: base.pizzaId }), base.user));
  return { ...base, orders };
}

test('a fila de despacho traz só entregas próprias sem entregador', () => {
  const { user, pizzaId, driverId, orders } = setup(2);
  createOrder({ ...orderInput(2, { productId: pizzaId }), type: 'retirada' }, user);
  createOrder({ ...orderInput(3, { productId: pizzaId }), courier: 'plataforma', channel: 'ifood' }, user);

  const queue = dispatchQueue();
  assert.equal(queue.length, 2, 'retirada e pedido de plataforma ficam fora da fila');

  createRoute(driverId, [orders[0].id], user);
  assert.equal(dispatchQueue().length, 1, 'pedido já roteirizado sai da fila');
});

test('createRoute otimiza a ordem, calcula km/tempo e prende os pedidos ao entregador', () => {
  const { user, driverId, orders } = setup(3);
  const route = createRoute(driverId, orders.map((o) => o.id), user);

  assert.equal(route.stops.length, 3);
  assert.deepEqual(route.stops.map((s) => s.seq), [1, 2, 3]);
  assert.ok(route.planned_km > 0);
  assert.ok(route.planned_minutes > 0);
  assert.ok(route.maps_url.includes('google.com/maps'));
  for (const order of orders) {
    assert.equal(getOrder(order.id).driver_id, driverId);
    assert.equal(getOrder(order.id).route_id, route.id);
  }
});

test('o mesmo pedido não entra em duas rotas', () => {
  const { user, driverId, driver2Id, orders } = setup(2);
  createRoute(driverId, [orders[0].id], user);
  assert.throws(() => createRoute(driver2Id, [orders[0].id], user), /já está na rota/i);
});

test('rota rejeita retirada, pedido de plataforma e pedido finalizado', () => {
  const { user, pizzaId, driverId } = setup(0);
  const pickup = createOrder({ ...orderInput(0, { productId: pizzaId }), type: 'retirada' }, user);
  const platform = createOrder({ ...orderInput(1, { productId: pizzaId }), courier: 'plataforma' }, user);
  const cancelled = createOrder(orderInput(2, { productId: pizzaId }), user);
  changeStatus(cancelled.id, 'cancelado', user, { reason: 'teste' });

  assert.throws(() => createRoute(driverId, [pickup.id], user), /não é uma entrega/i);
  assert.throws(() => createRoute(driverId, [platform.id], user), /plataforma/i);
  assert.throws(() => createRoute(driverId, [cancelled.id], user), /finalizado/i);
  assert.throws(() => createRoute(driverId, [], user), /ao menos um pedido/i);
});

test('iniciar a rota coloca o entregador em rota e os pedidos em entrega', () => {
  const { user, driverId, orders } = setup(2);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  const started = startRoute(route.id, user);

  assert.equal(started.status, 'em_rota');
  assert.ok(started.started_at);
  assert.equal(get('SELECT status FROM drivers WHERE id = ?', driverId).status, 'em_rota');
  for (const order of orders) assert.equal(getOrder(order.id).status, 'em_entrega');
  // Iniciar de novo é inofensivo: o entregador pode tocar duas vezes no botão.
  assert.equal(startRoute(route.id, user).status, 'em_rota');
});

test('concluir todas as paradas fecha a rota e devolve o entregador à loja', () => {
  const { user, driverId, orders } = setup(2);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  startRoute(route.id, user);

  completeStop(route.id, orders[0].id, user);
  assert.equal(getOrder(orders[0].id).status, 'entregue');
  assert.equal(getRoute(route.id).status, 'em_rota', 'ainda falta uma parada');

  const finished = completeStop(route.id, orders[1].id, user);
  assert.equal(finished.status, 'concluida');
  assert.ok(finished.finished_at);
  assert.equal(get('SELECT status FROM drivers WHERE id = ?', driverId).status, 'na_loja');
  assert.throws(() => completeStop(route.id, orders[0].id, user), /já foi finalizada/i);
});

test('entrega frustrada devolve o pedido para a fila da loja', () => {
  const { user, driverId, orders } = setup(2);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  startRoute(route.id, user);

  completeStop(route.id, orders[0].id, user, { failed: true, reason: 'Cliente ausente' });
  const order = getOrder(orders[0].id);
  assert.equal(order.status, 'pronto');
  assert.equal(order.driver_id, null);
  assert.equal(order.route_id, null);
  assert.equal(get("SELECT status, failure_reason FROM route_stops WHERE order_id = ?", orders[0].id).status, 'falhou');
  assert.equal(dispatchQueue().length, 1, 'volta a aparecer para o despacho');
});

test('cancelar a rota devolve os pedidos pendentes e libera o entregador', () => {
  const { user, driverId, orders } = setup(3);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  startRoute(route.id, user);
  completeStop(route.id, route.stops[0].order_id, user);

  const cancelled = cancelRoute(route.id, user, 'Moto quebrou');
  assert.equal(cancelled.status, 'cancelada');
  assert.equal(get('SELECT status FROM drivers WHERE id = ?', driverId).status, 'na_loja');
  assert.equal(getOrder(route.stops[0].order_id).status, 'entregue', 'o que já foi entregue continua entregue');
  assert.equal(dispatchQueue().length, 2, 'os pendentes voltam para a fila');
});

test('despacho automático divide a fila entre os entregadores na loja', () => {
  const { user, driverId, driver2Id } = setup(6);
  const routes = autoDispatch(user, {});
  assert.equal(routes.length, 2, 'dois entregadores na loja, duas rotas');
  assert.equal(routes.reduce((acc, r) => acc + r.stops.length, 0), 6);
  assert.deepEqual(routes.map((r) => r.driver_id).sort(), [driverId, driver2Id].sort());
  assert.equal(dispatchQueue().length, 0);
});

test('despacho automático respeita o limite por entregador e exige gente disponível', () => {
  const { user, driverId, driver2Id } = setup(6);
  setDriverStatus(driver2Id, 'offline', user);
  const routes = autoDispatch(user, { max_per_driver: 2 });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].stops.length, 2);
  assert.equal(dispatchQueue().length, 4, 'o restante continua na fila');

  setDriverStatus(driverId, 'offline', user);
  assert.throws(() => autoDispatch(user, {}), /Nenhum entregador disponível/i);
});

test('despacho automático avisa quando não há nada para entregar', () => {
  const { user } = setup(0);
  assert.throws(() => autoDispatch(user, {}), /Não há pedidos aguardando/i);
});

test('reordenar paradas mantém exatamente os mesmos pedidos', () => {
  const { user, driverId, orders } = setup(3);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  const reversed = route.stops.map((s) => s.order_id).reverse();

  const updated = reorderStops(route.id, reversed, user);
  assert.deepEqual(updated.stops.map((s) => s.order_id), reversed);
  assert.throws(() => reorderStops(route.id, reversed.slice(1), user), /exatamente os pedidos/i);
});

test('reotimizar a rota não perde paradas e recalcula a distância', () => {
  const { user, driverId, orders } = setup(4);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  reorderStops(route.id, route.stops.map((s) => s.order_id).reverse(), user);

  const optimized = optimizeRoute(route.id, user);
  assert.equal(optimized.stops.length, 4);
  assert.ok(optimized.planned_km > 0);
  assert.equal(new Set(optimized.stops.map((s) => s.seq)).size, 4, 'as sequências não se repetem');
});

test('pedido de última hora pode ser encaixado numa rota em andamento', () => {
  const { user, driverId, orders } = setup(3);
  const route = createRoute(driverId, orders.slice(0, 2).map((o) => o.id), user);
  startRoute(route.id, user);
  changeStatus(orders[2].id, 'pronto', user);

  const updated = addOrderToRoute(route.id, orders[2].id, user);
  assert.equal(updated.stops.length, 3);
  assert.equal(getOrder(orders[2].id).status, 'em_entrega', 'entra já como saído para entrega');
  assert.throws(() => addOrderToRoute(route.id, orders[2].id, user), /já está na rota/i);
});

test('entregador em rota não pode encerrar o turno', () => {
  const { user, driverId, orders } = setup(1);
  const route = createRoute(driverId, [orders[0].id], user);
  startRoute(route.id, user);
  assert.throws(() => setDriverStatus(driverId, 'offline', user), /ainda tem rota/i);
});

test('o acerto do dia soma entregas, taxas e comissão por entregador', () => {
  const { user, driverId, orders } = setup(2);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  startRoute(route.id, user);
  completeStop(route.id, orders[0].id, user);
  completeStop(route.id, orders[1].id, user);

  const settlement = driverSettlement();
  const jorge = settlement.find((s) => s.driver_id === driverId);
  assert.equal(jorge.deliveries, 2);
  assert.equal(jorge.commission_cents, 800, '2 entregas x R$ 4,00');
  assert.ok(jorge.fees_cents > 0);
  assert.ok(jorge.km > 0, 'os km da rota concluída entram no acerto');
});

test('listRoutes filtra por entregador e por status', () => {
  const { user, driverId, driver2Id, orders } = setup(4);
  const a = createRoute(driverId, orders.slice(0, 2).map((o) => o.id), user);
  createRoute(driver2Id, orders.slice(2).map((o) => o.id), user);
  startRoute(a.id, user);

  assert.equal(listRoutes({ driver_id: driverId }).length, 1);
  assert.equal(listRoutes({ status: 'em_rota' }).length, 1);
  assert.equal(listRoutes({ status: 'planejada' }).length, 1);
});

/* ------------------------- Waze, QR e mesclagem ------------------------- */

test('cada parada carrega o link do Waze com as coordenadas do cliente', () => {
  const { user, driverId, orders } = setup(2);
  const route = createRoute(driverId, orders.map((o) => o.id), user);
  for (const stop of route.stops) {
    assert.match(stop.waze_url, /^https:\/\/waze\.com\/ul\?ll=-?\d+\.\d+%2C-?\d+\.\d+&navigate=yes$/);
  }
});

test('sem coordenada, o Waze recebe o endereço escrito', () => {
  const link = wazeUrl({ street: 'Rua Japoara', number: '78', district: 'Anchieta', city: 'Rio de Janeiro - RJ' });
  assert.match(link, /^https:\/\/waze\.com\/ul\?q=/);
  assert.match(decodeURIComponent(link), /Rua Japoara, 78/);
  assert.equal(wazeUrl({}), '', 'sem endereço nenhum não há link');
});

test('escanear a comanda joga o pedido na rota aberta do entregador', () => {
  const { user, driverId, orders } = setup(3);
  const route = createRoute(driverId, [orders[0].id], user);

  const result = scanOrderIntoRoute(`OUTFOOD:PEDIDO:${orders[1].code}`, driverId, user);
  assert.equal(result.created, false, 'aproveita a rota que já existe');
  assert.equal(result.route.id, route.id);
  assert.equal(result.route.stops.length, 2);
  assert.equal(getOrder(orders[1].id).driver_id, driverId);
});

test('escanear sem rota aberta cria uma rota nova para o entregador', () => {
  const { user, driverId, orders } = setup(1);
  const result = scanOrderIntoRoute(orders[0].code, driverId, user);
  assert.equal(result.created, true);
  assert.equal(result.route.stops.length, 1);
  assert.equal(result.order.code, orders[0].code);
});

test('a leitura recusa código desconhecido, pedido já roteirizado e pedido finalizado', () => {
  const { user, driverId, driver2Id, pizzaId, orders } = setup(2);
  assert.throws(() => scanOrderIntoRoute('0000-000', driverId, user), /Não encontrei o pedido/i);
  assert.throws(() => scanOrderIntoRoute('', driverId, user), /não reconhecido/i);

  createRoute(driver2Id, [orders[0].id], user);
  assert.throws(() => scanOrderIntoRoute(orders[0].code, driverId, user), /já está na rota/i);

  const pickup = createOrder({ ...orderInput(5, { productId: pizzaId }), type: 'retirada' }, user);
  assert.throws(() => scanOrderIntoRoute(pickup.code, driverId, user), /não é uma entrega/i);

  changeStatus(orders[1].id, 'cancelado', user, { reason: 'teste' });
  assert.throws(() => scanOrderIntoRoute(orders[1].code, driverId, user), /já foi finalizado/i);
});

test('escanear o pedido que já está na própria rota avisa em vez de duplicar', () => {
  const { user, driverId, orders } = setup(1);
  scanOrderIntoRoute(orders[0].code, driverId, user);
  assert.throws(() => scanOrderIntoRoute(orders[0].code, driverId, user), /já está na sua rota/i);
});

test('mesclar rotas move as paradas pendentes e reotimiza o trajeto', () => {
  const { user, driverId, driver2Id, orders } = setup(4);
  const target = createRoute(driverId, orders.slice(0, 2).map((o) => o.id), user);
  const source = createRoute(driver2Id, orders.slice(2).map((o) => o.id), user);

  const merged = mergeRoutes(target.id, source.id, user);
  assert.equal(merged.stops.length, 4);
  assert.equal(getRoute(source.id).status, 'cancelada');
  assert.equal(new Set(merged.stops.map((s) => s.seq)).size, 4);
  for (const order of orders) assert.equal(getOrder(order.id).driver_id, driverId, 'tudo passa para um entregador só');
  assert.equal(get('SELECT status FROM drivers WHERE id = ?', driver2Id).status, 'na_loja');
});

test('mesclar preserva o que já foi entregue e recusa combinações inválidas', () => {
  const { user, driverId, driver2Id, orders } = setup(4);
  const target = createRoute(driverId, orders.slice(0, 2).map((o) => o.id), user);
  const source = createRoute(driver2Id, orders.slice(2).map((o) => o.id), user);
  startRoute(source.id, user);
  completeStop(source.id, source.stops[0].order_id, user);

  const merged = mergeRoutes(target.id, source.id, user);
  assert.equal(merged.stops.length, 3, 'só a parada pendente migra');
  assert.equal(getOrder(source.stops[0].order_id).status, 'entregue');

  assert.throws(() => mergeRoutes(target.id, target.id, user), /duas rotas diferentes/i);
  assert.throws(() => mergeRoutes(target.id, source.id, user), /já foi finalizada|não tem paradas pendentes/i);
});

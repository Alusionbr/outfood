import { all, get, run, getSettings, transaction } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { estimateRouteMinutes, legDistances, mapsLink, optimizeStops, routeDistanceKm, splitAmongDrivers } from '../lib/geo.js';
import { publish } from '../lib/events.js';
import { businessDay, changeStatus, decorate, finishRouteIfDone, formatAddress, logEvent, orderItems } from './orders.js';
import { driverCommissionCents, storePoint } from './pricing.js';

export const DRIVER_STATUS = ['offline', 'na_loja', 'em_rota'];
export const DRIVER_STATUS_LABELS = { offline: 'Fora de turno', na_loja: 'Na loja', em_rota: 'Em rota' };
export const COMMISSION_TYPES = ['por_entrega', 'percentual_taxa', 'percentual_pedido', 'diaria'];

export function listDrivers({ activeOnly = false } = {}) {
  const rows = all(
    `SELECT d.*, u.email AS user_email FROM drivers d
       LEFT JOIN users u ON u.id = d.user_id
      ${activeOnly ? 'WHERE d.active = 1' : ''}
      ORDER BY d.active DESC, d.name`
  );
  return rows.map(decorateDriver);
}

export function getDriver(id) {
  const row = get('SELECT d.*, u.email AS user_email FROM drivers d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = ?', id);
  return row ? decorateDriver(row) : null;
}

function decorateDriver(driver) {
  const day = businessDay();
  const stats = get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'entregue' THEN 1 ELSE 0 END), 0) AS delivered,
            COALESCE(SUM(CASE WHEN status = 'em_entrega' THEN 1 ELSE 0 END), 0) AS in_route,
            COALESCE(SUM(delivery_fee_cents), 0) AS fees_cents
       FROM orders WHERE driver_id = ? AND business_day = ?`,
    driver.id, day
  );
  const activeRoute = get(
    "SELECT * FROM routes WHERE driver_id = ? AND status = 'em_rota' ORDER BY id DESC LIMIT 1", driver.id
  );
  return {
    ...driver,
    active: !!driver.active,
    status_label: DRIVER_STATUS_LABELS[driver.status] || driver.status,
    today: {
      orders: stats?.total || 0,
      delivered: stats?.delivered || 0,
      in_route: stats?.in_route || 0,
      fees_cents: stats?.fees_cents || 0,
    },
    active_route_id: activeRoute?.id ?? null,
  };
}

/** Pedidos prontos para despacho (entrega própria, sem entregador). */
export function dispatchQueue() {
  const rows = all(
    `SELECT o.*, z.name AS zone_name FROM orders o
       LEFT JOIN zones z ON z.id = o.zone_id
      WHERE o.type = 'entrega' AND o.courier = 'loja'
        AND o.driver_id IS NULL
        AND o.status IN ('recebido','em_preparo','pronto')
      ORDER BY o.promised_at, o.id`
  );
  return rows.map((row) => ({ ...decorate(row, false), items: orderItems(row.id) }));
}

export function getRoute(id) {
  const route = get(
    `SELECT r.*, d.name AS driver_name, d.phone AS driver_phone FROM routes r
       JOIN drivers d ON d.id = r.driver_id WHERE r.id = ?`,
    id
  );
  if (!route) return null;
  const stops = all(
    `SELECT s.*, o.code, o.customer_name, o.customer_phone, o.street, o.number, o.complement,
            o.district, o.city, o.reference, o.lat, o.lon, o.total_cents, o.delivery_fee_cents,
            o.payment_method, o.paid, o.change_for_cents, o.notes, o.status AS order_status,
            o.public_token
       FROM route_stops s JOIN orders o ON o.id = s.order_id
      WHERE s.route_id = ? ORDER BY s.seq`,
    id
  ).map((stop) => ({
    ...stop,
    address: formatAddress(stop),
    paid: !!stop.paid,
    items: orderItems(stop.order_id),
    waze_url: wazeUrl(stop),
  }));

  const settings = getSettings();
  const store = storePoint(settings);
  return {
    ...route,
    stops,
    store,
    maps_url: mapsLink([
      { ...store, address: settings.store_address },
      ...stops.map((s) => ({ lat: s.lat, lon: s.lon, address: s.address })),
    ]),
    pending_stops: stops.filter((s) => s.status === 'pendente').length,
    cash_to_collect_cents: stops
      .filter((s) => !s.paid && s.status !== 'entregue')
      .reduce((acc, s) => acc + (s.total_cents || 0), 0),
  };
}

export function listRoutes(filters = {}) {
  const where = [];
  const params = [];
  if (filters.day) { where.push('r.business_day = ?'); params.push(filters.day); }
  if (filters.driver_id) { where.push('r.driver_id = ?'); params.push(filters.driver_id); }
  if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
  const rows = all(
    `SELECT r.id FROM routes r ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 200`,
    ...params
  );
  return rows.map((row) => getRoute(row.id));
}

/**
 * Cria uma rota para um entregador com os pedidos informados, já otimizada.
 */
export function createRoute(driverId, orderIds, user) {
  const driver = get('SELECT * FROM drivers WHERE id = ?', driverId);
  if (!driver) throw notFound('Entregador não encontrado');
  if (!driver.active) throw conflict(`${driver.name} está inativo`);
  if (!Array.isArray(orderIds) || !orderIds.length) throw badRequest('Selecione ao menos um pedido para a rota');

  const settings = getSettings();
  const store = storePoint(settings);

  return transaction(() => {
    const orders = orderIds.map((id) => {
      const order = get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound(`Pedido ${id} não encontrado`);
      if (order.type !== 'entrega') throw conflict(`Pedido ${order.code} não é uma entrega`);
      if (order.courier === 'plataforma') throw conflict(`Pedido ${order.code} é retirado pela plataforma`);
      if (['entregue', 'cancelado'].includes(order.status)) throw conflict(`Pedido ${order.code} já foi finalizado`);
      const existing = get(
        `SELECT r.id FROM route_stops s JOIN routes r ON r.id = s.route_id
          WHERE s.order_id = ? AND s.status = 'pendente' AND r.status <> 'cancelada'`, id
      );
      if (existing) throw conflict(`Pedido ${order.code} já está na rota #${existing.id}`);
      return order;
    });

    const ordered = optimizeStops(store, orders);
    const legs = legDistances(store, ordered);
    const km = routeDistanceKm(store, ordered);
    const minutes = estimateRouteMinutes(store, ordered, {
      avgSpeedKmh: settings.avg_speed_kmh,
      stopMinutes: settings.stop_minutes,
    });

    const result = run(
      'INSERT INTO routes(driver_id, status, planned_km, planned_minutes, business_day, created_by) VALUES (?,?,?,?,?,?)',
      driverId, 'planejada', km, minutes, businessDay(), user?.id ?? null
    );
    const routeId = Number(result.lastInsertRowid);

    ordered.forEach((order, index) => {
      run('INSERT INTO route_stops(route_id, order_id, seq, leg_km) VALUES (?,?,?,?)',
        routeId, order.id, index + 1, legs[index] ?? 0);
      run('UPDATE orders SET driver_id = ?, route_id = ?, updated_at = datetime(\'now\') WHERE id = ?',
        driverId, routeId, order.id);
      logEvent(order.id, 'rota', order.status, order.status, `Atribuído a ${driver.name} (rota #${routeId})`, user?.id);
    });

    const route = getRoute(routeId);
    publish('route:created', { route });
    return route;
  });
}

/**
 * Distribui automaticamente a fila entre os entregadores disponíveis,
 * agrupando por setor geográfico e equilibrando a carga.
 */
export function autoDispatch(user, options = {}) {
  const settings = getSettings();
  const store = storePoint(settings);
  const queue = options.order_ids?.length
    ? options.order_ids.map((id) => get('SELECT * FROM orders WHERE id = ?', id)).filter(Boolean)
    : dispatchQueue();
  if (!queue.length) throw badRequest('Não há pedidos aguardando entregador');

  const driverIds = options.driver_ids?.length
    ? options.driver_ids
    : all("SELECT id FROM drivers WHERE active = 1 AND status = 'na_loja' ORDER BY id").map((d) => d.id);
  if (!driverIds.length) throw badRequest('Nenhum entregador disponível na loja. Marque alguém como "Na loja".');

  const maxPerDriver = Number(options.max_per_driver) || 0;
  const buckets = splitAmongDrivers(store, queue, driverIds.length);

  return transaction(() => {
    const routes = [];
    buckets.forEach((bucket, index) => {
      const stops = maxPerDriver > 0 ? bucket.slice(0, maxPerDriver) : bucket;
      if (!stops.length) return;
      routes.push(createRoute(driverIds[index], stops.map((s) => s.id), user));
    });
    publish('dispatch:auto', { routes: routes.map((r) => r.id) });
    return routes;
  });
}

export function startRoute(routeId, user) {
  const route = get('SELECT * FROM routes WHERE id = ?', routeId);
  if (!route) throw notFound('Rota não encontrada');
  if (route.status === 'em_rota') return getRoute(routeId);
  if (route.status !== 'planejada') throw conflict('Somente rotas planejadas podem ser iniciadas');

  return transaction(() => {
    run("UPDATE routes SET status = 'em_rota', started_at = datetime('now') WHERE id = ?", routeId);
    run("UPDATE drivers SET status = 'em_rota' WHERE id = ?", route.driver_id);
    const stops = all('SELECT order_id FROM route_stops WHERE route_id = ? ORDER BY seq', routeId);
    for (const stop of stops) {
      const order = get('SELECT status FROM orders WHERE id = ?', stop.order_id);
      if (order.status === 'recebido' || order.status === 'em_preparo') {
        changeStatus(stop.order_id, 'pronto', user, { reason: 'Saiu com o entregador' });
      }
      if (get('SELECT status FROM orders WHERE id = ?', stop.order_id).status === 'pronto') {
        changeStatus(stop.order_id, 'em_entrega', user);
      }
    }
    const updated = getRoute(routeId);
    publish('route:started', { route: updated });
    return updated;
  });
}

export function completeStop(routeId, orderId, user, { failed = false, reason = null } = {}) {
  const stop = get('SELECT * FROM route_stops WHERE route_id = ? AND order_id = ?', routeId, orderId);
  if (!stop) throw notFound('Parada não encontrada nesta rota');
  if (stop.status !== 'pendente') throw conflict('Esta parada já foi finalizada');

  return transaction(() => {
    if (failed) {
      run("UPDATE route_stops SET status = 'falhou', failure_reason = ?, delivered_at = datetime('now') WHERE id = ?", reason, stop.id);
      logEvent(orderId, 'entrega_falhou', null, null, reason || 'Entrega não realizada', user?.id);
      run("UPDATE orders SET status = 'pronto', driver_id = NULL, route_id = NULL, updated_at = datetime('now') WHERE id = ?", orderId);
      publish('order:updated', { order: getOrderSafe(orderId) });
    } else {
      run("UPDATE route_stops SET status = 'entregue', delivered_at = datetime('now') WHERE id = ?", stop.id);
      const order = get('SELECT * FROM orders WHERE id = ?', orderId);
      if (order.status !== 'entregue') changeStatus(orderId, 'entregue', user);
    }
    finishRouteIfDone(routeId);
    return getRoute(routeId);
  });
}

function getOrderSafe(orderId) {
  const row = get('SELECT * FROM orders WHERE id = ?', orderId);
  return row ? decorate(row, false) : null;
}

export function cancelRoute(routeId, user, reason) {
  const route = get('SELECT * FROM routes WHERE id = ?', routeId);
  if (!route) throw notFound('Rota não encontrada');
  if (route.status === 'concluida') throw conflict('Rota já concluída');

  return transaction(() => {
    const stops = all("SELECT * FROM route_stops WHERE route_id = ? AND status = 'pendente'", routeId);
    for (const stop of stops) {
      const order = get('SELECT * FROM orders WHERE id = ?', stop.order_id);
      run("UPDATE orders SET driver_id = NULL, route_id = NULL, updated_at = datetime('now') WHERE id = ?", stop.order_id);
      if (order.status === 'em_entrega') {
        run("UPDATE orders SET status = 'pronto' WHERE id = ?", stop.order_id);
        logEvent(stop.order_id, 'status', 'em_entrega', 'pronto', 'Rota cancelada, pedido voltou para a fila', user?.id);
      }
    }
    run("UPDATE route_stops SET status = 'cancelada' WHERE route_id = ? AND status = 'pendente'", routeId);
    run("UPDATE routes SET status = 'cancelada', finished_at = datetime('now') WHERE id = ?", routeId);
    const others = get("SELECT COUNT(*) AS total FROM routes WHERE driver_id = ? AND status = 'em_rota'", route.driver_id);
    if (others?.total === 0) run("UPDATE drivers SET status = 'na_loja' WHERE id = ?", route.driver_id);
    publish('route:cancelled', { route_id: routeId, reason: reason || null });
    return getRoute(routeId);
  });
}

/** Reordena manualmente as paradas de uma rota. */
export function reorderStops(routeId, orderIds, user) {
  const route = get('SELECT * FROM routes WHERE id = ?', routeId);
  if (!route) throw notFound('Rota não encontrada');
  const stops = all('SELECT * FROM route_stops WHERE route_id = ?', routeId);
  const ids = new Set(stops.map((s) => s.order_id));
  if (orderIds.length !== stops.length || orderIds.some((id) => !ids.has(Number(id)))) {
    throw badRequest('A nova ordem deve conter exatamente os pedidos da rota');
  }
  return transaction(() => {
    orderIds.forEach((orderId, index) => {
      run('UPDATE route_stops SET seq = ? WHERE route_id = ? AND order_id = ?', index + 1, routeId, Number(orderId));
    });
    recalcRoute(routeId);
    const updated = getRoute(routeId);
    publish('route:updated', { route: updated });
    return updated;
  });
}

/** Reotimiza a rota a partir do ponto atual do entregador (ou da loja). */
export function optimizeRoute(routeId, user) {
  const route = get('SELECT * FROM routes WHERE id = ?', routeId);
  if (!route) throw notFound('Rota não encontrada');
  const settings = getSettings();
  const driver = get('SELECT * FROM drivers WHERE id = ?', route.driver_id);
  const origin = driver?.lat != null && driver?.lon != null && route.status === 'em_rota'
    ? { lat: driver.lat, lon: driver.lon }
    : storePoint(settings);

  return transaction(() => {
    const pending = all(
      `SELECT s.*, o.lat, o.lon FROM route_stops s JOIN orders o ON o.id = s.order_id
        WHERE s.route_id = ? AND s.status = 'pendente' ORDER BY s.seq`, routeId
    );
    const ordered = optimizeStops(origin, pending);
    const done = all("SELECT * FROM route_stops WHERE route_id = ? AND status <> 'pendente'", routeId);
    let seq = done.length;
    ordered.forEach((stop) => { run('UPDATE route_stops SET seq = ? WHERE id = ?', ++seq, stop.id); });
    recalcRoute(routeId);
    const updated = getRoute(routeId);
    publish('route:updated', { route: updated });
    return updated;
  });
}

export function recalcRoute(routeId) {
  const settings = getSettings();
  const store = storePoint(settings);
  const stops = all(
    `SELECT s.id, o.lat, o.lon FROM route_stops s JOIN orders o ON o.id = s.order_id
      WHERE s.route_id = ? ORDER BY s.seq`, routeId
  );
  const legs = legDistances(store, stops);
  stops.forEach((stop, index) => run('UPDATE route_stops SET leg_km = ? WHERE id = ?', legs[index] ?? 0, stop.id));
  const km = routeDistanceKm(store, stops);
  const minutes = estimateRouteMinutes(store, stops, {
    avgSpeedKmh: settings.avg_speed_kmh,
    stopMinutes: settings.stop_minutes,
  });
  run('UPDATE routes SET planned_km = ?, planned_minutes = ? WHERE id = ?', km, minutes, routeId);
}

/** Adiciona um pedido a uma rota já existente (encaixe de última hora). */
export function addOrderToRoute(routeId, orderId, user) {
  const route = get('SELECT * FROM routes WHERE id = ?', routeId);
  if (!route) throw notFound('Rota não encontrada');
  if (['concluida', 'cancelada'].includes(route.status)) throw conflict('Rota já finalizada');
  const order = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) throw notFound('Pedido não encontrado');
  if (order.route_id) throw conflict(`Pedido ${order.code} já está na rota #${order.route_id}`);

  return transaction(() => {
    const maxSeq = get('SELECT COALESCE(MAX(seq),0) AS seq FROM route_stops WHERE route_id = ?', routeId).seq;
    run('INSERT INTO route_stops(route_id, order_id, seq) VALUES (?,?,?)', routeId, orderId, maxSeq + 1);
    run("UPDATE orders SET driver_id = ?, route_id = ?, updated_at = datetime('now') WHERE id = ?", route.driver_id, routeId, orderId);
    logEvent(orderId, 'rota', order.status, order.status, `Encaixado na rota #${routeId}`, user?.id);
    if (route.status === 'em_rota' && order.status === 'pronto') changeStatus(orderId, 'em_entrega', user);
    recalcRoute(routeId);
    const updated = getRoute(routeId);
    publish('route:updated', { route: updated });
    return updated;
  });
}

export function setDriverStatus(driverId, status, user) {
  const driver = get('SELECT * FROM drivers WHERE id = ?', driverId);
  if (!driver) throw notFound('Entregador não encontrado');
  if (!DRIVER_STATUS.includes(status)) throw badRequest('Status inválido para entregador');
  if (status === 'offline') {
    const active = get("SELECT COUNT(*) AS total FROM routes WHERE driver_id = ? AND status = 'em_rota'", driverId);
    if (active?.total > 0) throw conflict(`${driver.name} ainda tem rota em andamento`);
  }
  run('UPDATE drivers SET status = ? WHERE id = ?', status, driverId);
  publish('driver:status', { driver_id: driverId, status });
  return getDriver(driverId);
}

export function pingDriver(driverId, lat, lon) {
  run("UPDATE drivers SET lat = ?, lon = ?, last_ping = datetime('now') WHERE id = ?", lat, lon, driverId);
  publish('driver:position', { driver_id: driverId, lat, lon });
  return { ok: true };
}

/** Fechamento por entregador: entregas, taxas e comissão do dia. */
export function driverSettlement(day = businessDay()) {
  const drivers = all('SELECT * FROM drivers WHERE active = 1 ORDER BY name');
  return drivers.map((driver) => {
    const orders = all(
      "SELECT * FROM orders WHERE driver_id = ? AND business_day = ? AND status = 'entregue'",
      driver.id, day
    );
    const commission = orders.reduce((acc, order) => acc + driverCommissionCents(driver, order), 0);
    const dailyRate = driver.commission_type === 'diaria' && orders.length ? Number(driver.commission_value) || 0 : 0;
    const cash = orders
      .filter((o) => o.payment_method === 'dinheiro')
      .reduce((acc, o) => acc + o.total_cents, 0);
    const km = all(
      "SELECT planned_km FROM routes WHERE driver_id = ? AND business_day = ? AND status = 'concluida'",
      driver.id, day
    ).reduce((acc, r) => acc + (Number(r.planned_km) || 0), 0);
    return {
      driver_id: driver.id,
      name: driver.name,
      deliveries: orders.length,
      fees_cents: orders.reduce((acc, o) => acc + o.delivery_fee_cents, 0),
      commission_cents: commission + dailyRate,
      cash_collected_cents: cash,
      km: Math.round(km * 10) / 10,
    };
  });
}

/**
 * Link universal do Waze para uma parada. O Waze navega para um destino por
 * vez, então cada parada tem o seu; o trajeto completo continua no Maps.
 */
export function wazeUrl(stop) {
  if (stop?.lat != null && stop?.lon != null) {
    return `https://waze.com/ul?ll=${stop.lat}%2C${stop.lon}&navigate=yes`;
  }
  const address = formatAddress(stop || {});
  return address ? `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes` : '';
}

/**
 * Junta duas rotas do mesmo dia numa só e reotimiza — útil quando o entregador
 * pega a rota de um colega ou quando duas rotas pequenas cabem numa viagem.
 */
export function mergeRoutes(targetId, sourceId, user) {
  if (Number(targetId) === Number(sourceId)) throw badRequest('Escolha duas rotas diferentes');
  const target = get('SELECT * FROM routes WHERE id = ?', targetId);
  const source = get('SELECT * FROM routes WHERE id = ?', sourceId);
  if (!target || !source) throw notFound('Rota não encontrada');
  for (const route of [target, source]) {
    if (['concluida', 'cancelada'].includes(route.status)) {
      throw conflict(`A rota #${route.id} já foi finalizada`);
    }
  }

  return transaction(() => {
    const stops = all("SELECT * FROM route_stops WHERE route_id = ? AND status = 'pendente' ORDER BY seq", sourceId);
    if (!stops.length) throw conflict(`A rota #${sourceId} não tem paradas pendentes`);
    let seq = get('SELECT COALESCE(MAX(seq),0) AS seq FROM route_stops WHERE route_id = ?', targetId).seq;
    for (const stop of stops) {
      run('UPDATE route_stops SET route_id = ?, seq = ? WHERE id = ?', targetId, ++seq, stop.id);
      run("UPDATE orders SET driver_id = ?, route_id = ?, updated_at = datetime('now') WHERE id = ?",
        target.driver_id, targetId, stop.order_id);
      logEvent(stop.order_id, 'rota', null, null, `Rota #${sourceId} mesclada na rota #${targetId}`, user?.id);
      if (target.status === 'em_rota') {
        const order = get('SELECT status FROM orders WHERE id = ?', stop.order_id);
        if (order.status === 'pronto') changeStatus(stop.order_id, 'em_entrega', user);
      }
    }
    run("UPDATE routes SET status = 'cancelada', finished_at = datetime('now') WHERE id = ?", sourceId);
    const freed = get("SELECT COUNT(*) AS total FROM routes WHERE driver_id = ? AND status = 'em_rota'", source.driver_id);
    if (freed?.total === 0) run("UPDATE drivers SET status = 'na_loja' WHERE id = ?", source.driver_id);
    optimizeRoute(targetId, user);
    const merged = getRoute(targetId);
    publish('route:merged', { route: merged, from: Number(sourceId) });
    return merged;
  });
}

/**
 * Despacho por leitura: o entregador aponta a câmera para o QR impresso na
 * comanda e o pedido entra na rota dele — abrindo uma rota nova se não houver.
 */
export function scanOrderIntoRoute(code, driverId, user) {
  const clean = String(code || '').trim().replace(/^OUTFOOD:PEDIDO:/i, '');
  if (!clean) throw badRequest('Código do pedido não reconhecido');
  const order = get('SELECT * FROM orders WHERE code = ?', clean);
  if (!order) throw notFound(`Não encontrei o pedido ${clean}`);
  if (order.type !== 'entrega') throw conflict(`O pedido ${order.code} é ${order.type}, não é uma entrega`);
  if (order.courier === 'plataforma') throw conflict(`O pedido ${order.code} é retirado pela plataforma`);
  if (['entregue', 'cancelado'].includes(order.status)) throw conflict(`O pedido ${order.code} já foi finalizado`);

  const open = get(
    `SELECT * FROM routes WHERE driver_id = ? AND status IN ('planejada','em_rota')
      ORDER BY CASE status WHEN 'em_rota' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
    driverId
  );
  if (order.route_id && open && order.route_id === open.id) {
    throw conflict(`O pedido ${order.code} já está na sua rota`);
  }
  if (order.route_id) throw conflict(`O pedido ${order.code} já está na rota #${order.route_id}`);

  const route = open ? addOrderToRoute(open.id, order.id, user) : createRoute(driverId, [order.id], user);
  return { route, order: get('SELECT code, customer_name FROM orders WHERE id = ?', order.id), created: !open };
}

/**
 * Despacho: fila de entregas, mapa com loja/zonas/pedidos e rotas por entregador.
 * A otimização roda no servidor; aqui a gente monta as rotas e acompanha.
 */
import { api } from '../api.js';
import { onServerEvent, state } from '../store.js';
import { emptyState, modal, notifyError, printWithQr, promptDialog, toast } from '../ui.js';
import { navigateDialog, qrBlock, routeQrDialog, scanOrderCode } from '../navigation.js';
import { DRIVER_STATUS_META, ROUTE_STATUS_LABELS, STOP_STATUS_LABELS, esc, formatPhone, money, since, statusBadge } from '../util.js';

let unsubscribe = null;
let map = null;
let layers = [];
let data = { queue: [], drivers: [], routes: [] };
const selected = new Set();

export async function render(container) {
  unsubscribe?.();
  container.innerHTML = `
    <div class="grid cols-2" style="grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)">
      <div>
        <div class="card">
          <header>
            <h3>Fila de entregas</h3>
            <span class="badge" id="queueCount">0</span>
            <div class="row tight" style="margin-left:auto">
              <button class="btn-2 btn-sm" id="scan">📷 Escanear</button>
              <button class="btn-2 btn-sm" id="selectAll">Selecionar tudo</button>
              <button class="btn-sm" id="auto">⚡ Distribuir automático</button>
            </div>
          </header>
          <div class="body" id="queue"><div class="loading">Carregando fila...</div></div>
          <div class="body" style="border-top:1px solid var(--border)">
            <div class="row">
              <select id="driverSelect" class="grow"></select>
              <button id="createRoute">Criar rota com selecionados</button>
            </div>
            <div class="hint">A rota sai da loja e é ordenada automaticamente pelo menor percurso.</div>
          </div>
        </div>

        <div class="card">
          <header><h3>Entregadores</h3></header>
          <div class="table-wrap" id="drivers"></div>
        </div>
      </div>

      <div>
        <div class="card">
          <header><h3>Mapa da operação</h3>
            <div class="row tight" style="margin-left:auto">
              <label class="checkbox"><input type="checkbox" id="showZones" checked> zonas</label>
              <button class="btn-ghost btn-sm" id="fit">Centralizar</button>
            </div>
          </header>
          <div class="body">
            <div id="map" class="map"></div>
            <div class="map-legend">
              <span><i style="background:#1F2933"></i> loja</span>
              <span><i style="background:#E65100"></i> aguardando entregador</span>
              <span><i style="background:#2E7D32"></i> em rota</span>
              <span><i style="background:#1565C0"></i> posição do entregador</span>
            </div>
          </div>
        </div>

        <div class="card">
          <header><h3>Rotas de hoje</h3></header>
          <div class="body stack" id="routes"></div>
        </div>
      </div>
    </div>`;

  bind(container);
  await load(container);
  unsubscribe = onServerEvent('*', (payload, name) => {
    if (name.startsWith('order:') || name.startsWith('route:') || name.startsWith('driver:')) load(container, true);
  });
}

export function destroy() {
  unsubscribe?.();
  if (map) { map.remove(); map = null; }
  layers = [];
  selected.clear();
}

function bind(container) {
  container.querySelector('#auto').onclick = async () => {
    if (!data.queue.length) return toast('A fila está vazia', 'warn');
    try {
      const routes = await api.autoDispatch({ order_ids: selected.size ? [...selected] : [] });
      toast(`${routes.length} rota(s) criada(s)`, 'ok');
      selected.clear();
      load(container);
    } catch (err) { notifyError(err); }
  };
  container.querySelector('#selectAll').onclick = () => {
    const all = data.queue.every((o) => selected.has(o.id));
    data.queue.forEach((o) => (all ? selected.delete(o.id) : selected.add(o.id)));
    drawQueue(container);
  };
  container.querySelector('#createRoute').onclick = async () => {
    const driverId = Number(container.querySelector('#driverSelect').value);
    if (!driverId) return toast('Escolha o entregador', 'warn');
    if (!selected.size) return toast('Selecione ao menos um pedido', 'warn');
    try {
      const route = await api.post('/api/routes', { driver_id: driverId, order_ids: [...selected] });
      toast(`Rota #${route.id} criada — ${route.stops.length} paradas, ${route.planned_km} km`, 'ok');
      selected.clear();
      load(container);
    } catch (err) { notifyError(err); }
  };
  container.querySelector('#scan').onclick = async () => {
    const code = await scanOrderCode();
    if (!code) return;
    const driverId = Number(container.querySelector('#driverSelect').value);
    if (!driverId) return toast('Escolha antes o entregador que vai levar', 'warn');
    try {
      const result = await api.post('/api/dispatch/scan', { code, driver_id: driverId });
      toast(`${result.order.code} entrou na rota #${result.route.id}`, 'ok');
      load(container);
    } catch (err) { notifyError(err); }
  };
  container.querySelector('#fit').onclick = () => fitMap();
  container.querySelector('#showZones').onchange = () => drawMap(container);
}

async function load(container, silent = false) {
  try {
    data = await api.dispatchQueue();
    drawQueue(container);
    drawDrivers(container);
    drawRoutes(container);
    drawMap(container);
  } catch (err) {
    if (!silent) notifyError(err);
  }
}

function drawQueue(container) {
  const host = container.querySelector('#queue');
  container.querySelector('#queueCount').textContent = data.queue.length;
  const select = container.querySelector('#driverSelect');
  const available = data.drivers.filter((d) => d.active);
  select.innerHTML = '<option value="">Escolha o entregador</option>' + available.map((d) => `
    <option value="${d.id}">${esc(d.name)} — ${esc(DRIVER_STATUS_META[d.status]?.label || d.status)} (${d.today.in_route} em rota)</option>`).join('');

  if (!data.queue.length) {
    host.innerHTML = emptyState('✅', 'Nenhuma entrega esperando', 'Todos os pedidos já têm entregador.');
    return;
  }
  host.innerHTML = `<div class="stack">${data.queue.map((o) => `
    <label class="ticket ${o.lat == null ? 'warn' : ''}" style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
      <input type="checkbox" data-pick="${o.id}" ${selected.has(o.id) ? 'checked' : ''} style="width:auto;margin-top:3px">
      <span class="grow">
        <span class="head"><span class="code">${esc(o.code)}</span>${statusBadge(o.status)}<span class="when">${since(o.created_at)}</span></span>
        <span class="who" style="display:block">${esc(o.customer_name)}</span>
        <span class="where">${esc(o.address || 'sem endereço')}</span>
        ${o.lat == null ? '<span class="badge red">sem coordenada</span>' : ''}
        ${o.zone_name ? `<span class="badge">${esc(o.zone_name)}</span>` : ''}
        <span class="badge ${o.paid ? 'green' : 'orange'}">${o.paid ? 'pago' : 'receber ' + money(o.total_cents)}</span>
      </span>
    </label>`).join('')}</div>`;

  host.querySelectorAll('[data-pick]').forEach((input) => {
    input.onchange = () => {
      const id = Number(input.dataset.pick);
      if (input.checked) selected.add(id); else selected.delete(id);
    };
  });
}

function drawDrivers(container) {
  container.querySelector('#drivers').innerHTML = data.drivers.length ? `<table>
    <thead><tr><th>Entregador</th><th>Status</th><th class="num">Hoje</th><th class="num">Taxas</th><th></th></tr></thead>
    <tbody>${data.drivers.map((d) => `
      <tr>
        <td>${esc(d.name)}<div class="small muted">${esc(formatPhone(d.phone) || d.vehicle)}</div></td>
        <td><span class="dot ${DRIVER_STATUS_META[d.status]?.dot}"></span> ${esc(DRIVER_STATUS_META[d.status]?.label || d.status)}</td>
        <td class="num">${d.today.delivered}/${d.today.orders}</td>
        <td class="num">${money(d.today.fees_cents)}</td>
        <td class="right"><select data-driver="${d.id}" style="width:auto">
          ${['na_loja', 'em_rota', 'offline'].map((s) => `<option value="${s}" ${d.status === s ? 'selected' : ''}>${DRIVER_STATUS_META[s].label}</option>`).join('')}
        </select></td>
      </tr>`).join('')}</tbody></table>` : emptyState('🏍️', 'Cadastre seus entregadores', 'Menu Cadastros → Entregadores');

  container.querySelectorAll('select[data-driver]').forEach((select) => {
    select.onchange = async () => {
      try {
        await api.post(`/api/drivers/${select.dataset.driver}/status`, { status: select.value });
        load(container, true);
      } catch (err) { notifyError(err); load(container, true); }
    };
  });
}

function drawRoutes(container) {
  const host = container.querySelector('#routes');
  if (!data.routes.length) {
    host.innerHTML = emptyState('🗺️', 'Nenhuma rota ativa', 'Selecione pedidos e crie uma rota.');
    return;
  }
  host.innerHTML = data.routes.map((route) => `
    <div class="card" style="margin:0">
      <header>
        <h4>Rota #${route.id} · ${esc(route.driver_name)}</h4>
        <span class="badge ${route.status === 'em_rota' ? 'orange' : 'blue'}">${esc(ROUTE_STATUS_LABELS[route.status] || route.status)}</span>
        <span class="badge">${route.stops.length} paradas · ${route.planned_km} km · ~${route.planned_minutes} min</span>
      </header>
      <div class="body">
        <ol style="margin:0;padding-left:20px">
          ${route.stops.map((s) => `<li style="margin-bottom:4px">
            <b>${esc(s.code)}</b> ${esc(s.customer_name)} — ${esc(s.address)}
            <span class="badge ${s.status === 'entregue' ? 'green' : 'gray'}">${esc(STOP_STATUS_LABELS[s.status] || s.status)}</span>
            ${s.status === 'pendente' ? `<a class="badge orange" href="${esc(s.waze_url)}" target="_blank" rel="noopener">Waze</a>
              <button class="btn-ghost btn-sm" data-nav="${route.id}:${s.order_id}">QR</button>
              <button class="btn-ghost btn-sm" data-deliver="${route.id}:${s.order_id}">entregue</button>` : ''}
          </li>`).join('')}
        </ol>
        <div class="row mt">
          ${route.status === 'planejada' ? `<button class="btn-sm" data-start="${route.id}">🛵 Iniciar rota</button>` : ''}
          <button class="btn-2 btn-sm" data-manifest="${route.id}">🖨 Romaneio + QR</button>
          <button class="btn-2 btn-sm" data-qr="${route.id}">🔳 QR da rota</button>
          <a class="btn btn-2 btn-sm" href="${esc(route.maps_url)}" target="_blank" rel="noopener">🗺 Abrir no Maps</a>
          <button class="btn-ghost btn-sm" data-optimize="${route.id}">♻ Reotimizar</button>
          ${data.routes.length > 1 ? `<button class="btn-ghost btn-sm" data-merge="${route.id}">🔗 Mesclar</button>` : ''}
          <button class="btn-danger btn-sm" data-cancel="${route.id}">Cancelar rota</button>
          <span class="badge orange" style="margin-left:auto">a receber ${money(route.cash_to_collect_cents)}</span>
        </div>
      </div>
    </div>`).join('');

  const act = (selector, handler) => host.querySelectorAll(selector).forEach((b) => { b.onclick = () => handler(b); });
  act('[data-start]', async (b) => { try { await api.post(`/api/routes/${b.dataset.start}/start`); toast('Rota iniciada', 'ok'); load(container); } catch (e) { notifyError(e); } });
  act('[data-optimize]', async (b) => { try { const r = await api.post(`/api/routes/${b.dataset.optimize}/optimize`); toast(`Rota reotimizada: ${r.planned_km} km`, 'ok'); load(container); } catch (e) { notifyError(e); } });
  act('[data-manifest]', async (b) => {
    const route = data.routes.find((r) => String(r.id) === b.dataset.manifest);
    try {
      const { text } = await api.print(`/api/print/route/${b.dataset.manifest}`);
      printWithQr(text, qrBlock(route.maps_url, 'Escaneie para abrir a rota no Maps', 150));
    } catch (e) { notifyError(e); }
  });
  act('[data-qr]', (b) => routeQrDialog(data.routes.find((r) => String(r.id) === b.dataset.qr)));
  act('[data-nav]', (b) => {
    const [routeId, orderId] = b.dataset.nav.split(':');
    const route = data.routes.find((r) => String(r.id) === routeId);
    const stop = route.stops.find((s) => String(s.order_id) === orderId);
    navigateDialog(stop, { routeMapsUrl: route.maps_url });
  });
  act('[data-merge]', (b) => mergeDialog(container, data.routes.find((r) => String(r.id) === b.dataset.merge)));
  act('[data-deliver]', async (b) => {
    const [routeId, orderId] = b.dataset.deliver.split(':');
    try { await api.post(`/api/routes/${routeId}/stops/${orderId}`, {}); toast('Entrega confirmada', 'ok'); load(container); } catch (e) { notifyError(e); }
  });
  act('[data-cancel]', async (b) => {
    const reason = await promptDialog({ title: 'Cancelar rota', label: 'Motivo', placeholder: 'Moto quebrou' });
    if (!reason) return;
    try { await api.post(`/api/routes/${b.dataset.cancel}/cancel`, { reason }); toast('Rota cancelada, pedidos voltaram para a fila', 'warn'); load(container); } catch (e) { notifyError(e); }
  });
}

/* ------------------------------- mapa ------------------------------- */

function drawMap(container) {
  if (typeof L === 'undefined') return;
  const element = container.querySelector('#map');
  if (!element) return;
  const store = storePoint();

  if (!map) {
    map = L.map(element, { scrollWheelZoom: true }).setView(store ? [store.lat, store.lon] : [-22.83, -43.4], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19,
    }).addTo(map);
  }
  layers.forEach((layer) => layer.remove());
  layers = [];

  if (store) {
    layers.push(L.marker([store.lat, store.lon], { icon: divIcon('pin-store', '🏪'), zIndexOffset: 900 })
      .addTo(map).bindPopup(`<b>${esc(state.settings.store_name || 'Loja')}</b>`));
    const radius = Number(state.settings.delivery_radius_km) || 0;
    if (radius) layers.push(L.circle([store.lat, store.lon], { radius: radius * 1000, color: '#1F2933', weight: 1, fillOpacity: .03, dashArray: '6,6' }).addTo(map));
  }

  if (container.querySelector('#showZones').checked) {
    for (const zone of state.zones) {
      if (zone.lat == null || !zone.active) continue;
      layers.push(L.circle([zone.lat, zone.lon], {
        radius: Number(zone.radius_km) * 1000, color: zone.color, weight: 2, fillColor: zone.color, fillOpacity: .07,
      }).addTo(map).bindPopup(`<b>${esc(zone.name)}</b><br>taxa ${money(zone.fee_cents)}`));
    }
  }

  for (const order of data.queue) {
    if (order.lat == null) continue;
    layers.push(L.marker([order.lat, order.lon], { icon: pinIcon('#E65100', '•') }).addTo(map)
      .bindPopup(`<b>${esc(order.code)}</b><br>${esc(order.customer_name)}<br>${esc(order.address)}<br>${money(order.total_cents)}`));
  }

  for (const route of data.routes) {
    const points = [];
    if (store) points.push([store.lat, store.lon]);
    route.stops.forEach((stop, index) => {
      if (stop.lat == null) return;
      points.push([stop.lat, stop.lon]);
      layers.push(L.marker([stop.lat, stop.lon], { icon: pinIcon(stop.status === 'entregue' ? '#78848F' : '#2E7D32', String(index + 1)) })
        .addTo(map).bindPopup(`<b>#${stop.seq} ${esc(stop.code)}</b><br>${esc(stop.customer_name)}<br>${esc(stop.address)}<br>rota #${route.id} — ${esc(route.driver_name)}`));
    });
    if (points.length > 1) {
      layers.push(L.polyline(points, { color: '#2E7D32', weight: 3, opacity: .75, dashArray: '7,6' }).addTo(map));
    }
  }

  for (const driver of data.drivers) {
    if (driver.lat == null) continue;
    layers.push(L.marker([driver.lat, driver.lon], { icon: divIcon('pin-driver', '🏍️'), zIndexOffset: 800 })
      .addTo(map).bindPopup(`<b>${esc(driver.name)}</b><br>${esc(DRIVER_STATUS_META[driver.status]?.label || '')}`));
  }
  setTimeout(() => map.invalidateSize(), 60);
}

function fitMap() {
  if (!map) return;
  const points = layers.filter((l) => l.getLatLng).map((l) => l.getLatLng());
  if (points.length > 1) map.fitBounds(L.latLngBounds(points).pad(0.15));
  else if (points.length === 1) map.setView(points[0], 14);
}

function storePoint() {
  const { store_lat: lat, store_lon: lon } = state.settings;
  return lat != null && lon != null ? { lat: Number(lat), lon: Number(lon) } : null;
}

const divIcon = (className, content) =>
  L.divIcon({ className: '', html: `<div class="${className}">${content}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

const pinIcon = (color, label) =>
  L.divIcon({ className: '', html: `<div class="pin-order" style="background:${color}"><b>${esc(label)}</b></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });

/** Junta a rota escolhida a outra do mesmo dia e reotimiza o trajeto. */
async function mergeDialog(container, route) {
  const others = data.routes.filter((r) => r.id !== route.id && r.pending_stops > 0);
  if (!others.length) return toast('Não há outra rota com paradas pendentes', 'warn');
  const form = document.createElement('div');
  form.innerHTML = `
    <p>As paradas pendentes da rota escolhida passam para a
      <b>rota #${route.id} (${esc(route.driver_name)})</b> e o trajeto é reotimizado.</p>
    <div class="field"><label>Rota a incorporar</label>
      <select id="source">${others.map((r) => `<option value="${r.id}">
        Rota #${r.id} — ${esc(r.driver_name)} (${r.pending_stops} paradas)</option>`).join('')}</select></div>`;
  const merged = await modal({
    title: 'Mesclar rotas',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Mesclar',
        onClick: async ({ body }) => api.post(`/api/routes/${route.id}/merge`, {
          source_route_id: Number(body.querySelector('#source').value),
        }),
      },
    ],
  });
  if (merged?.id) {
    toast(`Rotas mescladas: ${merged.stops.length} paradas em ${merged.planned_km} km`, 'ok');
    load(container);
  }
}

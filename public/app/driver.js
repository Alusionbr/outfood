/**
 * App do entregador (mobile): rota do dia, navegação, confirmação de entrega
 * e envio da posição para o painel acompanhar no mapa.
 */
import { api, ApiError } from './api.js';
import { confirmDialog, notifyError, printText, printWithQr, promptDialog, toast } from './ui.js';
import { navigateDialog, orderQrPayload, qrBlock, scanOrderCode, wazeLink } from './navigation.js';
import { DRIVER_STATUS_META, ROUTE_STATUS_LABELS, STOP_STATUS_LABELS, esc, money, whatsappLink } from './util.js';

const app = document.getElementById('app');
let data = null;
let watchId = null;
let timer = null;

async function boot() {
  try {
    data = await api.get('/api/drivers/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderLogin();
    if (err instanceof ApiError && err.status === 404) return renderMessage('Seu usuário não está vinculado a um entregador. Peça ao gerente para vincular no cadastro da equipe.');
    if (err instanceof ApiError && err.status === 403) return renderMessage('Este app é exclusivo para usuários com perfil de entregador. Use o painel em /painel.');
    return renderMessage(err.message);
  }
  draw();
  startTracking();
  clearInterval(timer);
  timer = setInterval(refresh, 30000);
}

async function refresh() {
  try { data = await api.get('/api/drivers/me'); draw(); } catch { /* offline momentâneo */ }
}

function renderLogin(message = '') {
  app.innerHTML = `
    <div class="login-page">
      <form class="login-card" id="form">
        <div class="logo">🏍️</div>
        <h1>App do entregador</h1>
        <p>Entre com o seu usuário do Outfood.</p>
        ${message ? `<div class="toast err" style="position:static;margin-bottom:12px">${esc(message)}</div>` : ''}
        <div class="field"><label>E-mail</label><input type="email" id="email" autocomplete="username" required></div>
        <div class="field"><label>Senha</label><input type="password" id="password" autocomplete="current-password" required></div>
        <button class="btn-lg btn-block">Entrar</button>
      </form>
    </div>`;
  document.getElementById('form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api.login(document.getElementById('email').value.trim(), document.getElementById('password').value);
      boot();
    } catch (err) { renderLogin(err.message); }
  };
}

function renderMessage(text) {
  app.innerHTML = `<div class="driver-app"><div class="card"><div class="body">
    <p>${esc(text)}</p><a class="btn btn-2" href="/painel">Ir para o painel</a>
    <button class="btn-ghost btn-block mt" id="out">Sair</button></div></div></div>`;
  document.getElementById('out').onclick = async () => { await api.logout().catch(() => {}); renderLogin(); };
}

function draw() {
  const { driver, routes, active_route: active } = data;
  const route = active || routes.find((r) => r.status === 'planejada') || null;
  const pending = route ? route.stops.filter((s) => s.status === 'pendente') : [];
  const meta = DRIVER_STATUS_META[driver.status] || { label: driver.status, dot: 'off' };

  app.innerHTML = `
  <div class="driver-top">
    <div class="spread">
      <div>
        <h1>${esc(driver.name)}</h1>
        <div class="small muted"><span class="dot ${meta.dot}"></span> ${esc(meta.label)} ·
          ${driver.today.delivered}/${driver.today.orders} entregas hoje</div>
      </div>
      <button class="btn-ghost btn-sm" id="logout" style="color:#fff;border-color:#4A5560">Sair</button>
    </div>
    <div class="pill-group mt" style="width:100%">
      ${['na_loja', 'em_rota', 'offline'].map((s) => `<button data-status="${s}" class="${driver.status === s ? 'active' : ''}" style="flex:1">${DRIVER_STATUS_META[s].label}</button>`).join('')}
    </div>
  </div>

  <div class="driver-app">
    ${route ? `
      <div class="card"><div class="body spread">
        <div><b>Rota #${route.id}</b> <span class="badge ${route.status === 'em_rota' ? 'orange' : 'blue'}">${esc(ROUTE_STATUS_LABELS[route.status] || route.status)}</span>
          <div class="small muted">${route.stops.length} paradas · ${route.planned_km} km · ~${route.planned_minutes} min</div></div>
        <div class="right"><div class="small muted">a receber</div><b>${money(route.cash_to_collect_cents)}</b></div>
      </div></div>

      ${route.status === 'planejada' ? `<button class="btn-lg btn-block mb" id="start">🛵 Iniciar rota</button>` : ''}

      <div class="row mb">
        <button class="btn-2 grow" id="scan">📷 Escanear pedido</button>
        <button class="btn-2 grow" id="routeQr">🔳 QR da rota</button>
      </div>

      ${route.stops.map((stop) => stopCard(stop, route)).join('')}

      <div class="row mt">
        <a class="btn btn-2 grow" href="${esc(route.maps_url)}" target="_blank" rel="noopener">🗺 Abrir rota no Maps</a>
        <button class="btn-ghost" id="manifest">🖨 Romaneio</button>
      </div>
      ${pending.length === 0 ? '<div class="card mt"><div class="body center"><b>🎉 Rota concluída!</b><div class="small muted">Volte para a loja para pegar novas entregas.</div></div></div>' : ''}
    ` : `<div class="card"><div class="body center">
        <div style="font-size:34px">☕</div>
        <b>Nenhuma rota atribuída</b>
        <div class="small muted mt">Marque "Na loja" para receber as próximas entregas,
          ou escaneie o QR impresso na comanda para montar sua rota.</div>
        <button class="btn-lg btn-block mt" id="scan">📷 Escanear pedido</button>
      </div></div>`}

    ${routes.filter((r) => r.status === 'concluida').length ? `
      <h3 class="mt-lg mb">Rotas concluídas hoje</h3>
      ${routes.filter((r) => r.status === 'concluida').map((r) => `
        <div class="card"><div class="body spread">
          <div>Rota #${r.id} · ${r.stops.length} paradas</div>
          <div class="muted small">${r.planned_km} km</div>
        </div></div>`).join('')}` : ''}
  </div>`;

  document.getElementById('logout').onclick = async () => {
    stopTracking();
    await api.logout().catch(() => {});
    renderLogin();
  };
  document.querySelectorAll('[data-status]').forEach((button) => {
    button.onclick = async () => {
      try { await api.post(`/api/drivers/${driver.id}/status`, { status: button.dataset.status }); refresh(); }
      catch (err) { notifyError(err); }
    };
  });
  document.getElementById('start')?.addEventListener('click', async () => {
    try { await api.post(`/api/routes/${route.id}/start`); toast('Boa viagem!', 'ok'); refresh(); }
    catch (err) { notifyError(err); }
  });
  document.getElementById('manifest')?.addEventListener('click', async () => {
    try {
      const { text } = await api.print(`/api/print/route/${route.id}`);
      printWithQr(text, qrBlock(route.maps_url, 'Escaneie para abrir a rota no Maps', 150));
    } catch (err) { notifyError(err); }
  });

  document.getElementById('routeQr')?.addEventListener('click', () => routeQr(route));

  document.querySelectorAll('#scan').forEach((button) => {
    button.onclick = async () => {
      const code = await scanOrderCode();
      if (!code) return;
      try {
        const result = await api.post('/api/dispatch/scan', { code, driver_id: driver.id });
        toast(`${result.order.code} — ${result.order.customer_name} entrou na ${result.created ? 'nova rota' : 'sua rota'}`, 'ok');
        refresh();
      } catch (err) { notifyError(err); }
    };
  });

  document.querySelectorAll('[data-nav]').forEach((button) => {
    button.onclick = () => {
      const stop = route.stops.find((s) => String(s.order_id) === button.dataset.nav);
      navigateDialog(stop, { routeMapsUrl: route.maps_url });
    };
  });

  document.querySelectorAll('[data-done]').forEach((button) => {
    button.onclick = async () => {
      const [routeId, orderId] = button.dataset.done.split(':');
      if (!await confirmDialog('Confirmar que este pedido foi entregue?', { danger: false, confirmLabel: 'Entreguei' })) return;
      try { await api.post(`/api/routes/${routeId}/stops/${orderId}`, {}); toast('Entrega confirmada', 'ok'); refresh(); }
      catch (err) { notifyError(err); }
    };
  });
  document.querySelectorAll('[data-fail]').forEach((button) => {
    button.onclick = async () => {
      const reason = await promptDialog({ title: 'Não consegui entregar', label: 'O que aconteceu?', placeholder: 'Cliente ausente' });
      if (!reason) return;
      const [routeId, orderId] = button.dataset.fail.split(':');
      try { await api.post(`/api/routes/${routeId}/stops/${orderId}`, { failed: true, reason }); toast('Registrado. O pedido voltou para a loja.', 'warn'); refresh(); }
      catch (err) { notifyError(err); }
    };
  });
}

function stopCard(stop, route) {
  const done = stop.status !== 'pendente';
  const maps = stop.lat != null
    ? `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${stop.lat},${stop.lon}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.address || '')}`;
  return `
  <article class="stop ${done ? 'done' : ''}">
    <div class="spread">
      <div class="row tight"><span class="seq">${stop.seq}</span><h3>${esc(stop.customer_name)}</h3></div>
      <span class="badge ${done ? 'gray' : (stop.paid ? 'green' : 'orange')}">${done ? esc(STOP_STATUS_LABELS[stop.status] || stop.status) : (stop.paid ? 'pago' : 'receber ' + money(stop.total_cents))}</span>
    </div>
    <div class="addr">📍 ${esc(stop.address)}</div>
    ${stop.complement ? `<div class="small muted">Compl.: ${esc(stop.complement)}</div>` : ''}
    ${stop.reference ? `<div class="small muted">Ref.: ${esc(stop.reference)}</div>` : ''}
    <div class="small muted mono">${esc(stop.code)} · ${stop.items.length} itens · ${esc((stop.payment_method || 'a definir'))}</div>
    ${!stop.paid && stop.change_for_cents ? `<div class="badge orange">levar troco de ${money(Math.max(0, stop.change_for_cents - stop.total_cents))}</div>` : ''}
    ${stop.notes ? `<div class="small mt" style="color:var(--orange)">⚠ ${esc(stop.notes)}</div>` : ''}
    <div class="acts">
      <a class="btn btn-warn" href="${esc(stop.waze_url || wazeLink(stop))}" target="_blank" rel="noopener">🧭 Waze</a>
      <a class="btn btn-2" href="${esc(maps)}" target="_blank" rel="noopener">🗺 Maps</a>
      <button class="btn-2" data-nav="${stop.order_id}">🔳 QR</button>
      ${stop.customer_phone ? `<a class="btn btn-2" href="${esc(whatsappLink(stop.customer_phone, `Ola ${stop.customer_name}! Estou chegando com seu pedido ${stop.code}.`))}" target="_blank" rel="noopener">💬 Avisar</a>` : ''}
      ${done ? '' : `<button data-done="${route.id}:${stop.order_id}">✅ Entreguei</button>
        <button class="btn-danger" data-fail="${route.id}:${stop.order_id}">Não consegui</button>`}
    </div>
  </article>`;
}

function routeQr(route) {
  return navigateDialog(
    { customer_name: `Rota #${route.id}`, address: `${route.stops.length} paradas · ${route.planned_km} km`,
      lat: route.stops[0]?.lat, lon: route.stops[0]?.lon },
    { routeMapsUrl: route.maps_url, title: 'Navegação da rota' }
  );
}

/* Envia a posição a cada movimento relevante para o mapa do despacho. */
function startTracking() {
  if (!navigator.geolocation || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      if (!data?.driver) return;
      api.post(`/api/drivers/${data.driver.id}/ping`, {
        lat: position.coords.latitude, lon: position.coords.longitude,
      }).catch(() => {});
    },
    () => { /* sem permissão: o app segue funcionando normalmente */ },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
  );
}

function stopTracking() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  clearInterval(timer);
}

boot();

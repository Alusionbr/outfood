/** Painel do dia: os números que o gerente acompanha em tempo real. */
import { api } from '../api.js';
import { emptyState, notifyError } from '../ui.js';
import { onServerEvent } from '../store.js';
import { dayLabel, esc, money, plural, statusBadge, time, todayISO } from '../util.js';

let unsubscribe = null;
let refreshTimer = null;

export async function render(container, ctx) {
  unsubscribe?.();
  clearInterval(refreshTimer);
  clearTimeout(pending);
  const day = ctx.query.get('day') || todayISO();
  await draw(container, day);
  unsubscribe = onServerEvent('*', () => scheduleRefresh(container, day));
  refreshTimer = setInterval(() => draw(container, day, true), 60000);
}

export function destroy() {
  unsubscribe?.();
  clearInterval(refreshTimer);
  clearTimeout(pending);
}

let pending = null;
function scheduleRefresh(container, day) {
  clearTimeout(pending);
  pending = setTimeout(() => draw(container, day, true), 800);
}

async function draw(container, day, silent = false) {
  try {
    const [data, orders] = await Promise.all([api.dashboard(day), api.orders('open=1')]);
    container.innerHTML = template(data, orders, day);
    container.querySelector('#dayPicker').onchange = (e) => {
      location.hash = `#/?day=${e.target.value}`;
    };
  } catch (err) {
    if (!silent) notifyError(err);
  }
}

function template(d, openOrders, day) {
  const maxHour = Math.max(1, ...d.by_hour.map((h) => h.orders));
  return `
  <div class="row mb" style="justify-content:space-between">
    <div class="row tight">
      <label style="margin:0">Dia</label>
      <input type="date" id="dayPicker" value="${esc(day)}" style="width:auto">
      <span class="muted small">Dia comercial vira às 05h</span>
    </div>
    <a class="btn btn-2" href="#/pdv">+ Novo pedido</a>
  </div>

  <div class="grid auto mb">
    ${stat('Vendas do dia', money(d.revenue_cents), `${plural(d.orders, 'pedido')} • ticket ${money(d.ticket_cents)}`, 'accent')}
    ${stat('Em andamento', d.open_orders, `${plural(d.late_orders, 'atrasado')}`, d.late_orders ? 'danger' : 'info')}
    ${stat('Entregas concluídas', d.delivered, `${plural(d.deliveries, 'entrega')} • ${plural(d.pickups, 'retirada')}`, 'info')}
    ${stat('Taxas de entrega', money(d.fees_cents), d.avg_delivery_minutes != null ? `Média de ${d.avg_delivery_minutes} min por pedido` : 'Sem entregas fechadas', 'warn')}
  </div>

  <div class="grid cols-2">
    <div class="card">
      <header><h3>Pedidos em andamento</h3><span class="badge">${openOrders.length}</span></header>
      <div class="table-wrap scroll-y">
        ${openOrders.length ? `<table>
          <thead><tr><th>Pedido</th><th>Cliente</th><th>Status</th><th>Entregador</th><th class="num">Total</th></tr></thead>
          <tbody>${openOrders.map((o) => `
            <tr>
              <td class="mono">${esc(o.code)}<div class="small muted">${time(o.created_at)}</div></td>
              <td>${esc(o.customer_name)}<div class="small muted">${esc(o.district || o.type)}</div></td>
              <td>${statusBadge(o.status)}</td>
              <td class="small">${esc(o.driver_name || (o.courier === 'plataforma' ? 'Plataforma' : '—'))}</td>
              <td class="num strong">${money(o.total_cents)}</td>
            </tr>`).join('')}</tbody></table>`
          : emptyState('☕', 'Nenhum pedido em andamento', 'Tudo entregue por aqui.')}
      </div>
    </div>

    <div class="card">
      <header><h3>Movimento por hora</h3></header>
      <div class="body">
        ${d.by_hour.length ? `
          <div class="chart-bars">
            ${d.by_hour.map((h) => `<div class="bar" style="height:${Math.round((h.orders / maxHour) * 100)}%"
              title="${h.hour}h — ${h.orders} pedidos, ${money(h.revenue_cents)}"></div>`).join('')}
          </div>
          <div class="chart-labels">${d.by_hour.map((h) => `<span>${h.hour}h</span>`).join('')}</div>`
          : emptyState('📉', 'Sem vendas registradas hoje')}
        <div class="sep"></div>
        <h4 class="mb">Por canal</h4>
        ${d.by_channel.length ? d.by_channel.map((c) => `
          <div class="spread small" style="padding:3px 0">
            <span>${esc(channelLabel(c.channel))}</span>
            <span class="muted">${c.orders} pedidos · <b>${money(c.revenue_cents)}</b></span>
          </div>`).join('') : '<div class="muted small">Sem dados</div>'}
      </div>
    </div>
  </div>

  <div class="grid cols-3">
    <div class="card">
      <header><h3>Mais vendidos</h3></header>
      <div class="table-wrap">
        ${d.top_products.length ? `<table><tbody>${d.top_products.map((p) => `
          <tr><td>${esc(p.name)}</td><td class="num">${Math.round(p.qty)}x</td><td class="num muted">${money(p.revenue_cents)}</td></tr>`).join('')}
        </tbody></table>` : emptyState('🍽️', 'Nada vendido ainda')}
      </div>
    </div>

    <div class="card">
      <header><h3>Bairros que mais pedem</h3></header>
      <div class="table-wrap">
        ${d.by_district.length ? `<table><tbody>${d.by_district.map((b) => `
          <tr><td>${esc(b.district)}</td><td class="num">${b.orders}</td><td class="num muted">${money(b.revenue_cents)}</td></tr>`).join('')}
        </tbody></table>` : emptyState('🗺️', 'Sem entregas hoje')}
      </div>
    </div>

    <div class="card">
      <header><h3>Entregadores hoje</h3></header>
      <div class="table-wrap">
        ${d.drivers.length ? `<table>
          <thead><tr><th>Nome</th><th class="num">Entregas</th><th class="num">Comissão</th><th class="num">Dinheiro</th></tr></thead>
          <tbody>${d.drivers.map((x) => `
            <tr><td>${esc(x.name)}<div class="small muted">${x.km} km</div></td>
            <td class="num">${x.deliveries}</td><td class="num">${money(x.commission_cents)}</td>
            <td class="num">${money(x.cash_collected_cents)}</td></tr>`).join('')}
        </tbody></table>` : emptyState('🏍️', 'Nenhum entregador cadastrado')}
      </div>
    </div>
  </div>

  <div class="muted small">Dia ${dayLabel(d.day)} · atualizado ${time(new Date().toISOString())}</div>`;
}

function stat(label, value, sub, kind = '') {
  return `<div class="stat ${kind}"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;
}

function channelLabel(channel) {
  return { balcao: 'Balcão', telefone: 'Telefone', whatsapp: 'WhatsApp', site: 'Site próprio', ifood: 'iFood', rappi: 'Rappi', outra_plataforma: 'Outra plataforma' }[channel] || channel;
}

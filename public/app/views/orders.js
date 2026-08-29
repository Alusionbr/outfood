/** Lista de pedidos + ficha completa com ações de status, pagamento e impressão. */
import { api } from '../api.js';
import { can, onServerEvent } from '../store.js';
import { emptyState, modal, notifyError, printWithQr, promptDialog, toast } from '../ui.js';
import { orderQrPayload, qrBlock } from '../navigation.js';
import {
  CHANNEL_LABELS, PAYMENT_LABELS, STATUS_META, TYPE_LABELS, dateTime, esc, formatPhone,
  money, since, statusBadge, time, todayISO, whatsappLink,
} from '../util.js';

let unsubscribe = null;
let filters = { day: todayISO(), status: '', q: '', type: '' };

export async function render(container, ctx) {
  unsubscribe?.();
  if (ctx.query.get('status')) filters.status = ctx.query.get('status');
  container.innerHTML = shell();
  bindFilters(container);
  await load(container);
  unsubscribe = onServerEvent('*', (data, name) => {
    if (name.startsWith('order:') || name.startsWith('route:')) load(container, true);
  });
  if (ctx.query.get('id')) openOrder(Number(ctx.query.get('id')), container);
}

export function destroy() { unsubscribe?.(); }

function shell() {
  return `
  <div class="card">
    <header>
      <h3>Pedidos</h3>
      <div class="row tight">
        <input type="search" id="q" placeholder="Buscar código, cliente, telefone..." style="width:250px" value="${esc(filters.q)}">
        <input type="date" id="day" value="${esc(filters.day)}" style="width:auto">
        <select id="status" style="width:auto">
          <option value="">Todos os status</option>
          ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <select id="type" style="width:auto">
          <option value="">Todos os tipos</option>
          ${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${filters.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        ${can('orders:create') ? '<a class="btn" href="#/pdv">+ Novo</a>' : ''}
      </div>
    </header>
    <div class="table-wrap" id="list"><div class="loading">Carregando pedidos...</div></div>
  </div>`;
}

function bindFilters(container) {
  const apply = () => {
    filters = {
      day: container.querySelector('#day').value,
      status: container.querySelector('#status').value,
      type: container.querySelector('#type').value,
      q: container.querySelector('#q').value.trim(),
    };
    load(container);
  };
  container.querySelector('#day').onchange = apply;
  container.querySelector('#status').onchange = apply;
  container.querySelector('#type').onchange = apply;
  let timer;
  container.querySelector('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(apply, 350); };
}

async function load(container, silent = false) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  else if (filters.day) params.set('day', filters.day);
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  try {
    const orders = await api.orders(params.toString());
    const list = container.querySelector('#list');
    if (!list) return;
    list.innerHTML = orders.length ? table(orders) : emptyState('📭', 'Nenhum pedido encontrado', 'Ajuste os filtros ou registre um novo pedido.');
    list.querySelectorAll('tr[data-id]').forEach((row) => {
      row.onclick = () => openOrder(Number(row.dataset.id), container);
    });
  } catch (err) {
    if (!silent) notifyError(err);
  }
}

function table(orders) {
  const total = orders.filter((o) => o.status !== 'cancelado').reduce((acc, o) => acc + o.total_cents, 0);
  return `<table>
    <thead><tr>
      <th>Pedido</th><th>Cliente</th><th>Tipo / canal</th><th>Status</th><th>Entregador</th>
      <th class="num">Total</th><th class="num">Pago</th>
    </tr></thead>
    <tbody>${orders.map((o) => `
      <tr data-id="${o.id}" style="cursor:pointer">
        <td class="mono">${esc(o.code)}<div class="small muted">${time(o.created_at)} · ${since(o.created_at)}</div></td>
        <td>${esc(o.customer_name)}<div class="small muted">${esc(o.address || formatPhone(o.customer_phone) || '-')}</div></td>
        <td class="small">${esc(TYPE_LABELS[o.type] || o.type)}<div class="muted">${esc(CHANNEL_LABELS[o.channel] || o.channel)}</div></td>
        <td>${statusBadge(o.status)}</td>
        <td class="small">${esc(o.driver_name || (o.courier === 'plataforma' ? '🛵 plataforma' : '—'))}</td>
        <td class="num strong">${money(o.total_cents)}</td>
        <td class="num">${o.paid ? '<span class="badge green">pago</span>' : '<span class="badge gray">em aberto</span>'}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot><tr><th colspan="5">${orders.length} pedidos</th><th class="num">${money(total)}</th><th></th></tr></tfoot>
  </table>`;
}

/* ------------------------------ ficha do pedido ------------------------------ */

export async function openOrder(id, container) {
  let order;
  try { order = await api.order(id); } catch (err) { return notifyError(err); }

  const body = document.createElement('div');
  body.innerHTML = detail(order);

  const actions = [{ label: 'Fechar', className: 'btn-ghost' }];
  await modal({ title: `Pedido ${order.code}`, body, wide: true, actions });
  bind(body, order, container);
}

function detail(o) {
  const track = `${location.origin}/r/${o.public_token}`;
  return `
  <div class="spread mb">
    <div>${statusBadge(o.status)} <span class="badge">${esc(TYPE_LABELS[o.type])}</span>
      <span class="badge">${esc(CHANNEL_LABELS[o.channel] || o.channel)}</span>
      ${o.courier === 'plataforma' ? '<span class="badge blue">entregador da plataforma</span>' : ''}
      ${o.paid ? '<span class="badge green">pago</span>' : '<span class="badge orange">a receber</span>'}</div>
    <div class="muted small">${dateTime(o.created_at)}</div>
  </div>

  <div class="grid cols-2">
    <div>
      <h4>Cliente</h4>
      <div>${esc(o.customer_name)}</div>
      ${o.customer_phone ? `<div class="small">${esc(formatPhone(o.customer_phone))}
        <a class="badge green" target="_blank" rel="noopener" href="${esc(whatsappLink(o.customer_phone, `Ola ${o.customer_name}! Sobre seu pedido ${o.code}: `))}">WhatsApp</a></div>` : ''}
      ${o.address ? `<div class="small mt">📍 ${esc(o.address)}</div>` : ''}
      ${o.reference ? `<div class="small muted">Ref.: ${esc(o.reference)}</div>` : ''}
      ${o.zone_name ? `<div class="small muted">Zona: ${esc(o.zone_name)}${o.distance_km ? ` · ${o.distance_km} km` : ''}</div>` : ''}
      ${o.lat == null && o.type === 'entrega' ? '<div class="badge red mt">sem coordenada — não entra na otimização</div>' : ''}
    </div>
    <div>
      <h4>Entrega</h4>
      <div class="small">Entregador: <b>${esc(o.driver_name || '—')}</b></div>
      <div class="small">Prometido para: <b>${time(o.promised_at)}</b> (${o.prep_minutes} min de preparo)</div>
      ${o.delivered_at ? `<div class="small">Entregue em ${dateTime(o.delivered_at)}</div>` : ''}
      ${o.notes ? `<div class="small mt"><b>Observações:</b> ${esc(o.notes)}</div>` : ''}
      <div class="small mt">Acompanhamento: <a href="${esc(track)}" target="_blank" rel="noopener">${esc(track)}</a></div>
    </div>
  </div>

  <div class="sep"></div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qtd</th><th class="num">Unit.</th><th class="num">Total</th></tr></thead>
    <tbody>${o.items.map((i) => `
      <tr><td>${esc(i.name)}
        ${(i.options || []).map((x) => `<div class="small muted">+ ${esc(x.name)} ${x.price_cents ? money(x.price_cents) : ''}</div>`).join('')}
        ${i.notes ? `<div class="small" style="color:var(--orange)">obs: ${esc(i.notes)}</div>` : ''}</td>
      <td class="num">${i.qty}</td><td class="num">${money(i.unit_price_cents)}</td><td class="num">${money(i.total_cents)}</td></tr>`).join('')}
    </tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal</span><span>${money(o.subtotal_cents)}</span></div>
    ${o.delivery_fee_cents ? `<div><span>Taxa de entrega</span><span>${money(o.delivery_fee_cents)}</span></div>` : ''}
    ${o.discount_cents ? `<div><span>Desconto</span><span>- ${money(o.discount_cents)}</span></div>` : ''}
    ${o.surcharge_cents ? `<div><span>Acréscimo</span><span>${money(o.surcharge_cents)}</span></div>` : ''}
    <div class="big"><span>Total</span><span>${money(o.total_cents)}</span></div>
    <div class="small muted"><span>${esc(PAYMENT_LABELS[o.payment_method] || 'Pagamento a definir')}</span>
      <span>${o.change_for_cents ? `troco para ${money(o.change_for_cents)} = ${money(Math.max(0, o.change_for_cents - o.total_cents))}` : ''}</span></div>
  </div>

  <div class="sep"></div>
  <div class="row" id="orderActions">
    ${(o.next_statuses || []).map((s) => `<button class="${s === 'cancelado' ? 'btn-danger' : ''}" data-status="${s}">
      ${STATUS_META[s]?.icon || ''} ${esc(STATUS_META[s]?.label || s)}</button>`).join('')}
    ${!o.paid && can('orders:pay') ? '<button class="btn-2" data-pay>💵 Registrar pagamento</button>' : ''}
    <button class="btn-ghost" data-print="kitchen">🖨 Comanda</button>
    <button class="btn-ghost" data-print="receipt">🧾 Cupom</button>
    ${o.type === 'entrega' && o.lat == null ? '<button class="btn-ghost" data-geocode>📍 Localizar endereço</button>' : ''}
  </div>

  <details class="mt">
    <summary class="muted small" style="cursor:pointer">Histórico do pedido (${o.timeline.length})</summary>
    <table class="mt"><tbody>${o.timeline.map((e) => `
      <tr><td class="small">${dateTime(e.created_at)}</td>
      <td class="small">${esc(e.to_status ? (STATUS_META[e.to_status]?.label || e.to_status) : e.type)}</td>
      <td class="small muted">${esc(e.message || '')}${e.user_name ? ` — ${esc(e.user_name)}` : ''}</td></tr>`).join('')}
    </tbody></table>
  </details>`;
}

function bind(body, order, container) {
  body.querySelectorAll('[data-status]').forEach((button) => {
    button.onclick = async () => {
      const status = button.dataset.status;
      let reason = null;
      if (status === 'cancelado') {
        reason = await promptDialog({ title: 'Cancelar pedido', label: 'Motivo do cancelamento', placeholder: 'Cliente desistiu' });
        if (!reason) return;
      }
      try {
        await api.setStatus(order.id, status, reason);
        toast(`Pedido ${order.code}: ${STATUS_META[status]?.label || status}`, 'ok');
        body.closest('.modal-scrim')?.remove();
        if (container) load(container, true);
      } catch (err) { notifyError(err); }
    };
  });

  body.querySelector('[data-pay]')?.addEventListener('click', () => payDialog(order, body, container));

  body.querySelectorAll('[data-print]').forEach((button) => {
    button.onclick = async () => {
      const kind = button.dataset.print;
      try {
        const { text } = await api.print(`/api/print/order/${order.id}/${kind}`);
        // Comanda: QR do pedido (despacho por leitura). Cupom: QR do rastreio.
        const qr = kind === 'kitchen'
          ? qrBlock(orderQrPayload(order.code), `Pedido ${order.code}`, 140)
          : qrBlock(`${location.origin}/r/${order.public_token}`, 'Acompanhe seu pedido', 140);
        printWithQr(text, qr);
      } catch (err) { notifyError(err); }
    };
  });

  body.querySelector('[data-geocode]')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'Localizando...';
    try {
      const result = await api.post(`/api/orders/${order.id}/geocode`);
      toast(result.found ? 'Endereço localizado no mapa' : 'Não localizei este endereço', result.found ? 'ok' : 'warn');
      body.closest('.modal-scrim')?.remove();
      if (container) load(container, true);
    } catch (err) { notifyError(err); }
  });
}

async function payDialog(order, body, container) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="field"><label>Forma de pagamento</label>
      <select id="method">${Object.entries(PAYMENT_LABELS).map(([k, v]) => `<option value="${k}" ${order.payment_method === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="grid cols-2">
      <div class="field"><label>Valor (R$)</label><input type="number" step="0.01" id="amount" value="${(order.total_cents / 100).toFixed(2)}"></div>
      <div class="field"><label>Recebido (R$)</label><input type="number" step="0.01" id="received" value="${(order.total_cents / 100).toFixed(2)}"></div>
    </div>
    <div class="hint">O troco é calculado automaticamente para pagamentos em dinheiro.</div>`;

  const done = await modal({
    title: `Pagamento do pedido ${order.code}`,
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Registrar',
        onClick: async ({ body: modalBody }) => {
          await api.pay(order.id, {
            method: modalBody.querySelector('#method').value,
            amount_cents: Math.round(Number(modalBody.querySelector('#amount').value) * 100),
            received_cents: Math.round(Number(modalBody.querySelector('#received').value) * 100),
          });
          return true;
        },
      },
    ],
  });
  if (done) {
    toast('Pagamento registrado', 'ok');
    body.closest('.modal-scrim')?.remove();
    if (container) load(container, true);
  }
}
